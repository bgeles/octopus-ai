//! Harness (Fase 5): MCP servers externos registrados no app, com saúde da última checagem.

use anyhow::{Context, Result};
use rusqlite::{params, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

use super::{new_id, now, Store};
use crate::protocol::{McpCheckResult, McpServerConfig};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpHealth {
    pub ok: bool,
    pub tools: Vec<crate::protocol::McpToolInfo>,
    pub error: Option<String>,
    pub latency_ms: Option<u64>,
    pub server_version: Option<String>,
    pub checked_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServer {
    pub id: String,
    /// `None` = global (vale para todos os projetos).
    pub project_id: Option<String>,
    pub name: String,
    pub transport: String,
    pub config: McpServerConfig,
    pub enabled: bool,
    pub last_health: Option<McpHealth>,
    pub created_at: String,
    pub updated_at: String,
}

impl McpServer {
    pub const SELECT: &'static str = "SELECT id, project_id, name, transport, config_json, enabled, last_health_json, created_at, updated_at FROM mcp_server";
    pub(crate) fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        let config: McpServerConfig =
            serde_json::from_str(&row.get::<_, String>(4)?).map_err(|e| {
                rusqlite::Error::FromSqlConversionFailure(
                    4,
                    rusqlite::types::Type::Text,
                    Box::new(e),
                )
            })?;
        let health: Option<McpHealth> = row
            .get::<_, Option<String>>(6)?
            .and_then(|s| serde_json::from_str(&s).ok());
        Ok(Self {
            id: row.get(0)?,
            project_id: row.get(1)?,
            name: row.get(2)?,
            transport: row.get(3)?,
            config,
            enabled: row.get::<_, i64>(5)? != 0,
            last_health: health,
            created_at: row.get(7)?,
            updated_at: row.get(8)?,
        })
    }

    /// Cópia para export/backup: sem valores de env/headers.
    pub fn redacted(&self) -> McpServer {
        McpServer {
            config: self.config.redacted(),
            last_health: None,
            ..self.clone()
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerInput {
    #[serde(default)]
    pub id: Option<String>,
    /// `None` = global.
    #[serde(default)]
    pub project_id: Option<String>,
    pub name: String,
    pub config: McpServerConfig,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool {
    true
}

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

impl Store {
    /// Servidores globais + do projeto, ordenados por nome.
    pub fn list_mcp_servers(&self, project_id: Option<&str>) -> Result<Vec<McpServer>> {
        let conn = self.conn.lock().expect("store mutex");
        let mut stmt = conn.prepare(&format!(
            "{} WHERE project_id IS NULL OR (?1 IS NOT NULL AND project_id = ?1) ORDER BY (project_id IS NOT NULL), name",
            McpServer::SELECT
        ))?;
        let rows = stmt.query_map(params![project_id], McpServer::from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn get_mcp_server(&self, id: &str) -> Result<Option<McpServer>> {
        let conn = self.conn.lock().expect("store mutex");
        Ok(conn
            .query_row(
                &format!("{} WHERE id = ?1", McpServer::SELECT),
                params![id],
                McpServer::from_row,
            )
            .optional()?)
    }

    pub fn save_mcp_server(&self, input: &McpServerInput) -> Result<McpServer> {
        let name = input.name.trim();
        if !valid_name(name) {
            anyhow::bail!("Nome inválido: use letras, números, hífen ou sublinhado (até 64)");
        }
        if name == "octopus" {
            anyhow::bail!("O nome \"octopus\" é do servidor embutido");
        }
        match &input.config {
            McpServerConfig::Stdio { command, .. } if command.trim().is_empty() => {
                anyhow::bail!("O comando não pode ser vazio")
            }
            McpServerConfig::Sse { url, .. } | McpServerConfig::Http { url, .. }
                if !(url.starts_with("http://") || url.starts_with("https://")) =>
            {
                anyhow::bail!("A URL precisa começar com http:// ou https://")
            }
            _ => {}
        }
        if let Some(pid) = &input.project_id {
            if self.get_project(pid)?.is_none() {
                anyhow::bail!("Projeto {pid} não encontrado");
            }
        }
        let ts = now();
        let config_json = serde_json::to_string(&input.config)?;
        let id = {
            let conn = self.conn.lock().expect("store mutex");
            let taken: Option<String> = conn
                .query_row(
                    "SELECT id FROM mcp_server WHERE COALESCE(project_id, '') = COALESCE(?1, '') AND name = ?2",
                    params![input.project_id, name],
                    |r| r.get(0),
                )
                .optional()?;
            match &input.id {
                Some(id) => {
                    if taken.as_deref().is_some_and(|t| t != id) {
                        anyhow::bail!("Já existe um MCP server chamado {name} neste escopo");
                    }
                    let changed = conn.execute(
                        "UPDATE mcp_server SET project_id = ?2, name = ?3, transport = ?4, config_json = ?5, enabled = ?6, updated_at = ?7, last_health_json = NULL WHERE id = ?1",
                        params![id, input.project_id, name, input.config.transport(), config_json, input.enabled as i64, ts],
                    )?;
                    if changed == 0 {
                        anyhow::bail!("MCP server {id} não encontrado");
                    }
                    id.clone()
                }
                None => {
                    if taken.is_some() {
                        anyhow::bail!("Já existe um MCP server chamado {name} neste escopo");
                    }
                    let id = new_id("mcp");
                    conn.execute(
                        "INSERT INTO mcp_server (id, project_id, name, transport, config_json, enabled, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
                        params![id, input.project_id, name, input.config.transport(), config_json, input.enabled as i64, ts],
                    )?;
                    id
                }
            }
        };
        self.get_mcp_server(&id)?
            .context("MCP server recém-gravado sumiu")
    }

    pub fn set_mcp_server_enabled(&self, id: &str, enabled: bool) -> Result<McpServer> {
        {
            let conn = self.conn.lock().expect("store mutex");
            let changed = conn.execute(
                "UPDATE mcp_server SET enabled = ?2, updated_at = ?3 WHERE id = ?1",
                params![id, enabled as i64, now()],
            )?;
            if changed == 0 {
                anyhow::bail!("MCP server {id} não encontrado");
            }
        }
        self.get_mcp_server(id)?.context("MCP server sumiu")
    }

    pub fn delete_mcp_server(&self, id: &str) -> Result<bool> {
        let conn = self.conn.lock().expect("store mutex");
        Ok(conn.execute("DELETE FROM mcp_server WHERE id = ?1", params![id])? > 0)
    }

    pub fn set_mcp_health(&self, id: &str, result: &McpCheckResult) -> Result<McpServer> {
        let health = McpHealth {
            ok: result.ok,
            tools: result.tools.clone(),
            error: result.error.clone(),
            latency_ms: result.latency_ms,
            server_version: result.server_version.clone(),
            checked_at: now(),
        };
        {
            let conn = self.conn.lock().expect("store mutex");
            conn.execute(
                "UPDATE mcp_server SET last_health_json = ?2 WHERE id = ?1",
                params![id, serde_json::to_string(&health)?],
            )?;
        }
        self.get_mcp_server(id)?.context("MCP server sumiu")
    }

    /// Servidores que entram em `options.mcpServers`: os ativos (globais + projeto) ou, quando o
    /// perfil do membro escolheu um subconjunto, só esses (ativos).
    pub fn mcp_servers_for_run(
        &self,
        project_id: &str,
        agent_profile_id: Option<&str>,
    ) -> Result<Option<BTreeMap<String, McpServerConfig>>> {
        let all = self.list_mcp_servers(Some(project_id))?;
        let chosen: Option<Vec<String>> = match agent_profile_id {
            Some(id) => {
                let conn = self.conn.lock().expect("store mutex");
                conn.query_row(
                    "SELECT mcp_server_ids_json FROM agent_profile WHERE id = ?1",
                    params![id],
                    |r| r.get::<_, Option<String>>(0),
                )
                .optional()?
                .flatten()
                .and_then(|s| serde_json::from_str(&s).ok())
            }
            None => None,
        };
        let map: BTreeMap<String, McpServerConfig> = all
            .into_iter()
            .filter(|s| s.enabled)
            .filter(|s| chosen.as_ref().is_none_or(|ids| ids.contains(&s.id)))
            .map(|s| (s.name, s.config))
            .collect();
        Ok(if map.is_empty() { None } else { Some(map) })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stdio(cmd: &str) -> McpServerConfig {
        McpServerConfig::Stdio {
            command: cmd.into(),
            args: Some(vec!["-y".into()]),
            env: Some([("TOKEN".to_string(), "s3cr3t".to_string())].into()),
        }
    }

    #[test]
    fn crud_scope_and_run_selection() {
        let store = Store::open_in_memory().unwrap();
        let project = store.create_project("p", "/tmp/p").unwrap();
        let other = store.create_project("q", "/tmp/q").unwrap();
        let docs = store
            .save_mcp_server(&McpServerInput {
                id: None,
                project_id: None,
                name: "docs".into(),
                config: stdio("npx"),
                enabled: true,
            })
            .unwrap();
        let jira = store
            .save_mcp_server(&McpServerInput {
                id: None,
                project_id: Some(project.id.clone()),
                name: "jira".into(),
                config: McpServerConfig::Http {
                    url: "https://mcp.example.com/jira".into(),
                    headers: Some([("Authorization".to_string(), "Bearer x".to_string())].into()),
                },
                enabled: true,
            })
            .unwrap();
        store
            .save_mcp_server(&McpServerInput {
                id: None,
                project_id: Some(other.id.clone()),
                name: "pg".into(),
                config: stdio("uvx"),
                enabled: true,
            })
            .unwrap();
        assert!(
            store
                .save_mcp_server(&McpServerInput {
                    id: None,
                    project_id: None,
                    name: "docs".into(),
                    config: stdio("x"),
                    enabled: true
                })
                .is_err(),
            "nome duplicado no escopo"
        );
        assert!(store
            .save_mcp_server(&McpServerInput {
                id: None,
                project_id: None,
                name: "octopus".into(),
                config: stdio("x"),
                enabled: true
            })
            .is_err());
        assert!(store
            .save_mcp_server(&McpServerInput {
                id: None,
                project_id: None,
                name: "bad name".into(),
                config: stdio("x"),
                enabled: true
            })
            .is_err());
        assert!(store
            .save_mcp_server(&McpServerInput {
                id: None,
                project_id: None,
                name: "u".into(),
                config: McpServerConfig::Sse {
                    url: "ftp://x".into(),
                    headers: None
                },
                enabled: true
            })
            .is_err());

        let listed = store.list_mcp_servers(Some(&project.id)).unwrap();
        assert_eq!(
            listed.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(),
            vec!["docs", "jira"]
        );
        assert_eq!(store.list_mcp_servers(None).unwrap().len(), 1);

        let servers = store
            .mcp_servers_for_run(&project.id, None)
            .unwrap()
            .unwrap();
        assert_eq!(
            servers.keys().cloned().collect::<Vec<_>>(),
            vec!["docs", "jira"]
        );
        store.set_mcp_server_enabled(&jira.id, false).unwrap();
        assert_eq!(
            store
                .mcp_servers_for_run(&project.id, None)
                .unwrap()
                .unwrap()
                .len(),
            1
        );

        // Export redige segredos; a saúde fica guardada.
        let checked = store
            .set_mcp_health(
                &docs.id,
                &McpCheckResult {
                    ok: true,
                    tools: vec![crate::protocol::McpToolInfo {
                        name: "read_file".into(),
                        description: None,
                    }],
                    error: None,
                    latency_ms: Some(80),
                    server_version: Some("fs 1.0".into()),
                },
            )
            .unwrap();
        assert!(checked.last_health.as_ref().unwrap().ok);
        let red = checked.redacted();
        assert!(red.last_health.is_none());
        if let McpServerConfig::Stdio { env, .. } = &red.config {
            assert_eq!(env.as_ref().unwrap()["TOKEN"], "");
        } else {
            panic!();
        }
        // Editar limpa a saúde; apagar some.
        let edited = store
            .save_mcp_server(&McpServerInput {
                id: Some(docs.id.clone()),
                project_id: None,
                name: "docs2".into(),
                config: stdio("npx"),
                enabled: true,
            })
            .unwrap();
        assert!(edited.last_health.is_none());
        assert_eq!(edited.name, "docs2");
        assert!(store.delete_mcp_server(&docs.id).unwrap());
        assert!(store
            .mcp_servers_for_run(&project.id, None)
            .unwrap()
            .is_none());
    }
}
