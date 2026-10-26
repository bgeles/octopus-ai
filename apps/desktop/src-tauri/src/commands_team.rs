//! Comandos do time: cargos, membros e totais por membro.

use serde::Deserialize;
use tauri::{AppHandle, Emitter, State};

use crate::commands::AppState;
use crate::commands_config::auto_backup;
use crate::commands_security::audit;
use crate::scheduler::{TickOptions, TickReport};
use crate::store::team::{AgentTotals, Role, RoleInput, TeamMember, TeamMemberInput};

type CmdResult<T> = Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

#[tauri::command]
pub fn list_roles(state: State<'_, AppState>, project_id: Option<String>) -> CmdResult<Vec<Role>> {
    state.store.list_roles(project_id.as_deref()).map_err(err)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateRoleInput {
    #[serde(default)]
    pub project_id: Option<String>,
    pub input: RoleInput,
}

#[tauri::command]
pub fn create_role(state: State<'_, AppState>, input: CreateRoleInput) -> CmdResult<Role> {
    let role = state
        .store
        .create_role(input.project_id.as_deref(), &input.input)
        .map_err(err)?;
    auto_backup(&state);
    Ok(role)
}

#[tauri::command]
pub fn update_role(
    state: State<'_, AppState>,
    role_id: String,
    input: RoleInput,
) -> CmdResult<Role> {
    let role = state.store.update_role(&role_id, &input).map_err(err)?;
    auto_backup(&state);
    Ok(role)
}

#[tauri::command]
pub fn delete_role(state: State<'_, AppState>, role_id: String) -> CmdResult<bool> {
    let deleted = state.store.delete_role(&role_id).map_err(err)?;
    if deleted {
        auto_backup(&state);
    }
    Ok(deleted)
}

#[tauri::command]
pub fn list_team(state: State<'_, AppState>, project_id: String) -> CmdResult<Vec<TeamMember>> {
    state.store.list_team(&project_id).map_err(err)
}

#[tauri::command]
pub fn add_team_member(
    state: State<'_, AppState>,
    project_id: String,
    input: TeamMemberInput,
) -> CmdResult<TeamMember> {
    let member = state
        .store
        .add_team_member(&project_id, &input)
        .map_err(err)?;
    audit(
        &state,
        "você",
        "team.member.added",
        Some(&project_id),
        serde_json::json!({"agentProfileId": member.profile.id, "name": member.profile.name, "role": member.role.title}),
    );
    auto_backup(&state);
    Ok(member)
}

#[tauri::command]
pub fn update_team_member(
    state: State<'_, AppState>,
    agent_profile_id: String,
    input: TeamMemberInput,
) -> CmdResult<TeamMember> {
    let member = state
        .store
        .update_team_member(&agent_profile_id, &input)
        .map_err(err)?;
    audit(
        &state,
        "você",
        "team.member.updated",
        Some(&member.project_id),
        serde_json::json!({"agentProfileId": member.profile.id, "name": member.profile.name, "role": member.role.title, "reportsTo": member.reports_to_agent_id}),
    );
    auto_backup(&state);
    Ok(member)
}

/// Pausa ou retoma um membro (pausado não recebe trabalho novo); ao retomar, o scheduler roda.
#[tauri::command]
pub async fn set_member_paused(
    app: AppHandle,
    state: State<'_, AppState>,
    agent_profile_id: String,
    paused: bool,
) -> CmdResult<TeamMember> {
    let member = state
        .store
        .set_member_paused(&agent_profile_id, paused)
        .map_err(err)?;
    audit(
        &state,
        "você",
        if paused {
            "team.member.paused"
        } else {
            "team.member.resumed"
        },
        Some(&member.project_id),
        serde_json::json!({"agentProfileId": agent_profile_id, "name": member.profile.name}),
    );
    let report = if paused {
        TickReport::default()
    } else {
        crate::scheduler::tick(&state.store, &state.sidecar, state.secrets.as_ref())
            .await
            .map_err(err)?
    };
    let _ = app.emit(crate::commands_orchestration::BOARD_CHANGED, &report);
    Ok(member)
}

/// "Rodar agora": tick escopado ao membro, ignorando a pausa dele e a pausa global.
#[tauri::command]
pub async fn run_member_now(
    app: AppHandle,
    state: State<'_, AppState>,
    agent_profile_id: String,
) -> CmdResult<TickReport> {
    let member = state
        .store
        .get_team_member_by_agent(&agent_profile_id)
        .map_err(err)?
        .ok_or_else(|| format!("Membro {agent_profile_id} não encontrado"))?;
    let report = crate::scheduler::tick_with(
        &state.store,
        &state.sidecar,
        state.secrets.as_ref(),
        &TickOptions {
            only_agent: Some(agent_profile_id.clone()),
            force: true,
        },
    )
    .await
    .map_err(err)?;
    audit(
        &state,
        "você",
        "team.member.run_now",
        Some(&member.project_id),
        serde_json::json!({"agentProfileId": agent_profile_id, "name": member.profile.name, "started": report.started.len()}),
    );
    if report.changed() {
        let _ = app.emit(crate::commands_orchestration::BOARD_CHANGED, &report);
    }
    Ok(report)
}

#[tauri::command]
pub fn remove_team_member(state: State<'_, AppState>, agent_profile_id: String) -> CmdResult<bool> {
    let removed = state
        .store
        .remove_team_member(&agent_profile_id)
        .map_err(err)?;
    if removed {
        audit(
            &state,
            "você",
            "team.member.removed",
            None,
            serde_json::json!({"agentProfileId": agent_profile_id}),
        );
        auto_backup(&state);
    }
    Ok(removed)
}

#[tauri::command]
pub fn team_totals(state: State<'_, AppState>, project_id: String) -> CmdResult<Vec<AgentTotals>> {
    state.store.team_totals(&project_id).map_err(err)
}
