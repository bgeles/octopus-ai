//! Octopus AI — core Rust do app desktop.
//!
//! Responsabilidades desta camada: abrir o store, subir o sidecar do Agent SDK,
//! persistir e repassar eventos de run para a janela e expor comandos à UI.

pub mod commands;
pub mod commands_config;
pub mod commands_team;
pub mod protocol;
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

    app.manage(AppState {
        store,
        sidecar,
        runtime,
    });
    Ok(())
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
        ])
        .run(tauri::generate_context!())
        .expect("erro ao iniciar o Octopus AI");
}
