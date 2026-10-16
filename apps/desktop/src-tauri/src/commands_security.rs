//! Comandos de segurança: auditoria (Fase 3, iteração 01); política, sandbox, orçamentos e
//! segredos chegam nas iterações seguintes.

use serde_json::Value;
use tauri::State;

use crate::commands::AppState;
use crate::store::audit::{AuditEvent, AuditVerification};
use crate::store::policy::{PolicyDecision, PolicyRule, PolicyRuleInput};

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

// ---------------------------------------------------------------------- política

#[tauri::command]
pub fn list_policy_rules(
    state: State<'_, AppState>,
    project_id: Option<String>,
) -> CmdResult<Vec<PolicyRule>> {
    state
        .store
        .list_policy_rules(project_id.as_deref())
        .map_err(err)
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateRuleInput {
    #[serde(default)]
    pub project_id: Option<String>,
    pub input: PolicyRuleInput,
}

#[tauri::command]
pub fn create_policy_rule(
    state: State<'_, AppState>,
    input: CreateRuleInput,
) -> CmdResult<PolicyRule> {
    let rule = state
        .store
        .create_policy_rule(input.project_id.as_deref(), &input.input)
        .map_err(err)?;
    audit(
        &state,
        "você",
        "config.rule.created",
        input.project_id.as_deref(),
        serde_json::json!({"ruleId": rule.id, "kind": rule.kind, "pattern": rule.pattern, "action": rule.action}),
    );
    Ok(rule)
}

#[tauri::command]
pub fn update_policy_rule(
    state: State<'_, AppState>,
    rule_id: String,
    input: PolicyRuleInput,
) -> CmdResult<PolicyRule> {
    let rule = state
        .store
        .update_policy_rule(&rule_id, &input)
        .map_err(err)?;
    audit(
        &state,
        "você",
        "config.rule.updated",
        rule.project_id.as_deref(),
        serde_json::json!({"ruleId": rule.id, "kind": rule.kind, "pattern": rule.pattern, "action": rule.action, "enabled": rule.enabled}),
    );
    Ok(rule)
}

#[tauri::command]
pub fn set_policy_rule_enabled(
    state: State<'_, AppState>,
    rule_id: String,
    enabled: bool,
) -> CmdResult<PolicyRule> {
    let rule = state
        .store
        .set_policy_rule_enabled(&rule_id, enabled)
        .map_err(err)?;
    audit(
        &state,
        "você",
        "config.rule.toggled",
        rule.project_id.as_deref(),
        serde_json::json!({"ruleId": rule.id, "enabled": enabled}),
    );
    Ok(rule)
}

#[tauri::command]
pub fn delete_policy_rule(state: State<'_, AppState>, rule_id: String) -> CmdResult<bool> {
    let deleted = state.store.delete_policy_rule(&rule_id).map_err(err)?;
    if deleted {
        audit(
            &state,
            "você",
            "config.rule.deleted",
            None,
            serde_json::json!({"ruleId": rule_id}),
        );
    }
    Ok(deleted)
}

/// Simula a política para uma chamada (a UI usa para testar uma regra antes de salvar).
#[tauri::command]
pub fn evaluate_policy(
    state: State<'_, AppState>,
    project_id: String,
    tool_name: String,
    input: Value,
) -> CmdResult<PolicyDecision> {
    let project = state
        .store
        .get_project(&project_id)
        .map_err(err)?
        .ok_or_else(|| format!("Projeto {project_id} não encontrado"))?;
    state
        .store
        .evaluate_policy(
            &project.id,
            std::path::Path::new(&project.path),
            &tool_name,
            &input,
        )
        .map_err(err)
}
