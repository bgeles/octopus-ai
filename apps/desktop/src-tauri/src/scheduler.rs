//! Scheduler: a cada tick, pega tasks `ready` com dependências concluídas, respeita o paralelismo
//! do workflow, cria o worktree (se o workflow pedir), monta o run como o membro responsável e o inicia.
//! As transições no fim do run ficam no store (`finish_task_run`), disparadas pelos eventos do sidecar.

use std::path::Path;

use anyhow::Result;
use serde::{Deserialize, Serialize};
use tracing::{info, warn};

use crate::protocol::{RunOptions, RunStartParams};
use crate::sidecar::Sidecar;
use crate::store::models::RunStatus;
use crate::store::Store;

pub const PAUSED_SETTING: &str = "scheduler.paused";
const DEFAULT_MAX_TURNS: u32 = 40;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TickReport {
    /// Tasks cujo run começou neste tick.
    pub started: Vec<StartedTask>,
    /// Tasks que falharam ao iniciar (motivo).
    pub failed: Vec<(String, String)>,
    /// Tasks em estágio gate movidas para `waiting_approval`.
    pub parked: usize,
    pub paused: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartedTask {
    pub task_id: String,
    pub run_id: String,
    pub project_id: String,
}

impl TickReport {
    pub fn changed(&self) -> bool {
        !self.started.is_empty() || !self.failed.is_empty() || self.parked > 0
    }
}

pub fn is_paused(store: &Store) -> bool {
    matches!(
        store.get_setting(PAUSED_SETTING),
        Ok(Some(serde_json::Value::Bool(true)))
    )
}

pub async fn tick(store: &Store, sidecar: &Sidecar) -> Result<TickReport> {
    let mut report = TickReport::default();
    if is_paused(store) {
        report.paused = true;
        return Ok(report);
    }
    for project in store.list_projects()? {
        report.parked += store.park_gate_tasks(&project.id)?;
        for (task, workflow, stage) in store.runnable_tasks(&project.id)? {
            let agent_id = stage
                .agent_profile_id
                .clone()
                .or_else(|| task.assigned_agent_id.clone());
            let cwd = if workflow.use_worktrees {
                match Store::ensure_worktree(Path::new(&project.path), &task.id) {
                    Ok(path) => path.to_string_lossy().into_owned(),
                    Err(e) => {
                        let msg = format!("worktree: {e}");
                        store.fail_task(&task.id, &msg)?;
                        report.failed.push((task.id.clone(), msg));
                        continue;
                    }
                }
            } else {
                project.path.clone()
            };
            let base = RunOptions {
                max_turns: Some(DEFAULT_MAX_TURNS),
                include_partial_messages: Some(true),
                task_context: Some(Store::task_context(&task, &stage)),
                ..Default::default()
            };
            let options = match agent_id.as_deref() {
                Some(agent) => match store.agent_run_options(agent, &base) {
                    Ok(o) => o,
                    Err(e) => {
                        warn!(
                            "task {}: membro {agent} inválido ({e}); rodando sem membro",
                            task.id
                        );
                        base
                    }
                },
                None => base,
            };
            let prompt = Store::task_prompt(&task, &stage, &workflow);
            let run = store.create_run_full(
                &project.id,
                &prompt,
                &options,
                agent_id.as_deref(),
                Some(&task.id),
            )?;
            let worktree = if workflow.use_worktrees {
                Some(cwd.as_str())
            } else {
                None
            };
            if !store.claim_task(&task.id, &run.id, worktree)? {
                // Alguém mudou a task entre a seleção e o claim.
                store.mark_run_failed(&run.id, "task deixou de estar pronta")?;
                continue;
            }
            let params = RunStartParams {
                run_id: run.id.clone(),
                cwd,
                prompt,
                options,
            };
            match sidecar.start_run(params).await {
                Ok(_) => {
                    store.set_run_status(&run.id, RunStatus::Running)?;
                    info!(task = %task.id, run = %run.id, "scheduler iniciou run da task");
                    report.started.push(StartedTask {
                        task_id: task.id.clone(),
                        run_id: run.id.clone(),
                        project_id: project.id.clone(),
                    });
                }
                Err(e) => {
                    let msg = format!("Falha ao iniciar o agente: {e}");
                    store.mark_run_failed(&run.id, &msg)?;
                    store.fail_task(&task.id, &msg)?;
                    report.failed.push((task.id.clone(), msg));
                }
            }
        }
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sidecar::SidecarCommand;
    use crate::store::orchestration::{TaskInput, TaskStatus};
    use crate::store::team::TeamMemberInput;
    use std::path::PathBuf;

    fn fake_sidecar_command() -> Option<SidecarCommand> {
        let script =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake_sidecar.mjs");
        std::process::Command::new("node")
            .arg("--version")
            .output()
            .ok()
            .filter(|o| o.status.success())?;
        Some(SidecarCommand::new(
            "node",
            vec![script.to_string_lossy().into_owned()],
        ))
    }

    #[tokio::test]
    async fn tick_starts_runnable_tasks_as_the_stage_member_and_claims_them() {
        let Some(command) = fake_sidecar_command() else {
            eprintln!("node não encontrado; pulando teste do scheduler");
            return;
        };
        let (sidecar, _notifications) = Sidecar::spawn(command).await.unwrap();
        let store = Store::open_in_memory().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let project = store
            .create_project("p", dir.path().to_str().unwrap())
            .unwrap();
        store
            .add_team_member(
                &project.id,
                &TeamMemberInput {
                    name: "Pedro".into(),
                    role_id: "role_planejador".into(),
                    ..Default::default()
                },
            )
            .unwrap();
        let wf = store
            .create_workflow_from_template(&project.id, "plan-implement-review-approve", false)
            .unwrap();
        let t1 = store
            .create_task(
                &project.id,
                &wf.id,
                &TaskInput {
                    title: "Primeira".into(),
                    ..Default::default()
                },
            )
            .unwrap();
        let t2 = store
            .create_task(
                &project.id,
                &wf.id,
                &TaskInput {
                    title: "Segunda".into(),
                    depends_on: vec![t1.id.clone()],
                    ..Default::default()
                },
            )
            .unwrap();

        let report = tick(&store, &sidecar).await.unwrap();
        assert_eq!(report.started.len(), 1);
        assert_eq!(report.started[0].task_id, t1.id);
        assert!(report.failed.is_empty());
        let t1_now = store.get_task(&t1.id).unwrap().unwrap();
        assert_eq!(t1_now.status, TaskStatus::Running);
        let run = store.get_run(&report.started[0].run_id).unwrap().unwrap();
        assert_eq!(run.status, RunStatus::Running);
        assert_eq!(run.task_id.as_deref(), Some(t1.id.as_str()));
        assert!(
            run.agent_profile_id.is_some(),
            "estágio Planejar tem o Pedro"
        );
        assert!(run
            .options
            .system_prompt_append
            .as_deref()
            .unwrap()
            .contains("Você é Pedro"));
        assert_eq!(run.options.task_context.as_ref().unwrap().stage, "Planejar");
        assert!(run.prompt.contains("# Primeira"));

        // Segundo tick: nada (slot ocupado, t2 depende de t1).
        let again = tick(&store, &sidecar).await.unwrap();
        assert!(again.started.is_empty());
        assert_eq!(
            store.get_task(&t2.id).unwrap().unwrap().status,
            TaskStatus::Ready
        );

        // Pausado: nada acontece.
        store
            .set_setting(PAUSED_SETTING, &serde_json::json!(true))
            .unwrap();
        assert!(tick(&store, &sidecar).await.unwrap().paused);
        sidecar.shutdown().await;
    }

    #[tokio::test]
    async fn tick_fails_task_when_worktree_is_impossible() {
        let Some(command) = fake_sidecar_command() else {
            return;
        };
        let (sidecar, _n) = Sidecar::spawn(command).await.unwrap();
        let store = Store::open_in_memory().unwrap();
        let dir = tempfile::tempdir().unwrap(); // não é repositório git
        let project = store
            .create_project("p", dir.path().to_str().unwrap())
            .unwrap();
        let wf = store
            .create_workflow_from_template(&project.id, "research-synthesis", true)
            .unwrap();
        let t = store
            .create_task(
                &project.id,
                &wf.id,
                &TaskInput {
                    title: "X".into(),
                    ..Default::default()
                },
            )
            .unwrap();
        let report = tick(&store, &sidecar).await.unwrap();
        assert_eq!(report.failed.len(), 1);
        assert!(report.failed[0].1.contains("worktree"));
        let t_now = store.get_task(&t.id).unwrap().unwrap();
        assert_eq!(t_now.status, TaskStatus::Failed);
        sidecar.shutdown().await;
    }
}
