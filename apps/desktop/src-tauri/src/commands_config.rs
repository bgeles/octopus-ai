//! Comandos de preferências, onboarding (checagem do ambiente) e backup local de configurações.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

use crate::commands::AppState;
use crate::sidecar::command::find_node;
use crate::store::config::{
    read_export, BackupSnapshot, ConfigExport, ImportMode, ImportPreview, ImportResult,
    SnapshotReason,
};

type CmdResult<T> = Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Grava uma cópia automática depois de uma mudança de configuração. Falhas só viram log.
pub fn auto_backup(state: &AppState) {
    if state.store.backup_dir().is_none() {
        return;
    }
    if let Err(e) = state
        .store
        .write_snapshot(SnapshotReason::Auto, APP_VERSION)
    {
        tracing::warn!("cópia automática de configuração falhou: {e}");
    }
}

// ---------------------------------------------------------------------- preferências

#[tauri::command]
pub fn get_settings(
    state: State<'_, AppState>,
) -> CmdResult<std::collections::BTreeMap<String, Value>> {
    state.store.list_settings().map_err(err)
}

#[tauri::command]
pub fn set_setting(state: State<'_, AppState>, key: String, value: Value) -> CmdResult<()> {
    let key = key.trim();
    if key.is_empty() {
        return Err("Chave vazia".into());
    }
    if value.is_null() {
        state.store.delete_setting(key).map_err(err)?;
    } else {
        state.store.set_setting(key, &value).map_err(err)?;
    }
    crate::commands_security::audit(
        &state,
        "você",
        "config.setting",
        None,
        serde_json::json!({"key": key, "value": value}),
    );
    auto_backup(&state);
    Ok(())
}

// ---------------------------------------------------------------------- ambiente

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckItem {
    pub ok: bool,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentCheck {
    pub node: CheckItem,
    pub sidecar: CheckItem,
    pub claude_auth: CheckItem,
    /// `keychain`, `api_key`, `credentials_file` ou `null`.
    pub auth_method: Option<String>,
    pub checked_at: String,
}

#[tauri::command]
pub fn check_environment(state: State<'_, AppState>) -> EnvironmentCheck {
    let node = check_node();
    let sidecar = CheckItem {
        ok: true,
        detail: format!(
            "agent-runtime {} · Claude Agent SDK {}",
            state.runtime.runtime_version, state.runtime.sdk_version
        ),
    };
    let (claude_auth, auth_method) = check_claude_auth();
    EnvironmentCheck {
        node,
        sidecar,
        claude_auth,
        auth_method,
        checked_at: chrono::Utc::now().to_rfc3339(),
    }
}

fn check_node() -> CheckItem {
    let path = find_node();
    let version = Command::new(&path)
        .arg("--version")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());
    match version {
        Some(v) => CheckItem {
            ok: true,
            detail: format!("{path} · {v}"),
        },
        None => CheckItem {
            ok: false,
            detail: "Node.js não encontrado no PATH nem nos caminhos usuais (Homebrew, /usr/local, Volta, nvm). Instale o Node ou aponte OCTOPUS_NODE.".into(),
        },
    }
}

/// Detecta credenciais do Claude Code sem ler o segredo: só verifica a existência.
fn check_claude_auth() -> (CheckItem, Option<String>) {
    if std::env::var("ANTHROPIC_API_KEY")
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false)
    {
        return (
            CheckItem {
                ok: true,
                detail: "ANTHROPIC_API_KEY definida no ambiente".into(),
            },
            Some("api_key".into()),
        );
    }
    if cfg!(target_os = "macos") && keychain_has_claude_credentials() {
        return (
            CheckItem {
                ok: true,
                detail: "credencial do Claude Code no Keychain · login pessoal".into(),
            },
            Some("keychain".into()),
        );
    }
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        if home.join(".claude/.credentials.json").is_file() {
            return (
                CheckItem {
                    ok: true,
                    detail: "credencial em ~/.claude/.credentials.json".into(),
                },
                Some("credentials_file".into()),
            );
        }
    }
    (
        CheckItem {
            ok: false,
            detail: "nenhuma credencial do Claude Code no Keychain nem ANTHROPIC_API_KEY. Rode `claude` no Terminal e faça login.".into(),
        },
        None,
    )
}

fn keychain_has_claude_credentials() -> bool {
    Command::new("security")
        .args(["find-generic-password", "-s", "Claude Code-credentials"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

// ---------------------------------------------------------------------- export / import

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportOutcome {
    pub snapshot: BackupSnapshot,
    /// Caminho extra para onde o arquivo foi copiado, quando o usuário escolheu um destino.
    pub copied_to: Option<String>,
}

/// Grava uma cópia manual nas cópias locais e, se `destination` vier, copia o arquivo para lá.
#[tauri::command]
pub fn config_export(
    state: State<'_, AppState>,
    destination: Option<String>,
) -> CmdResult<ExportOutcome> {
    let snapshot = state
        .store
        .write_snapshot(SnapshotReason::Manual, APP_VERSION)
        .map_err(err)?;
    let copied_to = match destination {
        Some(dest) if !dest.trim().is_empty() => {
            std::fs::copy(&snapshot.path, &dest)
                .map_err(|e| format!("copiando para {dest}: {e}"))?;
            Some(dest)
        }
        _ => None,
    };
    Ok(ExportOutcome {
        snapshot,
        copied_to,
    })
}

/// Export em memória (para o mock e para mostrar o JSON na UI).
#[tauri::command]
pub fn config_export_json(state: State<'_, AppState>) -> CmdResult<ConfigExport> {
    state.store.export_config(APP_VERSION).map_err(err)
}

#[tauri::command]
pub fn config_import_preview(state: State<'_, AppState>, path: String) -> CmdResult<ImportPreview> {
    let export = read_export(Path::new(&path)).map_err(err)?;
    state.store.preview_import(&export).map_err(err)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigImportInput {
    pub path: String,
    pub mode: ImportMode,
}

#[tauri::command]
pub fn config_import(
    state: State<'_, AppState>,
    input: ConfigImportInput,
) -> CmdResult<ImportResult> {
    let export = read_export(Path::new(&input.path)).map_err(err)?;
    if state.store.backup_dir().is_some() {
        state
            .store
            .write_snapshot(SnapshotReason::PreRestore, APP_VERSION)
            .map_err(err)?;
    }
    let result = state
        .store
        .import_config(&export, input.mode)
        .map_err(err)?;
    auto_backup(&state);
    Ok(result)
}

#[tauri::command]
pub fn config_backups_list(state: State<'_, AppState>) -> CmdResult<Vec<BackupSnapshot>> {
    state.store.list_snapshots().map_err(err)
}

#[tauri::command]
pub fn config_backup_preview(state: State<'_, AppState>, id: String) -> CmdResult<ImportPreview> {
    let snapshot = state
        .store
        .get_snapshot(&id)
        .map_err(err)?
        .ok_or_else(|| format!("Cópia {id} não encontrada"))?;
    let export = read_export(Path::new(&snapshot.path)).map_err(err)?;
    state.store.preview_import(&export).map_err(err)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreInput {
    pub id: String,
    pub mode: ImportMode,
}

#[tauri::command]
pub fn config_backup_restore(
    state: State<'_, AppState>,
    input: RestoreInput,
) -> CmdResult<ImportResult> {
    let result = state
        .store
        .restore_snapshot(&input.id, input.mode, APP_VERSION)
        .map_err(err)?;
    crate::commands_security::audit(
        &state,
        "você",
        "config.restored",
        None,
        serde_json::json!({"snapshotId": input.id, "mode": input.mode, "result": result}),
    );
    auto_backup(&state);
    Ok(result)
}

/// Revela uma cópia no Finder. Só caminhos dentro da pasta de backups.
#[tauri::command]
pub fn config_backup_reveal(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    let snapshot = state
        .store
        .get_snapshot(&id)
        .map_err(err)?
        .ok_or_else(|| format!("Cópia {id} não encontrada"))?;
    let dir = state
        .store
        .backup_dir()
        .ok_or_else(|| "Sem pasta de backups".to_string())?;
    let path = Path::new(&snapshot.path);
    if !path.starts_with(dir) {
        return Err("Caminho fora da pasta de backups".into());
    }
    Command::new("open")
        .arg("-R")
        .arg(path)
        .status()
        .map_err(err)?;
    Ok(())
}
