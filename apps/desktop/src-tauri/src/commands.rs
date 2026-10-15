//! Comandos Tauri expostos à UI. Todos devolvem `Result<T, String>` para a ponte JS.

use std::sync::Arc;

use serde::Deserialize;
use tauri::State;

use crate::protocol::{
    HelloResult, PermissionDecideParams, PermissionDecision, RunOptions, RunStartParams,
    SessionSummary,
};
use crate::sidecar::Sidecar;
use crate::store::models::{Project, Run, RunStatus, StoredRunEvent};
use crate::store::Store;

pub struct AppState {
    pub store: Arc<Store>,
    pub sidecar: Arc<Sidecar>,
    pub runtime: HelloResult,
}

type CmdResult<T> = Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

#[tauri::command]
pub fn runtime_info(state: State<'_, AppState>) -> HelloResult {
    state.runtime.clone()
}

#[tauri::command]
pub fn list_projects(state: State<'_, AppState>) -> CmdResult<Vec<Project>> {
    state.store.list_projects().map_err(err)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateProjectInput {
    pub name: String,
    pub path: String,
}

#[tauri::command]
pub fn create_project(state: State<'_, AppState>, input: CreateProjectInput) -> CmdResult<Project> {
    if input.name.trim().is_empty() {
        return Err("Informe um nome para o projeto".into());
    }
    let path = std::path::Path::new(&input.path);
    if !path.is_dir() {
        return Err(format!("A pasta {} não existe", input.path));
    }
    state
        .store
        .create_project(&input.name, &input.path)
        .map_err(err)
}

#[tauri::command]
pub fn delete_project(state: State<'_, AppState>, project_id: String) -> CmdResult<bool> {
    state.store.delete_project(&project_id).map_err(err)
}

#[tauri::command]
pub fn list_runs(
    state: State<'_, AppState>,
    project_id: String,
    limit: Option<u32>,
) -> CmdResult<Vec<Run>> {
    state
        .store
        .list_runs(&project_id, limit.unwrap_or(50))
        .map_err(err)
}

#[tauri::command]
pub fn get_run(state: State<'_, AppState>, run_id: String) -> CmdResult<Option<Run>> {
    state.store.get_run(&run_id).map_err(err)
}

#[tauri::command]
pub fn list_run_events(
    state: State<'_, AppState>,
    run_id: String,
) -> CmdResult<Vec<StoredRunEvent>> {
    state.store.list_run_events(&run_id).map_err(err)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartRunInput {
    pub project_id: String,
    pub prompt: String,
    #[serde(default)]
    pub options: RunOptions,
}

#[tauri::command]
pub async fn start_run(state: State<'_, AppState>, input: StartRunInput) -> CmdResult<Run> {
    if input.prompt.trim().is_empty() {
        return Err("O prompt não pode ser vazio".into());
    }
    let project = state
        .store
        .get_project(&input.project_id)
        .map_err(err)?
        .ok_or_else(|| format!("Projeto {} não encontrado", input.project_id))?;

    let run = state
        .store
        .create_run(&project.id, &input.prompt, &input.options)
        .map_err(err)?;

    let params = RunStartParams {
        run_id: run.id.clone(),
        cwd: project.path.clone(),
        prompt: input.prompt,
        options: input.options,
    };
    match state.sidecar.start_run(params).await {
        Ok(_) => {
            state
                .store
                .set_run_status(&run.id, RunStatus::Running)
                .map_err(err)?;
            state
                .store
                .get_run(&run.id)
                .map_err(err)?
                .ok_or_else(|| "run sumiu após criar".to_string())
        }
        Err(e) => {
            let message = format!("Falha ao iniciar o agente: {e}");
            state
                .store
                .mark_run_failed(&run.id, &message)
                .map_err(err)?;
            Err(message)
        }
    }
}

#[tauri::command]
pub async fn interrupt_run(state: State<'_, AppState>, run_id: String) -> CmdResult<bool> {
    let result = state.sidecar.interrupt_run(&run_id).await.map_err(err)?;
    if result.interrupted {
        state
            .store
            .set_run_status(&run_id, RunStatus::Interrupted)
            .map_err(err)?;
    }
    Ok(result.interrupted)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecidePermissionInput {
    pub run_id: String,
    pub request_id: String,
    pub decision: PermissionDecision,
}

#[tauri::command]
pub async fn decide_permission(
    state: State<'_, AppState>,
    input: DecidePermissionInput,
) -> CmdResult<bool> {
    let params = PermissionDecideParams {
        run_id: input.run_id.clone(),
        request_id: input.request_id,
        decision: input.decision,
    };
    let result = state.sidecar.decide_permission(params).await.map_err(err)?;
    if result.applied {
        state
            .store
            .set_run_status(&input.run_id, RunStatus::Running)
            .map_err(err)?;
    }
    Ok(result.applied)
}

#[tauri::command]
pub async fn list_sessions(
    state: State<'_, AppState>,
    project_id: String,
) -> CmdResult<Vec<SessionSummary>> {
    let project = state
        .store
        .get_project(&project_id)
        .map_err(err)?
        .ok_or_else(|| format!("Projeto {project_id} não encontrado"))?;
    let result = state
        .sidecar
        .list_sessions(&project.path)
        .await
        .map_err(err)?;
    Ok(result.sessions)
}
