//! Octopus AI — core Rust do app desktop.
//!
//! Responsabilidades desta camada: abrir o store, subir o sidecar do Agent SDK,
//! persistir e repassar eventos de run para a janela e expor comandos à UI.

pub mod commands;
pub mod commands_config;
pub mod commands_orchestration;
pub mod commands_security;
pub mod commands_team;
pub mod protocol;
pub mod scheduler;
pub mod secrets;
pub mod sidecar;
pub mod store;

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
                    }
                    Ok(_) => {}
                    Err(e) => warn!("tick do scheduler falhou: {e:#}"),
                }
            }
        });
    }

    app.manage(AppState {
        store,
        sidecar,
        runtime,
        secrets,
    });
    Ok(())
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
        ])
        .run(tauri::generate_context!())
        .expect("erro ao iniciar o Octopus AI");
}
