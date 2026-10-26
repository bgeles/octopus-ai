//! Scheduler: a cada tick, pega tasks `ready` com dependências concluídas, respeita o paralelismo
//! do workflow, cria o worktree (se o workflow pedir), monta o run como o membro responsável e o inicia.
//! As transições no fim do run ficam no store (`finish_task_run`), disparadas pelos eventos do sidecar.

use std::path::Path;

use anyhow::Result;
use serde::{Deserialize, Serialize};
use tracing::{info, warn};

use crate::protocol::{RunOptions, RunStartParams};
use crate::secrets::SecretStore;
use crate::sidecar::Sidecar;
use crate::store::models::RunStatus;
use crate::store::Store;

pub const PAUSED_SETTING: &str = "scheduler.paused";
const DEFAULT_MAX_TURNS: u32 = 40;
/// Ferramentas liberadas num run de revisão: ler e inspecionar o git; nada que mude o trabalho.
const REVIEW_ALLOWED_TOOLS: &[&str] = &[
    "Read",
    "Glob",
    "Grep",
    "Bash(git status:*)",
    "Bash(git diff:*)",
    "Bash(git log:*)",
    "Bash(git show:*)",
    "Bash(ls:*)",
    "Bash(cat:*)",
    "Bash(wc:*)",
    "Bash(head:*)",
    "Bash(tail:*)",
];

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
    /// `task` (trabalho) ou `review` (revisão por um membro).
    #[serde(default = "default_started_kind")]
    pub kind: String,
}

fn default_started_kind() -> String {
    "task".into()
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

/// Opções de um tick: só um membro e/ou forçado ("Rodar agora" ignora a pausa global e a do membro).
#[derive(Debug, Clone, Default)]
pub struct TickOptions {
    pub only_agent: Option<String>,
    pub force: bool,
}

pub async fn tick(
    store: &Store,
    sidecar: &Sidecar,
    secrets: &dyn SecretStore,
) -> Result<TickReport> {
    tick_with(store, sidecar, secrets, &TickOptions::default()).await
}

pub async fn tick_with(
    store: &Store,
    sidecar: &Sidecar,
    secrets: &dyn SecretStore,
    opts: &TickOptions,
) -> Result<TickReport> {
    let mut report = TickReport::default();
    if is_paused(store) && !opts.force {
        report.paused = true;
        return Ok(report);
    }
    let filter = crate::store::orchestration::TaskFilter {
        only_agent: opts.only_agent.clone(),
        ignore_pause: opts.force,
    };
    for project in store.list_projects()? {
        if opts.only_agent.is_none() {
            report.parked += store.park_gate_tasks(&project.id)?;
        }
        for (task, workflow, stage) in store.runnable_tasks_with(&project.id, &filter)? {
            // Quem foi atribuído à task (por você ou por um gestor delegando) vence o padrão do estágio.
            let agent_id = task
                .assigned_agent_id
                .clone()
                .or_else(|| stage.agent_profile_id.clone());
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
            let defaults = store.project_defaults(&project.id)?;
            let base = RunOptions {
                max_turns: Some(defaults.max_turns.unwrap_or(DEFAULT_MAX_TURNS)),
                model: defaults.model.clone(),
                include_partial_messages: Some(true),
                task_context: Some(Store::task_context(&task, &stage)),
                policy_hooks: Some(true),
                memory: Some(Default::default()),
                ..Default::default()
            };
            let Some(options) = member_options(
                store,
                &mut report,
                &project,
                &task,
                agent_id.as_deref(),
                base,
            )?
            else {
                continue;
            };
            let prompt =
                Store::task_prompt(&task, &stage, &workflow, &store.prompt_context(&task)?);
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
            let base_commit = crate::store::task_diff::git_head(Path::new(&cwd));
            if !store.claim_task(&task.id, &run.id, worktree, base_commit.as_deref())? {
                // Alguém mudou a task entre a seleção e o claim.
                store.mark_run_failed(&run.id, "task deixou de estar pronta")?;
                continue;
            }
            let mut options = options;
            {
                let brief = store.memory_brief(&project.id, Some(&task.id), &prompt, &run.id)?;
                let memory = options.memory.get_or_insert_with(Default::default);
                memory.tools = Some(true);
                if let Some(b) = brief {
                    memory.brief = Some(b.text);
                    memory.brief_items = Some(b.items);
                }
            }
            launch(
                store,
                sidecar,
                secrets,
                &mut report,
                &project,
                &task,
                agent_id.as_deref(),
                run.id.clone(),
                cwd,
                prompt,
                options,
                "task",
            )
            .await?;
        }

        // Revisões por agentes: a task está em `review` esperando o aprovador do organograma.
        let limits = store.review_limits();
        for (task, workflow, stage) in store.reviewable_tasks_with(&project.id, &filter)? {
            let Some(reviewer) = task.approver_agent_id.clone() else {
                continue;
            };
            let worker_name = task
                .assigned_agent_id
                .as_deref()
                .or(stage.agent_profile_id.as_deref())
                .and_then(|id| store.get_team_member_by_agent(id).ok().flatten())
                .map(|m| m.profile.name);
            let cwd = task
                .worktree_path
                .clone()
                .unwrap_or_else(|| project.path.clone());
            let defaults = store.project_defaults(&project.id)?;
            let base = RunOptions {
                max_turns: Some(limits.review_max_turns),
                model: defaults.model.clone(),
                include_partial_messages: Some(true),
                task_context: Some(Store::review_context(&task, &stage)),
                policy_hooks: Some(true),
                memory: Some(Default::default()),
                // Revisar é ler e decidir: nada de editar o trabalho do outro.
                disallowed_tools: Some(
                    ["Edit", "Write", "MultiEdit", "NotebookEdit"]
                        .iter()
                        .map(|t| t.to_string())
                        .collect(),
                ),
                ..Default::default()
            };
            let Some(options) =
                member_options(store, &mut report, &project, &task, Some(&reviewer), base)?
            else {
                continue;
            };
            // Revisor em modo padrão (não `plan`: nele o agente se recusa a chamar task_update) e com
            // uma allowlist só de leitura; outros comandos pedem aprovação pela política, como sempre.
            let mut options = options;
            options.permission_mode = Some(crate::protocol::PermissionMode::Default);
            options.allowed_tools =
                Some(REVIEW_ALLOWED_TOOLS.iter().map(|t| t.to_string()).collect());
            let prompt = Store::review_prompt(
                &task,
                &stage,
                &workflow,
                worker_name.as_deref(),
                &store.prompt_context(&task)?,
            );
            let run =
                store.create_review_run(&project.id, &prompt, &options, &reviewer, &task.id)?;
            if !store.claim_review(&task.id, &run.id)? {
                store.mark_run_failed(&run.id, "task deixou de estar em revisão")?;
                continue;
            }
            options.memory.get_or_insert_with(Default::default).tools = Some(true);
            launch(
                store,
                sidecar,
                secrets,
                &mut report,
                &project,
                &task,
                Some(&reviewer),
                run.id.clone(),
                cwd,
                prompt,
                options,
                "review",
            )
            .await?;
        }
    }
    Ok(report)
}

/// Opções do run como o membro (`agent_run_options`), sandbox e orçamento. `None` quando o
/// orçamento barra o run (a task fica bloqueada com o motivo).
fn member_options(
    store: &Store,
    report: &mut TickReport,
    project: &crate::store::models::Project,
    task: &crate::store::orchestration::Task,
    agent_id: Option<&str>,
    base: RunOptions,
) -> Result<Option<RunOptions>> {
    let mut options = match agent_id {
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
    options.sandbox = store.sandbox_for_project(project)?;
    match store.apply_budget(&project.id, agent_id, options) {
        Ok(o) => Ok(Some(o)),
        Err(e) => {
            let msg = format!("Orçamento: {e}");
            store.move_task(
                &task.id,
                None,
                crate::store::orchestration::TaskStatus::Blocked,
                Some(&msg),
            )?;
            report.failed.push((task.id.clone(), msg));
            Ok(None)
        }
    }
}

/// Completa as opções (fontes de settings, MCPs, hooks, plugin, segredos) e inicia o run no sidecar.
#[allow(clippy::too_many_arguments)]
async fn launch(
    store: &Store,
    sidecar: &Sidecar,
    secrets: &dyn SecretStore,
    report: &mut TickReport,
    project: &crate::store::models::Project,
    task: &crate::store::orchestration::Task,
    agent_id: Option<&str>,
    run_id: String,
    cwd: String,
    prompt: String,
    mut options: RunOptions,
    kind: &str,
) -> Result<()> {
    if options.setting_sources.is_none() {
        options.setting_sources = store.project_setting_sources(&project.id)?;
    }
    if options.mcp_servers.is_none() {
        options.mcp_servers = store.mcp_servers_for_run(&project.id, agent_id)?;
    }
    if options.custom_hooks.is_none() {
        options.custom_hooks = store.custom_hooks_for_run(&project.id)?;
    }
    if options.plugins.is_none() {
        options.plugins = store
            .materialize_plugin(&project.id, agent_id, options.setting_sources.as_deref())?
            .map(|p| vec![p]);
    }
    let options = match crate::secrets::options_for_sidecar(project, &options, secrets) {
        Ok(o) => o,
        Err(e) => {
            let msg = format!("{e:#}");
            store.mark_run_failed(&run_id, &msg)?;
            report.failed.push((task.id.clone(), msg));
            return Ok(());
        }
    };
    let params = RunStartParams {
        run_id: run_id.clone(),
        cwd,
        prompt,
        options,
    };
    match sidecar.start_run(params).await {
        Ok(_) => {
            store.set_run_status(&run_id, RunStatus::Running)?;
            info!(task = %task.id, run = %run_id, kind, "scheduler iniciou run");
            report.started.push(StartedTask {
                task_id: task.id.clone(),
                run_id,
                project_id: project.id.clone(),
                kind: kind.to_string(),
            });
        }
        Err(e) => {
            let msg = format!("Falha ao iniciar o agente: {e}");
            store.mark_run_failed(&run_id, &msg)?;
            if kind == "review" {
                // A task volta a esperar outro run de revisão (ou sobe para você após duas falhas).
                store.release_review(&task.id, &msg)?;
            } else {
                store.fail_task(&task.id, &msg)?;
            }
            report.failed.push((task.id.clone(), msg));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secrets::MemorySecrets;
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

        let report = tick(&store, &sidecar, &MemorySecrets::default())
            .await
            .unwrap();
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
        assert_eq!(run.options.policy_hooks, Some(true));
        let sandbox = run
            .options
            .sandbox
            .as_ref()
            .expect("perfil Dev padrão aplicado");
        assert_eq!(
            sandbox
                .filesystem
                .as_ref()
                .unwrap()
                .allow_write
                .as_ref()
                .unwrap()[0],
            project.path
        );

        // Segundo tick: nada (slot ocupado, t2 depende de t1).
        let again = tick(&store, &sidecar, &MemorySecrets::default())
            .await
            .unwrap();
        assert!(again.started.is_empty());
        assert_eq!(
            store.get_task(&t2.id).unwrap().unwrap().status,
            TaskStatus::Ready
        );

        // Pausado: nada acontece.
        store
            .set_setting(PAUSED_SETTING, &serde_json::json!(true))
            .unwrap();
        assert!(
            tick(&store, &sidecar, &MemorySecrets::default())
                .await
                .unwrap()
                .paused
        );
        sidecar.shutdown().await;
    }

    #[tokio::test]
    async fn tick_blocks_task_when_budget_is_exhausted() {
        use crate::store::security::{BudgetInput, BudgetScope};
        let Some(command) = fake_sidecar_command() else {
            return;
        };
        let (sidecar, _n) = Sidecar::spawn(command).await.unwrap();
        let store = Store::open_in_memory().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let project = store
            .create_project("p", dir.path().to_str().unwrap())
            .unwrap();
        store
            .set_budget_policy(
                BudgetScope::Project,
                &project.id,
                &BudgetInput {
                    hard_usd: Some(0.5),
                    ..Default::default()
                },
            )
            .unwrap();
        // Gasta o orçamento do mês com um run já concluído.
        let spent = store
            .create_run(&project.id, "antes", &RunOptions::default())
            .unwrap();
        store
            .record_run_event(
                &spent.id,
                0,
                "t",
                &crate::protocol::RunEvent::Result {
                    session_id: "s".into(),
                    subtype: "success".into(),
                    is_error: false,
                    cost_usd: Some(0.9),
                    duration_ms: None,
                    num_turns: Some(1),
                    usage: None,
                    stop_reason: None,
                    result_text: None,
                },
            )
            .unwrap();
        let wf = store
            .create_workflow_from_template(&project.id, "research-synthesis", false)
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
        let report = tick(&store, &sidecar, &MemorySecrets::default())
            .await
            .unwrap();
        assert!(report.started.is_empty());
        assert_eq!(report.failed.len(), 1);
        let t_now = store.get_task(&t.id).unwrap().unwrap();
        assert_eq!(t_now.status, TaskStatus::Blocked);
        assert!(t_now
            .last_note
            .as_deref()
            .unwrap()
            .contains("Orçamento mensal esgotado"));
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
        let report = tick(&store, &sidecar, &MemorySecrets::default())
            .await
            .unwrap();
        assert_eq!(report.failed.len(), 1);
        assert!(report.failed[0].1.contains("worktree"));
        let t_now = store.get_task(&t.id).unwrap().unwrap();
        assert_eq!(t_now.status, TaskStatus::Failed);
        sidecar.shutdown().await;
    }

    #[tokio::test]
    async fn tick_skips_paused_member_and_run_now_starts_only_his_task() {
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
        let pedro = store
            .add_team_member(
                &project.id,
                &TeamMemberInput {
                    name: "Pedro".into(),
                    role_id: "role_planejador".into(),
                    ..Default::default()
                },
            )
            .unwrap()
            .profile
            .id;
        let ana = store
            .add_team_member(
                &project.id,
                &TeamMemberInput {
                    name: "Ana".into(),
                    role_id: "role_implementador".into(),
                    ..Default::default()
                },
            )
            .unwrap()
            .profile
            .id;
        let wf = store
            .create_workflow_from_template(&project.id, "research-synthesis", false)
            .unwrap();
        // Dois slots: a task do Pedro (forçada) não pode bloquear a da Ana no tick seguinte.
        let wf = store
            .update_workflow(
                &wf.id,
                &crate::store::orchestration::WorkflowInput {
                    name: wf.name.clone(),
                    stages: wf.stages.clone(),
                    use_worktrees: false,
                    max_parallel: 2,
                    goal_id: None,
                },
            )
            .unwrap();
        let t_pedro = store
            .create_task(
                &project.id,
                &wf.id,
                &TaskInput {
                    title: "Do Pedro".into(),
                    assigned_agent_id: Some(pedro.clone()),
                    ..Default::default()
                },
            )
            .unwrap();
        let t_ana = store
            .create_task(
                &project.id,
                &wf.id,
                &TaskInput {
                    title: "Da Ana".into(),
                    assigned_agent_id: Some(ana.clone()),
                    ..Default::default()
                },
            )
            .unwrap();
        store.set_member_paused(&pedro, true).unwrap();
        store
            .set_setting(PAUSED_SETTING, &serde_json::json!(true))
            .unwrap();

        // Scheduler global pausado: nada roda; "Rodar agora" do Pedro força só a task dele.
        let report = tick(&store, &sidecar, &MemorySecrets::default())
            .await
            .unwrap();
        assert!(report.paused && report.started.is_empty());
        let report = tick_with(
            &store,
            &sidecar,
            &MemorySecrets::default(),
            &TickOptions {
                only_agent: Some(pedro.clone()),
                force: true,
            },
        )
        .await
        .unwrap();
        assert_eq!(report.started.len(), 1, "{report:?}");
        assert_eq!(report.started[0].task_id, t_pedro.id);
        let run = store.get_run(&report.started[0].run_id).unwrap().unwrap();
        assert_eq!(run.agent_profile_id.as_deref(), Some(pedro.as_str()));
        assert_eq!(
            store.get_task(&t_ana.id).unwrap().unwrap().status,
            TaskStatus::Ready
        );

        // Scheduler retomado: Ana roda; Pedro continua pausado para trabalho novo.
        store
            .set_setting(PAUSED_SETTING, &serde_json::json!(false))
            .unwrap();
        let t_pedro2 = store
            .create_task(
                &project.id,
                &wf.id,
                &TaskInput {
                    title: "Outra do Pedro".into(),
                    assigned_agent_id: Some(pedro.clone()),
                    ..Default::default()
                },
            )
            .unwrap();
        let report = tick(&store, &sidecar, &MemorySecrets::default())
            .await
            .unwrap();
        assert_eq!(
            report
                .started
                .iter()
                .map(|s| s.task_id.as_str())
                .collect::<Vec<_>>(),
            vec![t_ana.id.as_str()]
        );
        assert_eq!(
            store.get_task(&t_pedro2.id).unwrap().unwrap().status,
            TaskStatus::Ready
        );
        sidecar.shutdown().await;
    }

    #[tokio::test]
    async fn tick_starts_review_runs_as_the_approver_without_edit_tools() {
        use crate::protocol::{RunEvent, TaskMode, TaskStatusUpdate, Usage};
        use crate::store::team::Autonomy;
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
        let rui = store
            .add_team_member(
                &project.id,
                &TeamMemberInput {
                    name: "Rui".into(),
                    role_id: "role_revisor".into(),
                    autonomy: Some(Autonomy::Managed),
                    can_approve: Some(true),
                    ..Default::default()
                },
            )
            .unwrap()
            .profile
            .id;
        let ana = store
            .add_team_member(
                &project.id,
                &TeamMemberInput {
                    name: "Ana".into(),
                    role_id: "role_implementador".into(),
                    reports_to_agent_id: Some(rui.clone()),
                    autonomy: Some(Autonomy::Managed),
                    ..Default::default()
                },
            )
            .unwrap()
            .profile
            .id;
        let wf = store
            .create_workflow_from_template(&project.id, "research-synthesis", false)
            .unwrap();
        let task = store
            .create_task(
                &project.id,
                &wf.id,
                &TaskInput {
                    title: "Mapear".into(),
                    assigned_agent_id: Some(ana.clone()),
                    ..Default::default()
                },
            )
            .unwrap();

        // 1º tick: Ana trabalha. O run termina pedindo revisão → vai para Rui (não para você).
        let report = tick(&store, &sidecar, &MemorySecrets::default())
            .await
            .unwrap();
        assert_eq!(report.started.len(), 1);
        assert_eq!(report.started[0].kind, "task");
        let work_run = report.started[0].run_id.clone();
        store
            .record_run_event(
                &work_run,
                0,
                "t",
                &RunEvent::TaskUpdate {
                    task_id: task.id.clone(),
                    status: TaskStatusUpdate::Review,
                    note: Some("pronto".into()),
                    result: Some("## Entrega".into()),
                },
            )
            .unwrap();
        store
            .record_run_event(
                &work_run,
                1,
                "t",
                &RunEvent::Result {
                    session_id: "s".into(),
                    subtype: "success".into(),
                    is_error: false,
                    cost_usd: Some(0.1),
                    duration_ms: None,
                    num_turns: Some(1),
                    usage: Some(Usage::default()),
                    stop_reason: None,
                    result_text: None,
                },
            )
            .unwrap();
        let in_review = store.get_task(&task.id).unwrap().unwrap();
        assert_eq!(in_review.status, TaskStatus::Review);
        assert_eq!(in_review.approver_agent_id.as_deref(), Some(rui.as_str()));

        // 2º tick: começa o run de revisão como Rui, no modo revisão, sem ferramentas de edição.
        let report = tick(&store, &sidecar, &MemorySecrets::default())
            .await
            .unwrap();
        assert_eq!(report.started.len(), 1, "{report:?}");
        assert_eq!(report.started[0].kind, "review");
        let review = store.get_run(&report.started[0].run_id).unwrap().unwrap();
        assert_eq!(review.kind, "review");
        assert_eq!(review.status, RunStatus::Running);
        assert_eq!(review.agent_profile_id.as_deref(), Some(rui.as_str()));
        assert_eq!(review.task_id.as_deref(), Some(task.id.as_str()));
        let ctx = review.options.task_context.as_ref().unwrap();
        assert_eq!(ctx.mode, TaskMode::Review);
        assert_eq!(
            ctx.allowed_statuses,
            vec![TaskStatusUpdate::Approved, TaskStatusUpdate::Returned]
        );
        assert_eq!(review.options.max_turns, Some(15));
        let disallowed = review.options.disallowed_tools.as_ref().unwrap();
        assert!(
            disallowed.contains(&"Edit".to_string()) && disallowed.contains(&"Write".to_string())
        );
        // Revisor do cargo "Revisor" (plan) roda em modo padrão com allowlist de leitura.
        assert_eq!(
            review.options.permission_mode,
            Some(crate::protocol::PermissionMode::Default)
        );
        let allowed = review.options.allowed_tools.as_ref().unwrap();
        assert!(allowed.contains(&"Bash(git diff:*)".to_string()));
        assert!(!allowed.iter().any(|t| t == "Write" || t == "Bash"));
        assert!(review.prompt.contains("Revisão da task"));
        assert!(review.prompt.contains("feita por Ana"));
        assert!(review.prompt.contains("## Entrega"));
        assert!(review
            .options
            .system_prompt_append
            .as_deref()
            .unwrap()
            .contains("Você é Rui"));
        let locked = store.get_task(&task.id).unwrap().unwrap();
        assert_eq!(locked.lock_run_id.as_deref(), Some(review.id.as_str()));
        assert_eq!(locked.review_attempts, 1);
        // Com a revisão em andamento, nada mais começa.
        let again = tick(&store, &sidecar, &MemorySecrets::default())
            .await
            .unwrap();
        assert!(again.started.is_empty());
        sidecar.shutdown().await;
    }

    /// Verificação da Fase 2 com o Claude de verdade: o scheduler inicia a task como o membro do time,
    /// o agente recebe a tool MCP `task_update` e a task avança quando ele a chama.
    /// Custa dinheiro: `cargo test real_sidecar -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore = "usa o Claude de verdade (custa dinheiro); rode com --ignored"]
    async fn real_sidecar_runs_a_task_and_the_agent_calls_task_update() {
        use crate::protocol::{PermissionDecideParams, PermissionDecision, RunEvent};
        use crate::sidecar::command::find_node;
        use crate::sidecar::SidecarNotification;

        let main_js = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../packages/agent-runtime/dist/main.js")
            .canonicalize()
            .expect("sidecar compilado");
        let (sidecar, mut notifications) = Sidecar::spawn(SidecarCommand::new(
            find_node(),
            vec![main_js.to_string_lossy().into_owned()],
        ))
        .await
        .unwrap();
        sidecar.hello().await.unwrap();

        let store = Store::open_in_memory().unwrap();
        let dir = tempfile::tempdir().unwrap();
        for args in [
            vec!["init", "-q"],
            vec![
                "-c",
                "user.email=t@t",
                "-c",
                "user.name=t",
                "commit",
                "-q",
                "--allow-empty",
                "-m",
                "init",
            ],
        ] {
            assert!(std::process::Command::new("git")
                .args(&args)
                .current_dir(dir.path())
                .status()
                .unwrap()
                .success());
        }
        let project = store
            .create_project("verificacao", dir.path().to_str().unwrap())
            .unwrap();
        store
            .add_team_member(
                &project.id,
                &TeamMemberInput {
                    name: "Ana".into(),
                    role_id: "role_implementador".into(),
                    max_turns: Some(6),
                    ..Default::default()
                },
            )
            .unwrap();
        let wf = store
            .create_workflow_from_template(&project.id, "research-synthesis", true)
            .unwrap();
        // Pesquisar tem Pesquisador como responsável; sem um no time, cai no membro atribuído à task.
        let ana = store.list_team(&project.id).unwrap()[0].profile.id.clone();
        let task = store
            .create_task(
                &project.id,
                &wf.id,
                &TaskInput {
                    title: "Checagem do orquestrador".into(),
                    description_md: "Não leia nem altere arquivos. A memória do projeto (já no seu contexto, e também pela tool memory_search) contém a palavra secreta do projeto. Chame a tool task_update com status \"done\" e a nota igual a essa palavra, em minúsculas, sem mais nada.".into(),
                    assigned_agent_id: Some(ana),
                    ..Default::default()
                },
            )
            .unwrap();

        store
            .save_page(
                &crate::store::memory::MemoryPageInput {
                    project_id: project.id.clone(),
                    page_id: None,
                    kind: "decisions".into(),
                    title: "Palavra secreta do projeto".into(),
                    body_md: "A palavra secreta deste projeto é melancia.".into(),
                },
                "teste",
                "manual",
            )
            .unwrap();
        let report = tick(&store, &sidecar, &MemorySecrets::default())
            .await
            .unwrap();
        assert_eq!(report.started.len(), 1, "{report:?}");
        let run_id = report.started[0].run_id.clone();
        let claimed = store.get_task(&task.id).unwrap().unwrap();
        assert_eq!(claimed.status, TaskStatus::Running);
        assert!(claimed
            .worktree_path
            .as_deref()
            .unwrap()
            .contains(".octopus/worktrees/"));
        assert!(Path::new(claimed.worktree_path.as_deref().unwrap())
            .join(".git")
            .exists());

        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(240);
        let mut saw_task_update = false;
        loop {
            let n = tokio::time::timeout_at(deadline, notifications.recv())
                .await
                .expect("timeout esperando o run")
                .expect("canal fechado");
            match n {
                SidecarNotification::MemoryCall(call) => {
                    let result = store
                        .handle_memory_call(&call.run_id, call.op, &call.args)
                        .unwrap();
                    eprintln!("memória {:?} → ok={}", call.op, result.ok);
                    sidecar
                        .memory_result(crate::protocol::MemoryResultParams {
                            run_id: call.run_id.clone(),
                            call_id: call.call_id.clone(),
                            result,
                        })
                        .await
                        .unwrap();
                }
                // Como o app: o hook PreToolUse é decidido pelo motor de política em Rust.
                SidecarNotification::Hook(hook) => {
                    let decision = crate::decide_hook(&store, &hook);
                    eprintln!("hook {} → {:?}", hook.tool_name, decision.behavior);
                    sidecar
                        .decide_hook(crate::protocol::HookDecideParams {
                            run_id: hook.run_id.clone(),
                            hook_id: hook.hook_id.clone(),
                            decision,
                        })
                        .await
                        .unwrap();
                }
                SidecarNotification::RunEvent(ev) if ev.run_id == run_id => {
                    eprintln!("[{}] {}", ev.seq, ev.event.kind());
                    if let RunEvent::PermissionRequest {
                        request_id,
                        tool_name,
                        ..
                    } = &ev.event
                    {
                        eprintln!("negando {tool_name} pedido pelo agente");
                        sidecar
                            .decide_permission(PermissionDecideParams {
                                run_id: run_id.clone(),
                                request_id: request_id.clone(),
                                decision: PermissionDecision::Deny {
                                    message: "teste: só task_update".into(),
                                },
                            })
                            .await
                            .unwrap();
                    }
                    if matches!(ev.event, RunEvent::TaskUpdate { .. }) {
                        saw_task_update = true;
                    }
                    let terminal = ev.event.is_terminal();
                    store
                        .record_run_event(&ev.run_id, ev.seq, &ev.at, &ev.event)
                        .unwrap();
                    if terminal {
                        break;
                    }
                }
                SidecarNotification::Exited(code) => panic!("sidecar saiu: {code:?}"),
                _ => {}
            }
        }
        let run = store.get_run(&run_id).unwrap().unwrap();
        eprintln!(
            "run {:?} custo {:?} resultado {:?}",
            run.status, run.cost_usd, run.result_text
        );
        assert_eq!(run.status, RunStatus::Completed, "{:?}", run.error_message);
        assert!(saw_task_update, "o agente não chamou task_update");
        let finished = store.get_task(&task.id).unwrap().unwrap();
        let note = finished
            .last_note
            .clone()
            .unwrap_or_default()
            .to_lowercase();
        assert!(
            note.contains("melancia"),
            "o brief de memória não chegou ao agente: nota = {note:?}"
        );
        assert!(
            store
                .list_context_events(&run_id)
                .unwrap()
                .iter()
                .any(|e| e.kind == "brief"),
            "evento brief_injected não registrado"
        );

        // Consolidação com Haiku: o run de memória só usa memory_write e produz páginas "haiku".
        store
            .set_setting(
                crate::store::memory::CONSOLIDATION_SETTING,
                &serde_json::json!("haiku"),
            )
            .unwrap();
        let (cprompt, coptions) = store
            .plan_consolidation(&run_id)
            .unwrap()
            .expect("há observações para consolidar");
        let crun = store
            .create_consolidation_run(&project.id, &cprompt, &coptions)
            .unwrap();
        sidecar
            .start_run(RunStartParams {
                run_id: crun.id.clone(),
                cwd: project.path.clone(),
                prompt: cprompt,
                options: coptions,
            })
            .await
            .unwrap();
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(180);
        loop {
            let n = tokio::time::timeout_at(deadline, notifications.recv())
                .await
                .expect("timeout na consolidação")
                .expect("canal fechado");
            match n {
                SidecarNotification::MemoryCall(call) => {
                    let result = store
                        .handle_memory_call(&call.run_id, call.op, &call.args)
                        .unwrap();
                    eprintln!(
                        "consolidação memória {:?} → {}",
                        call.op,
                        result.content.lines().next().unwrap_or("")
                    );
                    sidecar
                        .memory_result(crate::protocol::MemoryResultParams {
                            run_id: call.run_id.clone(),
                            call_id: call.call_id.clone(),
                            result,
                        })
                        .await
                        .unwrap();
                }
                SidecarNotification::RunEvent(ev) if ev.run_id == crun.id => {
                    if let RunEvent::PermissionRequest { tool_name, .. } = &ev.event {
                        panic!("run de consolidação pediu permissão para {tool_name}");
                    }
                    let terminal = ev.event.is_terminal();
                    store
                        .record_run_event(&ev.run_id, ev.seq, &ev.at, &ev.event)
                        .unwrap();
                    if terminal {
                        break;
                    }
                }
                _ => {}
            }
        }
        let crun_done = store.get_run(&crun.id).unwrap().unwrap();
        eprintln!(
            "consolidação {:?} custo {:?}",
            crun_done.status, crun_done.cost_usd
        );
        assert_eq!(crun_done.status, RunStatus::Completed);
        let haiku_pages: Vec<_> = store
            .list_pages(&project.id, false)
            .unwrap()
            .into_iter()
            .filter(|p| p.source == "haiku")
            .collect();
        // O Haiku pode legitimamente decidir que um run trivial não rende página ("zero a três páginas");
        // o que se exige é terminar sem pedir permissão e, se gravar, marcar como "haiku".
        eprintln!("páginas gravadas pela consolidação: {}", haiku_pages.len());
        assert!(
            store
                .list_pages(&project.id, false)
                .unwrap()
                .iter()
                .all(|p| p.source != "agent"),
            "páginas do run de consolidação devem vir como haiku"
        );
        assert!(
            store
                .list_pages(&project.id, false)
                .unwrap()
                .iter()
                .any(|p| p.kind == "tasklog"),
            "o log bruto continua existindo"
        );
        let after = store.get_task(&task.id).unwrap().unwrap();
        eprintln!(
            "task {:?} estágio {} nota {:?}",
            after.status, after.stage_id, after.last_note
        );
        assert_eq!(after.stage_id, "stage_2", "done avança para Sintetizar");
        assert_eq!(after.status, TaskStatus::Ready);
        assert!(after
            .last_note
            .as_deref()
            .unwrap_or("")
            .to_lowercase()
            .contains("melancia"));
        let kinds: Vec<String> = store
            .list_task_events(&task.id)
            .unwrap()
            .into_iter()
            .map(|e| e.kind)
            .collect();
        assert!(kinds.contains(&"agent_update".to_string()));
        assert!(kinds.contains(&"advanced".to_string()));
        sidecar.shutdown().await;
    }

    /// Verificação da Fase 9 (relatório final) com o Claude de verdade: a única task de um workflow
    /// conclui nos dois estágios, o relatório nasce com a entrega e o Haiku escreve o resumo executivo.
    /// Custa dinheiro: `cargo test real_report -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore = "usa o Claude de verdade (custa dinheiro); rode com --ignored"]
    async fn real_report_is_built_and_summarized_by_haiku() {
        use crate::protocol::{
            PermissionDecideParams, PermissionDecision, RunEvent, RunStartParams,
        };
        use crate::sidecar::command::find_node;
        use crate::sidecar::SidecarNotification;

        let main_js = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../packages/agent-runtime/dist/main.js")
            .canonicalize()
            .expect("sidecar compilado");
        let (sidecar, mut notifications) = Sidecar::spawn(SidecarCommand::new(
            find_node(),
            vec![main_js.to_string_lossy().into_owned()],
        ))
        .await
        .unwrap();
        sidecar.hello().await.unwrap();

        let store = Store::open_in_memory().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let project = store
            .create_project("relatorio", dir.path().to_str().unwrap())
            .unwrap();
        store
            .set_setting(
                crate::store::reports::REPORT_SUMMARY_SETTING,
                &serde_json::json!("haiku"),
            )
            .unwrap();
        let dani = store
            .add_team_member(
                &project.id,
                &TeamMemberInput {
                    name: "Dani".into(),
                    role_id: "role_pesquisador".into(),
                    max_turns: Some(4),
                    ..Default::default()
                },
            )
            .unwrap()
            .profile
            .id;
        let wf = store
            .create_workflow_from_template(&project.id, "research-synthesis", false)
            .unwrap();
        let task = store
            .create_task(
                &project.id,
                &wf.id,
                &TaskInput {
                    title: "Definição de triagem".into(),
                    description_md: "Não leia nem altere arquivos. Chame a tool task_update com status \"done\", uma nota curta e, em \"result\", um resumo em markdown de duas linhas definindo o que é triagem de leads.".into(),
                    assigned_agent_id: Some(dani.clone()),
                    ..Default::default()
                },
            )
            .unwrap();

        async fn drive(
            store: &Store,
            sidecar: &Sidecar,
            notifications: &mut tokio::sync::mpsc::Receiver<crate::sidecar::SidecarNotification>,
            run_id: &str,
        ) {
            let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(240);
            loop {
                let n = tokio::time::timeout_at(deadline, notifications.recv())
                    .await
                    .expect("timeout esperando o run")
                    .expect("canal fechado");
                match n {
                    SidecarNotification::MemoryCall(call) => {
                        let result = store
                            .handle_memory_call(&call.run_id, call.op, &call.args)
                            .unwrap();
                        sidecar
                            .memory_result(crate::protocol::MemoryResultParams {
                                run_id: call.run_id.clone(),
                                call_id: call.call_id.clone(),
                                result,
                            })
                            .await
                            .unwrap();
                    }
                    SidecarNotification::Hook(hook) => {
                        let decision = crate::decide_hook(store, &hook);
                        sidecar
                            .decide_hook(crate::protocol::HookDecideParams {
                                run_id: hook.run_id.clone(),
                                hook_id: hook.hook_id.clone(),
                                decision,
                            })
                            .await
                            .unwrap();
                    }
                    SidecarNotification::RunEvent(ev) if ev.run_id == run_id => {
                        eprintln!("[{}] {}", ev.seq, ev.event.kind());
                        if let RunEvent::PermissionRequest { request_id, .. } = &ev.event {
                            sidecar
                                .decide_permission(PermissionDecideParams {
                                    run_id: run_id.to_string(),
                                    request_id: request_id.clone(),
                                    decision: PermissionDecision::Deny {
                                        message: "teste: só task_update".into(),
                                    },
                                })
                                .await
                                .unwrap();
                        }
                        let terminal = ev.event.is_terminal();
                        store
                            .record_run_event(&ev.run_id, ev.seq, &ev.at, &ev.event)
                            .unwrap();
                        if terminal {
                            break;
                        }
                    }
                    SidecarNotification::Exited(code) => panic!("sidecar saiu: {code:?}"),
                    _ => {}
                }
            }
        }

        // Dois estágios, dois runs da Dani; ao fim do segundo a task está concluída e o relatório existe.
        for stage in 1..=2 {
            let report = tick(&store, &sidecar, &MemorySecrets::default())
                .await
                .unwrap();
            assert_eq!(report.started.len(), 1, "estágio {stage}: {report:?}");
            drive(
                &store,
                &sidecar,
                &mut notifications,
                &report.started[0].run_id,
            )
            .await;
            let run = store.get_run(&report.started[0].run_id).unwrap().unwrap();
            assert_eq!(run.status, RunStatus::Completed, "{:?}", run.error_message);
        }
        let done = store.get_task(&task.id).unwrap().unwrap();
        assert_eq!(done.status, TaskStatus::Done, "nota: {:?}", done.last_note);
        let report = store
            .get_workflow_report(&wf.id)
            .unwrap()
            .expect("relatório gerado ao concluir");
        eprintln!("relatório: {}\n", report.body_md);
        assert_eq!(report.trigger, "auto");
        assert_eq!((report.tasks_done, report.tasks_total), (1, 1));
        assert!(report.body_md.contains("Definição de triagem"));
        assert_eq!(report.summary_status, "pending");

        // Resumo executivo com o Haiku de verdade.
        let plans = store.plan_report_summaries(&project.id).unwrap();
        assert_eq!(plans.len(), 1);
        let (report_id, prompt, options) = plans.into_iter().next().unwrap();
        let srun = store
            .create_report_run(&project.id, &report_id, &prompt, &options)
            .unwrap();
        sidecar
            .start_run(RunStartParams {
                run_id: srun.id.clone(),
                cwd: project.path.clone(),
                prompt,
                options,
            })
            .await
            .unwrap();
        drive(&store, &sidecar, &mut notifications, &srun.id).await;
        let srun_done = store.get_run(&srun.id).unwrap().unwrap();
        eprintln!(
            "resumo {:?} custo {:?}: {:?}",
            srun_done.status, srun_done.cost_usd, srun_done.result_text
        );
        assert_eq!(
            srun_done.status,
            RunStatus::Completed,
            "{:?}",
            srun_done.error_message
        );
        let summarized = store.get_report(&report_id).unwrap().unwrap();
        assert_eq!(summarized.summary_status, "done");
        assert!(summarized.summary_md.as_deref().unwrap().len() > 20);
        assert!(summarized.markdown().contains("## Resumo executivo"));
        sidecar.shutdown().await;
    }

    /// Verificação da Fase 8 (delegação) com o Claude de verdade: Gabi (gestora, delega) lista o
    /// time e cria uma task para a Dani pelas tools do board; o próximo tick roda como a Dani.
    /// Custa dinheiro: `cargo test real_delegation -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore = "usa o Claude de verdade (custa dinheiro); rode com --ignored"]
    async fn real_delegation_creates_a_task_for_a_report() {
        use crate::protocol::{
            PermissionDecideParams, PermissionDecision, RunEvent, RunStartParams,
        };
        use crate::sidecar::command::find_node;
        use crate::sidecar::SidecarNotification;

        let main_js = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../packages/agent-runtime/dist/main.js")
            .canonicalize()
            .expect("sidecar compilado");
        let (sidecar, mut notifications) = Sidecar::spawn(SidecarCommand::new(
            find_node(),
            vec![main_js.to_string_lossy().into_owned()],
        ))
        .await
        .unwrap();
        sidecar.hello().await.unwrap();

        let store = Store::open_in_memory().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let project = store
            .create_project("delegacao", dir.path().to_str().unwrap())
            .unwrap();
        let gabi = store
            .add_team_member(
                &project.id,
                &TeamMemberInput {
                    name: "Gabi".into(),
                    role_id: "role_gestor_produto".into(),
                    max_turns: Some(8),
                    ..Default::default()
                },
            )
            .unwrap()
            .profile
            .id;
        let dani = store
            .add_team_member(
                &project.id,
                &TeamMemberInput {
                    name: "Dani".into(),
                    role_id: "role_pesquisador".into(),
                    reports_to_agent_id: Some(gabi.clone()),
                    max_turns: Some(4),
                    ..Default::default()
                },
            )
            .unwrap()
            .profile
            .id;
        let wf = store
            .create_workflow_from_template(&project.id, "research-synthesis", false)
            .unwrap();
        // Fase 9: missão e objetivo entram no porquê (team_list, task_create(goal), prompts).
        store
            .set_project_mission(&project.id, Some("Reduzir a triagem de leads em 30%."))
            .unwrap();
        let goal = store
            .create_goal(
                &project.id,
                &crate::store::goals::GoalInput {
                    title: "Mapear integrações externas".into(),
                    ..Default::default()
                },
            )
            .unwrap();
        store
            .update_workflow(
                &wf.id,
                &crate::store::orchestration::WorkflowInput {
                    name: wf.name.clone(),
                    stages: wf.stages.clone(),
                    use_worktrees: false,
                    max_parallel: 1,
                    goal_id: Some(goal.id.clone()),
                },
            )
            .unwrap();

        // Run avulso como a Gabi (como "Dar uma tarefa" na UI).
        let prompt = "Use a tool team_list para ver quem está no seu time e os objetivos ativos. Depois crie, com a tool task_create, exatamente UMA task para a Dani com o título \"Inventário de integrações externas\", uma descrição curta, critérios de aceite verificáveis e o parâmetro goal com o objetivo \"Mapear integrações externas\". Não faça mais nada e não crie arquivos. Termine dizendo o id da task criada.";
        let options = store
            .agent_run_options(&gabi, &RunOptions::default())
            .unwrap();
        assert_eq!(options.board_tools, Some(true));
        assert!(options
            .system_prompt_append
            .as_deref()
            .unwrap_or_default()
            .contains("Missão do projeto: Reduzir a triagem de leads em 30%."));
        let run = store
            .create_run_full(&project.id, prompt, &options, Some(&gabi), None)
            .unwrap();
        let options =
            crate::secrets::options_for_sidecar(&project, &options, &MemorySecrets::default())
                .unwrap();
        sidecar
            .start_run(RunStartParams {
                run_id: run.id.clone(),
                cwd: project.path.clone(),
                prompt: prompt.into(),
                options,
            })
            .await
            .unwrap();
        store.set_run_status(&run.id, RunStatus::Running).unwrap();

        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(300);
        let mut board_ops = Vec::new();
        loop {
            let n = tokio::time::timeout_at(deadline, notifications.recv())
                .await
                .expect("timeout esperando o run")
                .expect("canal fechado");
            match n {
                SidecarNotification::BoardCall(call) => {
                    let result = store
                        .handle_board_call(&call.run_id, call.op, &call.args)
                        .unwrap();
                    eprintln!(
                        "board {:?} → ok={} · {}",
                        call.op,
                        result.ok,
                        result.content.lines().next().unwrap_or("")
                    );
                    board_ops.push((call.op, result.ok));
                    sidecar
                        .board_result(crate::protocol::BoardResultParams {
                            run_id: call.run_id.clone(),
                            call_id: call.call_id.clone(),
                            result,
                        })
                        .await
                        .unwrap();
                }
                SidecarNotification::MemoryCall(call) => {
                    let result = store
                        .handle_memory_call(&call.run_id, call.op, &call.args)
                        .unwrap();
                    sidecar
                        .memory_result(crate::protocol::MemoryResultParams {
                            run_id: call.run_id.clone(),
                            call_id: call.call_id.clone(),
                            result,
                        })
                        .await
                        .unwrap();
                }
                SidecarNotification::Hook(hook) => {
                    let decision = crate::decide_hook(&store, &hook);
                    sidecar
                        .decide_hook(crate::protocol::HookDecideParams {
                            run_id: hook.run_id.clone(),
                            hook_id: hook.hook_id.clone(),
                            decision,
                        })
                        .await
                        .unwrap();
                }
                SidecarNotification::RunEvent(ev) if ev.run_id == run.id => {
                    eprintln!("[{}] {}", ev.seq, ev.event.kind());
                    if let RunEvent::PermissionRequest {
                        request_id,
                        tool_name,
                        ..
                    } = &ev.event
                    {
                        eprintln!("negando {tool_name}: a Gabi só delega");
                        sidecar
                            .decide_permission(PermissionDecideParams {
                                run_id: run.id.clone(),
                                request_id: request_id.clone(),
                                decision: PermissionDecision::Deny {
                                    message: "teste: só as tools do board".into(),
                                },
                            })
                            .await
                            .unwrap();
                    }
                    let terminal = ev.event.is_terminal();
                    store
                        .record_run_event(&ev.run_id, ev.seq, &ev.at, &ev.event)
                        .unwrap();
                    if terminal {
                        break;
                    }
                }
                SidecarNotification::Exited(code) => panic!("sidecar saiu: {code:?}"),
                _ => {}
            }
        }
        let done = store.get_run(&run.id).unwrap().unwrap();
        eprintln!(
            "run da Gabi {:?} custo {:?} resultado {:?}",
            done.status, done.cost_usd, done.result_text
        );
        assert_eq!(
            done.status,
            RunStatus::Completed,
            "{:?}",
            done.error_message
        );
        assert!(
            board_ops
                .iter()
                .any(|(op, ok)| *op == crate::protocol::BoardOp::TaskCreate && *ok),
            "task_create não aconteceu: {board_ops:?}"
        );
        let tasks = store.list_tasks(&project.id).unwrap();
        assert_eq!(
            tasks.len(),
            1,
            "exatamente uma task: {:?}",
            tasks.iter().map(|t| &t.title).collect::<Vec<_>>()
        );
        let task = &tasks[0];
        assert!(
            task.title.to_lowercase().contains("integra"),
            "{}",
            task.title
        );
        assert_eq!(task.assigned_agent_id.as_deref(), Some(dani.as_str()));
        assert_eq!(task.created_by_agent_id.as_deref(), Some(gabi.as_str()));
        assert_eq!(task.status, TaskStatus::Ready);
        // Por `goal` ou herdado do workflow: a task fica ligada ao objetivo.
        assert_eq!(task.goal_id.as_deref(), Some(goal.id.as_str()));
        let events = store.list_task_events(&task.id).unwrap();
        assert_eq!(events[0].kind, "created_by_agent");
        assert_eq!(events[0].actor, "agente Gabi");

        // O scheduler pega a task e roda como a Dani (a atribuição vence o estágio): só conferimos o início.
        let report = tick(&store, &sidecar, &MemorySecrets::default())
            .await
            .unwrap();
        assert_eq!(report.started.len(), 1, "{report:?}");
        let dani_run = store.get_run(&report.started[0].run_id).unwrap().unwrap();
        assert_eq!(dani_run.agent_profile_id.as_deref(), Some(dani.as_str()));
        assert!(dani_run.prompt.contains("criada por um membro do time"));
        assert!(dani_run
            .prompt
            .contains("Missão do projeto: Reduzir a triagem de leads em 30%."));
        assert!(dani_run
            .prompt
            .contains("Objetivo desta task: Mapear integrações externas"));
        sidecar.interrupt_run(&dani_run.id).await.ok();
        sidecar.shutdown().await;
    }

    /// Verificação da Fase 8 (confiança) com o Claude de verdade: Ana (gerenciada) pede revisão,
    /// o scheduler roda o Rui (gerente que aprova) como revisor e a task segue sem clique humano.
    /// Custa dinheiro: `cargo test real_chained -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore = "usa o Claude de verdade (custa dinheiro); rode com --ignored"]
    async fn real_chained_review_is_approved_by_the_manager() {
        use crate::protocol::{PermissionDecideParams, PermissionDecision, RunEvent};
        use crate::sidecar::command::find_node;
        use crate::sidecar::SidecarNotification;
        use crate::store::team::Autonomy;

        let main_js = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../packages/agent-runtime/dist/main.js")
            .canonicalize()
            .expect("sidecar compilado");
        let (sidecar, mut notifications) = Sidecar::spawn(SidecarCommand::new(
            find_node(),
            vec![main_js.to_string_lossy().into_owned()],
        ))
        .await
        .unwrap();
        sidecar.hello().await.unwrap();

        let store = Store::open_in_memory().unwrap();
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("README.md"), "# verificação\n").unwrap();
        for args in [
            vec!["init", "-q"],
            vec!["add", "."],
            vec![
                "-c",
                "user.email=t@t",
                "-c",
                "user.name=t",
                "commit",
                "-q",
                "-m",
                "init",
            ],
        ] {
            assert!(std::process::Command::new("git")
                .args(&args)
                .current_dir(dir.path())
                .status()
                .unwrap()
                .success());
        }
        let project = store
            .create_project("confianca", dir.path().to_str().unwrap())
            .unwrap();
        let rui = store
            .add_team_member(
                &project.id,
                &TeamMemberInput {
                    name: "Rui".into(),
                    role_id: "role_revisor".into(),
                    autonomy: Some(Autonomy::Managed),
                    can_approve: Some(true),
                    max_turns: Some(8),
                    ..Default::default()
                },
            )
            .unwrap()
            .profile
            .id;
        let ana = store
            .add_team_member(
                &project.id,
                &TeamMemberInput {
                    name: "Ana".into(),
                    role_id: "role_implementador".into(),
                    reports_to_agent_id: Some(rui.clone()),
                    autonomy: Some(Autonomy::Managed),
                    max_turns: Some(8),
                    ..Default::default()
                },
            )
            .unwrap()
            .profile
            .id;
        let wf = store
            .create_workflow_from_template(&project.id, "research-synthesis", true)
            .unwrap();
        let task = store
            .create_task(
                &project.id,
                &wf.id,
                &TaskInput {
                    title: "Nota de verificação".into(),
                    description_md: "Crie o arquivo NOTA.md na raiz do diretório de trabalho atual com exatamente uma linha: \"Verificação da cadeia de aprovação\". Não altere mais nada. Depois chame a tool task_update com status \"review\" (você quer que seu gerente revise), uma nota curta e, em \"result\", um resumo em markdown da entrega.".into(),
                    acceptance_md: "Existe NOTA.md na raiz com exatamente essa linha e nada mais foi alterado.".into(),
                    assigned_agent_id: Some(ana.clone()),
                    ..Default::default()
                },
            )
            .unwrap();

        // Processa notificações até o run terminar (hooks, memória, permissões como o app).
        async fn drive(
            store: &Store,
            sidecar: &Sidecar,
            notifications: &mut tokio::sync::mpsc::Receiver<crate::sidecar::SidecarNotification>,
            run_id: &str,
        ) {
            let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(300);
            loop {
                let n = tokio::time::timeout_at(deadline, notifications.recv())
                    .await
                    .expect("timeout esperando o run")
                    .expect("canal fechado");
                match n {
                    SidecarNotification::MemoryCall(call) => {
                        let result = store
                            .handle_memory_call(&call.run_id, call.op, &call.args)
                            .unwrap();
                        sidecar
                            .memory_result(crate::protocol::MemoryResultParams {
                                run_id: call.run_id.clone(),
                                call_id: call.call_id.clone(),
                                result,
                            })
                            .await
                            .unwrap();
                    }
                    SidecarNotification::Hook(hook) => {
                        let decision = crate::decide_hook(store, &hook);
                        sidecar
                            .decide_hook(crate::protocol::HookDecideParams {
                                run_id: hook.run_id.clone(),
                                hook_id: hook.hook_id.clone(),
                                decision,
                            })
                            .await
                            .unwrap();
                    }
                    SidecarNotification::RunEvent(ev) if ev.run_id == run_id => {
                        eprintln!("[{}] {}", ev.seq, ev.event.kind());
                        if let RunEvent::PermissionRequest { request_id, .. } = &ev.event {
                            sidecar
                                .decide_permission(PermissionDecideParams {
                                    run_id: run_id.to_string(),
                                    request_id: request_id.clone(),
                                    decision: PermissionDecision::Allow {
                                        updated_input: None,
                                    },
                                })
                                .await
                                .unwrap();
                        }
                        let terminal = ev.event.is_terminal();
                        store
                            .record_run_event(&ev.run_id, ev.seq, &ev.at, &ev.event)
                            .unwrap();
                        if terminal {
                            break;
                        }
                    }
                    SidecarNotification::Exited(code) => panic!("sidecar saiu: {code:?}"),
                    _ => {}
                }
            }
        }

        // 1) Ana trabalha e pede revisão → task em `review` com o Rui, sem passar por você.
        let report = tick(&store, &sidecar, &MemorySecrets::default())
            .await
            .unwrap();
        assert_eq!(report.started.len(), 1, "{report:?}");
        assert_eq!(report.started[0].kind, "task");
        let work_run = report.started[0].run_id.clone();
        drive(&store, &sidecar, &mut notifications, &work_run).await;
        let run = store.get_run(&work_run).unwrap().unwrap();
        eprintln!("run da Ana {:?} custo {:?}", run.status, run.cost_usd);
        assert_eq!(run.status, RunStatus::Completed, "{:?}", run.error_message);
        let after_work = store.get_task(&task.id).unwrap().unwrap();
        assert_eq!(
            after_work.status,
            TaskStatus::Review,
            "nota: {:?}",
            after_work.last_note
        );
        assert_eq!(after_work.approver_agent_id.as_deref(), Some(rui.as_str()));

        // 2) O scheduler roda o Rui como revisor, no worktree da task, sem editar.
        let report = tick(&store, &sidecar, &MemorySecrets::default())
            .await
            .unwrap();
        assert_eq!(report.started.len(), 1, "{report:?}");
        assert_eq!(report.started[0].kind, "review");
        let review_run = report.started[0].run_id.clone();
        drive(&store, &sidecar, &mut notifications, &review_run).await;
        let review = store.get_run(&review_run).unwrap().unwrap();
        eprintln!(
            "run do Rui {:?} custo {:?} resultado {:?}",
            review.status, review.cost_usd, review.result_text
        );
        assert_eq!(review.kind, "review");
        assert_eq!(
            review.status,
            RunStatus::Completed,
            "{:?}",
            review.error_message
        );
        assert!(
            store
                .list_observations(&project.id, Some(&review_run), 500)
                .unwrap()
                .iter()
                .all(|o| !matches!(o.tool_name.as_deref(), Some("Write" | "Edit" | "MultiEdit"))),
            "revisor não edita"
        );

        // 3) A task seguiu (aprovada pelo Rui) ou voltou para a Ana (devolvida) — nunca para você.
        let after_review = store.get_task(&task.id).unwrap().unwrap();
        let events = store.list_task_events(&task.id).unwrap();
        let decision = events
            .iter()
            .rev()
            .find(|e| e.kind == "approved" || e.kind == "returned")
            .expect("o revisor decidiu");
        eprintln!(
            "decisão: {} por {} · nota {:?} · task agora {:?} em {}",
            decision.kind,
            decision.actor,
            decision.note,
            after_review.status,
            after_review.stage_id
        );
        assert_eq!(decision.actor, "agente Rui");
        assert_ne!(
            after_review.status,
            TaskStatus::WaitingApproval,
            "não devia subir para você"
        );
        if decision.kind == "approved" {
            assert_eq!(after_review.stage_id, "stage_2");
            assert_eq!(after_review.status, TaskStatus::Ready);
        } else {
            assert_eq!(after_review.status, TaskStatus::Ready);
            assert_eq!(after_review.return_count, 1);
        }
        assert!(
            !events
                .iter()
                .any(|e| e.actor == "você" && e.kind != "created"),
            "nenhum clique humano na cadeia"
        );
        sidecar.shutdown().await;
    }

    /// Verificação da Fase 8 (entregas) com o Claude de verdade: a task roda num worktree, o agente
    /// cria um arquivo e chama `task_update(done, result)`; o core guarda o resumo, os arquivos
    /// tocados e consegue montar o diff contra o commit base.
    /// Custa dinheiro: `cargo test real_delivery -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore = "usa o Claude de verdade (custa dinheiro); rode com --ignored"]
    async fn real_delivery_is_recorded_with_files_and_diff() {
        use crate::protocol::{PermissionDecideParams, PermissionDecision, RunEvent};
        use crate::sidecar::command::find_node;
        use crate::sidecar::SidecarNotification;

        let main_js = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../packages/agent-runtime/dist/main.js")
            .canonicalize()
            .expect("sidecar compilado");
        let (sidecar, mut notifications) = Sidecar::spawn(SidecarCommand::new(
            find_node(),
            vec![main_js.to_string_lossy().into_owned()],
        ))
        .await
        .unwrap();
        sidecar.hello().await.unwrap();

        let store = Store::open_in_memory().unwrap();
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("README.md"), "# verificação\n").unwrap();
        for args in [
            vec!["init", "-q"],
            vec!["add", "."],
            vec![
                "-c",
                "user.email=t@t",
                "-c",
                "user.name=t",
                "commit",
                "-q",
                "-m",
                "init",
            ],
        ] {
            assert!(std::process::Command::new("git")
                .args(&args)
                .current_dir(dir.path())
                .status()
                .unwrap()
                .success());
        }
        let project = store
            .create_project("entregas", dir.path().to_str().unwrap())
            .unwrap();
        store
            .add_team_member(
                &project.id,
                &TeamMemberInput {
                    name: "Ana".into(),
                    role_id: "role_implementador".into(),
                    max_turns: Some(10),
                    ..Default::default()
                },
            )
            .unwrap();
        let wf = store
            .create_workflow_from_template(&project.id, "research-synthesis", true)
            .unwrap();
        let ana = store.list_team(&project.id).unwrap()[0].profile.id.clone();
        let task = store
            .create_task(
                &project.id,
                &wf.id,
                &TaskInput {
                    title: "Notas da verificação".into(),
                    description_md: "Crie o arquivo NOTAS.md na raiz do diretório de trabalho atual com exatamente uma linha: \"Notas da verificação\". Não altere nada mais. Depois chame a tool task_update com status \"done\", uma nota curta e, em \"result\", um resumo em markdown com um título \"## Entrega\" e a frase \"Como verificar\".".into(),
                    assigned_agent_id: Some(ana),
                    ..Default::default()
                },
            )
            .unwrap();

        let report = tick(&store, &sidecar, &MemorySecrets::default())
            .await
            .unwrap();
        assert_eq!(report.started.len(), 1, "{report:?}");
        let run_id = report.started[0].run_id.clone();
        let claimed = store.get_task(&task.id).unwrap().unwrap();
        assert!(claimed.base_commit.is_some(), "claim grava o commit base");
        let worktree = claimed.worktree_path.clone().unwrap();

        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(300);
        loop {
            let n = tokio::time::timeout_at(deadline, notifications.recv())
                .await
                .expect("timeout esperando o run")
                .expect("canal fechado");
            match n {
                SidecarNotification::MemoryCall(call) => {
                    let result = store
                        .handle_memory_call(&call.run_id, call.op, &call.args)
                        .unwrap();
                    sidecar
                        .memory_result(crate::protocol::MemoryResultParams {
                            run_id: call.run_id.clone(),
                            call_id: call.call_id.clone(),
                            result,
                        })
                        .await
                        .unwrap();
                }
                SidecarNotification::Hook(hook) => {
                    let decision = crate::decide_hook(&store, &hook);
                    eprintln!("hook {} → {:?}", hook.tool_name, decision.behavior);
                    sidecar
                        .decide_hook(crate::protocol::HookDecideParams {
                            run_id: hook.run_id.clone(),
                            hook_id: hook.hook_id.clone(),
                            decision,
                        })
                        .await
                        .unwrap();
                }
                SidecarNotification::RunEvent(ev) if ev.run_id == run_id => {
                    eprintln!("[{}] {}", ev.seq, ev.event.kind());
                    if let RunEvent::PermissionRequest {
                        request_id,
                        tool_name,
                        ..
                    } = &ev.event
                    {
                        // Como você clicando "Permitir uma vez" para a escrita do arquivo.
                        eprintln!("permitindo {tool_name}");
                        sidecar
                            .decide_permission(PermissionDecideParams {
                                run_id: run_id.clone(),
                                request_id: request_id.clone(),
                                decision: PermissionDecision::Allow {
                                    updated_input: None,
                                },
                            })
                            .await
                            .unwrap();
                    }
                    let terminal = ev.event.is_terminal();
                    store
                        .record_run_event(&ev.run_id, ev.seq, &ev.at, &ev.event)
                        .unwrap();
                    if terminal {
                        break;
                    }
                }
                SidecarNotification::Exited(code) => panic!("sidecar saiu: {code:?}"),
                _ => {}
            }
        }
        let run = store.get_run(&run_id).unwrap().unwrap();
        eprintln!("run {:?} custo {:?}", run.status, run.cost_usd);
        assert_eq!(run.status, RunStatus::Completed, "{:?}", run.error_message);
        assert!(
            Path::new(&worktree).join("NOTAS.md").exists(),
            "o agente não criou NOTAS.md no worktree"
        );

        let after = store.get_task(&task.id).unwrap().unwrap();
        eprintln!(
            "entrega: result_md={:?} files={:?}",
            after.result_md, after.files_changed
        );
        let result_md = after.result_md.clone().expect("result_md preenchido");
        assert!(
            result_md.to_lowercase().contains("entrega"),
            "resumo da entrega: {result_md}"
        );
        assert_eq!(after.result_run_id.as_deref(), Some(run_id.as_str()));
        assert!(
            after.files_changed.iter().any(|f| f == "NOTAS.md"),
            "arquivos tocados: {:?}",
            after.files_changed
        );
        let diff = store.task_diff(&task.id).unwrap();
        eprintln!(
            "diff: available={} scope={} files={:?}",
            diff.available,
            diff.scope,
            diff.files
                .iter()
                .map(|f| (f.path.clone(), f.status.clone()))
                .collect::<Vec<_>>()
        );
        assert!(diff.available, "{:?}", diff.reason);
        assert_eq!(diff.scope, "worktree");
        let notas = diff
            .files
            .iter()
            .find(|f| f.path == "NOTAS.md")
            .expect("NOTAS.md no diff");
        assert_eq!(notas.status, "added");
        assert!(notas.after.contains("Notas da verificação"));
        sidecar.shutdown().await;
    }
}
