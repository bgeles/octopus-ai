//! Persistência local em SQLite (rusqlite, bundled).
//!
//! O banco vive em `~/Library/Application Support/ai.octopus.desktop/octopus.db`.
//! Migrations são SQL versionado aplicado em `open()`. Todo acesso passa por `Store`,
//! que serializa escritas com um `Mutex` (SQLite tem um único escritor).

pub mod audit;
pub mod config;
pub mod harness;
pub mod memory;
pub mod models;
pub mod orchestration;
pub mod policy;
pub mod security;
pub mod team;

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::{Context, Result};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};

use crate::protocol::{PermissionDecision, RunEvent, RunOptions};
use models::{Approval, ApprovalDecision, Project, ProjectTotals, Run, RunStatus, StoredRunEvent};

const MIGRATIONS: &[(&str, &str)] = &[
    ("0001_init", include_str!("migrations/0001_init.sql")),
    (
        "0002_approvals",
        include_str!("migrations/0002_approvals.sql"),
    ),
    (
        "0003_settings_backups",
        include_str!("migrations/0003_settings_backups.sql"),
    ),
    ("0004_team", include_str!("migrations/0004_team.sql")),
    (
        "0005_orchestration",
        include_str!("migrations/0005_orchestration.sql"),
    ),
    ("0006_audit", include_str!("migrations/0006_audit.sql")),
    ("0007_policy", include_str!("migrations/0007_policy.sql")),
    (
        "0008_sandbox_budget",
        include_str!("migrations/0008_sandbox_budget.sql"),
    ),
    ("0009_memory", include_str!("migrations/0009_memory.sql")),
    (
        "0010_memory_handoff",
        include_str!("migrations/0010_memory_handoff.sql"),
    ),
    (
        "0011_run_kind",
        include_str!("migrations/0011_run_kind.sql"),
    ),
    (
        "0012_context_pin",
        include_str!("migrations/0012_context_pin.sql"),
    ),
    (
        "0013_mcp_servers",
        include_str!("migrations/0013_mcp_servers.sql"),
    ),
];

pub struct Store {
    conn: Mutex<Connection>,
    /// Pasta das cópias de configuração (`<dados>/backups`); `None` em memória.
    backup_dir: Option<PathBuf>,
    /// Pasta de dados do app (wiki de memória em `projects/<id>/memory/wiki`); `None` em memória.
    data_dir: Option<PathBuf>,
}

impl Store {
    /// Abre (ou cria) o banco no caminho dado e aplica migrations pendentes.
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("criando {}", parent.display()))?;
        }
        let conn = Connection::open(path).with_context(|| format!("abrindo {}", path.display()))?;
        let mut store = Self::from_connection(conn, config::default_backup_dir(path))?;
        store.data_dir = path.parent().map(Path::to_path_buf);
        Ok(store)
    }

    /// Define a pasta de dados (testes com a wiki em uma pasta temporária).
    pub fn with_data_dir(mut self, dir: PathBuf) -> Self {
        self.data_dir = Some(dir);
        self
    }

    /// Banco em memória, para testes.
    pub fn open_in_memory() -> Result<Self> {
        Self::from_connection(Connection::open_in_memory()?, None)
    }

    fn from_connection(conn: Connection, backup_dir: Option<PathBuf>) -> Result<Self> {
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA foreign_keys = ON;
             PRAGMA busy_timeout = 5000;",
        )?;
        let store = Self {
            conn: Mutex::new(conn),
            backup_dir,
            data_dir: None,
        };
        store.migrate()?;
        Ok(store)
    }

    /// Caminho padrão do banco para esta instalação.
    pub fn default_path() -> Result<PathBuf> {
        let dirs = directories::ProjectDirs::from("ai", "octopus", "desktop")
            .context("não foi possível resolver o diretório de dados do usuário")?;
        Ok(dirs.data_dir().join("octopus.db"))
    }

    fn migrate(&self) -> Result<()> {
        let conn = self.conn.lock().expect("store mutex");
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS schema_migrations (
                name TEXT PRIMARY KEY,
                applied_at TEXT NOT NULL
            );",
        )?;
        for (name, sql) in MIGRATIONS {
            let applied: Option<String> = conn
                .query_row(
                    "SELECT name FROM schema_migrations WHERE name = ?1",
                    params![name],
                    |r| r.get(0),
                )
                .optional()?;
            if applied.is_some() {
                continue;
            }
            conn.execute_batch(sql)
                .with_context(|| format!("aplicando migration {name}"))?;
            conn.execute(
                "INSERT INTO schema_migrations (name, applied_at) VALUES (?1, ?2)",
                params![name, Utc::now().to_rfc3339()],
            )?;
        }
        Ok(())
    }

    pub fn applied_migrations(&self) -> Result<Vec<String>> {
        let conn = self.conn.lock().expect("store mutex");
        let mut stmt = conn.prepare("SELECT name FROM schema_migrations ORDER BY name")?;
        let names = stmt
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(names)
    }

    // ------------------------------------------------------------------ projetos

    pub fn create_project(&self, name: &str, path: &str) -> Result<Project> {
        let project = Project {
            id: new_id("proj"),
            name: name.trim().to_string(),
            path: path.to_string(),
            auth_mode: models::AuthMode::Subscription,
            created_at: now(),
            sandbox_profile_id: Some("sandbox_dev".into()),
        };
        let conn = self.conn.lock().expect("store mutex");
        conn.execute(
            "INSERT INTO project (id, name, path, auth_mode, created_at, sandbox_profile_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![project.id, project.name, project.path, project.auth_mode.as_str(), project.created_at, project.sandbox_profile_id],
        )?;
        Ok(project)
    }

    pub fn update_project_auth(&self, id: &str, auth_mode: models::AuthMode) -> Result<Project> {
        let conn = self.conn.lock().unwrap();
        let changed = conn.execute(
            "UPDATE project SET auth_mode = ?2 WHERE id = ?1",
            params![id, auth_mode.as_str()],
        )?;
        drop(conn);
        if changed == 0 {
            anyhow::bail!("Projeto {id} não encontrado");
        }
        self.get_project(id)?
            .ok_or_else(|| anyhow::anyhow!("Projeto {id} não encontrado"))
    }

    pub fn list_projects(&self) -> Result<Vec<Project>> {
        let conn = self.conn.lock().expect("store mutex");
        let mut stmt = conn.prepare(
            "SELECT id, name, path, auth_mode, created_at, sandbox_profile_id FROM project ORDER BY created_at DESC",
        )?;
        let rows = stmt
            .query_map([], Project::from_row)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn get_project(&self, id: &str) -> Result<Option<Project>> {
        let conn = self.conn.lock().expect("store mutex");
        let project = conn
            .query_row(
                "SELECT id, name, path, auth_mode, created_at, sandbox_profile_id FROM project WHERE id = ?1",
                params![id],
                Project::from_row,
            )
            .optional()?;
        Ok(project)
    }

    pub fn delete_project(&self, id: &str) -> Result<bool> {
        let conn = self.conn.lock().expect("store mutex");
        let changed = conn.execute("DELETE FROM project WHERE id = ?1", params![id])?;
        Ok(changed > 0)
    }

    // ------------------------------------------------------------------ runs

    pub fn create_run(&self, project_id: &str, prompt: &str, options: &RunOptions) -> Result<Run> {
        self.create_run_for_agent(project_id, prompt, options, None)
    }

    pub fn create_run_for_agent(
        &self,
        project_id: &str,
        prompt: &str,
        options: &RunOptions,
        agent_profile_id: Option<&str>,
    ) -> Result<Run> {
        self.create_run_full(project_id, prompt, options, agent_profile_id, None)
    }

    pub fn create_run_full(
        &self,
        project_id: &str,
        prompt: &str,
        options: &RunOptions,
        agent_profile_id: Option<&str>,
        task_id: Option<&str>,
    ) -> Result<Run> {
        let run = Run {
            id: new_id("run"),
            project_id: project_id.to_string(),
            prompt: prompt.to_string(),
            options: options.clone(),
            status: RunStatus::Queued,
            claude_session_id: None,
            model: options.model.clone(),
            started_at: now(),
            ended_at: None,
            cost_usd: None,
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 0,
            num_turns: None,
            stop_reason: None,
            result_text: None,
            error_message: None,
            agent_profile_id: agent_profile_id.map(str::to_string),
            task_id: task_id.map(str::to_string),
            kind: "agent".into(),
        };
        self.insert_run(&run)?;
        Ok(run)
    }

    /// Run de consolidação da memória (Haiku): não é de um membro nem de uma task.
    pub fn create_consolidation_run(
        &self,
        project_id: &str,
        prompt: &str,
        options: &RunOptions,
    ) -> Result<Run> {
        let mut run = self.create_run_full(project_id, prompt, options, None, None)?;
        {
            let conn = self.conn.lock().expect("store mutex");
            conn.execute(
                "UPDATE run SET kind = 'consolidation' WHERE id = ?1",
                params![run.id],
            )?;
        }
        run.kind = "consolidation".into();
        Ok(run)
    }

    fn insert_run(&self, run: &Run) -> Result<()> {
        let conn = self.conn.lock().expect("store mutex");
        conn.execute(
            "INSERT INTO run (id, project_id, prompt, options_json, status, model, started_at, agent_profile_id, task_id, kind)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                run.id,
                run.project_id,
                run.prompt,
                serde_json::to_string(&run.options)?,
                run.status.as_str(),
                run.model,
                run.started_at,
                run.agent_profile_id,
                run.task_id,
                run.kind
            ],
        )?;
        Ok(())
    }

    pub fn get_run(&self, id: &str) -> Result<Option<Run>> {
        let conn = self.conn.lock().expect("store mutex");
        let run = conn
            .query_row(
                &format!("{} WHERE id = ?1", Run::SELECT),
                params![id],
                Run::from_row,
            )
            .optional()?;
        Ok(run)
    }

    pub fn list_runs(&self, project_id: &str, limit: u32) -> Result<Vec<Run>> {
        let conn = self.conn.lock().expect("store mutex");
        let mut stmt = conn.prepare(&format!(
            "{} WHERE project_id = ?1 ORDER BY started_at DESC LIMIT ?2",
            Run::SELECT
        ))?;
        let rows = stmt
            .query_map(params![project_id, limit], Run::from_row)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Soma custo e tokens de todos os runs do projeto (o custo só existe em runs concluídos).
    pub fn project_totals(&self, project_id: &str) -> Result<ProjectTotals> {
        let conn = self.conn.lock().expect("store mutex");
        conn.query_row(
            "SELECT COUNT(*), COALESCE(SUM(cost_usd), 0), COALESCE(SUM(input_tokens), 0),
                    COALESCE(SUM(output_tokens), 0), COALESCE(SUM(cache_read_tokens), 0)
             FROM run WHERE project_id = ?1",
            params![project_id],
            |r| {
                Ok(ProjectTotals {
                    project_id: project_id.to_string(),
                    runs: r.get::<_, i64>(0)? as u64,
                    cost_usd: r.get(1)?,
                    input_tokens: r.get::<_, i64>(2)? as u64,
                    output_tokens: r.get::<_, i64>(3)? as u64,
                    cache_read_tokens: r.get::<_, i64>(4)? as u64,
                })
            },
        )
        .map_err(Into::into)
    }

    pub fn set_run_status(&self, id: &str, status: RunStatus) -> Result<()> {
        let conn = self.conn.lock().expect("store mutex");
        conn.execute(
            "UPDATE run SET status = ?2 WHERE id = ?1",
            params![id, status.as_str()],
        )?;
        Ok(())
    }

    pub fn mark_run_failed(&self, id: &str, message: &str) -> Result<()> {
        let conn = self.conn.lock().expect("store mutex");
        conn.execute(
            "UPDATE run SET status = 'failed', error_message = ?2, ended_at = ?3 WHERE id = ?1",
            params![id, message, now()],
        )?;
        Ok(())
    }

    /// Persiste um evento e atualiza as colunas derivadas do run (sessão, uso, resultado).
    pub fn record_run_event(
        &self,
        run_id: &str,
        seq: u64,
        at: &str,
        event: &RunEvent,
    ) -> Result<()> {
        let mut conn = self.conn.lock().expect("store mutex");
        let tx = conn.transaction()?;
        if event.is_persistent() {
            tx.execute(
                "INSERT OR IGNORE INTO run_event (run_id, seq, at, kind, payload_json) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![run_id, seq as i64, at, event.kind(), serde_json::to_string(event)?],
            )?;
        }
        match event {
            RunEvent::SessionInit {
                session_id, model, ..
            } => {
                tx.execute(
                    "UPDATE run SET claude_session_id = ?2, model = ?3, status = 'running' WHERE id = ?1",
                    params![run_id, session_id, model],
                )?;
                let project_id = run_project_id(&tx, run_id)?;
                Self::audit_in(
                    &tx,
                    "sistema",
                    "run.started",
                    project_id.as_deref(),
                    serde_json::json!({"runId": run_id, "sessionId": session_id, "model": model}),
                )?;
            }
            RunEvent::Usage { usage, .. } => {
                tx.execute(
                    "UPDATE run SET input_tokens = ?2, output_tokens = ?3, cache_read_tokens = ?4 WHERE id = ?1",
                    params![run_id, usage.input_tokens as i64, usage.output_tokens as i64, usage.cache_read_tokens as i64],
                )?;
            }
            RunEvent::PermissionRequest {
                request_id,
                tool_name,
                input,
                reason,
            } => {
                tx.execute(
                    "UPDATE run SET status = 'waiting_approval' WHERE id = ?1",
                    params![run_id],
                )?;
                tx.execute(
                    "INSERT OR IGNORE INTO approval (id, run_id, request_id, tool_name, tool_input_json, reason, requested_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![
                        new_id("appr"),
                        run_id,
                        request_id,
                        tool_name,
                        serde_json::to_string(input)?,
                        reason,
                        at
                    ],
                )?;
            }
            RunEvent::Result {
                session_id,
                is_error,
                cost_usd,
                num_turns,
                usage,
                stop_reason,
                result_text,
                ..
            } => {
                let status = if *is_error {
                    RunStatus::Failed
                } else {
                    RunStatus::Completed
                };
                close_pending_approvals(&tx, run_id)?;
                Self::finish_task_run(&tx, run_id, !*is_error, result_text.as_deref())?;
                let project_id = run_project_id(&tx, run_id)?;
                Self::audit_in(
                    &tx,
                    "sistema",
                    "run.finished",
                    project_id.as_deref(),
                    serde_json::json!({"runId": run_id, "status": status.as_str(), "costUsd": cost_usd, "numTurns": num_turns}),
                )?;
                tx.execute(
                    "UPDATE run SET status = ?2, claude_session_id = COALESCE(NULLIF(?3, ''), claude_session_id),
                        cost_usd = ?4, num_turns = ?5, stop_reason = ?6, result_text = ?7, ended_at = ?8,
                        input_tokens = COALESCE(?9, input_tokens), output_tokens = COALESCE(?10, output_tokens),
                        cache_read_tokens = COALESCE(?11, cache_read_tokens)
                     WHERE id = ?1",
                    params![
                        run_id,
                        status.as_str(),
                        session_id,
                        cost_usd,
                        num_turns.map(|n| n as i64),
                        stop_reason,
                        result_text,
                        now(),
                        usage.as_ref().map(|u| u.input_tokens as i64),
                        usage.as_ref().map(|u| u.output_tokens as i64),
                        usage.as_ref().map(|u| u.cache_read_tokens as i64),
                    ],
                )?;
            }
            RunEvent::Observation {
                kind,
                title,
                body,
                tool_name,
                ..
            } => {
                if let Some(project_id) = run_project_id(&tx, run_id)? {
                    Self::record_observation_in(
                        &tx,
                        &project_id,
                        run_id,
                        *kind,
                        title,
                        body,
                        tool_name.as_deref(),
                        at,
                    )?;
                }
            }
            RunEvent::InstructionsLoaded {
                file_path,
                memory_type,
                load_reason,
            } => {
                if let Some(project_id) = run_project_id(&tx, run_id)? {
                    Self::record_context_event_in(
                        &tx,
                        &project_id,
                        run_id,
                        "instructions",
                        serde_json::json!({"filePath": file_path, "memoryType": memory_type, "loadReason": load_reason}),
                        at,
                    )?;
                }
            }
            RunEvent::BriefInjected { chars, items } => {
                if let Some(project_id) = run_project_id(&tx, run_id)? {
                    Self::record_context_event_in(
                        &tx,
                        &project_id,
                        run_id,
                        "brief",
                        serde_json::json!({"chars": chars, "items": items}),
                        at,
                    )?;
                }
            }
            RunEvent::Compaction {
                phase,
                trigger,
                summary,
            } => {
                if let Some(project_id) = run_project_id(&tx, run_id)? {
                    let kind = match phase {
                        crate::protocol::CompactionPhase::Pre => "compaction_pre",
                        crate::protocol::CompactionPhase::Post => "compaction_post",
                    };
                    Self::record_context_event_in(
                        &tx,
                        &project_id,
                        run_id,
                        kind,
                        serde_json::json!({"trigger": trigger, "summary": summary}),
                        at,
                    )?;
                }
            }
            RunEvent::Error {
                message,
                fatal: true,
            } => {
                close_pending_approvals(&tx, run_id)?;
                Self::finish_task_run(&tx, run_id, false, Some(message))?;
                let project_id = run_project_id(&tx, run_id)?;
                Self::audit_in(
                    &tx,
                    "sistema",
                    "run.failed",
                    project_id.as_deref(),
                    serde_json::json!({"runId": run_id, "message": message}),
                )?;
                tx.execute(
                    "UPDATE run SET status = 'failed', error_message = ?2, ended_at = ?3 WHERE id = ?1",
                    params![run_id, message, now()],
                )?;
            }
            RunEvent::TaskUpdate { status, note, .. } => {
                Self::apply_task_update(&tx, run_id, *status, note.as_deref())?;
            }
            _ => {}
        }
        // Fim do run: consolidação bruta das observações no log de tarefas.
        let consolidated_page = if event.is_terminal() {
            Self::consolidate_run_in(&tx, run_id)?
        } else {
            None
        };
        tx.commit()?;
        drop(conn);
        if let Some(page_id) = consolidated_page {
            self.flush_wiki_page(&page_id)?;
        }
        Ok(())
    }

    // ------------------------------------------------------------------ aprovações

    /// Grava a decisão (e o motivo) de um pedido pendente. Retorna `false` se não havia pendente.
    pub fn record_approval_decision(
        &self,
        run_id: &str,
        request_id: &str,
        decision: &PermissionDecision,
        note: Option<&str>,
    ) -> Result<bool> {
        let (kind, message) = match decision {
            PermissionDecision::Allow { .. } => (ApprovalDecision::Allow, note),
            PermissionDecision::Deny { message } => {
                (ApprovalDecision::Deny, Some(message.as_str()))
            }
        };
        let message = message.map(str::trim).filter(|m| !m.is_empty());
        let mut conn = self.conn.lock().expect("store mutex");
        let tx = conn.transaction()?;
        let changed = tx.execute(
            "UPDATE approval SET decision = ?3, decision_message = ?4, decided_at = ?5
             WHERE run_id = ?1 AND request_id = ?2 AND decision IS NULL",
            params![run_id, request_id, kind.as_str(), message, now()],
        )?;
        if changed > 0 {
            let (project_id, tool_name): (Option<String>, Option<String>) = tx
                .query_row(
                    "SELECT r.project_id, a.tool_name FROM approval a JOIN run r ON r.id = a.run_id WHERE a.run_id = ?1 AND a.request_id = ?2",
                    params![run_id, request_id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?
                .unwrap_or((None, None));
            Self::audit_in(
                &tx,
                "você",
                &format!("approval.{}", kind.as_str()),
                project_id.as_deref(),
                serde_json::json!({"runId": run_id, "requestId": request_id, "tool": tool_name, "message": message}),
            )?;
        }
        tx.commit()?;
        Ok(changed > 0)
    }

    /// Aprovações do projeto: pendentes primeiro, depois as mais recentes.
    pub fn list_approvals(&self, project_id: &str, limit: u32) -> Result<Vec<Approval>> {
        let conn = self.conn.lock().expect("store mutex");
        let mut stmt = conn.prepare(&format!(
            "{} WHERE r.project_id = ?1 ORDER BY (a.decision IS NULL) DESC, a.requested_at DESC LIMIT ?2",
            Approval::SELECT
        ))?;
        let rows = stmt
            .query_map(params![project_id, limit], Approval::from_row)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn list_run_events(&self, run_id: &str) -> Result<Vec<StoredRunEvent>> {
        let conn = self.conn.lock().expect("store mutex");
        let mut stmt = conn.prepare("SELECT run_id, seq, at, kind, payload_json FROM run_event WHERE run_id = ?1 ORDER BY seq")?;
        let rows = stmt
            .query_map(params![run_id], |r| {
                let payload: String = r.get(4)?;
                Ok(StoredRunEvent {
                    run_id: r.get(0)?,
                    seq: r.get::<_, i64>(1)? as u64,
                    at: r.get(2)?,
                    kind: r.get(3)?,
                    event: serde_json::from_str(&payload).map_err(|e| {
                        rusqlite::Error::FromSqlConversionFailure(
                            4,
                            rusqlite::types::Type::Text,
                            Box::new(e),
                        )
                    })?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }
}

fn run_project_id(tx: &rusqlite::Transaction<'_>, run_id: &str) -> Result<Option<String>> {
    Ok(tx
        .query_row(
            "SELECT project_id FROM run WHERE id = ?1",
            params![run_id],
            |r| r.get::<_, String>(0),
        )
        .optional()?)
}

/// Um run que termina leva junto seus pedidos pendentes: o sidecar já os negou.
fn close_pending_approvals(tx: &rusqlite::Transaction<'_>, run_id: &str) -> Result<()> {
    tx.execute(
        "UPDATE approval SET decision = 'deny', decision_message = 'Run encerrado antes da decisão', decided_at = ?2
         WHERE run_id = ?1 AND decision IS NULL",
        params![run_id, now()],
    )?;
    Ok(())
}

pub(crate) fn now() -> String {
    Utc::now().to_rfc3339()
}

pub fn new_id(prefix: &str) -> String {
    format!("{prefix}_{}", uuid::Uuid::new_v4().simple())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::Usage;

    fn store() -> Store {
        Store::open_in_memory().unwrap()
    }

    #[test]
    fn migrations_apply_once_and_are_idempotent() {
        let s = store();
        assert_eq!(
            s.applied_migrations().unwrap(),
            vec![
                "0001_init".to_string(),
                "0002_approvals".to_string(),
                "0003_settings_backups".to_string(),
                "0004_team".to_string(),
                "0005_orchestration".to_string(),
                "0006_audit".to_string(),
                "0007_policy".to_string(),
                "0008_sandbox_budget".to_string(),
                "0009_memory".to_string(),
                "0010_memory_handoff".to_string(),
                "0011_run_kind".to_string(),
                "0012_context_pin".to_string(),
                "0013_mcp_servers".to_string(),
            ]
        );
        // Reaplicar não deve falhar nem duplicar.
        s.migrate().unwrap();
        assert_eq!(s.applied_migrations().unwrap().len(), 13);
    }

    #[test]
    fn open_creates_file_and_parent_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("octopus.db");
        let s = Store::open(&path).unwrap();
        s.create_project("x", "/tmp/x").unwrap();
        drop(s);
        assert!(path.exists());
        let reopened = Store::open(&path).unwrap();
        assert_eq!(reopened.list_projects().unwrap().len(), 1);
    }

    #[test]
    fn project_crud() {
        let s = store();
        let p = s
            .create_project("  chat-core ", "/Users/dev/chat-core")
            .unwrap();
        assert_eq!(p.name, "chat-core");
        assert!(p.id.starts_with("proj_"));
        assert_eq!(s.list_projects().unwrap().len(), 1);
        assert_eq!(
            s.get_project(&p.id).unwrap().unwrap().path,
            "/Users/dev/chat-core"
        );
        assert!(s.delete_project(&p.id).unwrap());
        assert!(!s.delete_project(&p.id).unwrap());
        assert!(s.get_project(&p.id).unwrap().is_none());
    }

    #[test]
    fn run_lifecycle_updates_derived_columns() {
        let s = store();
        let p = s.create_project("p", "/tmp/p").unwrap();
        let options = RunOptions {
            model: Some("claude-opus-5-5".into()),
            max_turns: Some(5),
            ..Default::default()
        };
        let run = s.create_run(&p.id, "olá", &options).unwrap();
        assert_eq!(run.status, RunStatus::Queued);
        assert_eq!(run.options.max_turns, Some(5));

        s.record_run_event(
            &run.id,
            0,
            "2026-10-15T00:00:00Z",
            &RunEvent::SessionInit {
                session_id: "sess-1".into(),
                model: "claude-opus-5-5".into(),
                tools: vec![],
                mcp_servers: vec![],
                permission_mode: None,
            },
        )
        .unwrap();
        let r = s.get_run(&run.id).unwrap().unwrap();
        assert_eq!(r.status, RunStatus::Running);
        assert_eq!(r.claude_session_id.as_deref(), Some("sess-1"));

        // Delta não é persistido como evento.
        s.record_run_event(
            &run.id,
            1,
            "t",
            &RunEvent::AssistantTextDelta {
                text: "x".into(),
                parent_tool_use_id: None,
            },
        )
        .unwrap();
        s.record_run_event(
            &run.id,
            2,
            "t",
            &RunEvent::Usage {
                usage: Usage {
                    input_tokens: 100,
                    output_tokens: 20,
                    cache_read_tokens: 500,
                    cache_creation_tokens: 0,
                },
                context_window: Some(1_000_000),
            },
        )
        .unwrap();
        s.record_run_event(
            &run.id,
            3,
            "t",
            &RunEvent::PermissionRequest {
                request_id: "perm_1".into(),
                tool_name: "Bash".into(),
                input: serde_json::json!({"command": "ls"}),
                reason: None,
            },
        )
        .unwrap();
        assert_eq!(
            s.get_run(&run.id).unwrap().unwrap().status,
            RunStatus::WaitingApproval
        );

        s.record_run_event(
            &run.id,
            4,
            "t",
            &RunEvent::Result {
                session_id: "sess-1".into(),
                subtype: "success".into(),
                is_error: false,
                cost_usd: Some(0.42),
                duration_ms: Some(1000),
                num_turns: Some(3),
                usage: Some(Usage {
                    input_tokens: 120,
                    output_tokens: 40,
                    cache_read_tokens: 600,
                    cache_creation_tokens: 0,
                }),
                stop_reason: Some("end_turn".into()),
                result_text: Some("feito".into()),
            },
        )
        .unwrap();

        let r = s.get_run(&run.id).unwrap().unwrap();
        assert_eq!(r.status, RunStatus::Completed);
        assert_eq!(r.cost_usd, Some(0.42));
        assert_eq!(r.num_turns, Some(3));
        assert_eq!(r.input_tokens, 120);
        assert_eq!(r.cache_read_tokens, 600);
        assert_eq!(r.result_text.as_deref(), Some("feito"));
        assert!(r.ended_at.is_some());

        let events = s.list_run_events(&run.id).unwrap();
        assert_eq!(
            events.iter().map(|e| e.kind.as_str()).collect::<Vec<_>>(),
            vec!["session_init", "usage", "permission_request", "result"]
        );
        assert_eq!(events[0].seq, 0);
        assert!(matches!(events[3].event, RunEvent::Result { .. }));

        let runs = s.list_runs(&p.id, 10).unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].id, run.id);
    }

    #[test]
    fn fatal_error_marks_run_failed() {
        let s = store();
        let p = s.create_project("p", "/tmp/p").unwrap();
        let run = s.create_run(&p.id, "x", &RunOptions::default()).unwrap();
        s.record_run_event(
            &run.id,
            0,
            "t",
            &RunEvent::Error {
                message: "sem credencial".into(),
                fatal: true,
            },
        )
        .unwrap();
        let r = s.get_run(&run.id).unwrap().unwrap();
        assert_eq!(r.status, RunStatus::Failed);
        assert_eq!(r.error_message.as_deref(), Some("sem credencial"));
    }

    #[test]
    fn duplicate_seq_is_ignored() {
        let s = store();
        let p = s.create_project("p", "/tmp/p").unwrap();
        let run = s.create_run(&p.id, "x", &RunOptions::default()).unwrap();
        let ev = RunEvent::AssistantText {
            message_id: None,
            text: "a".into(),
            parent_tool_use_id: None,
        };
        s.record_run_event(&run.id, 0, "t", &ev).unwrap();
        s.record_run_event(&run.id, 0, "t", &ev).unwrap();
        assert_eq!(s.list_run_events(&run.id).unwrap().len(), 1);
    }

    #[test]
    fn deleting_project_cascades_runs() {
        let s = store();
        let p = s.create_project("p", "/tmp/p").unwrap();
        let run = s.create_run(&p.id, "x", &RunOptions::default()).unwrap();
        s.record_run_event(
            &run.id,
            0,
            "t",
            &RunEvent::Error {
                message: "m".into(),
                fatal: false,
            },
        )
        .unwrap();
        s.delete_project(&p.id).unwrap();
        assert!(s.get_run(&run.id).unwrap().is_none());
        assert!(s.list_run_events(&run.id).unwrap().is_empty());
    }

    fn permission(request_id: &str, tool: &str) -> RunEvent {
        RunEvent::PermissionRequest {
            request_id: request_id.into(),
            tool_name: tool.into(),
            input: serde_json::json!({"command": "ls"}),
            reason: Some("fora do modo somente leitura".into()),
        }
    }

    #[test]
    fn approval_lifecycle_pending_then_decided() {
        let s = store();
        let p = s.create_project("p", "/tmp/p").unwrap();
        let run = s.create_run(&p.id, "x", &RunOptions::default()).unwrap();
        s.record_run_event(
            &run.id,
            0,
            "2026-10-16T10:00:00Z",
            &permission("perm_1", "Bash"),
        )
        .unwrap();
        // Reentrega do mesmo evento não duplica.
        s.record_run_event(
            &run.id,
            0,
            "2026-10-16T10:00:00Z",
            &permission("perm_1", "Bash"),
        )
        .unwrap();
        s.record_run_event(
            &run.id,
            1,
            "2026-10-16T10:00:05Z",
            &permission("perm_2", "Edit"),
        )
        .unwrap();

        let list = s.list_approvals(&p.id, 10).unwrap();
        assert_eq!(list.len(), 2);
        assert!(list.iter().all(|a| a.decision.is_none()));
        assert_eq!(list[0].request_id, "perm_2", "mais recente primeiro");
        assert_eq!(list[0].project_id, p.id);
        assert_eq!(list[0].run_prompt, "x");
        assert_eq!(
            list[1].reason.as_deref(),
            Some("fora do modo somente leitura")
        );
        assert_eq!(list[1].tool_input["command"], "ls");

        assert!(s
            .record_approval_decision(
                &run.id,
                "perm_1",
                &PermissionDecision::Deny {
                    message: "sem rede".into()
                },
                None,
            )
            .unwrap());
        assert!(s
            .record_approval_decision(
                &run.id,
                "perm_2",
                &PermissionDecision::Allow {
                    updated_input: None
                },
                Some("  edição esperada  "),
            )
            .unwrap());
        // Já decidida: não muda de novo.
        assert!(!s
            .record_approval_decision(
                &run.id,
                "perm_2",
                &PermissionDecision::Allow {
                    updated_input: None
                },
                None,
            )
            .unwrap());
        assert!(!s
            .record_approval_decision(
                &run.id,
                "inexistente",
                &PermissionDecision::Allow {
                    updated_input: None
                },
                None,
            )
            .unwrap());

        let list = s.list_approvals(&p.id, 10).unwrap();
        let denied = list.iter().find(|a| a.request_id == "perm_1").unwrap();
        assert_eq!(denied.decision, Some(ApprovalDecision::Deny));
        assert_eq!(denied.decision_message.as_deref(), Some("sem rede"));
        assert!(denied.decided_at.is_some());
        let allowed = list.iter().find(|a| a.request_id == "perm_2").unwrap();
        assert_eq!(allowed.decision, Some(ApprovalDecision::Allow));
        assert_eq!(allowed.decision_message.as_deref(), Some("edição esperada"));

        // Pendentes vêm antes das decididas.
        s.record_run_event(
            &run.id,
            2,
            "2026-10-16T09:00:00Z",
            &permission("perm_0", "Write"),
        )
        .unwrap();
        let list = s.list_approvals(&p.id, 10).unwrap();
        assert_eq!(list[0].request_id, "perm_0");

        // Run encerrado fecha o que ficou pendente.
        s.record_run_event(
            &run.id,
            3,
            "t",
            &RunEvent::Error {
                message: "interrompido".into(),
                fatal: true,
            },
        )
        .unwrap();
        let list = s.list_approvals(&p.id, 10).unwrap();
        assert!(list.iter().all(|a| a.decision.is_some()));
        let closed = list.iter().find(|a| a.request_id == "perm_0").unwrap();
        assert_eq!(closed.decision, Some(ApprovalDecision::Deny));
        assert_eq!(
            closed.decision_message.as_deref(),
            Some("Run encerrado antes da decisão")
        );

        // Outro projeto não vê estas aprovações; apagar o projeto apaga tudo.
        let other = s.create_project("o", "/tmp/o").unwrap();
        assert!(s.list_approvals(&other.id, 10).unwrap().is_empty());
        s.delete_project(&p.id).unwrap();
        assert!(s.list_approvals(&p.id, 10).unwrap().is_empty());
    }

    #[test]
    fn project_totals_sum_only_the_projects_runs() {
        let s = store();
        let p = s.create_project("p", "/tmp/p").unwrap();
        let other = s.create_project("o", "/tmp/o").unwrap();
        assert_eq!(
            s.project_totals(&p.id).unwrap(),
            ProjectTotals {
                project_id: p.id.clone(),
                runs: 0,
                cost_usd: 0.0,
                input_tokens: 0,
                output_tokens: 0,
                cache_read_tokens: 0,
            }
        );
        let result = |cost: f64, input: u64| RunEvent::Result {
            session_id: "s".into(),
            subtype: "success".into(),
            is_error: false,
            cost_usd: Some(cost),
            duration_ms: None,
            num_turns: Some(1),
            usage: Some(Usage {
                input_tokens: input,
                output_tokens: 10,
                cache_read_tokens: 100,
                cache_creation_tokens: 0,
            }),
            stop_reason: None,
            result_text: None,
        };
        let r1 = s.create_run(&p.id, "a", &RunOptions::default()).unwrap();
        s.record_run_event(&r1.id, 0, "t", &result(0.25, 1000))
            .unwrap();
        let r2 = s.create_run(&p.id, "b", &RunOptions::default()).unwrap();
        s.record_run_event(&r2.id, 0, "t", &result(0.5, 2000))
            .unwrap();
        // Run ainda sem resultado conta como run, mas não soma custo.
        s.create_run(&p.id, "c", &RunOptions::default()).unwrap();
        let foreign = s
            .create_run(&other.id, "x", &RunOptions::default())
            .unwrap();
        s.record_run_event(&foreign.id, 0, "t", &result(9.0, 9))
            .unwrap();

        let totals = s.project_totals(&p.id).unwrap();
        assert_eq!(totals.runs, 3);
        assert!((totals.cost_usd - 0.75).abs() < 1e-9);
        assert_eq!(totals.input_tokens, 3000);
        assert_eq!(totals.output_tokens, 20);
        assert_eq!(totals.cache_read_tokens, 200);
    }
}
