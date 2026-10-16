//! Comandos de segurança: auditoria (Fase 3, iteração 01); política, sandbox, orçamentos e
//! segredos chegam nas iterações seguintes.

use serde_json::Value;
use tauri::State;

use crate::commands::AppState;
use crate::store::audit::{AuditEvent, AuditVerification};

type CmdResult<T> = Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/// Registra um evento de auditoria; falhas só viram log (a ação principal não pode falhar por isso).
pub fn audit(state: &AppState, actor: &str, kind: &str, project_id: Option<&str>, payload: Value) {
    if let Err(e) = state.store.audit(actor, kind, project_id, payload) {
        tracing::warn!("auditoria falhou ({kind}): {e}");
    }
}

#[tauri::command]
pub fn list_audit_events(
    state: State<'_, AppState>,
    project_id: Option<String>,
    kind_prefix: Option<String>,
    limit: Option<u32>,
) -> CmdResult<Vec<AuditEvent>> {
    state
        .store
        .list_audit_events(
            project_id.as_deref(),
            kind_prefix.as_deref(),
            limit.unwrap_or(200),
        )
        .map_err(err)
}

#[tauri::command]
pub fn verify_audit(state: State<'_, AppState>) -> CmdResult<AuditVerification> {
    state.store.verify_audit().map_err(err)
}

/// JSONL do log inteiro. Com `destination`, grava no caminho escolhido e devolve o caminho.
#[tauri::command]
pub fn export_audit(state: State<'_, AppState>, destination: Option<String>) -> CmdResult<String> {
    let jsonl = state.store.export_audit_jsonl().map_err(err)?;
    match destination {
        Some(path) if !path.trim().is_empty() => {
            std::fs::write(&path, &jsonl).map_err(|e| format!("gravando {path}: {e}"))?;
            audit(
                &state,
                "você",
                "audit.exported",
                None,
                serde_json::json!({"path": path, "events": jsonl.lines().count()}),
            );
            Ok(path)
        }
        _ => Ok(jsonl),
    }
}
