//! Comandos do board: workflows, tasks, gates e o tick manual do scheduler.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::commands::AppState;
use crate::commands_config::auto_backup;
use crate::commands_security::audit;
use crate::scheduler::{self, TickReport};
use crate::store::orchestration::{
    workflow_templates, Task, TaskEvent, TaskInput, TaskStatus, Workflow, WorkflowInput,
};

type CmdResult<T> = Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/// Evento Tauri emitido quando o scheduler muda o board.
pub const BOARD_CHANGED: &str = "board:changed";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowTemplate {
    pub id: String,
    pub name: String,
    pub stages: Vec<TemplateStage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateStage {
    pub name: String,
    pub role_title: Option<String>,
    pub gate: bool,
}

#[tauri::command]
pub fn list_workflow_templates() -> Vec<WorkflowTemplate> {
    workflow_templates()
        .into_iter()
        .map(|(id, name, stages)| WorkflowTemplate {
            id: id.to_string(),
            name: name.to_string(),
            stages: stages
                .into_iter()
                .map(|(stage, role, gate, _)| TemplateStage {
                    name: stage.to_string(),
                    role_title: role.map(str::to_string),
                    gate,
                })
                .collect(),
        })
        .collect()
}

#[tauri::command]
pub fn list_workflows(state: State<'_, AppState>, project_id: String) -> CmdResult<Vec<Workflow>> {
    state.store.list_workflows(&project_id).map_err(err)
}

#[tauri::command]
pub fn create_workflow(
    state: State<'_, AppState>,
    project_id: String,
    input: WorkflowInput,
) -> CmdResult<Workflow> {
    let wf = state
        .store
        .create_workflow(&project_id, &input)
        .map_err(err)?;
    auto_backup(&state);
    Ok(wf)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateInput {
    pub project_id: String,
    pub template_id: String,
    #[serde(default)]
    pub use_worktrees: bool,
}

#[tauri::command]
pub fn create_workflow_from_template(
    state: State<'_, AppState>,
    input: TemplateInput,
) -> CmdResult<Workflow> {
    let wf = state
        .store
        .create_workflow_from_template(&input.project_id, &input.template_id, input.use_worktrees)
        .map_err(err)?;
    audit(
        &state,
        "você",
        "board.workflow.created",
        Some(&input.project_id),
        serde_json::json!({"workflowId": wf.id, "name": wf.name, "template": input.template_id, "useWorktrees": input.use_worktrees}),
    );
    auto_backup(&state);
    Ok(wf)
}

#[tauri::command]
pub fn update_workflow(
    state: State<'_, AppState>,
    workflow_id: String,
    input: WorkflowInput,
) -> CmdResult<Workflow> {
    let wf = state
        .store
        .update_workflow(&workflow_id, &input)
        .map_err(err)?;
    auto_backup(&state);
    Ok(wf)
}

#[tauri::command]
pub fn delete_workflow(state: State<'_, AppState>, workflow_id: String) -> CmdResult<bool> {
    let deleted = state.store.delete_workflow(&workflow_id).map_err(err)?;
    if deleted {
        auto_backup(&state);
    }
    Ok(deleted)
}

#[tauri::command]
pub fn list_tasks(state: State<'_, AppState>, project_id: String) -> CmdResult<Vec<Task>> {
    state.store.list_tasks(&project_id).map_err(err)
}

#[tauri::command]
pub fn create_task(
    state: State<'_, AppState>,
    project_id: String,
    workflow_id: String,
    input: TaskInput,
) -> CmdResult<Task> {
    state
        .store
        .create_task(&project_id, &workflow_id, &input)
        .map_err(err)
}

#[tauri::command]
pub fn update_task(
    state: State<'_, AppState>,
    task_id: String,
    input: TaskInput,
) -> CmdResult<Task> {
    state.store.update_task(&task_id, &input).map_err(err)
}

#[tauri::command]
pub fn delete_task(state: State<'_, AppState>, task_id: String) -> CmdResult<bool> {
    state.store.delete_task(&task_id).map_err(err)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveTaskInput {
    pub task_id: String,
    #[serde(default)]
    pub stage_id: Option<String>,
    pub status: TaskStatus,
    #[serde(default)]
    pub note: Option<String>,
}

#[tauri::command]
pub fn move_task(state: State<'_, AppState>, input: MoveTaskInput) -> CmdResult<Task> {
    state
        .store
        .move_task(
            &input.task_id,
            input.stage_id.as_deref(),
            input.status,
            input.note.as_deref(),
        )
        .map_err(err)
}

/// Aprovação sua: vale para `waiting_approval` e também por cima de uma revisão por agente
/// (`review`); nesse caso o run de revisão em andamento é interrompido.
#[tauri::command]
pub async fn approve_task(
    state: State<'_, AppState>,
    task_id: String,
    note: Option<String>,
) -> CmdResult<Task> {
    let before = state.store.get_task(&task_id).map_err(err)?;
    let task = state
        .store
        .approve_task(&task_id, note.as_deref())
        .map_err(err)?;
    if let Some(run_id) = before.and_then(|t| t.lock_run_id) {
        if let Ok(result) = state.sidecar.interrupt_run(&run_id).await {
            if result.interrupted {
                let _ = state
                    .store
                    .set_run_status(&run_id, crate::store::models::RunStatus::Interrupted);
            }
        }
    }
    Ok(task)
}

#[tauri::command]
pub fn return_task(
    state: State<'_, AppState>,
    task_id: String,
    stage_id: String,
    note: Option<String>,
) -> CmdResult<Task> {
    state
        .store
        .return_task(&task_id, &stage_id, note.as_deref())
        .map_err(err)
}

#[tauri::command]
pub fn list_task_events(state: State<'_, AppState>, task_id: String) -> CmdResult<Vec<TaskEvent>> {
    state.store.list_task_events(&task_id).map_err(err)
}

/// Tick imediato do scheduler (a UI chama depois de criar/mover tasks).
#[tauri::command]
pub async fn scheduler_tick(app: AppHandle, state: State<'_, AppState>) -> CmdResult<TickReport> {
    let report = scheduler::tick(&state.store, &state.sidecar, state.secrets.as_ref())
        .await
        .map_err(err)?;
    if report.changed() {
        let _ = app.emit(BOARD_CHANGED, &report);
    }
    Ok(report)
}

/// Atividade recente do projeto (tasks, runs avulsos e decisões suas), opcionalmente de um membro.
#[tauri::command]
pub fn list_project_activity(
    state: State<'_, AppState>,
    project_id: String,
    agent_profile_id: Option<String>,
    limit: Option<u32>,
) -> CmdResult<Vec<crate::store::activity::ActivityItem>> {
    state
        .store
        .list_project_activity(
            &project_id,
            agent_profile_id.as_deref(),
            limit.unwrap_or(20).min(200),
        )
        .map_err(err)
}

/// Diff da entrega da task (worktree contra o commit base; sem worktree, a pasta do projeto).
#[tauri::command]
pub fn task_diff(
    state: State<'_, AppState>,
    task_id: String,
) -> CmdResult<crate::store::task_diff::TaskDiff> {
    state.store.task_diff(&task_id).map_err(err)
}
