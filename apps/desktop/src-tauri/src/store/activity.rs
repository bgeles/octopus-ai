//! Feed de atividade do projeto (Início e ficha do membro): uma linha do tempo única com os
//! movimentos das tasks, os runs avulsos e as decisões suas (aprovações, orçamento, time).
//! Runs de task entram pelos eventos da task (`run_started`, `run_finished`, `approved`…), então
//! a auditoria `run.*` e `board.review.*` fica de fora de propósito para não duplicar. Eventos sem
//! `run_id` (`advanced`, `completed`) herdam o run mais recente da task para mostrar membro e custo.

use anyhow::Result;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::Store;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityItem {
    /// `tev_…` (evento de task), `run_…:started` / `run_…:ended` (run avulso) ou `audit:<seq>`.
    pub id: String,
    pub at: String,
    /// `task` | `run` | `audit`
    pub source: String,
    /// kind do evento de task, `run_started|run_finished|run_failed|run_interrupted`, ou kind da auditoria.
    pub kind: String,
    pub actor: String,
    pub task_id: Option<String>,
    pub task_title: Option<String>,
    pub run_id: Option<String>,
    pub agent_profile_id: Option<String>,
    pub agent_name: Option<String>,
    pub cost_usd: Option<f64>,
    /// Nota do evento, prompt do run avulso ou seu resultado/erro.
    pub note: Option<String>,
    pub from_stage: Option<String>,
    pub to_stage: Option<String>,
    /// Só para auditoria: o payload original.
    pub payload: Option<Value>,
}

const ACTIVITY_SQL: &str = "
SELECT x.id, x.at, x.source, x.kind, x.actor, x.task_id, x.task_title, x.run_id,
       x.agent_profile_id, ap.name AS agent_name, x.cost_usd, x.note, x.from_stage, x.to_stage, x.payload_json
FROM (
  SELECT te.id AS id, te.at AS at, 'task' AS source, te.kind AS kind, te.actor AS actor,
         te.task_id AS task_id, t.title AS task_title, te.run_id AS run_id,
         COALESCE(r.agent_profile_id, t.approver_agent_id, t.assigned_agent_id) AS agent_profile_id,
         CASE WHEN te.kind IN ('run_finished','completed','advanced','run_failed','approved','returned') THEN r.cost_usd END AS cost_usd,
         te.note AS note, te.from_stage AS from_stage, te.to_stage AS to_stage, NULL AS payload_json
  FROM task_event te
  JOIN task t ON t.id = te.task_id
  LEFT JOIN run r ON r.id = COALESCE(te.run_id,
    (SELECT lr.id FROM run lr WHERE lr.task_id = te.task_id AND lr.started_at <= te.at AND lr.kind <> 'consolidation' ORDER BY lr.started_at DESC LIMIT 1))
  WHERE t.project_id = ?1 AND te.kind <> 'agent_update'
  UNION ALL
  SELECT r.id || ':started', r.started_at, 'run', 'run_started',
         CASE WHEN r.agent_profile_id IS NULL THEN 'você' ELSE 'scheduler' END,
         NULL, NULL, r.id, r.agent_profile_id, NULL, r.prompt, NULL, NULL, NULL
  FROM run r WHERE r.project_id = ?1 AND r.task_id IS NULL AND r.kind = 'agent'
  UNION ALL
  SELECT r.id || ':ended', r.ended_at, 'run',
         CASE r.status WHEN 'completed' THEN 'run_finished' WHEN 'interrupted' THEN 'run_interrupted' ELSE 'run_failed' END,
         'sistema', NULL, NULL, r.id, r.agent_profile_id, r.cost_usd,
         COALESCE(r.result_text, r.error_message), NULL, NULL, NULL
  FROM run r WHERE r.project_id = ?1 AND r.task_id IS NULL AND r.kind = 'agent' AND r.ended_at IS NOT NULL
  UNION ALL
  SELECT 'audit:' || ae.seq, ae.ts, 'audit', ae.kind, ae.actor,
         json_extract(ae.payload_json, '$.taskId'), NULL,
         json_extract(ae.payload_json, '$.runId'),
         COALESCE(ar.agent_profile_id, json_extract(ae.payload_json, '$.agentProfileId')),
         NULL, json_extract(ae.payload_json, '$.message'), NULL, NULL, ae.payload_json
  FROM audit_event ae
  LEFT JOIN run ar ON ar.id = json_extract(ae.payload_json, '$.runId')
  WHERE ae.project_id = ?1
    AND (ae.kind LIKE 'approval.%' OR ae.kind LIKE 'budget.%' OR ae.kind LIKE 'team.member.%')
) x
LEFT JOIN agent_profile ap ON ap.id = x.agent_profile_id
WHERE x.at IS NOT NULL AND (?2 IS NULL OR x.agent_profile_id = ?2)
ORDER BY x.at DESC, x.id DESC
LIMIT ?3";

impl Store {
    /// Atividade recente do projeto, mais nova primeiro; `agent_profile_id` restringe a um membro.
    pub fn list_project_activity(
        &self,
        project_id: &str,
        agent_profile_id: Option<&str>,
        limit: u32,
    ) -> Result<Vec<ActivityItem>> {
        let conn = self.conn.lock().expect("store mutex");
        let mut stmt = conn.prepare(ACTIVITY_SQL)?;
        let rows = stmt
            .query_map(params![project_id, agent_profile_id, limit as i64], |r| {
                let payload: Option<String> = r.get(14)?;
                Ok(ActivityItem {
                    id: r.get(0)?,
                    at: r.get(1)?,
                    source: r.get(2)?,
                    kind: r.get(3)?,
                    actor: r.get(4)?,
                    task_id: r.get(5)?,
                    task_title: r.get(6)?,
                    run_id: r.get(7)?,
                    agent_profile_id: r.get(8)?,
                    agent_name: r.get(9)?,
                    cost_usd: r.get(10)?,
                    note: r.get(11)?,
                    from_stage: r.get(12)?,
                    to_stage: r.get(13)?,
                    payload: payload.and_then(|p| serde_json::from_str(&p).ok()),
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{RunEvent, RunOptions, TaskStatusUpdate, Usage};
    use crate::store::orchestration::TaskInput;
    use crate::store::team::TeamMemberInput;

    fn result_event(ok: bool, cost: f64) -> RunEvent {
        RunEvent::Result {
            session_id: "s".into(),
            subtype: if ok { "success".into() } else { "error".into() },
            is_error: !ok,
            cost_usd: Some(cost),
            duration_ms: None,
            num_turns: Some(1),
            usage: Some(Usage::default()),
            stop_reason: None,
            result_text: Some("Pronto.".into()),
        }
    }

    #[test]
    fn activity_merges_sources_newest_first_and_resolves_names() {
        let s = Store::open_in_memory().unwrap();
        let project = s.create_project("p", "/tmp/p").unwrap().id;
        let ana = s
            .add_team_member(
                &project,
                &TeamMemberInput {
                    name: "Ana".into(),
                    role_id: "role_implementador".into(),
                    ..Default::default()
                },
            )
            .unwrap()
            .profile
            .id;
        let wf = s
            .create_workflow_from_template(&project, "research-synthesis", false)
            .unwrap();
        let task = s
            .create_task(
                &project,
                &wf.id,
                &TaskInput {
                    title: "Mapear".into(),
                    assigned_agent_id: Some(ana.clone()),
                    ..Default::default()
                },
            )
            .unwrap();
        let run = s
            .create_run_full(
                &project,
                "x",
                &RunOptions::default(),
                Some(&ana),
                Some(&task.id),
            )
            .unwrap();
        assert!(s.claim_task(&task.id, &run.id, None, None).unwrap());
        s.record_run_event(
            &run.id,
            0,
            "t",
            &RunEvent::TaskUpdate {
                task_id: task.id.clone(),
                status: TaskStatusUpdate::Done,
                note: Some("feito".into()),
                result: None,
            },
        )
        .unwrap();
        s.record_run_event(&run.id, 1, "t", &result_event(true, 0.25))
            .unwrap();
        // Run avulso seu, concluído.
        let solo = s
            .create_run_full(
                &project,
                "Resuma o projeto",
                &RunOptions::default(),
                None,
                None,
            )
            .unwrap();
        s.record_run_event(&solo.id, 0, "t", &result_event(true, 0.05))
            .unwrap();
        // Auditoria: só prefixos de decisão entram; run.finished fica de fora.
        s.audit(
            "você",
            "approval.deny",
            Some(&project),
            serde_json::json!({"runId": run.id, "tool": "Bash", "message": "não"}),
        )
        .unwrap();
        s.audit(
            "sistema",
            "run.finished",
            Some(&project),
            serde_json::json!({"runId": solo.id}),
        )
        .unwrap();

        let items = s.list_project_activity(&project, None, 50).unwrap();
        let kinds: Vec<&str> = items.iter().map(|i| i.kind.as_str()).collect();
        assert!(kinds.contains(&"created"), "{kinds:?}");
        assert!(kinds.contains(&"advanced"));
        assert!(kinds.contains(&"run_started"));
        assert!(kinds.contains(&"run_finished"));
        assert!(kinds.contains(&"approval.deny"));
        assert!(!kinds.contains(&"agent_update"));
        assert!(!kinds.contains(&"run.finished"));
        // Ordenado do mais novo para o mais antigo.
        for pair in items.windows(2) {
            assert!(
                pair[0].at >= pair[1].at,
                "{:?} < {:?}",
                pair[0].at,
                pair[1].at
            );
        }
        let advanced = items.iter().find(|i| i.kind == "advanced").unwrap();
        assert_eq!(advanced.task_title.as_deref(), Some("Mapear"));
        assert_eq!(advanced.agent_name.as_deref(), Some("Ana"));
        assert_eq!(advanced.cost_usd, Some(0.25));
        let solo_end = items
            .iter()
            .find(|i| i.kind == "run_finished" && i.source == "run")
            .unwrap();
        assert_eq!(solo_end.cost_usd, Some(0.05));
        assert_eq!(solo_end.note.as_deref(), Some("Pronto."));
        let deny = items.iter().find(|i| i.kind == "approval.deny").unwrap();
        assert_eq!(
            deny.agent_name.as_deref(),
            Some("Ana"),
            "resolvido pelo run"
        );
        assert_eq!(deny.note.as_deref(), Some("não"));
        assert!(deny.payload.is_some());

        // Filtro por membro e por projeto; limite.
        let only_ana = s.list_project_activity(&project, Some(&ana), 50).unwrap();
        assert!(!only_ana.is_empty());
        assert!(only_ana
            .iter()
            .all(|i| i.agent_profile_id.as_deref() == Some(ana.as_str())));
        assert!(only_ana
            .iter()
            .all(|i| i.source != "run" || i.run_id != Some(solo.id.clone())));
        let other = s.create_project("o", "/tmp/o").unwrap().id;
        assert!(s
            .list_project_activity(&other, None, 50)
            .unwrap()
            .is_empty());
        assert_eq!(s.list_project_activity(&project, None, 2).unwrap().len(), 2);
    }
}
