//! Octopus AI — core Rust do app desktop.
//!
//! Responsabilidades desta camada: abrir o store, subir o sidecar do Agent SDK,
//! persistir e repassar eventos de run para a janela e expor comandos à UI.

pub mod commands;
pub mod commands_config;
pub mod commands_harness;
pub mod commands_memory;
pub mod commands_orchestration;
pub mod commands_security;
pub mod commands_team;
pub mod protocol;
#[cfg(test)]
mod real_tests;
pub mod scheduler;
pub mod secrets;
pub mod sidecar;
pub mod store;
pub mod tray;
pub mod updates;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result};
use tauri::{AppHandle, Emitter, Manager};
use tracing::{error, info, warn};

use commands::AppState;
use sidecar::{Sidecar, SidecarCommand, SidecarNotification};
use store::Store;

/// Nome do evento Tauri com `RunEventNotification` no payload.
pub const RUN_EVENT: &str = "run:event";
/// Nome do evento Tauri com `RuntimeLog` no payload.
pub const RUNTIME_LOG: &str = "runtime:log";
/// Emitido quando o sidecar morre; payload é o código de saída (ou null).
pub const RUNTIME_EXITED: &str = "runtime:exited";
/// Emitido quando o Octopus interrompe runs por orçamento esgotado; payload `BudgetStopped`.
pub const BUDGET_STOPPED: &str = "budget:stopped";
/// Custo estimado de um run ativo mudou; payload `{runId, estCostUsd}`.
pub const RUN_COST: &str = "run:cost";

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetStopped {
    pub run_ids: Vec<String>,
    pub reason: String,
}

fn init_tracing() {
    use tracing_subscriber::EnvFilter;
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,octopus_desktop_lib=debug"));
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(true)
        .try_init();
}

/// Raiz do repositório em desenvolvimento (três níveis acima de `src-tauri`).
fn dev_repo_root() -> Option<PathBuf> {
    if cfg!(debug_assertions) {
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        manifest.parent()?.parent()?.parent().map(Path::to_path_buf)
    } else {
        None
    }
}

async fn bootstrap(app: &AppHandle) -> Result<()> {
    let db_path = Store::default_path()?;
    info!(path = %db_path.display(), "abrindo store");
    let store = Arc::new(Store::open(&db_path)?);
    let secrets: Arc<dyn secrets::SecretStore> = Arc::from(secrets::default_secret_store());

    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf));
    let resource_dir = app.path().resource_dir().ok();
    let command = SidecarCommand::resolve(
        exe_dir.as_deref(),
        dev_repo_root().as_deref(),
        resource_dir.as_deref(),
    )?;
    let (sidecar, mut notifications) = Sidecar::spawn(command).await?;
    let runtime = sidecar
        .hello()
        .await
        .context("handshake com o sidecar falhou")?;
    info!(runtime = %runtime.runtime_version, sdk = %runtime.sdk_version, "sidecar pronto");

    // Repasse de notificações: persiste e emite para a janela.
    {
        let app = app.clone();
        let store = store.clone();
        let sidecar = sidecar.clone();
        tauri::async_runtime::spawn(async move {
            while let Some(n) = notifications.recv().await {
                match n {
                    SidecarNotification::RunEvent(ev) => {
                        if let Err(e) =
                            store.record_run_event(&ev.run_id, ev.seq, &ev.at, &ev.event)
                        {
                            error!("falha persistindo evento do run {}: {e}", ev.run_id);
                        }
                        if let Err(e) = app.emit(RUN_EVENT, &ev) {
                            warn!("falha emitindo {RUN_EVENT}: {e}");
                        }
                        tray::notify(&app, &store, &ev.run_id, &ev.event);
                        if matches!(
                            ev.event,
                            protocol::RunEvent::SessionInit { .. }
                                | protocol::RunEvent::PermissionRequest { .. }
                                | protocol::RunEvent::TaskUpdate { .. }
                        ) || ev.event.is_terminal()
                        {
                            tray::refresh(&app, &store);
                        }
                        if let protocol::RunEvent::Usage { .. } = ev.event {
                            if let Ok(Some(run)) = store.get_run(&ev.run_id) {
                                let _ = app.emit(
                                    RUN_COST,
                                    serde_json::json!({"runId": run.id, "estCostUsd": run.est_cost_usd}),
                                );
                            }
                        }
                        // O custo andou (estimativa por resposta ou custo final): confere o orçamento.
                        if matches!(
                            ev.event,
                            protocol::RunEvent::Usage { .. } | protocol::RunEvent::Result { .. }
                        ) {
                            if let Some(stopped) =
                                enforce_budget(&store, &sidecar, &ev.run_id).await
                            {
                                let _ = app.emit(BUDGET_STOPPED, &stopped);
                                tray::notify_budget_stop(&app, &stopped.reason);
                                tray::refresh(&app, &store);
                            }
                        }
                        if ev.event.is_terminal() {
                            maybe_consolidate(&store, &sidecar, &ev.run_id).await;
                        }
                    }
                    SidecarNotification::Hook(hook) => {
                        let decision = decide_hook(&store, &hook);
                        if let Err(e) = sidecar
                            .decide_hook(protocol::HookDecideParams {
                                run_id: hook.run_id.clone(),
                                hook_id: hook.hook_id.clone(),
                                decision,
                            })
                            .await
                        {
                            warn!("hook.decide falhou para {}: {e}", hook.hook_id);
                        }
                    }
                    SidecarNotification::MemoryCall(call) => {
                        let result =
                            match store.handle_memory_call(&call.run_id, call.op, &call.args) {
                                Ok(r) => r,
                                Err(e) => protocol::MemoryCallResult {
                                    ok: false,
                                    content: format!("Erro na memória do projeto: {e:#}"),
                                },
                            };
                        if let Err(e) = sidecar
                            .memory_result(protocol::MemoryResultParams {
                                run_id: call.run_id.clone(),
                                call_id: call.call_id.clone(),
                                result,
                            })
                            .await
                        {
                            warn!("memory.result falhou para {}: {e}", call.call_id);
                        }
                    }
                    SidecarNotification::Log(log) => {
                        let _ = app.emit(RUNTIME_LOG, &log);
                    }
                    SidecarNotification::Exited(code) => {
                        error!(?code, "sidecar encerrou; runs ativos ficarão sem eventos");
                        let _ = app.emit(RUNTIME_EXITED, code);
                    }
                }
            }
        });
    }

    // Scheduler: um tick a cada poucos segundos; a UI é avisada quando o board muda.
    {
        let app = app.clone();
        let store = store.clone();
        let sidecar = sidecar.clone();
        let secrets = secrets.clone();
        tauri::async_runtime::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(4));
            loop {
                interval.tick().await;
                match scheduler::tick(&store, &sidecar, secrets.as_ref()).await {
                    Ok(report) if report.changed() => {
                        let _ = app.emit(commands_orchestration::BOARD_CHANGED, &report);
                        tray::refresh(&app, &store);
                    }
                    Ok(_) => {}
                    Err(e) => warn!("tick do scheduler falhou: {e:#}"),
                }
            }
        });
    }

    if let Err(e) = tray::install(app, &store) {
        warn!("ícone da menu bar indisponível: {e}");
    }
    app.manage(AppState {
        store,
        sidecar,
        runtime,
        secrets,
    });
    Ok(())
}

/// Com a preferência `memory.consolidation = haiku`, dispara o run de consolidação da memória
/// (modelo barato, só tools de memória) assim que um run de agente termina.
pub async fn maybe_consolidate(store: &Store, sidecar: &sidecar::Sidecar, run_id: &str) {
    let plan = match store.plan_consolidation(run_id) {
        Ok(Some(plan)) => plan,
        Ok(None) => return,
        Err(e) => {
            warn!("plano de consolidação do run {run_id} falhou: {e:#}");
            return;
        }
    };
    let project = match store
        .get_run(run_id)
        .ok()
        .flatten()
        .and_then(|run| store.get_project(&run.project_id).ok().flatten())
    {
        Some(p) => p,
        None => return,
    };
    let (prompt, options) = plan;
    let crun = match store.create_consolidation_run(&project.id, &prompt, &options) {
        Ok(r) => r,
        Err(e) => {
            warn!("não criei o run de consolidação: {e:#}");
            return;
        }
    };
    let params = protocol::RunStartParams {
        run_id: crun.id.clone(),
        cwd: project.path.clone(),
        prompt,
        options,
    };
    match sidecar.start_run(params).await {
        Ok(_) => {
            if let Err(e) = store.audit(
                "sistema",
                "memory.consolidation.started",
                Some(&project.id),
                serde_json::json!({"runId": crun.id, "sourceRunId": run_id, "model": store::memory::CONSOLIDATION_MODEL}),
            ) {
                warn!("auditoria da consolidação falhou: {e}");
            }
        }
        Err(e) => {
            let _ = store.mark_run_failed(&crun.id, &format!("{e:#}"));
            warn!("run de consolidação {} não iniciou: {e}", crun.id);
        }
    }
}

/// Se o projeto ou o membro do run passou do limite mensal (fechado + estimativa ao vivo),
/// interrompe os runs ativos daquele escopo. Cada run é marcado antes de pedir a parada ao
/// sidecar, para que o erro de interrupção que chega depois não vire "falhou".
pub async fn enforce_budget(
    store: &Store,
    sidecar: &sidecar::Sidecar,
    run_id: &str,
) -> Option<BudgetStopped> {
    let overrun = match store.budget_overrun(run_id) {
        Ok(Some(o)) => o,
        Ok(None) => return None,
        Err(e) => {
            warn!("checagem de orçamento do run {run_id} falhou: {e:#}");
            return None;
        }
    };
    let reason = overrun.reason();
    let mut stopped = Vec::new();
    for id in &overrun.run_ids {
        match store.stop_run_for_budget(id, &reason) {
            Ok(true) => {
                if let Err(e) = sidecar.interrupt_run(id).await {
                    warn!("interromper {id} por orçamento falhou no sidecar: {e:#}");
                }
                stopped.push(id.clone());
            }
            Ok(false) => {}
            Err(e) => warn!("não consegui parar {id} por orçamento: {e:#}"),
        }
    }
    if stopped.is_empty() {
        None
    } else {
        Some(BudgetStopped {
            run_ids: stopped,
            reason,
        })
    }
}

/// Avalia a política do projeto do run para um hook PreToolUse e registra na auditoria.
pub fn decide_hook(store: &Store, hook: &protocol::RunHookNotification) -> protocol::HookDecision {
    let project = store
        .get_run(&hook.run_id)
        .ok()
        .flatten()
        .and_then(|run| store.get_project(&run.project_id).ok().flatten());
    let Some(project) = project else {
        warn!("hook {} sem projeto conhecido; passando", hook.hook_id);
        return store::policy::PolicyDecision::pass().to_hook_decision();
    };
    match store.evaluate_policy(
        &project.id,
        Path::new(&project.path),
        &hook.tool_name,
        &hook.input,
    ) {
        Ok(decision) => {
            if decision.behavior != "pass" {
                if let Err(e) = store.audit(
                    "política",
                    &format!("policy.{}", decision.behavior),
                    Some(&project.id),
                    serde_json::json!({
                        "runId": hook.run_id,
                        "tool": hook.tool_name,
                        "input": hook.input,
                        "ruleId": decision.rule_id,
                        "reason": decision.reason,
                    }),
                ) {
                    warn!("auditoria da política falhou: {e}");
                }
            }
            decision.to_hook_decision()
        }
        Err(e) => {
            warn!("avaliação de política falhou ({e}); pedindo aprovação");
            protocol::HookDecision {
                behavior: "ask".into(),
                reason: Some("Falha ao avaliar a política; confirme manualmente".into()),
                updated_input: None,
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    init_tracing();
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Fechar a janela não encerra os runs: o app continua na menu bar.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::block_on(async move {
                if let Err(e) = bootstrap(&handle).await {
                    error!("falha na inicialização: {e:#}");
                    return Err(e);
                }
                Ok(())
            })?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::runtime_info,
            commands::list_projects,
            commands::create_project,
            commands::delete_project,
            commands::list_runs,
            commands::get_run,
            commands::list_run_events,
            commands::start_run,
            commands::interrupt_run,
            commands::decide_permission,
            commands::list_sessions,
            commands::rename_session,
            commands::tag_session,
            commands::list_approvals,
            commands::get_project_totals,
            commands::read_project_file,
            commands_config::get_settings,
            commands_config::set_setting,
            commands_config::check_environment,
            commands_config::config_export,
            commands_config::config_export_json,
            commands_config::config_import_preview,
            commands_config::config_import,
            commands_config::config_backups_list,
            commands_config::config_backup_preview,
            commands_config::config_backup_restore,
            commands_config::config_backup_reveal,
            commands_team::list_roles,
            commands_team::create_role,
            commands_team::update_role,
            commands_team::delete_role,
            commands_team::list_team,
            commands_team::add_team_member,
            commands_team::update_team_member,
            commands_team::remove_team_member,
            commands_team::team_totals,
            commands_orchestration::list_workflow_templates,
            commands_orchestration::list_workflows,
            commands_orchestration::create_workflow,
            commands_orchestration::create_workflow_from_template,
            commands_orchestration::update_workflow,
            commands_orchestration::delete_workflow,
            commands_orchestration::list_tasks,
            commands_orchestration::create_task,
            commands_orchestration::update_task,
            commands_orchestration::delete_task,
            commands_orchestration::move_task,
            commands_orchestration::approve_task,
            commands_orchestration::return_task,
            commands_orchestration::list_task_events,
            commands_orchestration::scheduler_tick,
            commands_security::list_audit_events,
            commands_security::verify_audit,
            commands_security::export_audit,
            commands_security::list_policy_rules,
            commands_security::create_policy_rule,
            commands_security::update_policy_rule,
            commands_security::set_policy_rule_enabled,
            commands_security::delete_policy_rule,
            commands_security::evaluate_policy,
            commands_security::list_sandbox_profiles,
            commands_security::set_project_sandbox,
            commands_security::get_budget_status,
            commands_security::set_budget_policy,
            commands_security::update_project_auth,
            commands_security::set_project_api_key,
            commands_security::clear_project_api_key,
            commands_security::has_project_api_key,
            commands_memory::list_memory_pages,
            commands_memory::get_memory_page,
            commands_memory::search_memory,
            commands_memory::save_memory_page,
            commands_memory::set_memory_page_archived,
            commands_memory::list_memory_page_versions,
            commands_memory::list_memory_observations,
            commands_memory::list_context_events,
            commands_memory::rebuild_memory_index,
            commands_memory::list_memory_handoffs,
            commands_memory::list_context_pins,
            commands_memory::add_context_pin,
            commands_memory::remove_context_pin,
            commands_harness::list_mcp_servers,
            commands_harness::save_mcp_server,
            commands_harness::set_mcp_server_enabled,
            commands_harness::delete_mcp_server,
            commands_harness::check_mcp_server,
            commands_harness::list_skills,
            commands_harness::scan_skills,
            commands_harness::set_skill_enabled,
            commands_harness::read_skill,
            commands_harness::save_skill,
            commands_harness::preview_run_options,
            commands_harness::list_custom_hooks,
            commands_harness::save_custom_hook,
            commands_harness::set_custom_hook_enabled,
            commands_harness::delete_custom_hook,
            commands_harness::test_custom_hook,
            updates::check_update,
            updates::install_update,
        ])
        .build(tauri::generate_context!())
        .expect("erro ao iniciar o Octopus AI")
        .run(|app, event| {
            // Clique no ícone do Dock com a janela escondida: mostra de novo.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                tray::show_main(app, None);
            }
            let _ = (app, event);
        });
}
