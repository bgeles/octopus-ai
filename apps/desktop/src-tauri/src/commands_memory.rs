//! Comandos Tauri da memória do projeto (Fase 4): páginas da wiki, busca FTS5 e observações.

use tauri::State;

use crate::commands::AppState;
use crate::commands_security::audit;
use crate::store::memory::{
    ContextEvent, MemoryObservation, MemoryPage, MemoryPageInput, MemoryPageVersion,
    MemorySearchHit,
};

type CmdResult<T> = Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

#[tauri::command]
pub fn list_memory_pages(
    state: State<'_, AppState>,
    project_id: String,
    include_archived: Option<bool>,
) -> CmdResult<Vec<MemoryPage>> {
    state
        .store
        .list_pages(&project_id, include_archived.unwrap_or(false))
        .map_err(err)
}

/// Lê uma página e conta o acesso (sobe o score de recall).
#[tauri::command]
pub fn get_memory_page(
    state: State<'_, AppState>,
    page_id: String,
) -> CmdResult<Option<MemoryPage>> {
    let page = state.store.get_page(&page_id).map_err(err)?;
    if page.is_some() {
        state.store.touch_pages(&[page_id]).map_err(err)?;
    }
    Ok(page)
}

#[tauri::command]
pub fn search_memory(
    state: State<'_, AppState>,
    project_id: String,
    query: String,
    limit: Option<usize>,
) -> CmdResult<Vec<MemorySearchHit>> {
    state
        .store
        .search_pages(&project_id, &query, limit.unwrap_or(20))
        .map_err(err)
}

#[tauri::command]
pub fn save_memory_page(
    state: State<'_, AppState>,
    input: MemoryPageInput,
) -> CmdResult<MemoryPage> {
    let reason = if input.page_id.is_some() {
        "edição manual"
    } else {
        "criação manual"
    };
    let page = state
        .store
        .save_page(&input, reason, "manual")
        .map_err(err)?;
    audit(
        &state,
        "você",
        "memory.page",
        Some(&input.project_id),
        serde_json::json!({"pageId": page.id, "kind": page.kind, "title": page.title, "reason": reason}),
    );
    Ok(page)
}

#[tauri::command]
pub fn set_memory_page_archived(
    state: State<'_, AppState>,
    page_id: String,
    archived: bool,
) -> CmdResult<MemoryPage> {
    let page = state
        .store
        .set_page_archived(&page_id, archived)
        .map_err(err)?;
    audit(
        &state,
        "você",
        if archived {
            "memory.page.archived"
        } else {
            "memory.page.restored"
        },
        Some(&page.project_id),
        serde_json::json!({"pageId": page.id, "title": page.title}),
    );
    Ok(page)
}

#[tauri::command]
pub fn list_memory_page_versions(
    state: State<'_, AppState>,
    page_id: String,
) -> CmdResult<Vec<MemoryPageVersion>> {
    state.store.page_versions(&page_id).map_err(err)
}

#[tauri::command]
pub fn list_memory_observations(
    state: State<'_, AppState>,
    project_id: String,
    run_id: Option<String>,
    limit: Option<usize>,
) -> CmdResult<Vec<MemoryObservation>> {
    state
        .store
        .list_observations(&project_id, run_id.as_deref(), limit.unwrap_or(200))
        .map_err(err)
}

#[tauri::command]
pub fn list_context_events(
    state: State<'_, AppState>,
    run_id: String,
) -> CmdResult<Vec<ContextEvent>> {
    state.store.list_context_events(&run_id).map_err(err)
}

/// Reconstrói o índice a partir dos arquivos `.md` da wiki (fonte da verdade).
#[tauri::command]
pub fn rebuild_memory_index(state: State<'_, AppState>, project_id: String) -> CmdResult<usize> {
    let n = state.store.rebuild_memory_index(&project_id).map_err(err)?;
    audit(
        &state,
        "você",
        "memory.reindex",
        Some(&project_id),
        serde_json::json!({"pages": n}),
    );
    Ok(n)
}
