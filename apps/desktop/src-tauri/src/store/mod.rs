//! Persistência local em SQLite (rusqlite, bundled).
//!
//! O banco vive em `~/Library/Application Support/ai.octopus.desktop/octopus.db`.
//! Migrations são SQL versionado aplicado em `open()`. Todo acesso passa por `Store`,
//! que serializa escritas com um `Mutex` (SQLite tem um único escritor).

pub mod models;

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::{Context, Result};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};

use crate::protocol::{RunEvent, RunOptions};
use models::{Project, Run, RunStatus, StoredRunEvent};

const MIGRATIONS: &[(&str, &str)] = &[("0001_init", include_str!("migrations/0001_init.sql"))];

pub struct Store {
    conn: Mutex<Connection>,
}

impl Store {
    /// Abre (ou cria) o banco no caminho dado e aplica migrations pendentes.
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("criando {}", parent.display()))?;
        }
        let conn = Connection::open(path).with_context(|| format!("abrindo {}", path.display()))?;
        Self::from_connection(conn)
    }

    /// Banco em memória, para testes.
    pub fn open_in_memory() -> Result<Self> {
        Self::from_connection(Connection::open_in_memory()?)
    }

    fn from_connection(conn: Connection) -> Result<Self> {
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA foreign_keys = ON;
             PRAGMA busy_timeout = 5000;",
        )?;
        let store = Self {
            conn: Mutex::new(conn),
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
        };
        let conn = self.conn.lock().expect("store mutex");
        conn.execute(
            "INSERT INTO project (id, name, path, auth_mode, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![project.id, project.name, project.path, project.auth_mode.as_str(), project.created_at],
        )?;
        Ok(project)
    }

    pub fn list_projects(&self) -> Result<Vec<Project>> {
        let conn = self.conn.lock().expect("store mutex");
        let mut stmt = conn.prepare(
            "SELECT id, name, path, auth_mode, created_at FROM project ORDER BY created_at DESC",
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
                "SELECT id, name, path, auth_mode, created_at FROM project WHERE id = ?1",
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
        };
        let conn = self.conn.lock().expect("store mutex");
        conn.execute(
            "INSERT INTO run (id, project_id, prompt, options_json, status, model, started_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                run.id,
                run.project_id,
                run.prompt,
                serde_json::to_string(&run.options)?,
                run.status.as_str(),
                run.model,
                run.started_at
            ],
        )?;
        Ok(run)
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
            }
            RunEvent::Usage { usage, .. } => {
                tx.execute(
                    "UPDATE run SET input_tokens = ?2, output_tokens = ?3, cache_read_tokens = ?4 WHERE id = ?1",
                    params![run_id, usage.input_tokens as i64, usage.output_tokens as i64, usage.cache_read_tokens as i64],
                )?;
            }
            RunEvent::PermissionRequest { .. } => {
                tx.execute(
                    "UPDATE run SET status = 'waiting_approval' WHERE id = ?1",
                    params![run_id],
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
            RunEvent::Error {
                message,
                fatal: true,
            } => {
                tx.execute(
                    "UPDATE run SET status = 'failed', error_message = ?2, ended_at = ?3 WHERE id = ?1",
                    params![run_id, message, now()],
                )?;
            }
            _ => {}
        }
        tx.commit()?;
        Ok(())
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

fn now() -> String {
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
            vec!["0001_init".to_string()]
        );
        // Reaplicar não deve falhar nem duplicar.
        s.migrate().unwrap();
        assert_eq!(s.applied_migrations().unwrap().len(), 1);
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
}
