//! Hooks livres (Harness → Hooks): comandos de shell do usuário que o sidecar roda em eventos do
//! agente, além dos hooks declarativos (política, memória, brief). Globais ou de um projeto.
//! O que um hook pode fazer no run é filtrado no sidecar (`customHooks.ts`): só aperta.

use anyhow::{Context, Result};
use rusqlite::{params, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

use super::{new_id, now, Store};
use crate::protocol::{CustomHook, CustomHookEvent};

/// Tempo limite máximo de um hook (o SDK também corta pelo `timeout` do matcher).
pub const MAX_TIMEOUT_SEC: u32 = 600;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomHookRecord {
    pub id: String,
    /// `None` = vale para todos os projetos.
    pub project_id: Option<String>,
    pub name: String,
    pub event: CustomHookEvent,
    pub matcher: Option<String>,
    pub command: String,
    pub timeout_sec: u32,
    pub enabled: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomHookInput {
    /// Ausente = novo hook.
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub project_id: Option<String>,
    pub name: String,
    pub event: CustomHookEvent,
    #[serde(default)]
    pub matcher: Option<String>,
    pub command: String,
    #[serde(default = "default_timeout")]
    pub timeout_sec: u32,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
}

fn default_timeout() -> u32 {
    30
}

fn default_enabled() -> bool {
    true
}

impl CustomHookRecord {
    pub const SELECT: &'static str = "SELECT id, project_id, name, event, matcher, command, timeout_sec, enabled, created_at, updated_at FROM custom_hook";

    pub(crate) fn from_row(r: &Row<'_>) -> rusqlite::Result<Self> {
        let event: String = r.get(3)?;
        Ok(CustomHookRecord {
            id: r.get(0)?,
            project_id: r.get(1)?,
            name: r.get(2)?,
            event: CustomHookEvent::parse(&event).ok_or_else(|| {
                rusqlite::Error::FromSqlConversionFailure(
                    3,
                    rusqlite::types::Type::Text,
                    format!("evento de hook desconhecido: {event}").into(),
                )
            })?,
            matcher: r.get(4)?,
            command: r.get(5)?,
            timeout_sec: r.get::<_, i64>(6)? as u32,
            enabled: r.get::<_, i64>(7)? != 0,
            created_at: r.get(8)?,
            updated_at: r.get(9)?,
        })
    }

    /// Forma enviada ao sidecar.
    pub fn to_hook(&self) -> CustomHook {
        CustomHook {
            id: self.id.clone(),
            name: self.name.clone(),
            event: self.event,
            matcher: self.matcher.clone().filter(|_| self.event.is_tool_event()),
            command: self.command.clone(),
            timeout_sec: self.timeout_sec,
        }
    }
}

/// Normaliza e valida a entrada: nome e comando obrigatórios, regex válida, tempo limite razoável.
fn validate(input: &CustomHookInput) -> Result<(String, Option<String>, String)> {
    let name = input.name.trim().to_string();
    if name.is_empty() || name.chars().count() > 80 {
        anyhow::bail!("Dê um nome ao hook (até 80 caracteres)");
    }
    let command = input.command.trim().to_string();
    if command.is_empty() {
        anyhow::bail!("O comando não pode ser vazio");
    }
    if input.timeout_sec == 0 || input.timeout_sec > MAX_TIMEOUT_SEC {
        anyhow::bail!("O tempo limite vai de 1 a {MAX_TIMEOUT_SEC} segundos");
    }
    let matcher = input
        .matcher
        .as_deref()
        .map(str::trim)
        .filter(|m| !m.is_empty() && *m != "*")
        .map(str::to_string);
    if let Some(m) = &matcher {
        if !input.event.is_tool_event() {
            anyhow::bail!(
                "Filtro de ferramentas só vale para PreToolUse e PostToolUse; deixe em branco em {}",
                input.event.as_str()
            );
        }
        regex::Regex::new(m).with_context(|| format!("Regex inválida no filtro: {m}"))?;
    }
    Ok((name, matcher, command))
}

/// Valida um hook ainda não salvo (formulário) e devolve a forma que o sidecar roda.
pub fn draft_hook(input: &CustomHookInput) -> Result<CustomHook> {
    let (name, matcher, command) = validate(input)?;
    Ok(CustomHook {
        id: input.id.clone().unwrap_or_else(|| "hook_rascunho".into()),
        name,
        event: input.event,
        matcher,
        command,
        timeout_sec: input.timeout_sec,
    })
}

impl Store {
    /// Hooks globais e (com `project_id`) os do projeto, na ordem em que rodam.
    pub fn list_custom_hooks(&self, project_id: Option<&str>) -> Result<Vec<CustomHookRecord>> {
        let conn = self.conn.lock().expect("store mutex");
        let mut stmt = conn.prepare(&format!(
            "{} WHERE project_id IS NULL OR project_id = ?1 ORDER BY (project_id IS NOT NULL), created_at, id",
            CustomHookRecord::SELECT
        ))?;
        let rows = stmt
            .query_map(params![project_id], CustomHookRecord::from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub(crate) fn list_all_custom_hooks(&self) -> Result<Vec<CustomHookRecord>> {
        let conn = self.conn.lock().expect("store mutex");
        let mut stmt = conn.prepare(&format!(
            "{} ORDER BY (project_id IS NOT NULL), created_at, id",
            CustomHookRecord::SELECT
        ))?;
        let rows = stmt
            .query_map([], CustomHookRecord::from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn get_custom_hook(&self, id: &str) -> Result<Option<CustomHookRecord>> {
        let conn = self.conn.lock().expect("store mutex");
        Ok(conn
            .query_row(
                &format!("{} WHERE id = ?1", CustomHookRecord::SELECT),
                params![id],
                CustomHookRecord::from_row,
            )
            .optional()?)
    }

    pub fn save_custom_hook(&self, input: &CustomHookInput) -> Result<CustomHookRecord> {
        let (name, matcher, command) = validate(input)?;
        if let Some(pid) = &input.project_id {
            if self.get_project(pid)?.is_none() {
                anyhow::bail!("Projeto {pid} não encontrado");
            }
        }
        let ts = now();
        let id = {
            let conn = self.conn.lock().expect("store mutex");
            match &input.id {
                Some(id) => {
                    let changed = conn.execute(
                        "UPDATE custom_hook SET project_id = ?2, name = ?3, event = ?4, matcher = ?5, command = ?6, timeout_sec = ?7, enabled = ?8, updated_at = ?9 WHERE id = ?1",
                        params![id, input.project_id, name, input.event.as_str(), matcher, command, input.timeout_sec as i64, input.enabled as i64, ts],
                    )?;
                    if changed == 0 {
                        anyhow::bail!("Hook {id} não encontrado");
                    }
                    id.clone()
                }
                None => {
                    let id = new_id("hook");
                    conn.execute(
                        "INSERT INTO custom_hook (id, project_id, name, event, matcher, command, timeout_sec, enabled, created_at, updated_at)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
                        params![id, input.project_id, name, input.event.as_str(), matcher, command, input.timeout_sec as i64, input.enabled as i64, ts],
                    )?;
                    id
                }
            }
        };
        self.get_custom_hook(&id)?.context("hook sumiu após salvar")
    }

    pub fn set_custom_hook_enabled(&self, id: &str, enabled: bool) -> Result<CustomHookRecord> {
        {
            let conn = self.conn.lock().expect("store mutex");
            let changed = conn.execute(
                "UPDATE custom_hook SET enabled = ?2, updated_at = ?3 WHERE id = ?1",
                params![id, enabled as i64, now()],
            )?;
            if changed == 0 {
                anyhow::bail!("Hook {id} não encontrado");
            }
        }
        self.get_custom_hook(id)?.context("hook sumiu")
    }

    pub fn delete_custom_hook(&self, id: &str) -> Result<bool> {
        let conn = self.conn.lock().expect("store mutex");
        Ok(conn.execute("DELETE FROM custom_hook WHERE id = ?1", params![id])? > 0)
    }

    /// Hooks ativos que vão para um run do projeto (`None` se não há nenhum).
    pub fn custom_hooks_for_run(&self, project_id: &str) -> Result<Option<Vec<CustomHook>>> {
        let hooks: Vec<CustomHook> = self
            .list_custom_hooks(Some(project_id))?
            .into_iter()
            .filter(|h| h.enabled)
            .map(|h| h.to_hook())
            .collect();
        Ok(if hooks.is_empty() { None } else { Some(hooks) })
    }
}

/// Entrada de exemplo para "Testar com exemplo": o mesmo formato que o SDK manda ao hook.
pub fn sample_input(
    event: CustomHookEvent,
    cwd: &str,
    tool_name: Option<&str>,
    tool_input: Option<&serde_json::Value>,
) -> serde_json::Value {
    let mut input = serde_json::json!({
        "session_id": "teste",
        "transcript_path": "",
        "cwd": cwd,
        "hook_event_name": event.as_str(),
    });
    let obj = input.as_object_mut().expect("objeto");
    match event {
        CustomHookEvent::PreToolUse | CustomHookEvent::PostToolUse => {
            obj.insert("tool_name".into(), tool_name.unwrap_or("Bash").into());
            obj.insert(
                "tool_input".into(),
                tool_input
                    .cloned()
                    .unwrap_or_else(|| serde_json::json!({"command": "ls"})),
            );
            obj.insert("tool_use_id".into(), "toolu_teste".into());
            if event == CustomHookEvent::PostToolUse {
                obj.insert("tool_response".into(), serde_json::json!({"stdout": "ok"}));
            }
        }
        CustomHookEvent::UserPromptSubmit => {
            obj.insert("prompt".into(), "crie a migração V14".into());
        }
        CustomHookEvent::Stop | CustomHookEvent::SubagentStop => {
            obj.insert("stop_hook_active".into(), false.into());
        }
        CustomHookEvent::SessionStart => {
            obj.insert("source".into(), "startup".into());
        }
        CustomHookEvent::SessionEnd => {
            obj.insert("reason".into(), "other".into());
        }
        CustomHookEvent::Notification => {
            obj.insert("message".into(), "Claude precisa da sua permissão".into());
        }
        CustomHookEvent::PreCompact => {
            obj.insert("trigger".into(), "manual".into());
            obj.insert("custom_instructions".into(), "".into());
        }
    }
    input
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(event: CustomHookEvent, matcher: Option<&str>) -> CustomHookInput {
        CustomHookInput {
            id: None,
            project_id: None,
            name: "Guarda".into(),
            event,
            matcher: matcher.map(str::to_string),
            command: "scripts/guard.sh".into(),
            timeout_sec: 30,
            enabled: true,
        }
    }

    #[test]
    fn crud_scopes_and_run_selection() {
        let s = Store::open_in_memory().unwrap();
        let p = s.create_project("p", "/tmp/p").unwrap();
        let q = s.create_project("q", "/tmp/q").unwrap();
        let global = s
            .save_custom_hook(&input(CustomHookEvent::Stop, None))
            .unwrap();
        let local = s
            .save_custom_hook(&CustomHookInput {
                project_id: Some(p.id.clone()),
                name: "  Bloquear migração  ".into(),
                ..input(CustomHookEvent::PreToolUse, Some("Bash|Write"))
            })
            .unwrap();
        assert_eq!(local.name, "Bloquear migração");
        assert_eq!(
            s.list_custom_hooks(Some(&p.id))
                .unwrap()
                .iter()
                .map(|h| h.id.clone())
                .collect::<Vec<_>>(),
            vec![global.id.clone(), local.id.clone()],
            "globais primeiro"
        );
        assert_eq!(s.list_custom_hooks(Some(&q.id)).unwrap().len(), 1);

        let for_run = s.custom_hooks_for_run(&p.id).unwrap().unwrap();
        assert_eq!(for_run.len(), 2);
        assert_eq!(for_run[1].matcher.as_deref(), Some("Bash|Write"));

        // Desligar tira do run; sem nenhum ativo, nada vai para o SDK.
        s.set_custom_hook_enabled(&global.id, false).unwrap();
        assert_eq!(s.custom_hooks_for_run(&q.id).unwrap(), None);

        // Editar mantém o id e troca os campos.
        let edited = s
            .save_custom_hook(&CustomHookInput {
                id: Some(local.id.clone()),
                project_id: Some(p.id.clone()),
                command: "true".into(),
                timeout_sec: 5,
                ..input(CustomHookEvent::PostToolUse, Some("*"))
            })
            .unwrap();
        assert_eq!(edited.id, local.id);
        assert_eq!(edited.event, CustomHookEvent::PostToolUse);
        assert_eq!(edited.matcher, None, "* = todas");
        assert!(s.delete_custom_hook(&local.id).unwrap());
        assert!(!s.delete_custom_hook(&local.id).unwrap());
        // Apagar o projeto leva os hooks dele.
        let other = s
            .save_custom_hook(&CustomHookInput {
                project_id: Some(q.id.clone()),
                ..input(CustomHookEvent::Stop, None)
            })
            .unwrap();
        s.delete_project(&q.id).unwrap();
        assert!(s.get_custom_hook(&other.id).unwrap().is_none());
    }

    #[test]
    fn rejects_invalid_hooks() {
        let s = Store::open_in_memory().unwrap();
        let bad = |i: CustomHookInput| s.save_custom_hook(&i).unwrap_err().to_string();
        assert!(bad(CustomHookInput {
            name: " ".into(),
            ..input(CustomHookEvent::Stop, None)
        })
        .contains("nome"));
        assert!(bad(CustomHookInput {
            command: "  ".into(),
            ..input(CustomHookEvent::Stop, None)
        })
        .contains("comando"));
        assert!(bad(input(CustomHookEvent::PreToolUse, Some("Bash("))).contains("Regex inválida"));
        assert!(bad(input(CustomHookEvent::Stop, Some("Bash"))).contains("só vale"));
        assert!(bad(CustomHookInput {
            timeout_sec: 0,
            ..input(CustomHookEvent::Stop, None)
        })
        .contains("tempo limite"));
        assert!(bad(CustomHookInput {
            project_id: Some("proj_x".into()),
            ..input(CustomHookEvent::Stop, None)
        })
        .contains("não encontrado"));
    }

    #[test]
    fn blocked_runs_are_audited_listed_in_preview_and_backed_up() {
        use crate::protocol::{RunEvent, RunOptions};
        let s = Store::open_in_memory().unwrap();
        let p = s.create_project("p", "/tmp/p").unwrap();
        let hook = s
            .save_custom_hook(&CustomHookInput {
                project_id: Some(p.id.clone()),
                ..input(CustomHookEvent::PreToolUse, Some("Bash"))
            })
            .unwrap();
        // O evento chega do sidecar no formato do protocolo TS.
        let event: RunEvent = serde_json::from_value(serde_json::json!({
            "type": "hook_ran", "hookId": hook.id, "name": "Guarda", "event": "PreToolUse",
            "toolName": "Bash", "outcome": "blocked", "exitCode": 2, "durationMs": 9, "message": "proibido"
        }))
        .unwrap();
        let ok: RunEvent = serde_json::from_value(serde_json::json!({
            "type": "hook_ran", "hookId": hook.id, "name": "Guarda", "event": "PreToolUse",
            "outcome": "ok", "durationMs": 3
        }))
        .unwrap();
        let run = s.create_run(&p.id, "x", &RunOptions::default()).unwrap();
        s.record_run_event(&run.id, 1, "t", &ok).unwrap();
        s.record_run_event(&run.id, 2, "t", &event).unwrap();
        let audited = s.list_audit_events(Some(&p.id), Some("hook."), 10).unwrap();
        assert_eq!(audited.len(), 1, "só o bloqueio vai para a auditoria");
        assert_eq!(audited[0].payload["message"], "proibido");
        assert_eq!(s.list_run_events(&run.id).unwrap().len(), 2);

        let preview = s
            .preview_run_options(
                &crate::secrets::MemorySecrets::default(),
                &p.id,
                None,
                "oi",
                &RunOptions::default(),
            )
            .unwrap();
        assert!(preview
            .hooks
            .iter()
            .any(|h| h.event == "PreToolUse · Bash" && h.origin == "Harness · Hooks"));
        assert_eq!(preview.options.custom_hooks.as_ref().unwrap().len(), 1);

        // Backup: sai no export e volta num banco novo.
        let export = s.export_config("t").unwrap();
        assert_eq!(export.custom_hooks.len(), 1);
        let other = Store::open_in_memory().unwrap();
        let result = other
            .import_config(&export, crate::store::config::ImportMode::Merge)
            .unwrap();
        assert_eq!(result.custom_hooks_applied, 1);
        assert_eq!(
            other.list_custom_hooks(Some(&p.id)).unwrap()[0].command,
            "scripts/guard.sh"
        );
    }

    #[test]
    fn sample_input_matches_the_sdk_shape() {
        let pre = sample_input(CustomHookEvent::PreToolUse, "/tmp/p", Some("Write"), None);
        assert_eq!(pre["hook_event_name"], "PreToolUse");
        assert_eq!(pre["tool_name"], "Write");
        assert_eq!(pre["cwd"], "/tmp/p");
        let prompt = sample_input(CustomHookEvent::UserPromptSubmit, "/tmp/p", None, None);
        assert!(prompt["prompt"].is_string());
        assert!(prompt.get("tool_name").is_none());
    }
}
