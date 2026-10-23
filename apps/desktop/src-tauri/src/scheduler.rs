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

pub async fn tick(
    store: &Store,
    sidecar: &Sidecar,
    secrets: &dyn SecretStore,
) -> Result<TickReport> {
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
            let mut options = match agent_id.as_deref() {
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
            options.sandbox = store.sandbox_for_project(&project)?;
            let options = match store.apply_budget(&project.id, agent_id.as_deref(), options) {
                Ok(o) => o,
                Err(e) => {
                    let msg = format!("Orçamento: {e}");
                    store.move_task(
                        &task.id,
                        None,
                        crate::store::orchestration::TaskStatus::Blocked,
                        Some(&msg),
                    )?;
                    report.failed.push((task.id.clone(), msg));
                    continue;
                }
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
                if options.setting_sources.is_none() {
                    options.setting_sources = store.project_setting_sources(&project.id)?;
                }
                if options.mcp_servers.is_none() {
                    options.mcp_servers =
                        store.mcp_servers_for_run(&project.id, agent_id.as_deref())?;
                }
                if options.custom_hooks.is_none() {
                    options.custom_hooks = store.custom_hooks_for_run(&project.id)?;
                }
                if options.plugins.is_none() {
                    options.plugins = store
                        .materialize_plugin(
                            &project.id,
                            agent_id.as_deref(),
                            options.setting_sources.as_deref(),
                        )?
                        .map(|p| vec![p]);
                }
            }
            let options = match crate::secrets::options_for_sidecar(&project, &options, secrets) {
                Ok(o) => o,
                Err(e) => {
                    let msg = format!("{e:#}");
                    store.mark_run_failed(&run.id, &msg)?;
                    report.failed.push((task.id.clone(), msg));
                    continue;
                }
            };
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
