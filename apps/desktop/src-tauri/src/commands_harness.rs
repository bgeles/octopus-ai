//! Comandos Tauri do harness (Fase 5): MCP servers com teste de conexão.

use tauri::State;

use crate::commands::AppState;
use crate::commands_security::audit;
use crate::protocol::{HookRunResult, HooksTestParams};
use crate::store::harness::{McpServer, McpServerInput};
use crate::store::hooks::{CustomHookInput, CustomHookRecord};
use crate::store::preview::RunPreview;
use crate::store::skills::{Skill, SkillInput};

type CmdResult<T> = Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

#[tauri::command]
pub fn list_mcp_servers(
    state: State<'_, AppState>,
    project_id: Option<String>,
) -> CmdResult<Vec<McpServer>> {
    state
        .store
        .list_mcp_servers(project_id.as_deref())
        .map_err(err)
}

#[tauri::command]
pub fn save_mcp_server(state: State<'_, AppState>, input: McpServerInput) -> CmdResult<McpServer> {
    let creating = input.id.is_none();
    let server = state.store.save_mcp_server(&input).map_err(err)?;
    audit(
        &state,
        "você",
        if creating {
            "harness.mcp.created"
        } else {
            "harness.mcp.updated"
        },
        server.project_id.as_deref(),
        serde_json::json!({"serverId": server.id, "name": server.name, "transport": server.transport, "config": server.config.redacted()}),
    );
    crate::commands_config::auto_backup(&state);
    Ok(server)
}

#[tauri::command]
pub fn set_mcp_server_enabled(
    state: State<'_, AppState>,
    server_id: String,
    enabled: bool,
) -> CmdResult<McpServer> {
    let server = state
        .store
        .set_mcp_server_enabled(&server_id, enabled)
        .map_err(err)?;
    audit(
        &state,
        "você",
        "harness.mcp.enabled",
        server.project_id.as_deref(),
        serde_json::json!({"serverId": server.id, "name": server.name, "enabled": enabled}),
    );
    crate::commands_config::auto_backup(&state);
    Ok(server)
}

#[tauri::command]
pub fn delete_mcp_server(state: State<'_, AppState>, server_id: String) -> CmdResult<bool> {
    let server = state.store.get_mcp_server(&server_id).map_err(err)?;
    let removed = state.store.delete_mcp_server(&server_id).map_err(err)?;
    if removed {
        audit(
            &state,
            "você",
            "harness.mcp.deleted",
            server.as_ref().and_then(|s| s.project_id.as_deref()),
            serde_json::json!({"serverId": server_id, "name": server.as_ref().map(|s| s.name.clone())}),
        );
        crate::commands_config::auto_backup(&state);
    }
    Ok(removed)
}

/// Abre o servidor pelo sidecar (cliente MCP oficial), lista as tools e guarda a saúde.
#[tauri::command]
pub async fn check_mcp_server(
    state: State<'_, AppState>,
    server_id: String,
) -> CmdResult<McpServer> {
    let server = state
        .store
        .get_mcp_server(&server_id)
        .map_err(err)?
        .ok_or_else(|| format!("MCP server {server_id} não encontrado"))?;
    let result = state
        .sidecar
        .mcp_check(crate::protocol::McpCheckParams {
            name: server.name.clone(),
            config: server.config.clone(),
        })
        .await
        .map_err(err)?;
    let updated = state
        .store
        .set_mcp_health(&server_id, &result)
        .map_err(err)?;
    audit(
        &state,
        "você",
        "harness.mcp.checked",
        server.project_id.as_deref(),
        serde_json::json!({"serverId": server.id, "name": server.name, "ok": result.ok, "tools": result.tools.len(), "error": result.error, "latencyMs": result.latency_ms}),
    );
    Ok(updated)
}

// ---------------------------------------------------------------------- skills

#[tauri::command]
pub fn list_skills(state: State<'_, AppState>, project_id: String) -> CmdResult<Vec<Skill>> {
    state.store.list_skills(&project_id).map_err(err)
}

/// Varre `.claude/skills` do projeto e `~/.claude/skills`.
#[tauri::command]
pub fn scan_skills(state: State<'_, AppState>, project_id: String) -> CmdResult<Vec<Skill>> {
    let skills = state.store.scan_skills(&project_id).map_err(err)?;
    audit(
        &state,
        "você",
        "harness.skills.scanned",
        Some(&project_id),
        serde_json::json!({"count": skills.len()}),
    );
    Ok(skills)
}

#[tauri::command]
pub fn set_skill_enabled(
    state: State<'_, AppState>,
    skill_id: String,
    enabled: bool,
) -> CmdResult<Skill> {
    let skill = state
        .store
        .set_skill_enabled(&skill_id, enabled)
        .map_err(err)?;
    audit(
        &state,
        "você",
        "harness.skill.enabled",
        skill.project_id.as_deref(),
        serde_json::json!({"skillId": skill.id, "name": skill.name, "enabled": enabled}),
    );
    crate::commands_config::auto_backup(&state);
    Ok(skill)
}

#[tauri::command]
pub fn read_skill(state: State<'_, AppState>, skill_id: String) -> CmdResult<String> {
    state.store.read_skill(&skill_id).map_err(err)
}

#[tauri::command]
pub fn save_skill(state: State<'_, AppState>, input: SkillInput) -> CmdResult<Skill> {
    let creating = input.skill_id.is_none();
    let skill = state.store.save_skill(&input).map_err(err)?;
    audit(
        &state,
        "você",
        if creating {
            "harness.skill.created"
        } else {
            "harness.skill.updated"
        },
        Some(&input.project_id),
        serde_json::json!({"skillId": skill.id, "name": skill.name, "path": skill.path}),
    );
    Ok(skill)
}

// ---------------------------------------------------------------------- perfil de execução

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewInput {
    pub project_id: String,
    #[serde(default)]
    pub agent_profile_id: Option<String>,
    #[serde(default)]
    pub prompt: String,
    #[serde(default)]
    pub options: crate::protocol::RunOptions,
}

/// Preview, sem efeitos colaterais, do `RunOptions` que um run receberia (segredos redigidos).
#[tauri::command]
pub fn preview_run_options(
    state: State<'_, AppState>,
    input: PreviewInput,
) -> CmdResult<RunPreview> {
    state
        .store
        .preview_run_options(
            state.secrets.as_ref(),
            &input.project_id,
            input.agent_profile_id.as_deref(),
            &input.prompt,
            &input.options,
        )
        .map_err(err)
}

// ---------------------------------------------------------------------- hooks livres

#[tauri::command]
pub fn list_custom_hooks(
    state: State<'_, AppState>,
    project_id: Option<String>,
) -> CmdResult<Vec<CustomHookRecord>> {
    state
        .store
        .list_custom_hooks(project_id.as_deref())
        .map_err(err)
}

fn hook_payload(h: &CustomHookRecord) -> serde_json::Value {
    serde_json::json!({"hookId": h.id, "name": h.name, "event": h.event.as_str(), "matcher": h.matcher, "command": h.command, "timeoutSec": h.timeout_sec, "enabled": h.enabled})
}

#[tauri::command]
pub fn save_custom_hook(
    state: State<'_, AppState>,
    input: CustomHookInput,
) -> CmdResult<CustomHookRecord> {
    let creating = input.id.is_none();
    let hook = state.store.save_custom_hook(&input).map_err(err)?;
    audit(
        &state,
        "você",
        if creating {
            "harness.hook.created"
        } else {
            "harness.hook.updated"
        },
        hook.project_id.as_deref(),
        hook_payload(&hook),
    );
    crate::commands_config::auto_backup(&state);
    Ok(hook)
}

#[tauri::command]
pub fn set_custom_hook_enabled(
    state: State<'_, AppState>,
    hook_id: String,
    enabled: bool,
) -> CmdResult<CustomHookRecord> {
    let hook = state
        .store
        .set_custom_hook_enabled(&hook_id, enabled)
        .map_err(err)?;
    audit(
        &state,
        "você",
        "harness.hook.enabled",
        hook.project_id.as_deref(),
        serde_json::json!({"hookId": hook.id, "name": hook.name, "enabled": enabled}),
    );
    crate::commands_config::auto_backup(&state);
    Ok(hook)
}

#[tauri::command]
pub fn delete_custom_hook(state: State<'_, AppState>, hook_id: String) -> CmdResult<bool> {
    let hook = state.store.get_custom_hook(&hook_id).map_err(err)?;
    let removed = state.store.delete_custom_hook(&hook_id).map_err(err)?;
    if removed {
        audit(
            &state,
            "você",
            "harness.hook.deleted",
            hook.as_ref().and_then(|h| h.project_id.as_deref()),
            serde_json::json!({"hookId": hook_id, "name": hook.as_ref().map(|h| h.name.clone())}),
        );
        crate::commands_config::auto_backup(&state);
    }
    Ok(removed)
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestCustomHookInput {
    pub project_id: String,
    pub hook: CustomHookInput,
    #[serde(default)]
    pub tool_name: Option<String>,
    #[serde(default)]
    pub tool_input: Option<serde_json::Value>,
}

/// Roda o hook (salvo ou ainda no formulário) com uma entrada de exemplo, pelo sidecar.
#[tauri::command]
pub async fn test_custom_hook(
    state: State<'_, AppState>,
    input: TestCustomHookInput,
) -> CmdResult<HookRunResult> {
    let project = state
        .store
        .get_project(&input.project_id)
        .map_err(err)?
        .ok_or_else(|| format!("Projeto {} não encontrado", input.project_id))?;
    let mut hook = crate::store::hooks::draft_hook(&input.hook).map_err(err)?;
    // O pedido ao sidecar espera até 60 s.
    hook.timeout_sec = hook.timeout_sec.min(50);
    let sample = crate::store::hooks::sample_input(
        hook.event,
        &project.path,
        input.tool_name.as_deref(),
        input.tool_input.as_ref(),
    );
    state
        .sidecar
        .hooks_test(HooksTestParams {
            hook,
            cwd: project.path.clone(),
            input: sample,
        })
        .await
        .map_err(err)
}
