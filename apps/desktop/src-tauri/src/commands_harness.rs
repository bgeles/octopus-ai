//! Comandos Tauri do harness (Fase 5): MCP servers com teste de conexão.

use tauri::State;

use crate::commands::AppState;
use crate::commands_security::audit;
use crate::store::harness::{McpServer, McpServerInput};

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
