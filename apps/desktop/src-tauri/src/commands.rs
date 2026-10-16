//! Comandos Tauri expostos à UI. Todos devolvem `Result<T, String>` para a ponte JS.

use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::protocol::{
    HelloResult, PermissionDecideParams, PermissionDecision, RunOptions, RunStartParams,
    SessionSummary, SessionsRenameParams, SessionsTagParams,
};
use crate::sidecar::Sidecar;
use crate::store::models::{Approval, Project, ProjectTotals, Run, RunStatus, StoredRunEvent};
use crate::store::Store;

pub struct AppState {
    pub store: Arc<Store>,
    pub sidecar: Arc<Sidecar>,
    pub runtime: HelloResult,
    pub secrets: Arc<dyn crate::secrets::SecretStore>,
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
    let project = state
        .store
        .create_project(&input.name, &input.path)
        .map_err(err)?;
    crate::commands_security::audit(
        &state,
        "você",
        "config.project.created",
        Some(&project.id),
        serde_json::json!({"name": project.name, "path": project.path}),
    );
    crate::commands_config::auto_backup(&state);
    Ok(project)
}

#[tauri::command]
pub fn delete_project(state: State<'_, AppState>, project_id: String) -> CmdResult<bool> {
    let deleted = state.store.delete_project(&project_id).map_err(err)?;
    if deleted {
        crate::commands_security::audit(
            &state,
            "você",
            "config.project.deleted",
            Some(&project_id),
            serde_json::json!({}),
        );
        crate::commands_config::auto_backup(&state);
    }
    Ok(deleted)
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
    /// Membro do time que executa o run: instruções do cargo, limites e delegados entram nas opções.
    #[serde(default)]
    pub agent_profile_id: Option<String>,
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

    let mut options = match input.agent_profile_id.as_deref() {
        Some(agent_id) => state
            .store
            .agent_run_options(agent_id, &input.options)
            .map_err(err)?,
        None => input.options,
    };
    options.policy_hooks = Some(true);
    options.memory.get_or_insert_with(Default::default);
    options.sandbox = state.store.sandbox_for_project(&project).map_err(err)?;
    let options = state
        .store
        .apply_budget(&project.id, input.agent_profile_id.as_deref(), options)
        .map_err(err)?;
    let run = state
        .store
        .create_run_for_agent(
            &project.id,
            &input.prompt,
            &options,
            input.agent_profile_id.as_deref(),
        )
        .map_err(err)?;

    // Memória: brief (handoff pendente + páginas relevantes) e tools MCP só na cópia enviada ao sidecar.
    let mut options = options;
    {
        let brief = state
            .store
            .memory_brief(&project.id, None, &input.prompt, &run.id)
            .map_err(err)?;
        let memory = options.memory.get_or_insert_with(Default::default);
        memory.tools = Some(true);
        if let Some(b) = brief {
            memory.brief = Some(b.text);
            memory.brief_items = Some(b.items);
        }
        if options.setting_sources.is_none() {
            options.setting_sources = state
                .store
                .project_setting_sources(&project.id)
                .map_err(err)?;
        }
        if options.mcp_servers.is_none() {
            options.mcp_servers = state
                .store
                .mcp_servers_for_run(&project.id, input.agent_profile_id.as_deref())
                .map_err(err)?;
        }
        if options.plugins.is_none() {
            options.plugins = state
                .store
                .materialize_plugin(
                    &project.id,
                    input.agent_profile_id.as_deref(),
                    options.setting_sources.as_deref(),
                )
                .map_err(err)?
                .map(|p| vec![p]);
        }
    }
    // A chave de API (quando o projeto usa uma) entra só aqui, a caminho do sidecar;
    // o run gravado acima fica com as opções sem segredo.
    let options =
        match crate::secrets::options_for_sidecar(&project, &options, state.secrets.as_ref()) {
            Ok(o) => o,
            Err(e) => {
                let msg = format!("{e:#}");
                state.store.mark_run_failed(&run.id, &msg).map_err(err)?;
                return Err(msg);
            }
        };
    let params = RunStartParams {
        run_id: run.id.clone(),
        cwd: project.path.clone(),
        prompt: input.prompt,
        options,
    };
    match state.sidecar.start_run(params).await {
        Ok(_) => {
            state
                .store
                .set_run_status(&run.id, RunStatus::Running)
                .map_err(err)?;
            crate::commands_security::audit(
                &state,
                "você",
                "run.requested",
                Some(&project.id),
                serde_json::json!({"runId": run.id, "agentProfileId": input.agent_profile_id, "resume": run.options.resume_session_id, "permissionMode": run.options.permission_mode}),
            );
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
        crate::commands_security::audit(
            &state,
            "você",
            "run.interrupted",
            None,
            serde_json::json!({"runId": run_id}),
        );
    }
    Ok(result.interrupted)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecidePermissionInput {
    pub run_id: String,
    pub request_id: String,
    pub decision: PermissionDecision,
    /// Motivo informado pelo usuário ao permitir (ao negar, a mensagem da decisão já é o motivo).
    #[serde(default)]
    pub note: Option<String>,
}

#[tauri::command]
pub async fn decide_permission(
    state: State<'_, AppState>,
    input: DecidePermissionInput,
) -> CmdResult<bool> {
    let params = PermissionDecideParams {
        run_id: input.run_id.clone(),
        request_id: input.request_id.clone(),
        decision: input.decision.clone(),
    };
    let result = state.sidecar.decide_permission(params).await.map_err(err)?;
    if result.applied {
        state
            .store
            .record_approval_decision(
                &input.run_id,
                &input.request_id,
                &input.decision,
                input.note.as_deref(),
            )
            .map_err(err)?;
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameSessionInput {
    pub project_id: String,
    pub session_id: String,
    pub title: String,
}

#[tauri::command]
pub async fn rename_session(
    state: State<'_, AppState>,
    input: RenameSessionInput,
) -> CmdResult<bool> {
    let title = input.title.trim();
    if title.is_empty() {
        return Err("Informe um título para a sessão".into());
    }
    let project = state
        .store
        .get_project(&input.project_id)
        .map_err(err)?
        .ok_or_else(|| format!("Projeto {} não encontrado", input.project_id))?;
    let result = state
        .sidecar
        .rename_session(SessionsRenameParams {
            session_id: input.session_id,
            cwd: project.path,
            title: title.to_string(),
        })
        .await
        .map_err(err)?;
    Ok(result.ok)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagSessionInput {
    pub project_id: String,
    pub session_id: String,
    /// `None` ou vazio remove a tag.
    #[serde(default)]
    pub tag: Option<String>,
}

#[tauri::command]
pub async fn tag_session(state: State<'_, AppState>, input: TagSessionInput) -> CmdResult<bool> {
    let project = state
        .store
        .get_project(&input.project_id)
        .map_err(err)?
        .ok_or_else(|| format!("Projeto {} não encontrado", input.project_id))?;
    let tag = input
        .tag
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty());
    let result = state
        .sidecar
        .tag_session(SessionsTagParams {
            session_id: input.session_id,
            cwd: project.path,
            tag,
        })
        .await
        .map_err(err)?;
    Ok(result.ok)
}

#[tauri::command]
pub fn get_project_totals(
    state: State<'_, AppState>,
    project_id: String,
) -> CmdResult<ProjectTotals> {
    state.store.project_totals(&project_id).map_err(err)
}

#[tauri::command]
pub fn list_approvals(
    state: State<'_, AppState>,
    project_id: String,
    limit: Option<u32>,
) -> CmdResult<Vec<Approval>> {
    state
        .store
        .list_approvals(&project_id, limit.unwrap_or(100))
        .map_err(err)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilePreview {
    pub path: String,
    pub exists: bool,
    pub content: String,
    pub truncated: bool,
}

const DEFAULT_PREVIEW_BYTES: usize = 256 * 1024;

/// Lê um arquivo da pasta do projeto para o preview/diff de aprovações.
/// Caminhos fora da pasta do projeto são recusados.
#[tauri::command]
pub fn read_project_file(
    state: State<'_, AppState>,
    project_id: String,
    path: String,
    max_bytes: Option<usize>,
) -> CmdResult<FilePreview> {
    let project = state
        .store
        .get_project(&project_id)
        .map_err(err)?
        .ok_or_else(|| format!("Projeto {project_id} não encontrado"))?;
    let resolved = resolve_within(Path::new(&project.path), &path)?;
    read_preview(&resolved, max_bytes.unwrap_or(DEFAULT_PREVIEW_BYTES))
}

/// Resolve `requested` (absoluto ou relativo) dentro de `root`, recusando escapes por `..`
/// ou por links simbólicos.
pub fn resolve_within(root: &Path, requested: &str) -> Result<PathBuf, String> {
    let requested_path = Path::new(requested);
    let joined = if requested_path.is_absolute() {
        requested_path.to_path_buf()
    } else {
        root.join(requested_path)
    };
    // Normalização lexical: remove `.` e resolve `..` sem tocar no disco.
    let mut normalized = PathBuf::new();
    for component in joined.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() {
                    return Err(format!("Caminho fora da pasta do projeto: {requested}"));
                }
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    let root_real = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let inside = match normalized.canonicalize() {
        // Existe: vale o caminho real (links simbólicos para fora são recusados).
        Ok(real) => real.starts_with(&root_real),
        // Ainda não existe (ex.: Write cria o arquivo): vale o caminho lexical.
        Err(_) => normalized.starts_with(root) || normalized.starts_with(&root_real),
    };
    if inside {
        Ok(normalized)
    } else {
        Err(format!("Caminho fora da pasta do projeto: {requested}"))
    }
}

fn read_preview(path: &Path, max_bytes: usize) -> CmdResult<FilePreview> {
    let display = path.to_string_lossy().into_owned();
    if !path.exists() {
        return Ok(FilePreview {
            path: display,
            exists: false,
            content: String::new(),
            truncated: false,
        });
    }
    if path.is_dir() {
        return Err(format!("{display} é uma pasta"));
    }
    let bytes = std::fs::read(path).map_err(|e| format!("Falha lendo {display}: {e}"))?;
    let truncated = bytes.len() > max_bytes;
    let slice = if truncated {
        &bytes[..max_bytes]
    } else {
        &bytes[..]
    };
    Ok(FilePreview {
        path: display,
        exists: true,
        content: String::from_utf8_lossy(slice).into_owned(),
        truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_within_accepts_relative_and_absolute_inside_root() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/a.txt"), "x").unwrap();

        let rel = resolve_within(root, "src/a.txt").unwrap();
        assert!(rel.ends_with("src/a.txt"));
        let abs = resolve_within(root, root.join("src/./a.txt").to_str().unwrap()).unwrap();
        assert!(abs.ends_with("src/a.txt"));
        // Arquivo que ainda não existe (Write cria): aceito se estiver dentro.
        assert!(resolve_within(root, "src/novo.sql").is_ok());
    }

    #[test]
    fn resolve_within_rejects_escapes() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        assert!(resolve_within(root, "../fora.txt").is_err());
        assert!(resolve_within(root, "src/../../fora.txt").is_err());
        assert!(resolve_within(root, "/etc/passwd").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn resolve_within_rejects_symlink_leaving_root() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("segredo"), "s").unwrap();
        std::os::unix::fs::symlink(outside.path().join("segredo"), dir.path().join("link"))
            .unwrap();
        assert!(resolve_within(dir.path(), "link").is_err());
    }

    #[test]
    fn read_preview_reports_missing_and_truncates() {
        let dir = tempfile::tempdir().unwrap();
        let missing = read_preview(&dir.path().join("nada.txt"), 10).unwrap();
        assert!(!missing.exists);
        std::fs::write(dir.path().join("a.txt"), "0123456789abcdef").unwrap();
        let preview = read_preview(&dir.path().join("a.txt"), 10).unwrap();
        assert!(preview.exists);
        assert!(preview.truncated);
        assert_eq!(preview.content, "0123456789");
        assert!(read_preview(dir.path(), 10).is_err());
    }
}
