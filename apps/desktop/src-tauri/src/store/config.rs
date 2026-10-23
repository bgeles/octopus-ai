//! Backup local de configurações: export/import em JSON legível e cópias versionadas em disco.
//!
//! O export cobre só configuração (projetos, preferências e, nas fases seguintes, cargos, time,
//! workflows etc.). Nunca inclui runs, eventos, aprovações, chaves ou memória.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::models::{AuthMode, Project};
use super::team::{AgentProfile, Role, RoleScope};
use super::{new_id, now, Store};

/// Versão do formato do arquivo exportado. Incrementa em mudanças incompatíveis.
pub const CONFIG_SCHEMA_VERSION: u32 = 1;
/// Quantas cópias automáticas ficam guardadas.
pub const MAX_SNAPSHOTS: usize = 20;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigExport {
    pub schema_version: u32,
    pub exported_at: String,
    pub app_version: String,
    #[serde(default)]
    pub settings: BTreeMap<String, Value>,
    #[serde(default)]
    pub projects: Vec<Project>,
    /// Cargos do catálogo e dos projetos (sem segredos).
    #[serde(default)]
    pub roles: Vec<Role>,
    #[serde(default)]
    pub agent_profiles: Vec<AgentProfile>,
    #[serde(default)]
    pub team_members: Vec<TeamMemberRecord>,
    /// MCP servers (globais e dos projetos) sem valores de env/headers.
    #[serde(default)]
    pub mcp_servers: Vec<super::harness::McpServer>,
    /// Hooks livres (Harness → Hooks), globais e dos projetos.
    #[serde(default)]
    pub custom_hooks: Vec<super::hooks::CustomHookRecord>,
}

/// Linha crua de `team_member` (o export não resolve perfil/cargo, só ids).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamMemberRecord {
    pub id: String,
    pub project_id: String,
    pub agent_profile_id: String,
    pub reports_to_agent_id: Option<String>,
    pub position: i64,
    pub created_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ImportMode {
    /// Acrescenta o que não existe; mantém o que já está igual ou em conflito.
    Merge,
    /// O arquivo passa a ser a verdade: atualiza, acrescenta e remove o que não está nele.
    Replace,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    pub schema_version: u32,
    pub exported_at: String,
    pub projects_new: Vec<String>,
    pub projects_same: Vec<String>,
    /// Mesmo id ou mesma pasta, dados diferentes.
    pub projects_conflict: Vec<String>,
    /// Projetos locais ausentes do arquivo (removidos no modo `replace`, junto com o histórico).
    pub projects_removed: Vec<String>,
    pub settings: usize,
    #[serde(default)]
    pub roles: usize,
    #[serde(default)]
    pub team_members: usize,
    #[serde(default)]
    pub mcp_servers: usize,
    #[serde(default)]
    pub custom_hooks: usize,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub projects_added: usize,
    pub projects_updated: usize,
    pub projects_removed: usize,
    pub settings_applied: usize,
    #[serde(default)]
    pub roles_applied: usize,
    #[serde(default)]
    pub team_members_applied: usize,
    #[serde(default)]
    pub mcp_servers_applied: usize,
    #[serde(default)]
    pub custom_hooks_applied: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SnapshotReason {
    Auto,
    Manual,
    PreRestore,
}

impl SnapshotReason {
    pub fn as_str(&self) -> &'static str {
        match self {
            SnapshotReason::Auto => "auto",
            SnapshotReason::Manual => "manual",
            SnapshotReason::PreRestore => "pre-restore",
        }
    }
    fn parse(value: &str) -> Self {
        match value {
            "manual" => SnapshotReason::Manual,
            "pre-restore" => SnapshotReason::PreRestore,
            _ => SnapshotReason::Auto,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupSnapshot {
    pub id: String,
    pub created_at: String,
    pub path: String,
    pub schema_version: u32,
    pub reason: SnapshotReason,
    pub size_bytes: u64,
}

impl Store {
    // ------------------------------------------------------------------ preferências

    pub fn get_setting(&self, key: &str) -> Result<Option<Value>> {
        let conn = self.conn.lock().expect("store mutex");
        let raw: Option<String> = conn
            .query_row(
                "SELECT value_json FROM app_setting WHERE key = ?1",
                params![key],
                |r| r.get(0),
            )
            .optional()?;
        Ok(raw.map(|s| serde_json::from_str(&s)).transpose()?)
    }

    pub fn set_setting(&self, key: &str, value: &Value) -> Result<()> {
        let conn = self.conn.lock().expect("store mutex");
        conn.execute(
            "INSERT INTO app_setting (key, value_json, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
            params![key, serde_json::to_string(value)?, now()],
        )?;
        Ok(())
    }

    pub fn delete_setting(&self, key: &str) -> Result<bool> {
        let conn = self.conn.lock().expect("store mutex");
        Ok(conn.execute("DELETE FROM app_setting WHERE key = ?1", params![key])? > 0)
    }

    pub fn list_settings(&self) -> Result<BTreeMap<String, Value>> {
        let conn = self.conn.lock().expect("store mutex");
        let mut stmt = conn.prepare("SELECT key, value_json FROM app_setting ORDER BY key")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        let mut map = BTreeMap::new();
        for row in rows {
            let (key, raw) = row?;
            map.insert(key, serde_json::from_str(&raw)?);
        }
        Ok(map)
    }

    // ------------------------------------------------------------------ export / import

    pub fn export_config(&self, app_version: &str) -> Result<ConfigExport> {
        Ok(ConfigExport {
            schema_version: CONFIG_SCHEMA_VERSION,
            exported_at: now(),
            app_version: app_version.to_string(),
            settings: self.list_settings()?,
            projects: self.list_projects()?,
            roles: self.all_roles()?,
            agent_profiles: self.all_agent_profiles()?,
            team_members: self.all_team_member_records()?,
            mcp_servers: self
                .list_all_mcp_servers()?
                .iter()
                .map(|s| s.redacted())
                .collect(),
            custom_hooks: self.list_all_custom_hooks()?,
        })
    }

    fn list_all_mcp_servers(&self) -> Result<Vec<super::harness::McpServer>> {
        let conn = self.conn.lock().expect("store mutex");
        let mut stmt = conn.prepare(&format!(
            "{} ORDER BY (project_id IS NOT NULL), name",
            super::harness::McpServer::SELECT
        ))?;
        let rows = stmt
            .query_map([], super::harness::McpServer::from_row)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    fn all_roles(&self) -> Result<Vec<Role>> {
        let conn = self.conn.lock().expect("store mutex");
        let mut stmt = conn.prepare("SELECT id, scope, project_id, title, specialty, responsibilities_md, default_model, default_permission_mode, default_tools_json, icon, position, created_at, updated_at, default_autonomy, default_can_assign_tasks, default_can_approve FROM role ORDER BY position, title")?;
        let rows = stmt
            .query_map([], Role::from_row_pub)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    fn all_agent_profiles(&self) -> Result<Vec<AgentProfile>> {
        let conn = self.conn.lock().expect("store mutex");
        let mut stmt = conn.prepare("SELECT id, project_id, role_id, name, avatar_seed, instructions_md, model, permission_mode, allowed_tools_json, max_turns, max_budget_usd, created_at, mcp_server_ids_json, skill_ids_json, effort, autonomy, can_assign_tasks, can_approve FROM agent_profile ORDER BY created_at")?;
        let rows = stmt
            .query_map([], AgentProfile::from_row_pub)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    fn all_team_member_records(&self) -> Result<Vec<TeamMemberRecord>> {
        let conn = self.conn.lock().expect("store mutex");
        let mut stmt = conn.prepare("SELECT id, project_id, agent_profile_id, reports_to_agent_id, position, created_at FROM team_member ORDER BY project_id, position")?;
        let rows = stmt
            .query_map([], |r| {
                Ok(TeamMemberRecord {
                    id: r.get(0)?,
                    project_id: r.get(1)?,
                    agent_profile_id: r.get(2)?,
                    reports_to_agent_id: r.get(3)?,
                    position: r.get(4)?,
                    created_at: r.get(5)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn preview_import(&self, export: &ConfigExport) -> Result<ImportPreview> {
        let local = self.list_projects()?;
        let mut preview = ImportPreview {
            schema_version: export.schema_version,
            exported_at: export.exported_at.clone(),
            settings: export.settings.len(),
            roles: export.roles.len(),
            team_members: export.team_members.len(),
            mcp_servers: export.mcp_servers.len(),
            custom_hooks: export.custom_hooks.len(),
            ..Default::default()
        };
        for incoming in &export.projects {
            match local
                .iter()
                .find(|p| p.id == incoming.id || p.path == incoming.path)
            {
                None => preview.projects_new.push(incoming.name.clone()),
                Some(existing) if same_project(existing, incoming) => {
                    preview.projects_same.push(incoming.name.clone())
                }
                Some(existing) => preview
                    .projects_conflict
                    .push(format!("{} ↔ {}", incoming.name, existing.name)),
            }
        }
        for existing in &local {
            if !export
                .projects
                .iter()
                .any(|p| p.id == existing.id || p.path == existing.path)
            {
                preview.projects_removed.push(existing.name.clone());
            }
        }
        Ok(preview)
    }

    pub fn import_config(&self, export: &ConfigExport, mode: ImportMode) -> Result<ImportResult> {
        if export.schema_version > CONFIG_SCHEMA_VERSION {
            anyhow::bail!(
                "arquivo exportado por uma versão mais nova (schema {}); esta versão lê até {}",
                export.schema_version,
                CONFIG_SCHEMA_VERSION
            );
        }
        let local = self.list_projects()?;
        let mut result = ImportResult::default();
        {
            let mut conn = self.conn.lock().expect("store mutex");
            let tx = conn.transaction()?;
            for incoming in &export.projects {
                let existing = local
                    .iter()
                    .find(|p| p.id == incoming.id || p.path == incoming.path);
                match (existing, mode) {
                    (None, _) => {
                        tx.execute(
                            "INSERT INTO project (id, name, path, auth_mode, created_at, sandbox_profile_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                            params![incoming.id, incoming.name, incoming.path, incoming.auth_mode.as_str(), incoming.created_at, incoming.sandbox_profile_id.clone().unwrap_or_else(|| "sandbox_dev".into())],
                        )?;
                        result.projects_added += 1;
                    }
                    (Some(existing), ImportMode::Replace) if !same_project(existing, incoming) => {
                        tx.execute(
                            "UPDATE project SET name = ?2, path = ?3, auth_mode = ?4 WHERE id = ?1",
                            params![
                                existing.id,
                                incoming.name,
                                incoming.path,
                                incoming.auth_mode.as_str()
                            ],
                        )?;
                        result.projects_updated += 1;
                    }
                    _ => {}
                }
            }
            if mode == ImportMode::Replace {
                for existing in &local {
                    if !export
                        .projects
                        .iter()
                        .any(|p| p.id == existing.id || p.path == existing.path)
                    {
                        tx.execute("DELETE FROM project WHERE id = ?1", params![existing.id])?;
                        result.projects_removed += 1;
                    }
                }
                tx.execute("DELETE FROM app_setting", [])?;
            }
            for (key, value) in &export.settings {
                tx.execute(
                    "INSERT INTO app_setting (key, value_json, updated_at) VALUES (?1, ?2, ?3)
                     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
                    params![key, serde_json::to_string(value)?, now()],
                )?;
                result.settings_applied += 1;
            }
            // Cargos, perfis e membros: por id. Merge só acrescenta; replace sobrescreve e remove os ausentes.
            let upsert_role = |tx: &rusqlite::Transaction<'_>,
                               r: &Role,
                               replace: bool|
             -> Result<usize> {
                let scope = match r.scope {
                    RoleScope::Global => "global",
                    RoleScope::Project => "project",
                };
                let mode = serde_json::to_value(r.default_permission_mode)?;
                let mode = mode.as_str().map(str::to_string);
                let tools = r
                    .default_tools
                    .as_ref()
                    .map(serde_json::to_string)
                    .transpose()?;
                let sql = if replace {
                    "INSERT INTO role (id, scope, project_id, title, specialty, responsibilities_md, default_model, default_permission_mode, default_tools_json, icon, position, created_at, updated_at, default_autonomy, default_can_assign_tasks, default_can_approve)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
                     ON CONFLICT(id) DO UPDATE SET scope = excluded.scope, project_id = excluded.project_id, title = excluded.title, specialty = excluded.specialty,
                        responsibilities_md = excluded.responsibilities_md, default_model = excluded.default_model, default_permission_mode = excluded.default_permission_mode,
                        default_tools_json = excluded.default_tools_json, icon = excluded.icon, position = excluded.position, updated_at = excluded.updated_at,
                        default_autonomy = excluded.default_autonomy, default_can_assign_tasks = excluded.default_can_assign_tasks, default_can_approve = excluded.default_can_approve"
                } else {
                    "INSERT OR IGNORE INTO role (id, scope, project_id, title, specialty, responsibilities_md, default_model, default_permission_mode, default_tools_json, icon, position, created_at, updated_at, default_autonomy, default_can_assign_tasks, default_can_approve)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)"
                };
                Ok(tx.execute(
                    sql,
                    params![
                        r.id,
                        scope,
                        r.project_id,
                        r.title,
                        r.specialty,
                        r.responsibilities_md,
                        r.default_model,
                        mode,
                        tools,
                        r.icon,
                        r.position,
                        r.created_at,
                        r.updated_at,
                        r.default_autonomy.map(|a| a.as_str()),
                        r.default_can_assign_tasks.map(i64::from),
                        r.default_can_approve.map(i64::from)
                    ],
                )?)
            };
            let replace = mode == ImportMode::Replace;
            for role in &export.roles {
                // Cargos de projeto só entram se o projeto existir após o passo anterior.
                if let Some(pid) = &role.project_id {
                    let exists: i64 = tx.query_row(
                        "SELECT COUNT(*) FROM project WHERE id = ?1",
                        params![pid],
                        |r| r.get(0),
                    )?;
                    if exists == 0 {
                        continue;
                    }
                }
                result.roles_applied += upsert_role(&tx, role, replace)?;
            }
            for profile in &export.agent_profiles {
                if let Some(pid) = &profile.project_id {
                    let exists: i64 = tx.query_row(
                        "SELECT COUNT(*) FROM project WHERE id = ?1",
                        params![pid],
                        |r| r.get(0),
                    )?;
                    if exists == 0 {
                        continue;
                    }
                }
                let role_exists: i64 = tx.query_row(
                    "SELECT COUNT(*) FROM role WHERE id = ?1",
                    params![profile.role_id],
                    |r| r.get(0),
                )?;
                if role_exists == 0 {
                    continue;
                }
                let mode_str = serde_json::to_value(profile.permission_mode)?;
                let mode_str = mode_str.as_str().map(str::to_string);
                let tools = profile
                    .allowed_tools
                    .as_ref()
                    .map(serde_json::to_string)
                    .transpose()?;
                let sql = if replace {
                    "INSERT INTO agent_profile (id, project_id, role_id, name, avatar_seed, instructions_md, model, permission_mode, allowed_tools_json, max_turns, max_budget_usd, created_at, effort, autonomy, can_assign_tasks, can_approve)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
                     ON CONFLICT(id) DO UPDATE SET project_id = excluded.project_id, role_id = excluded.role_id, name = excluded.name, avatar_seed = excluded.avatar_seed,
                        instructions_md = excluded.instructions_md, model = excluded.model, permission_mode = excluded.permission_mode, allowed_tools_json = excluded.allowed_tools_json,
                        max_turns = excluded.max_turns, max_budget_usd = excluded.max_budget_usd, effort = excluded.effort,
                        autonomy = excluded.autonomy, can_assign_tasks = excluded.can_assign_tasks, can_approve = excluded.can_approve"
                } else {
                    "INSERT OR IGNORE INTO agent_profile (id, project_id, role_id, name, avatar_seed, instructions_md, model, permission_mode, allowed_tools_json, max_turns, max_budget_usd, created_at, effort, autonomy, can_assign_tasks, can_approve)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)"
                };
                tx.execute(
                    sql,
                    params![
                        profile.id,
                        profile.project_id,
                        profile.role_id,
                        profile.name,
                        profile.avatar_seed,
                        profile.instructions_md,
                        profile.model,
                        mode_str,
                        tools,
                        profile.max_turns.map(|n| n as i64),
                        profile.max_budget_usd,
                        profile.created_at,
                        profile.effort.map(|e| e.as_str()),
                        profile.autonomy.map(|a| a.as_str()),
                        profile.can_assign_tasks.map(i64::from),
                        profile.can_approve.map(i64::from)
                    ],
                )?;
            }
            for member in &export.team_members {
                let ok: i64 = tx.query_row(
                    "SELECT COUNT(*) FROM project p, agent_profile a WHERE p.id = ?1 AND a.id = ?2",
                    params![member.project_id, member.agent_profile_id],
                    |r| r.get(0),
                )?;
                if ok == 0 {
                    continue;
                }
                let sql = if replace {
                    "INSERT INTO team_member (id, project_id, agent_profile_id, reports_to_agent_id, position, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                     ON CONFLICT(id) DO UPDATE SET project_id = excluded.project_id, agent_profile_id = excluded.agent_profile_id, reports_to_agent_id = excluded.reports_to_agent_id, position = excluded.position"
                } else {
                    "INSERT OR IGNORE INTO team_member (id, project_id, agent_profile_id, reports_to_agent_id, position, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)"
                };
                result.team_members_applied += tx.execute(
                    sql,
                    params![
                        member.id,
                        member.project_id,
                        member.agent_profile_id,
                        member.reports_to_agent_id,
                        member.position,
                        member.created_at
                    ],
                )?;
            }
            if replace && !export.roles.is_empty() {
                // Remove membros/perfis/cargos ausentes do arquivo (perfis via cascade do cargo não: cargo em uso não some).
                let member_ids: Vec<String> =
                    export.team_members.iter().map(|m| m.id.clone()).collect();
                let profile_ids: Vec<String> =
                    export.agent_profiles.iter().map(|p| p.id.clone()).collect();
                let role_ids: Vec<String> = export.roles.iter().map(|r| r.id.clone()).collect();
                delete_missing(&tx, "team_member", &member_ids)?;
                delete_missing(&tx, "agent_profile", &profile_ids)?;
                let orphan_roles: Vec<String> = {
                    let mut stmt = tx.prepare("SELECT id FROM role WHERE id NOT IN (SELECT DISTINCT role_id FROM agent_profile)")?;
                    let ids = stmt
                        .query_map([], |r| r.get::<_, String>(0))?
                        .collect::<std::result::Result<Vec<_>, _>>()?;
                    ids
                };
                for id in orphan_roles {
                    if !role_ids.contains(&id) {
                        tx.execute("DELETE FROM role WHERE id = ?1", params![id])?;
                    }
                }
            }
            for server in &export.mcp_servers {
                if let Some(pid) = &server.project_id {
                    let exists: i64 = tx.query_row(
                        "SELECT COUNT(*) FROM project WHERE id = ?1",
                        params![pid],
                        |r| r.get(0),
                    )?;
                    if exists == 0 {
                        continue;
                    }
                }
                let existing: Option<String> = tx
                    .query_row(
                        "SELECT config_json FROM mcp_server WHERE id = ?1",
                        params![server.id],
                        |r| r.get(0),
                    )
                    .optional()?;
                let config = match existing
                    .and_then(|c| serde_json::from_str::<crate::protocol::McpServerConfig>(&c).ok())
                {
                    Some(current) => merge_secrets(&server.config, &current),
                    None => server.config.clone(),
                };
                tx.execute(
                    "INSERT INTO mcp_server (id, project_id, name, transport, config_json, enabled, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                     ON CONFLICT(id) DO UPDATE SET project_id = excluded.project_id, name = excluded.name, transport = excluded.transport, config_json = excluded.config_json, enabled = excluded.enabled, updated_at = excluded.updated_at",
                    params![server.id, server.project_id, server.name, server.transport, serde_json::to_string(&config)?, server.enabled as i64, server.created_at, now()],
                )?;
                result.mcp_servers_applied += 1;
            }
            for hook in &export.custom_hooks {
                if let Some(pid) = &hook.project_id {
                    let exists: i64 = tx.query_row(
                        "SELECT COUNT(*) FROM project WHERE id = ?1",
                        params![pid],
                        |r| r.get(0),
                    )?;
                    if exists == 0 {
                        continue;
                    }
                }
                let sql = if replace {
                    "INSERT INTO custom_hook (id, project_id, name, event, matcher, command, timeout_sec, enabled, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                     ON CONFLICT(id) DO UPDATE SET project_id = excluded.project_id, name = excluded.name, event = excluded.event, matcher = excluded.matcher,
                        command = excluded.command, timeout_sec = excluded.timeout_sec, enabled = excluded.enabled, updated_at = excluded.updated_at"
                } else {
                    "INSERT OR IGNORE INTO custom_hook (id, project_id, name, event, matcher, command, timeout_sec, enabled, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)"
                };
                result.custom_hooks_applied += tx.execute(
                    sql,
                    params![
                        hook.id,
                        hook.project_id,
                        hook.name,
                        hook.event.as_str(),
                        hook.matcher,
                        hook.command,
                        hook.timeout_sec as i64,
                        hook.enabled as i64,
                        hook.created_at,
                        now()
                    ],
                )?;
            }
            tx.commit()?;
        }
        Ok(result)
    }

    // ------------------------------------------------------------------ cópias em disco

    /// Pasta das cópias (`<dados>/backups`), ou `None` em bancos em memória.
    pub fn backup_dir(&self) -> Option<&Path> {
        self.backup_dir.as_deref()
    }

    /// Grava uma cópia da configuração atual e poda as mais antigas (só as automáticas contam para o limite).
    pub fn write_snapshot(
        &self,
        reason: SnapshotReason,
        app_version: &str,
    ) -> Result<BackupSnapshot> {
        let dir = self
            .backup_dir
            .clone()
            .context("backups indisponíveis para um banco em memória")?;
        std::fs::create_dir_all(&dir).with_context(|| format!("criando {}", dir.display()))?;
        let export = self.export_config(app_version)?;
        let stamp = export.exported_at.replace([':', '.'], "-");
        let id = new_id("bkp");
        let path = dir.join(format!("octopus-config-{stamp}-{}.json", reason.as_str()));
        let json = serde_json::to_string_pretty(&export)?;
        std::fs::write(&path, &json).with_context(|| format!("gravando {}", path.display()))?;
        let snapshot = BackupSnapshot {
            id,
            created_at: export.exported_at.clone(),
            path: path.to_string_lossy().into_owned(),
            schema_version: export.schema_version,
            reason,
            size_bytes: json.len() as u64,
        };
        {
            let conn = self.conn.lock().expect("store mutex");
            conn.execute(
                "INSERT INTO backup_snapshot (id, created_at, path, schema_version, reason, size_bytes) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![snapshot.id, snapshot.created_at, snapshot.path, snapshot.schema_version, snapshot.reason.as_str(), snapshot.size_bytes as i64],
            )?;
        }
        self.prune_snapshots()?;
        Ok(snapshot)
    }

    fn prune_snapshots(&self) -> Result<()> {
        let all = self.list_snapshots()?;
        let automatic: Vec<&BackupSnapshot> = all
            .iter()
            .filter(|s| s.reason == SnapshotReason::Auto)
            .collect();
        if automatic.len() <= MAX_SNAPSHOTS {
            return Ok(());
        }
        for old in &automatic[MAX_SNAPSHOTS..] {
            let _ = std::fs::remove_file(&old.path);
            let conn = self.conn.lock().expect("store mutex");
            conn.execute("DELETE FROM backup_snapshot WHERE id = ?1", params![old.id])?;
        }
        Ok(())
    }

    /// Cópias registradas, mais recentes primeiro. Cópias cujo arquivo sumiu são removidas do registro.
    pub fn list_snapshots(&self) -> Result<Vec<BackupSnapshot>> {
        let rows = {
            let conn = self.conn.lock().expect("store mutex");
            let mut stmt = conn.prepare(
                "SELECT id, created_at, path, schema_version, reason, size_bytes FROM backup_snapshot ORDER BY created_at DESC",
            )?;
            let collected = stmt
                .query_map([], |r| {
                    Ok(BackupSnapshot {
                        id: r.get(0)?,
                        created_at: r.get(1)?,
                        path: r.get(2)?,
                        schema_version: r.get::<_, i64>(3)? as u32,
                        reason: SnapshotReason::parse(&r.get::<_, String>(4)?),
                        size_bytes: r.get::<_, i64>(5)? as u64,
                    })
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            collected
        };
        let (present, gone): (Vec<_>, Vec<_>) =
            rows.into_iter().partition(|s| Path::new(&s.path).is_file());
        if !gone.is_empty() {
            let conn = self.conn.lock().expect("store mutex");
            for s in gone {
                conn.execute("DELETE FROM backup_snapshot WHERE id = ?1", params![s.id])?;
            }
        }
        Ok(present)
    }

    pub fn get_snapshot(&self, id: &str) -> Result<Option<BackupSnapshot>> {
        Ok(self.list_snapshots()?.into_iter().find(|s| s.id == id))
    }

    /// Restaura uma cópia registrada, gravando antes uma cópia `pre-restore`.
    pub fn restore_snapshot(
        &self,
        id: &str,
        mode: ImportMode,
        app_version: &str,
    ) -> Result<ImportResult> {
        let snapshot = self
            .get_snapshot(id)?
            .with_context(|| format!("cópia {id} não encontrada"))?;
        let export = read_export(Path::new(&snapshot.path))?;
        self.write_snapshot(SnapshotReason::PreRestore, app_version)?;
        self.import_config(&export, mode)
    }
}

fn delete_missing(tx: &rusqlite::Transaction<'_>, table: &str, keep: &[String]) -> Result<()> {
    let existing: Vec<String> = {
        let mut stmt = tx.prepare(&format!("SELECT id FROM {table}"))?;
        let ids = stmt
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        ids
    };
    for id in existing {
        if !keep.contains(&id) {
            tx.execute(&format!("DELETE FROM {table} WHERE id = ?1"), params![id])?;
        }
    }
    Ok(())
}

pub fn read_export(path: &Path) -> Result<ConfigExport> {
    let text =
        std::fs::read_to_string(path).with_context(|| format!("lendo {}", path.display()))?;
    let export: ConfigExport = serde_json::from_str(&text)
        .with_context(|| format!("{} não é um export válido", path.display()))?;
    Ok(export)
}

pub fn default_backup_dir(db_path: &Path) -> Option<PathBuf> {
    db_path.parent().map(|p| p.join("backups"))
}

fn same_project(a: &Project, b: &Project) -> bool {
    a.id == b.id
        && a.name == b.name
        && a.path == b.path
        && a.auth_mode == b.auth_mode
        && a.sandbox_profile_id == b.sandbox_profile_id
}

impl AuthMode {
    pub fn parse_opt(value: &str) -> Option<Self> {
        match value {
            "subscription" => Some(AuthMode::Subscription),
            "api_key" => Some(AuthMode::ApiKey),
            _ => None,
        }
    }
}

/// Mantém os valores de env/headers já guardados quando o arquivo importado vem com eles em branco.
fn merge_secrets(
    incoming: &crate::protocol::McpServerConfig,
    current: &crate::protocol::McpServerConfig,
) -> crate::protocol::McpServerConfig {
    use crate::protocol::McpServerConfig as C;
    let fill = |inc: &Option<std::collections::BTreeMap<String, String>>,
                cur: &Option<std::collections::BTreeMap<String, String>>| {
        inc.as_ref().map(|m| {
            m.iter()
                .map(|(k, v)| {
                    let value = if v.is_empty() {
                        cur.as_ref()
                            .and_then(|c| c.get(k))
                            .cloned()
                            .unwrap_or_default()
                    } else {
                        v.clone()
                    };
                    (k.clone(), value)
                })
                .collect()
        })
    };
    match (incoming, current) {
        (C::Stdio { command, args, env }, C::Stdio { env: cur, .. }) => C::Stdio {
            command: command.clone(),
            args: args.clone(),
            env: fill(env, cur),
        },
        (C::Sse { url, headers }, C::Sse { headers: cur, .. }) => C::Sse {
            url: url.clone(),
            headers: fill(headers, cur),
        },
        (C::Http { url, headers }, C::Http { headers: cur, .. }) => C::Http {
            url: url.clone(),
            headers: fill(headers, cur),
        },
        (other, _) => other.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn disk_store() -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("octopus.db")).unwrap();
        (dir, store)
    }

    #[test]
    fn settings_roundtrip_and_list() {
        let s = Store::open_in_memory().unwrap();
        assert!(s.get_setting("theme").unwrap().is_none());
        s.set_setting("theme", &serde_json::json!("dark")).unwrap();
        s.set_setting(
            "onboarding.completed_at",
            &serde_json::json!("2026-10-16T18:00:00Z"),
        )
        .unwrap();
        s.set_setting("theme", &serde_json::json!("light")).unwrap();
        assert_eq!(
            s.get_setting("theme").unwrap(),
            Some(serde_json::json!("light"))
        );
        assert_eq!(s.list_settings().unwrap().len(), 2);
        assert!(s.delete_setting("theme").unwrap());
        assert!(!s.delete_setting("theme").unwrap());
    }

    #[test]
    fn export_import_merge_and_replace() {
        let a = Store::open_in_memory().unwrap();
        let p1 = a.create_project("alpha", "/tmp/alpha").unwrap();
        a.create_project("beta", "/tmp/beta").unwrap();
        a.set_setting("theme", &serde_json::json!("dark")).unwrap();
        a.add_team_member(
            &p1.id,
            &super::super::team::TeamMemberInput {
                name: "Ana".into(),
                role_id: "role_implementador".into(),
                ..Default::default()
            },
        )
        .unwrap();
        let export = a.export_config("0.1.0").unwrap();
        assert_eq!(export.schema_version, CONFIG_SCHEMA_VERSION);
        assert_eq!(export.projects.len(), 2);
        assert_eq!(export.roles.len(), 8);
        assert_eq!(export.agent_profiles.len(), 1);
        assert_eq!(export.team_members.len(), 1);
        // Roundtrip JSON (é o que vai para o arquivo).
        let json = serde_json::to_string_pretty(&export).unwrap();
        assert!(!json.contains("run_event"));
        let parsed: ConfigExport = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, export);

        // Outro banco: alpha existe com nome diferente, gamma só aqui.
        let b = Store::open_in_memory().unwrap();
        let conn_insert = |id: &str, name: &str, path: &str| {
            let conn = b.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO project (id, name, path, auth_mode, created_at, sandbox_profile_id) VALUES (?1, ?2, ?3, 'subscription', 't', 'sandbox_dev')",
                params![id, name, path],
            )
            .unwrap();
        };
        conn_insert(&p1.id, "alpha-renomeado", "/tmp/alpha");
        conn_insert("proj_gamma", "gamma", "/tmp/gamma");
        b.set_setting("theme", &serde_json::json!("light")).unwrap();
        b.set_setting("local-only", &serde_json::json!(1)).unwrap();

        let preview = b.preview_import(&export).unwrap();
        assert_eq!(preview.projects_new, vec!["beta"]);
        assert!(preview.projects_same.is_empty());
        assert_eq!(preview.projects_conflict, vec!["alpha ↔ alpha-renomeado"]);
        assert_eq!(preview.projects_removed, vec!["gamma"]);
        assert_eq!(preview.settings, 1);

        let merged = b.import_config(&export, ImportMode::Merge).unwrap();
        assert_eq!(
            (
                merged.projects_added,
                merged.projects_updated,
                merged.projects_removed,
                merged.settings_applied
            ),
            (1, 0, 0, 1)
        );
        assert_eq!(
            merged.team_members_applied, 1,
            "membro de alpha entra (alpha existe em b)"
        );
        assert_eq!(b.list_team(&p1.id).unwrap().len(), 1);
        let names: Vec<String> = b
            .list_projects()
            .unwrap()
            .into_iter()
            .map(|p| p.name)
            .collect();
        assert!(
            names.contains(&"alpha-renomeado".to_string()),
            "merge mantém o conflito local"
        );
        assert!(names.contains(&"gamma".to_string()));
        assert_eq!(
            b.get_setting("theme").unwrap(),
            Some(serde_json::json!("dark"))
        );
        assert!(b.get_setting("local-only").unwrap().is_some());

        let replaced = b.import_config(&export, ImportMode::Replace).unwrap();
        assert_eq!(
            (
                replaced.projects_added,
                replaced.projects_updated,
                replaced.projects_removed,
                replaced.settings_applied
            ),
            (0, 1, 1, 1)
        );
        let mut names: Vec<String> = b
            .list_projects()
            .unwrap()
            .into_iter()
            .map(|p| p.name)
            .collect();
        names.sort();
        assert_eq!(names, vec!["alpha", "beta"]);
        assert!(
            b.get_setting("local-only").unwrap().is_none(),
            "replace limpa preferências ausentes"
        );
    }

    #[test]
    fn rejects_newer_schema() {
        let s = Store::open_in_memory().unwrap();
        let export = ConfigExport {
            schema_version: CONFIG_SCHEMA_VERSION + 1,
            exported_at: "t".into(),
            app_version: "9".into(),
            settings: BTreeMap::new(),
            projects: vec![],
            roles: vec![],
            agent_profiles: vec![],
            team_members: vec![],
            mcp_servers: vec![],
            custom_hooks: vec![],
        };
        assert!(s.import_config(&export, ImportMode::Merge).is_err());
    }

    #[test]
    fn snapshots_are_written_listed_pruned_and_restored() {
        let (dir, s) = disk_store();
        assert_eq!(s.backup_dir().unwrap(), dir.path().join("backups"));
        s.create_project("alpha", "/tmp/alpha").unwrap();
        let first = s.write_snapshot(SnapshotReason::Manual, "0.1.0").unwrap();
        assert!(Path::new(&first.path).is_file());
        assert_eq!(first.reason, SnapshotReason::Manual);
        assert!(first.size_bytes > 0);

        for _ in 0..(MAX_SNAPSHOTS + 3) {
            s.write_snapshot(SnapshotReason::Auto, "0.1.0").unwrap();
        }
        let list = s.list_snapshots().unwrap();
        let autos = list
            .iter()
            .filter(|x| x.reason == SnapshotReason::Auto)
            .count();
        assert_eq!(
            autos, MAX_SNAPSHOTS,
            "poda mantém só as últimas automáticas"
        );
        assert!(
            list.iter().any(|x| x.id == first.id),
            "a manual não é podada"
        );
        assert_eq!(
            std::fs::read_dir(dir.path().join("backups"))
                .unwrap()
                .count(),
            MAX_SNAPSHOTS + 1
        );

        // Muda a configuração e restaura a primeira cópia: volta ao estado antigo e gera pre-restore.
        s.create_project("beta", "/tmp/beta").unwrap();
        let result = s
            .restore_snapshot(&first.id, ImportMode::Replace, "0.1.0")
            .unwrap();
        assert_eq!(result.projects_removed, 1);
        let names: Vec<String> = s
            .list_projects()
            .unwrap()
            .into_iter()
            .map(|p| p.name)
            .collect();
        assert_eq!(names, vec!["alpha"]);
        assert!(s
            .list_snapshots()
            .unwrap()
            .iter()
            .any(|x| x.reason == SnapshotReason::PreRestore));

        // Arquivo apagado por fora some da lista.
        std::fs::remove_file(&first.path).unwrap();
        assert!(s.get_snapshot(&first.id).unwrap().is_none());
        assert!(s
            .restore_snapshot(&first.id, ImportMode::Merge, "0.1.0")
            .is_err());
    }

    #[test]
    fn in_memory_store_has_no_backups() {
        let s = Store::open_in_memory().unwrap();
        assert!(s.backup_dir().is_none());
        assert!(s.write_snapshot(SnapshotReason::Auto, "0.1.0").is_err());
    }
}
