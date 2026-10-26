//! Relatório final do workflow: quando a última task conclui (ou sob demanda), o core consolida as
//! entregas de cada task, custo, membros e duração num markdown; opcionalmente o Haiku escreve um
//! resumo executivo num run `kind = report` sem ferramentas (o texto final vira `summary_md`).

use anyhow::{Context, Result};
use rusqlite::{params, OptionalExtension, Row, Transaction};
use serde::{Deserialize, Serialize};

use super::memory::{first_chars, sanitize, CONSOLIDATION_MODEL, CONSOLIDATION_SETTING};
use super::models::Run;
use super::{new_id, now, Store};
use crate::protocol::{PermissionMode, RunOptions};

/// `off` | `haiku`; ausente herda `memory.consolidation == "haiku"`.
pub const REPORT_SUMMARY_SETTING: &str = "board.reportSummary";
const RESULT_CAP: usize = 6_000;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportTask {
    pub task_id: String,
    pub title: String,
    pub stage_name: String,
    pub member_name: Option<String>,
    pub agent_profile_id: Option<String>,
    pub cost_usd: f64,
    pub files_changed: Vec<String>,
    pub result_run_id: Option<String>,
    pub done: bool,
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportMember {
    pub agent_profile_id: String,
    pub name: String,
    pub role_title: String,
    pub runs: u32,
    pub cost_usd: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowReport {
    pub id: String,
    pub project_id: String,
    pub workflow_id: String,
    pub generation: u32,
    /// `auto` (última task concluiu) ou `manual` (botão "Gerar relatório").
    pub trigger: String,
    pub title: String,
    pub body_md: String,
    pub summary_md: Option<String>,
    /// `none` | `pending` | `running` | `done` | `failed`
    pub summary_status: String,
    pub summary_run_id: Option<String>,
    pub source_run_id: Option<String>,
    pub cost_usd: f64,
    pub tasks_total: u32,
    pub tasks_done: u32,
    pub members: Vec<ReportMember>,
    pub tasks: Vec<ReportTask>,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub created_at: String,
}

impl WorkflowReport {
    const SELECT: &'static str = "SELECT id, project_id, workflow_id, generation, trigger, title, body_md, summary_md, summary_status, summary_run_id, source_run_id, cost_usd, tasks_total, tasks_done, members_json, tasks_json, started_at, finished_at, created_at FROM workflow_report";

    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        let members: String = row.get(14)?;
        let tasks: String = row.get(15)?;
        Ok(WorkflowReport {
            id: row.get(0)?,
            project_id: row.get(1)?,
            workflow_id: row.get(2)?,
            generation: row.get::<_, i64>(3)? as u32,
            trigger: row.get(4)?,
            title: row.get(5)?,
            body_md: row.get(6)?,
            summary_md: row.get(7)?,
            summary_status: row.get(8)?,
            summary_run_id: row.get(9)?,
            source_run_id: row.get(10)?,
            cost_usd: row.get(11)?,
            tasks_total: row.get::<_, i64>(12)? as u32,
            tasks_done: row.get::<_, i64>(13)? as u32,
            members: serde_json::from_str(&members).unwrap_or_default(),
            tasks: serde_json::from_str(&tasks).unwrap_or_default(),
            started_at: row.get(16)?,
            finished_at: row.get(17)?,
            created_at: row.get(18)?,
        })
    }

    /// Markdown completo para Copiar/Exportar: resumo executivo (se houver) + corpo.
    pub fn markdown(&self) -> String {
        match self
            .summary_md
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            Some(summary) => format!(
                "{}\n\n## Resumo executivo\n\n{summary}\n\n{}",
                self.body_md.lines().next().unwrap_or(""),
                self.body_md
                    .split_once('\n')
                    .map(|x| x.1)
                    .unwrap_or("")
                    .trim_start_matches('\n')
            ),
            None => self.body_md.clone(),
        }
    }
}

struct TaskRow {
    id: String,
    title: String,
    stage_id: String,
    status: String,
    assigned: Option<String>,
    result_md: Option<String>,
    files: Vec<String>,
    result_run_id: Option<String>,
    created_at: String,
    updated_at: String,
}

impl Store {
    /// Dentro da tx que concluiu uma task: se não resta task aberta no workflow (e há tasks), grava
    /// uma geração `auto` do relatório — a menos que a última geração automática já cubra esse estado.
    pub(crate) fn maybe_complete_workflow_in(
        tx: &Transaction<'_>,
        workflow_id: &str,
        source_run_id: Option<&str>,
    ) -> Result<Option<WorkflowReport>> {
        let (total, open, last_done): (i64, i64, Option<String>) = tx.query_row(
            "SELECT COUNT(*), SUM(CASE WHEN status <> 'done' THEN 1 ELSE 0 END), MAX(CASE WHEN status = 'done' THEN updated_at END) FROM task WHERE workflow_id = ?1",
            params![workflow_id],
            |r| Ok((r.get(0)?, r.get::<_, Option<i64>>(1)?.unwrap_or(0), r.get(2)?)),
        )?;
        if total == 0 || open > 0 {
            return Ok(None);
        }
        let covered: Option<String> = tx
            .query_row(
                "SELECT finished_at FROM workflow_report WHERE workflow_id = ?1 AND trigger = 'auto' ORDER BY generation DESC LIMIT 1",
                params![workflow_id],
                |r| r.get(0),
            )
            .optional()?
            .flatten();
        if let (Some(covered), Some(last_done)) = (covered, last_done) {
            if covered >= last_done {
                return Ok(None);
            }
        }
        Ok(Some(Self::build_report_in(
            tx,
            workflow_id,
            "auto",
            source_run_id,
        )?))
    }

    /// Monta e grava uma geração do relatório (só SQL + formatação; nada de git ou LLM).
    pub(crate) fn build_report_in(
        tx: &Transaction<'_>,
        workflow_id: &str,
        trigger: &str,
        source_run_id: Option<&str>,
    ) -> Result<WorkflowReport> {
        let (project_id, workflow_name, stages_json): (String, String, String) = tx
            .query_row(
                "SELECT project_id, name, stages_json FROM workflow WHERE id = ?1",
                params![workflow_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?
            .with_context(|| format!("Workflow {workflow_id} não encontrado"))?;
        let stages: Vec<super::orchestration::Stage> =
            serde_json::from_str(&stages_json).unwrap_or_default();
        let stage_name = |id: &str| {
            stages
                .iter()
                .find(|s| s.id == id)
                .map(|s| s.name.clone())
                .unwrap_or_else(|| id.to_string())
        };
        let mut stmt = tx.prepare(
            "SELECT id, title, stage_id, status, assigned_agent_id, result_md, files_changed_json, result_run_id, created_at, updated_at FROM task WHERE workflow_id = ?1 ORDER BY position, created_at",
        )?;
        let tasks: Vec<TaskRow> = stmt
            .query_map(params![workflow_id], |r| {
                let files: String = r.get(6)?;
                Ok(TaskRow {
                    id: r.get(0)?,
                    title: r.get(1)?,
                    stage_id: r.get(2)?,
                    status: r.get(3)?,
                    assigned: r.get(4)?,
                    result_md: r.get(5)?,
                    files: serde_json::from_str(&files).unwrap_or_default(),
                    result_run_id: r.get(7)?,
                    created_at: r.get(8)?,
                    updated_at: r.get(9)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        drop(stmt);

        // Custo e membros: pelos runs de cada task (custo final, senão a estimativa).
        let mut report_tasks = Vec::new();
        let mut members: Vec<ReportMember> = Vec::new();
        let mut total_cost = 0.0;
        for t in &tasks {
            let mut rows = tx.prepare(
                "SELECT agent_profile_id, COALESCE(cost_usd, est_cost_usd, 0) FROM run WHERE task_id = ?1 AND kind IN ('agent', 'review')",
            )?;
            let runs: Vec<(Option<String>, f64)> = rows
                .query_map(params![t.id], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            drop(rows);
            let task_cost: f64 = runs.iter().map(|(_, c)| c).sum();
            total_cost += task_cost;
            for (agent, cost) in &runs {
                let Some(agent) = agent else { continue };
                if let Some(m) = members.iter_mut().find(|m| &m.agent_profile_id == agent) {
                    m.runs += 1;
                    m.cost_usd += cost;
                } else {
                    let named: Option<(String, String)> = tx
                        .query_row(
                            "SELECT ap.name, r.title FROM agent_profile ap JOIN role r ON r.id = ap.role_id WHERE ap.id = ?1",
                            params![agent],
                            |r| Ok((r.get(0)?, r.get(1)?)),
                        )
                        .optional()?;
                    let (name, role_title) =
                        named.unwrap_or_else(|| ("membro removido".into(), String::new()));
                    members.push(ReportMember {
                        agent_profile_id: agent.clone(),
                        name,
                        role_title,
                        runs: 1,
                        cost_usd: *cost,
                    });
                }
            }
            let member_id = runs
                .iter()
                .rev()
                .find_map(|(a, _)| a.clone())
                .or_else(|| t.assigned.clone());
            let member_name = member_id
                .as_deref()
                .and_then(|id| members.iter().find(|m| m.agent_profile_id == id))
                .map(|m| m.name.clone());
            report_tasks.push((
                ReportTask {
                    task_id: t.id.clone(),
                    title: t.title.clone(),
                    stage_name: stage_name(&t.stage_id),
                    member_name,
                    agent_profile_id: member_id,
                    cost_usd: task_cost,
                    files_changed: t.files.clone(),
                    result_run_id: t.result_run_id.clone(),
                    done: t.status == "done",
                    status: t.status.clone(),
                },
                t.result_md.clone(),
            ));
        }
        let tasks_total = tasks.len() as u32;
        let tasks_done = tasks.iter().filter(|t| t.status == "done").count() as u32;
        let started_at = tasks.iter().map(|t| t.created_at.clone()).min();
        let finished_at = tasks
            .iter()
            .filter(|t| t.status == "done")
            .map(|t| t.updated_at.clone())
            .max();
        let generation: i64 = tx.query_row(
            "SELECT COALESCE(MAX(generation), 0) + 1 FROM workflow_report WHERE workflow_id = ?1",
            params![workflow_id],
            |r| r.get(0),
        )?;

        // Corpo em markdown.
        let title = format!("Relatório — {workflow_name}");
        let mut body = format!("# {title}\n\n");
        if let (Some(s), Some(f)) = (&started_at, &finished_at) {
            body.push_str(&format!(
                "Período: {} → {} · Duração: {}\n",
                human_time(s),
                human_time(f),
                human_duration(s, f)
            ));
        }
        body.push_str(&format!(
            "Tasks: {tasks_done} de {tasks_total} concluídas · Custo: US$ {total_cost:.2}"
        ));
        if !members.is_empty() {
            body.push_str(&format!(
                " · Membros: {}",
                members
                    .iter()
                    .map(|m| {
                        if m.role_title.is_empty() {
                            m.name.clone()
                        } else {
                            format!("{} ({})", m.name, m.role_title)
                        }
                    })
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
        body.push_str("\n\n## Entregas\n");
        let mut pending = Vec::new();
        for (t, result_md) in &report_tasks {
            if !t.done {
                pending.push(t);
                continue;
            }
            body.push_str(&format!(
                "\n### {} · {} — {} · US$ {:.2} · {} {}\n",
                short_id(&t.task_id),
                t.title,
                t.member_name.as_deref().unwrap_or("run avulso"),
                t.cost_usd,
                t.files_changed.len(),
                if t.files_changed.len() == 1 {
                    "arquivo"
                } else {
                    "arquivos"
                }
            ));
            match result_md
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                Some(r) => {
                    body.push_str(&first_chars(r, RESULT_CAP));
                    body.push('\n');
                }
                None => body.push_str("_Sem resumo da entrega._\n"),
            }
            if !t.files_changed.is_empty() {
                body.push_str(&format!("Arquivos: {}\n", t.files_changed.join(", ")));
                body.push_str("Diff: abra a task no Board (Ver diff).\n");
            }
        }
        if !pending.is_empty() {
            body.push_str("\n## Pendentes\n");
            for t in pending {
                body.push_str(&format!(
                    "- {} · {} — {} ({})\n",
                    short_id(&t.task_id),
                    t.title,
                    t.stage_name,
                    t.status
                ));
            }
        }

        let id = new_id("report");
        let created_at = now();
        let summary_status = if Self::report_summary_enabled_in(tx)? {
            "pending"
        } else {
            "none"
        };
        let report_tasks: Vec<ReportTask> = report_tasks.into_iter().map(|(t, _)| t).collect();
        tx.execute(
            "INSERT INTO workflow_report (id, project_id, workflow_id, generation, trigger, title, body_md, summary_status, source_run_id, cost_usd, tasks_total, tasks_done, members_json, tasks_json, started_at, finished_at, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
            params![
                id,
                project_id,
                workflow_id,
                generation,
                trigger,
                title,
                body,
                summary_status,
                source_run_id,
                total_cost,
                tasks_total as i64,
                tasks_done as i64,
                serde_json::to_string(&members)?,
                serde_json::to_string(&report_tasks)?,
                started_at,
                finished_at,
                created_at
            ],
        )?;
        tx.query_row(
            &format!("{} WHERE id = ?1", WorkflowReport::SELECT),
            params![id],
            WorkflowReport::from_row,
        )
        .context("relatório sumiu após gravar")
    }

    fn report_summary_enabled_in(tx: &Transaction<'_>) -> Result<bool> {
        let setting = |key: &str| -> Result<Option<String>> {
            Ok(tx
                .query_row(
                    "SELECT value_json FROM app_setting WHERE key = ?1",
                    params![key],
                    |r| r.get::<_, String>(0),
                )
                .optional()?
                .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
                .and_then(|v| v.as_str().map(str::to_string)))
        };
        Ok(match setting(REPORT_SUMMARY_SETTING)?.as_deref() {
            Some("haiku") => true,
            Some(_) => false,
            None => setting(CONSOLIDATION_SETTING)?.as_deref() == Some("haiku"),
        })
    }

    /// Resumo executivo com Haiku está ligado? (`board.reportSummary`, senão herda da consolidação.)
    pub fn report_summary_enabled(&self) -> Result<bool> {
        let mut conn = self.conn.lock().expect("store mutex");
        let tx = conn.transaction()?;
        Self::report_summary_enabled_in(&tx)
    }

    /// Botão "Gerar relatório": nova geração `manual`, mesmo com tasks pendentes.
    pub fn generate_workflow_report(&self, workflow_id: &str) -> Result<WorkflowReport> {
        let report = {
            let mut conn = self.conn.lock().expect("store mutex");
            let tx = conn.transaction()?;
            let report = Self::build_report_in(&tx, workflow_id, "manual", None)?;
            tx.commit()?;
            report
        };
        self.audit(
            "você",
            "board.report.generated",
            Some(&report.project_id),
            serde_json::json!({"workflowId": workflow_id, "reportId": report.id, "generation": report.generation, "tasksDone": report.tasks_done, "tasksTotal": report.tasks_total}),
        )?;
        Ok(report)
    }

    /// Última geração de cada workflow do projeto, mais recente primeiro.
    pub fn list_workflow_reports(&self, project_id: &str) -> Result<Vec<WorkflowReport>> {
        let conn = self.conn.lock().expect("store mutex");
        let mut stmt = conn.prepare(&format!(
            "{} WHERE project_id = ?1 AND generation = (SELECT MAX(generation) FROM workflow_report w2 WHERE w2.workflow_id = workflow_report.workflow_id) ORDER BY created_at DESC",
            WorkflowReport::SELECT
        ))?;
        let rows = stmt
            .query_map(params![project_id], WorkflowReport::from_row)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn get_workflow_report(&self, workflow_id: &str) -> Result<Option<WorkflowReport>> {
        let conn = self.conn.lock().expect("store mutex");
        Ok(conn
            .query_row(
                &format!(
                    "{} WHERE workflow_id = ?1 ORDER BY generation DESC LIMIT 1",
                    WorkflowReport::SELECT
                ),
                params![workflow_id],
                WorkflowReport::from_row,
            )
            .optional()?)
    }

    pub fn get_report(&self, report_id: &str) -> Result<Option<WorkflowReport>> {
        let conn = self.conn.lock().expect("store mutex");
        Ok(conn
            .query_row(
                &format!("{} WHERE id = ?1", WorkflowReport::SELECT),
                params![report_id],
                WorkflowReport::from_row,
            )
            .optional()?)
    }

    /// Relatórios `pending` do projeto → (report_id, prompt, opções) e marca `running`.
    /// O run não tem ferramentas: o Haiku responde só com o resumo em markdown.
    pub fn plan_report_summaries(
        &self,
        project_id: &str,
    ) -> Result<Vec<(String, String, RunOptions)>> {
        let pending: Vec<WorkflowReport> = {
            let conn = self.conn.lock().expect("store mutex");
            let mut stmt = conn.prepare(&format!(
                "{} WHERE project_id = ?1 AND summary_status = 'pending' ORDER BY created_at",
                WorkflowReport::SELECT
            ))?;
            let rows = stmt
                .query_map(params![project_id], WorkflowReport::from_row)?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            rows
        };
        let mut plans = Vec::new();
        for report in pending {
            let prompt = format!(
                "Você é o assistente do gestor. Abaixo está o relatório consolidado de um workflow do board (entregas de cada task, custo, membros). Escreva um RESUMO EXECUTIVO em português, em markdown, com no máximo 8 linhas: o que foi entregue, o que ficou pendente ou arriscado e o próximo passo recomendado. Responda só com o resumo, sem título, sem repetir a lista de tasks.\n\n{}",
                first_chars(&report.body_md, 12_000)
            );
            let options = RunOptions {
                model: Some(CONSOLIDATION_MODEL.into()),
                permission_mode: Some(PermissionMode::DontAsk),
                max_turns: Some(2),
                max_budget_usd: Some(0.10),
                allowed_tools: Some(vec![]),
                disallowed_tools: Some(
                    [
                        "Bash",
                        "Edit",
                        "Write",
                        "MultiEdit",
                        "NotebookEdit",
                        "Read",
                        "Glob",
                        "Grep",
                        "WebFetch",
                        "WebSearch",
                        "Agent",
                    ]
                    .iter()
                    .map(|t| t.to_string())
                    .collect(),
                ),
                policy_hooks: Some(false),
                memory: Some(crate::protocol::MemoryOptions {
                    capture: false,
                    brief: None,
                    brief_items: None,
                    tools: None,
                }),
                ..Default::default()
            };
            let conn = self.conn.lock().expect("store mutex");
            conn.execute(
                "UPDATE workflow_report SET summary_status = 'running' WHERE id = ?1",
                params![report.id],
            )?;
            plans.push((report.id, prompt, options));
        }
        Ok(plans)
    }

    /// Cria o run `kind = report` e amarra ao relatório.
    pub fn create_report_run(
        &self,
        project_id: &str,
        report_id: &str,
        prompt: &str,
        options: &RunOptions,
    ) -> Result<Run> {
        let mut run = self.create_run_full(project_id, prompt, options, None, None)?;
        {
            let conn = self.conn.lock().expect("store mutex");
            conn.execute(
                "UPDATE run SET kind = 'report' WHERE id = ?1",
                params![run.id],
            )?;
            conn.execute(
                "UPDATE workflow_report SET summary_run_id = ?2 WHERE id = ?1",
                params![report_id, run.id],
            )?;
        }
        run.kind = "report".into();
        Ok(run)
    }

    /// Fim do run de resumo: grava `summary_md` (sanitizado) ou marca `failed`. Devolve o projeto.
    pub(crate) fn finish_report_run_in(
        tx: &Transaction<'_>,
        run_id: &str,
        success: bool,
        text: Option<&str>,
    ) -> Result<Option<String>> {
        let report: Option<(String, String)> = tx
            .query_row(
                "SELECT id, project_id FROM workflow_report WHERE summary_run_id = ?1",
                params![run_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let Some((report_id, project_id)) = report else {
            return Ok(None);
        };
        let text = text.map(str::trim).filter(|s| !s.is_empty());
        match (success, text) {
            (true, Some(t)) => {
                let (clean, _) = sanitize(t);
                tx.execute(
                    "UPDATE workflow_report SET summary_md = ?2, summary_status = 'done' WHERE id = ?1",
                    params![report_id, clean],
                )?;
            }
            _ => {
                tx.execute(
                    "UPDATE workflow_report SET summary_status = 'failed' WHERE id = ?1",
                    params![report_id],
                )?;
            }
        }
        Ok(Some(project_id))
    }
}

fn short_id(id: &str) -> String {
    let s = id.strip_prefix("task_").unwrap_or(id);
    format!("T-{}", &s[..s.len().min(8)])
}

fn human_time(iso: &str) -> String {
    iso.get(..16).unwrap_or(iso).replace('T', " ")
}

fn human_duration(start: &str, end: &str) -> String {
    let parse = |s: &str| chrono::DateTime::parse_from_rfc3339(s).ok();
    match (parse(start), parse(end)) {
        (Some(a), Some(b)) => {
            let mins = (b - a).num_minutes().max(0);
            if mins < 60 {
                format!("{mins} min")
            } else {
                format!("{} h {} min", mins / 60, mins % 60)
            }
        }
        _ => "—".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{RunEvent, TaskStatusUpdate, Usage};
    use crate::store::orchestration::{TaskInput, TaskStatus};
    use crate::store::team::TeamMemberInput;

    fn result_event(ok: bool, text: Option<&str>) -> RunEvent {
        RunEvent::Result {
            session_id: "s".into(),
            subtype: if ok { "success".into() } else { "error".into() },
            is_error: !ok,
            cost_usd: Some(0.1),
            duration_ms: None,
            num_turns: Some(1),
            usage: Some(Usage::default()),
            stop_reason: None,
            result_text: text.map(str::to_string),
        }
    }

    /// Roda a task até `done` como o membro: claim → task_update(done, result) → result.
    fn complete(s: &Store, project: &str, task_id: &str, agent: &str, result: &str) {
        let run = s
            .create_run_full(
                project,
                "x",
                &RunOptions::default(),
                Some(agent),
                Some(task_id),
            )
            .unwrap();
        assert!(s.claim_task(task_id, &run.id, None, None).unwrap());
        s.record_run_event(
            &run.id,
            0,
            "t",
            &RunEvent::TaskUpdate {
                task_id: task_id.into(),
                status: TaskStatusUpdate::Done,
                note: Some("feito".into()),
                result: Some(result.into()),
            },
        )
        .unwrap();
        s.record_run_event(&run.id, 1, "t", &result_event(true, Some("ok")))
            .unwrap();
    }

    #[test]
    fn report_is_generated_once_when_the_last_task_completes_and_on_demand() {
        let s = Store::open_in_memory().unwrap();
        let project = s.create_project("p", "/tmp/p").unwrap().id;
        let dani = s
            .add_team_member(
                &project,
                &TeamMemberInput {
                    name: "Dani".into(),
                    role_id: "role_pesquisador".into(),
                    ..Default::default()
                },
            )
            .unwrap()
            .profile
            .id;
        let wf = s
            .create_workflow_from_template(&project, "research-synthesis", false)
            .unwrap();
        // Duas tasks: cada uma percorre os dois estágios (sem gate humano neste template).
        let t1 = s
            .create_task(
                &project,
                &wf.id,
                &TaskInput {
                    title: "Inventário".into(),
                    assigned_agent_id: Some(dani.clone()),
                    ..Default::default()
                },
            )
            .unwrap();
        let t2 = s
            .create_task(
                &project,
                &wf.id,
                &TaskInput {
                    title: "Síntese".into(),
                    assigned_agent_id: Some(dani.clone()),
                    ..Default::default()
                },
            )
            .unwrap();
        complete(
            &s,
            &project,
            &t1.id,
            &dani,
            "## Entrega\n- 11 integrações listadas",
        );
        complete(&s, &project, &t1.id, &dani, "## Entrega\n- documento final");
        assert_eq!(
            s.get_task(&t1.id).unwrap().unwrap().status,
            TaskStatus::Done
        );
        assert!(
            s.list_workflow_reports(&project).unwrap().is_empty(),
            "ainda falta a t2"
        );
        complete(&s, &project, &t2.id, &dani, "## Entrega\n- síntese escrita");
        complete(&s, &project, &t2.id, &dani, "## Entrega\n- revisada");
        let reports = s.list_workflow_reports(&project).unwrap();
        assert_eq!(reports.len(), 1);
        let r = &reports[0];
        assert_eq!(r.trigger, "auto");
        assert_eq!(r.generation, 1);
        assert_eq!((r.tasks_done, r.tasks_total), (2, 2));
        assert!(
            (r.cost_usd - 0.4).abs() < 1e-6,
            "4 runs × 0,10: {}",
            r.cost_usd
        );
        assert_eq!(r.members.len(), 1);
        assert_eq!(r.members[0].name, "Dani");
        assert_eq!(r.members[0].runs, 4);
        assert!(r
            .body_md
            .contains("# Relatório — Pesquisa paralela → Síntese"));
        assert!(r.body_md.contains("Tasks: 2 de 2 concluídas"));
        assert!(r.body_md.contains("- revisada") && r.body_md.contains("- documento final"));
        assert!(!r.body_md.contains("## Pendentes"));
        assert_eq!(r.summary_status, "none", "sem Haiku por padrão");
        assert_eq!(s.get_workflow_report(&wf.id).unwrap().unwrap().id, r.id);
        assert_eq!(r.markdown(), r.body_md);

        // Mover uma task concluída de novo não gera outra geração automática.
        s.move_task(&t2.id, None, TaskStatus::Done, Some("confirmando"))
            .unwrap();
        assert_eq!(s.list_workflow_reports(&project).unwrap().len(), 1);
        assert_eq!(
            s.get_workflow_report(&wf.id).unwrap().unwrap().generation,
            1
        );

        // Sob demanda, com uma task nova pendente: geração 2 manual lista a pendente.
        s.create_task(
            &project,
            &wf.id,
            &TaskInput {
                title: "Extra".into(),
                ..Default::default()
            },
        )
        .unwrap();
        let manual = s.generate_workflow_report(&wf.id).unwrap();
        assert_eq!(manual.generation, 2);
        assert_eq!(manual.trigger, "manual");
        assert_eq!((manual.tasks_done, manual.tasks_total), (2, 3));
        assert!(manual.body_md.contains("## Pendentes") && manual.body_md.contains("Extra"));
        assert_eq!(s.list_workflow_reports(&project).unwrap()[0].generation, 2);
        assert!(!s
            .list_audit_events(Some(&project), Some("board.report.generated"), 5)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn human_gate_approval_generates_the_report() {
        let s = Store::open_in_memory().unwrap();
        let project = s.create_project("p", "/tmp/p").unwrap().id;
        let wf = s
            .create_workflow_from_template(&project, "plan-implement-review-approve", false)
            .unwrap();
        let t = s
            .create_task(
                &project,
                &wf.id,
                &TaskInput {
                    title: "Só uma".into(),
                    ..Default::default()
                },
            )
            .unwrap();
        s.move_task(&t.id, Some("stage_4"), TaskStatus::Ready, None)
            .unwrap();
        assert_eq!(s.park_gate_tasks(&project).unwrap(), 1);
        assert!(s.list_workflow_reports(&project).unwrap().is_empty());
        s.approve_task(&t.id, Some("ok")).unwrap();
        let reports = s.list_workflow_reports(&project).unwrap();
        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0].tasks_done, 1);
        assert!(reports[0].body_md.contains("_Sem resumo da entrega._"));
        assert!(reports[0].body_md.contains("run avulso"));
    }

    #[test]
    fn haiku_summary_follows_the_setting_and_lands_in_summary_md() {
        let s = Store::open_in_memory().unwrap();
        let project = s.create_project("p", "/tmp/p").unwrap().id;
        let wf = s
            .create_workflow_from_template(&project, "research-synthesis", false)
            .unwrap();
        // Desligado: nada a planejar.
        assert!(!s.report_summary_enabled().unwrap());
        s.generate_workflow_report(&wf.id).unwrap();
        assert!(s.plan_report_summaries(&project).unwrap().is_empty());
        // Herda da consolidação com Haiku.
        s.set_setting(CONSOLIDATION_SETTING, &serde_json::json!("haiku"))
            .unwrap();
        assert!(s.report_summary_enabled().unwrap());
        let report = s.generate_workflow_report(&wf.id).unwrap();
        assert_eq!(report.summary_status, "pending");
        let plans = s.plan_report_summaries(&project).unwrap();
        assert_eq!(plans.len(), 1);
        let (report_id, prompt, options) = &plans[0];
        assert_eq!(report_id, &report.id);
        assert!(prompt.contains("RESUMO EXECUTIVO") && prompt.contains("Relatório —"));
        assert_eq!(options.model.as_deref(), Some(CONSOLIDATION_MODEL));
        assert_eq!(options.allowed_tools, Some(vec![]));
        assert_eq!(options.max_turns, Some(2));
        assert_eq!(
            s.get_report(report_id).unwrap().unwrap().summary_status,
            "running"
        );
        assert!(
            s.plan_report_summaries(&project).unwrap().is_empty(),
            "já em andamento"
        );
        // Run de resumo termina: texto vira summary_md e o markdown completo o inclui.
        let run = s
            .create_report_run(&project, report_id, prompt, options)
            .unwrap();
        assert_eq!(run.kind, "report");
        s.record_run_event(
            &run.id,
            0,
            "t",
            &result_event(
                true,
                Some("Entregas no prazo. Próximo passo: automatizar o deploy."),
            ),
        )
        .unwrap();
        let done = s.get_report(report_id).unwrap().unwrap();
        assert_eq!(done.summary_status, "done");
        assert!(done
            .summary_md
            .as_deref()
            .unwrap()
            .contains("automatizar o deploy"));
        assert!(done.markdown().contains("## Resumo executivo"));
        // `board.reportSummary = off` vence a herança; run falho marca `failed`.
        s.set_setting(REPORT_SUMMARY_SETTING, &serde_json::json!("off"))
            .unwrap();
        assert!(!s.report_summary_enabled().unwrap());
        s.set_setting(REPORT_SUMMARY_SETTING, &serde_json::json!("haiku"))
            .unwrap();
        let r2 = s.generate_workflow_report(&wf.id).unwrap();
        let (id2, p2, o2) = s.plan_report_summaries(&project).unwrap().remove(0);
        assert_eq!(id2, r2.id);
        let run2 = s.create_report_run(&project, &id2, &p2, &o2).unwrap();
        s.record_run_event(&run2.id, 0, "t", &result_event(false, None))
            .unwrap();
        assert_eq!(
            s.get_report(&id2).unwrap().unwrap().summary_status,
            "failed"
        );
    }
}
