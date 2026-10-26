//! Time de agentes: cargos (catálogo global + ajustes do projeto), perfis e membros.
//! Também monta as opções do SDK de um membro (instruções do cargo + delegados como subagentes).

use std::collections::BTreeMap;

use anyhow::{Context, Result};
use rusqlite::{params, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

use super::{new_id, now, Store};
use crate::protocol::{AgentDefinition, EffortLevel, PermissionMode, RunOptions};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RoleScope {
    Global,
    Project,
}

impl RoleScope {
    fn as_str(&self) -> &'static str {
        match self {
            RoleScope::Global => "global",
            RoleScope::Project => "project",
        }
    }
    fn parse(value: &str) -> Self {
        if value == "project" {
            RoleScope::Project
        } else {
            RoleScope::Global
        }
    }
}

/// Autonomia de um papel/membro: quem aprova o trabalho dele quando um gate "por política" ou um
/// pedido de revisão do agente aparece.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum Autonomy {
    /// Você aprova (como sempre foi).
    #[default]
    Supervised,
    /// Sobe o organograma até um chefe que aprova; se a cadeia termina em você, você aprova.
    Managed,
    /// Sobe o organograma; se a cadeia termina em você, aprova sozinho e registra.
    Autonomous,
}

impl Autonomy {
    pub fn as_str(self) -> &'static str {
        match self {
            Autonomy::Supervised => "supervised",
            Autonomy::Managed => "managed",
            Autonomy::Autonomous => "autonomous",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "supervised" => Some(Autonomy::Supervised),
            "managed" => Some(Autonomy::Managed),
            "autonomous" => Some(Autonomy::Autonomous),
            _ => None,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Autonomy::Supervised => "supervisionado",
            Autonomy::Managed => "gerenciado",
            Autonomy::Autonomous => "autônomo",
        }
    }
}

/// Confiança efetiva de um membro (override do membro, senão default do cargo, senão o mais restrito).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TrustPolicy {
    pub autonomy: Autonomy,
    /// Pode criar e atribuir tasks para quem reporta a ele.
    pub can_assign_tasks: bool,
    /// Revisa e aprova o trabalho de quem reporta a ele.
    pub can_approve: bool,
}

/// Quem aprova o trabalho de um membro num gate por política (ou num pedido de revisão).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Approver {
    Human,
    Agent(String),
    Auto,
}

/// Sobe o organograma a partir de `assignee`: supervisionado → você; senão o primeiro chefe que
/// aprova; no topo, gerenciado → você e autônomo → auto-aprova. Membro desconhecido → você.
pub fn resolve_approver(team: &[TeamMember], assignee: &str) -> Approver {
    let Some(member) = team.iter().find(|m| m.profile.id == assignee) else {
        return Approver::Human;
    };
    if member.trust.autonomy == Autonomy::Supervised {
        return Approver::Human;
    }
    let mut current = member.reports_to_agent_id.clone();
    let mut hops = 0;
    while let Some(boss_id) = current {
        hops += 1;
        if hops > team.len() {
            break;
        }
        let Some(boss) = team.iter().find(|m| m.profile.id == boss_id) else {
            break;
        };
        if boss.trust.can_approve {
            return Approver::Agent(boss.profile.id.clone());
        }
        current = boss.reports_to_agent_id.clone();
    }
    match member.trust.autonomy {
        Autonomy::Autonomous => Approver::Auto,
        _ => Approver::Human,
    }
}

fn resolve_trust(profile: &AgentProfile, role: &Role) -> TrustPolicy {
    TrustPolicy {
        autonomy: profile
            .autonomy
            .or(role.default_autonomy)
            .unwrap_or_default(),
        can_assign_tasks: profile
            .can_assign_tasks
            .or(role.default_can_assign_tasks)
            .unwrap_or(false),
        can_approve: profile
            .can_approve
            .or(role.default_can_approve)
            .unwrap_or(false),
    }
}

fn bool_col(row: &Row<'_>, idx: usize) -> rusqlite::Result<Option<bool>> {
    Ok(row.get::<_, Option<i64>>(idx)?.map(|n| n != 0))
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Role {
    pub id: String,
    pub scope: RoleScope,
    pub project_id: Option<String>,
    pub title: String,
    pub specialty: String,
    pub responsibilities_md: String,
    pub default_model: Option<String>,
    pub default_permission_mode: Option<PermissionMode>,
    pub default_tools: Option<Vec<String>>,
    pub icon: Option<String>,
    pub position: i64,
    pub created_at: String,
    pub updated_at: String,
    /// Confiança padrão de quem tem este cargo (`None` = supervisionado / não).
    #[serde(default)]
    pub default_autonomy: Option<Autonomy>,
    #[serde(default)]
    pub default_can_assign_tasks: Option<bool>,
    #[serde(default)]
    pub default_can_approve: Option<bool>,
}

impl Role {
    const SELECT: &'static str = "SELECT id, scope, project_id, title, specialty, responsibilities_md, default_model, default_permission_mode, default_tools_json, icon, position, created_at, updated_at, default_autonomy, default_can_assign_tasks, default_can_approve FROM role";

    pub(crate) fn from_row_pub(row: &Row<'_>) -> rusqlite::Result<Self> {
        Self::from_row(row)
    }

    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Role {
            id: row.get(0)?,
            scope: RoleScope::parse(&row.get::<_, String>(1)?),
            project_id: row.get(2)?,
            title: row.get(3)?,
            specialty: row.get(4)?,
            responsibilities_md: row.get(5)?,
            default_model: row.get(6)?,
            default_permission_mode: row
                .get::<_, Option<String>>(7)?
                .and_then(|s| serde_json::from_value(serde_json::Value::String(s)).ok()),
            default_tools: parse_json_list(row.get::<_, Option<String>>(8)?),
            icon: row.get(9)?,
            position: row.get(10)?,
            created_at: row.get(11)?,
            updated_at: row.get(12)?,
            default_autonomy: row
                .get::<_, Option<String>>(13)?
                .as_deref()
                .and_then(Autonomy::parse),
            default_can_assign_tasks: bool_col(row, 14)?,
            default_can_approve: bool_col(row, 15)?,
        })
    }
}

/// Dados editáveis de um cargo (criação ou atualização).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoleInput {
    pub title: String,
    #[serde(default)]
    pub specialty: String,
    #[serde(default)]
    pub responsibilities_md: String,
    #[serde(default)]
    pub default_model: Option<String>,
    #[serde(default)]
    pub default_permission_mode: Option<PermissionMode>,
    #[serde(default)]
    pub default_tools: Option<Vec<String>>,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub default_autonomy: Option<Autonomy>,
    #[serde(default)]
    pub default_can_assign_tasks: Option<bool>,
    #[serde(default)]
    pub default_can_approve: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProfile {
    pub id: String,
    pub project_id: Option<String>,
    pub role_id: String,
    pub name: String,
    pub avatar_seed: String,
    pub instructions_md: Option<String>,
    pub model: Option<String>,
    pub permission_mode: Option<PermissionMode>,
    pub allowed_tools: Option<Vec<String>>,
    pub max_turns: Option<u32>,
    pub max_budget_usd: Option<f64>,
    pub created_at: String,
    /// MCP servers escolhidos para este membro (`None` = todos os ativos do escopo).
    #[serde(default)]
    pub mcp_server_ids: Option<Vec<String>>,
    /// Skills escolhidas para este membro (`None` = todas as ativas).
    #[serde(default)]
    pub skill_ids: Option<Vec<String>>,
    /// Esforço padrão do membro (`None` = do projeto, senão do modelo).
    #[serde(default)]
    pub effort: Option<EffortLevel>,
    /// Confiança do membro (`None` = herda do cargo).
    #[serde(default)]
    pub autonomy: Option<Autonomy>,
    #[serde(default)]
    pub can_assign_tasks: Option<bool>,
    #[serde(default)]
    pub can_approve: Option<bool>,
    /// Pausado: não recebe trabalho novo do scheduler (runs em andamento continuam).
    #[serde(default)]
    pub paused_at: Option<String>,
}

impl AgentProfile {
    pub(crate) const SELECT: &'static str = "SELECT id, project_id, role_id, name, avatar_seed, instructions_md, model, permission_mode, allowed_tools_json, max_turns, max_budget_usd, created_at, mcp_server_ids_json, skill_ids_json, effort, autonomy, can_assign_tasks, can_approve, paused_at FROM agent_profile";

    pub(crate) fn from_row_pub(row: &Row<'_>) -> rusqlite::Result<Self> {
        Self::from_row(row)
    }

    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(AgentProfile {
            id: row.get(0)?,
            project_id: row.get(1)?,
            role_id: row.get(2)?,
            name: row.get(3)?,
            avatar_seed: row.get(4)?,
            instructions_md: row.get(5)?,
            model: row.get(6)?,
            permission_mode: row
                .get::<_, Option<String>>(7)?
                .and_then(|s| serde_json::from_value(serde_json::Value::String(s)).ok()),
            allowed_tools: parse_json_list(row.get::<_, Option<String>>(8)?),
            max_turns: row.get::<_, Option<i64>>(9)?.map(|n| n as u32),
            max_budget_usd: row.get(10)?,
            created_at: row.get(11)?,
            mcp_server_ids: parse_json_list(row.get::<_, Option<String>>(12)?),
            skill_ids: parse_json_list(row.get::<_, Option<String>>(13)?),
            effort: row
                .get::<_, Option<String>>(14)?
                .as_deref()
                .and_then(EffortLevel::parse),
            autonomy: row
                .get::<_, Option<String>>(15)?
                .as_deref()
                .and_then(Autonomy::parse),
            can_assign_tasks: bool_col(row, 16)?,
            can_approve: bool_col(row, 17)?,
            paused_at: row.get(18)?,
        })
    }
}

/// Membro do time: perfil + cargo resolvidos, com a linha de reporte.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamMember {
    pub id: String,
    pub project_id: String,
    pub profile: AgentProfile,
    pub role: Role,
    /// `None` = reporta ao gestor (você).
    pub reports_to_agent_id: Option<String>,
    pub position: i64,
    pub created_at: String,
    /// Confiança efetiva (membro, senão cargo, senão supervisionado).
    #[serde(default)]
    pub trust: TrustPolicy,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamMemberInput {
    pub name: String,
    pub role_id: String,
    #[serde(default)]
    pub reports_to_agent_id: Option<String>,
    #[serde(default)]
    pub instructions_md: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub permission_mode: Option<PermissionMode>,
    #[serde(default)]
    pub allowed_tools: Option<Vec<String>>,
    #[serde(default)]
    pub max_turns: Option<u32>,
    #[serde(default)]
    pub max_budget_usd: Option<f64>,
    /// MCP servers do membro (`None` = todos os ativos).
    #[serde(default)]
    pub mcp_server_ids: Option<Vec<String>>,
    /// Skills do membro (`None` = todas as ativas).
    #[serde(default)]
    pub skill_ids: Option<Vec<String>>,
    #[serde(default)]
    pub effort: Option<EffortLevel>,
    /// Confiança (`None` = herda do cargo).
    #[serde(default)]
    pub autonomy: Option<Autonomy>,
    #[serde(default)]
    pub can_assign_tasks: Option<bool>,
    #[serde(default)]
    pub can_approve: Option<bool>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTotals {
    pub agent_profile_id: String,
    pub runs: u64,
    pub active_runs: u64,
    pub cost_usd: f64,
    pub last_run_at: Option<String>,
}

fn parse_json_list(raw: Option<String>) -> Option<Vec<String>> {
    raw.and_then(|s| serde_json::from_str(&s).ok())
}

fn to_json_list(list: &Option<Vec<String>>) -> Option<String> {
    list.as_ref()
        .map(|l| serde_json::to_string(l).unwrap_or_else(|_| "[]".into()))
}

fn permission_str(mode: &Option<PermissionMode>) -> Option<String> {
    mode.and_then(|m| serde_json::to_value(m).ok())
        .and_then(|v| v.as_str().map(str::to_string))
}

/// Iniciais para o avatar monocromático (duas letras).
pub fn initials(name: &str) -> String {
    let words: Vec<&str> = name.split_whitespace().collect();
    let mut out = String::new();
    match words.as_slice() {
        [] => {}
        [one] => out.extend(one.chars().take(2)),
        [first, .., last] => {
            out.extend(first.chars().take(1));
            out.extend(last.chars().take(1));
        }
    }
    out.to_uppercase()
}

/// Nome estável de subagente a partir do nome do membro (`agents` do SDK exige chaves simples).
pub fn agent_key(name: &str) -> String {
    let mut key: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    while key.contains("--") {
        key = key.replace("--", "-");
    }
    let key = key.trim_matches('-').to_string();
    if key.is_empty() {
        "membro".into()
    } else {
        key
    }
}

impl Store {
    // ------------------------------------------------------------------ cargos

    /// Cargos visíveis para um projeto: globais + os do próprio projeto. Sem projeto, só globais.
    pub fn list_roles(&self, project_id: Option<&str>) -> Result<Vec<Role>> {
        let conn = self.conn.lock().expect("store mutex");
        let mut stmt = conn.prepare(&format!(
            "{} WHERE scope = 'global' OR project_id = ?1 ORDER BY scope DESC, position, title",
            Role::SELECT
        ))?;
        let rows = stmt
            .query_map(params![project_id], Role::from_row)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn get_role(&self, id: &str) -> Result<Option<Role>> {
        let conn = self.conn.lock().expect("store mutex");
        Ok(conn
            .query_row(
                &format!("{} WHERE id = ?1", Role::SELECT),
                params![id],
                Role::from_row,
            )
            .optional()?)
    }

    pub fn create_role(&self, project_id: Option<&str>, input: &RoleInput) -> Result<Role> {
        let title = input.title.trim();
        if title.is_empty() {
            anyhow::bail!("Informe o título do cargo");
        }
        let scope = if project_id.is_some() {
            RoleScope::Project
        } else {
            RoleScope::Global
        };
        let id = new_id("role");
        let ts = now();
        let conn = self.conn.lock().expect("store mutex");
        let position: i64 =
            conn.query_row("SELECT COALESCE(MAX(position), 0) + 1 FROM role", [], |r| {
                r.get(0)
            })?;
        conn.execute(
            "INSERT INTO role (id, scope, project_id, title, specialty, responsibilities_md, default_model, default_permission_mode, default_tools_json, icon, position, created_at, updated_at, default_autonomy, default_can_assign_tasks, default_can_approve)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12, ?13, ?14, ?15)",
            params![
                id,
                scope.as_str(),
                project_id,
                title,
                input.specialty.trim(),
                input.responsibilities_md.trim(),
                input.default_model,
                permission_str(&input.default_permission_mode),
                to_json_list(&input.default_tools),
                input.icon,
                position,
                ts,
                input.default_autonomy.map(Autonomy::as_str),
                input.default_can_assign_tasks.map(i64::from),
                input.default_can_approve.map(i64::from)
            ],
        )?;
        drop(conn);
        self.get_role(&id)?.context("cargo sumiu após criar")
    }

    pub fn update_role(&self, id: &str, input: &RoleInput) -> Result<Role> {
        let title = input.title.trim();
        if title.is_empty() {
            anyhow::bail!("Informe o título do cargo");
        }
        {
            let conn = self.conn.lock().expect("store mutex");
            let changed = conn.execute(
                "UPDATE role SET title = ?2, specialty = ?3, responsibilities_md = ?4, default_model = ?5, default_permission_mode = ?6, default_tools_json = ?7, icon = ?8, updated_at = ?9, default_autonomy = ?10, default_can_assign_tasks = ?11, default_can_approve = ?12 WHERE id = ?1",
                params![
                    id,
                    title,
                    input.specialty.trim(),
                    input.responsibilities_md.trim(),
                    input.default_model,
                    permission_str(&input.default_permission_mode),
                    to_json_list(&input.default_tools),
                    input.icon,
                    now(),
                    input.default_autonomy.map(Autonomy::as_str),
                    input.default_can_assign_tasks.map(i64::from),
                    input.default_can_approve.map(i64::from)
                ],
            )?;
            if changed == 0 {
                anyhow::bail!("Cargo {id} não encontrado");
            }
        }
        self.get_role(id)?.context("cargo sumiu após atualizar")
    }

    /// Remove um cargo sem membros. Cargos do catálogo (seed) podem ser removidos como qualquer outro.
    pub fn delete_role(&self, id: &str) -> Result<bool> {
        let conn = self.conn.lock().expect("store mutex");
        let in_use: i64 = conn.query_row(
            "SELECT COUNT(*) FROM agent_profile WHERE role_id = ?1",
            params![id],
            |r| r.get(0),
        )?;
        if in_use > 0 {
            anyhow::bail!("O cargo tem {in_use} membro(s); mude o cargo deles antes de remover");
        }
        Ok(conn.execute("DELETE FROM role WHERE id = ?1", params![id])? > 0)
    }

    // ------------------------------------------------------------------ time

    pub fn list_team(&self, project_id: &str) -> Result<Vec<TeamMember>> {
        let conn = self.conn.lock().expect("store mutex");
        list_team_in(&conn, project_id)
    }
}

/// Versão do `list_team` para usar dentro de uma transação já aberta (sem pegar o mutex de novo).
pub(crate) fn list_team_in(
    conn: &rusqlite::Connection,
    project_id: &str,
) -> Result<Vec<TeamMember>> {
    {
        let mut stmt = conn.prepare(
            "SELECT id, agent_profile_id, reports_to_agent_id, position, created_at FROM team_member WHERE project_id = ?1 ORDER BY position, created_at",
        )?;
        let raw: Vec<(String, String, Option<String>, i64, String)> = stmt
            .query_map(params![project_id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let mut members = Vec::with_capacity(raw.len());
        for (id, profile_id, reports_to, position, created_at) in raw {
            let profile = conn
                .query_row(
                    &format!("{} WHERE id = ?1", AgentProfile::SELECT),
                    params![profile_id],
                    AgentProfile::from_row,
                )
                .with_context(|| format!("perfil {profile_id} do membro {id}"))?;
            let role = conn
                .query_row(
                    &format!("{} WHERE id = ?1", Role::SELECT),
                    params![profile.role_id],
                    Role::from_row,
                )
                .with_context(|| format!("cargo {} do membro {id}", profile.role_id))?;
            let trust = resolve_trust(&profile, &role);
            members.push(TeamMember {
                id,
                project_id: project_id.to_string(),
                profile,
                role,
                reports_to_agent_id: reports_to,
                position,
                created_at,
                trust,
            });
        }
        Ok(members)
    }
}

impl Store {
    pub fn get_team_member_by_agent(&self, agent_profile_id: &str) -> Result<Option<TeamMember>> {
        let project_id: Option<String> = {
            let conn = self.conn.lock().expect("store mutex");
            conn.query_row(
                "SELECT project_id FROM team_member WHERE agent_profile_id = ?1",
                params![agent_profile_id],
                |r| r.get(0),
            )
            .optional()?
        };
        let Some(project_id) = project_id else {
            return Ok(None);
        };
        Ok(self
            .list_team(&project_id)?
            .into_iter()
            .find(|m| m.profile.id == agent_profile_id))
    }

    pub fn add_team_member(&self, project_id: &str, input: &TeamMemberInput) -> Result<TeamMember> {
        let name = input.name.trim();
        if name.is_empty() {
            anyhow::bail!("Informe o nome do membro");
        }
        self.get_role(&input.role_id)?
            .with_context(|| format!("Cargo {} não encontrado", input.role_id))?;
        if let Some(boss) = &input.reports_to_agent_id {
            let exists = self
                .list_team(project_id)?
                .iter()
                .any(|m| &m.profile.id == boss);
            if !exists {
                anyhow::bail!("O membro a quem reportar não está neste time");
            }
        }
        let profile_id = new_id("agent");
        let member_id = new_id("member");
        let ts = now();
        {
            let mut conn = self.conn.lock().expect("store mutex");
            let tx = conn.transaction()?;
            tx.execute(
                "INSERT INTO agent_profile (id, project_id, role_id, name, avatar_seed, instructions_md, model, permission_mode, allowed_tools_json, max_turns, max_budget_usd, created_at, mcp_server_ids_json, skill_ids_json, effort, autonomy, can_assign_tasks, can_approve)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)",
                params![
                    profile_id,
                    project_id,
                    input.role_id,
                    name,
                    initials(name),
                    input.instructions_md.as_deref().map(str::trim).filter(|s| !s.is_empty()),
                    input.model,
                    permission_str(&input.permission_mode),
                    to_json_list(&input.allowed_tools),
                    input.max_turns.map(|n| n as i64),
                    input.max_budget_usd,
                    ts,
                    to_json_list(&input.mcp_server_ids),
                    to_json_list(&input.skill_ids),
                    input.effort.map(|e| e.as_str()),
                    input.autonomy.map(Autonomy::as_str),
                    input.can_assign_tasks.map(i64::from),
                    input.can_approve.map(i64::from)
                ],
            )?;
            let position: i64 = tx.query_row(
                "SELECT COALESCE(MAX(position), 0) + 1 FROM team_member WHERE project_id = ?1",
                params![project_id],
                |r| r.get(0),
            )?;
            tx.execute(
                "INSERT INTO team_member (id, project_id, agent_profile_id, reports_to_agent_id, position, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![member_id, project_id, profile_id, input.reports_to_agent_id, position, ts],
            )?;
            tx.commit()?;
        }
        self.get_team_member_by_agent(&profile_id)?
            .context("membro sumiu após criar")
    }

    pub fn update_team_member(
        &self,
        agent_profile_id: &str,
        input: &TeamMemberInput,
    ) -> Result<TeamMember> {
        let name = input.name.trim();
        if name.is_empty() {
            anyhow::bail!("Informe o nome do membro");
        }
        let current = self
            .get_team_member_by_agent(agent_profile_id)?
            .with_context(|| format!("Membro {agent_profile_id} não encontrado"))?;
        if let Some(boss) = &input.reports_to_agent_id {
            if boss == agent_profile_id {
                anyhow::bail!("Um membro não pode reportar a si mesmo");
            }
            let team = self.list_team(&current.project_id)?;
            if !team.iter().any(|m| &m.profile.id == boss) {
                anyhow::bail!("O membro a quem reportar não está neste time");
            }
            if reports_chain_contains(&team, boss, agent_profile_id) {
                anyhow::bail!("Isso criaria um ciclo de delegação");
            }
        }
        {
            let mut conn = self.conn.lock().expect("store mutex");
            let tx = conn.transaction()?;
            tx.execute(
                "UPDATE agent_profile SET role_id = ?2, name = ?3, avatar_seed = ?4, instructions_md = ?5, model = ?6, permission_mode = ?7, allowed_tools_json = ?8, max_turns = ?9, max_budget_usd = ?10, mcp_server_ids_json = ?11, skill_ids_json = ?12, effort = ?13, autonomy = ?14, can_assign_tasks = ?15, can_approve = ?16 WHERE id = ?1",
                params![
                    agent_profile_id,
                    input.role_id,
                    name,
                    initials(name),
                    input.instructions_md.as_deref().map(str::trim).filter(|s| !s.is_empty()),
                    input.model,
                    permission_str(&input.permission_mode),
                    to_json_list(&input.allowed_tools),
                    input.max_turns.map(|n| n as i64),
                    input.max_budget_usd,
                    to_json_list(&input.mcp_server_ids),
                    to_json_list(&input.skill_ids),
                    input.effort.map(|e| e.as_str()),
                    input.autonomy.map(Autonomy::as_str),
                    input.can_assign_tasks.map(i64::from),
                    input.can_approve.map(i64::from)
                ],
            )?;
            tx.execute(
                "UPDATE team_member SET reports_to_agent_id = ?2 WHERE agent_profile_id = ?1",
                params![agent_profile_id, input.reports_to_agent_id],
            )?;
            tx.commit()?;
        }
        self.get_team_member_by_agent(agent_profile_id)?
            .context("membro sumiu após atualizar")
    }

    /// Remove o membro e seu perfil. Quem reportava a ele passa a reportar ao gestor; runs ficam (agent_profile_id vira NULL).
    pub fn remove_team_member(&self, agent_profile_id: &str) -> Result<bool> {
        let name = self
            .get_team_member_by_agent(agent_profile_id)?
            .map(|m| m.profile.name);
        let mut conn = self.conn.lock().expect("store mutex");
        let tx = conn.transaction()?;
        // Tasks que ele estava revisando sobem para você, em vez de ficarem órfãs em `review`.
        let reviewing: Vec<String> = tx
            .prepare("SELECT id FROM task WHERE approver_agent_id = ?1 AND status = 'review'")?
            .query_map(params![agent_profile_id], |r| r.get(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        for task_id in &reviewing {
            tx.execute(
                "UPDATE task SET status = 'waiting_approval', approver_agent_id = NULL, lock_run_id = NULL, updated_at = ?2 WHERE id = ?1",
                params![task_id, now()],
            )?;
            super::orchestration::insert_task_event(
                &tx,
                task_id,
                "escalated",
                None,
                None,
                None,
                "sistema",
                Some(&format!(
                    "{} saiu do time; a revisão passa para você",
                    name.as_deref().unwrap_or("o revisor")
                )),
            )?;
        }
        let changed = tx.execute(
            "DELETE FROM agent_profile WHERE id = ?1",
            params![agent_profile_id],
        )?;
        tx.commit()?;
        Ok(changed > 0)
    }

    /// Custo e runs por membro do projeto.
    pub fn team_totals(&self, project_id: &str) -> Result<Vec<AgentTotals>> {
        let conn = self.conn.lock().expect("store mutex");
        let mut stmt = conn.prepare(
            "SELECT agent_profile_id, COUNT(*), SUM(CASE WHEN status IN ('queued','running','waiting_approval') THEN 1 ELSE 0 END),
                    COALESCE(SUM(cost_usd), 0), MAX(started_at)
             FROM run WHERE project_id = ?1 AND agent_profile_id IS NOT NULL GROUP BY agent_profile_id",
        )?;
        let rows = stmt
            .query_map(params![project_id], |r| {
                Ok(AgentTotals {
                    agent_profile_id: r.get(0)?,
                    runs: r.get::<_, i64>(1)? as u64,
                    active_runs: r.get::<_, i64>(2)? as u64,
                    cost_usd: r.get(3)?,
                    last_run_at: r.get(4)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Opções do SDK para rodar como um membro: instruções do cargo + do membro, limites e os
    /// delegados (quem reporta a ele) como subagentes. As opções pedidas pela UI prevalecem.
    pub fn agent_run_options(
        &self,
        agent_profile_id: &str,
        requested: &RunOptions,
    ) -> Result<RunOptions> {
        let member = self
            .get_team_member_by_agent(agent_profile_id)?
            .with_context(|| format!("Membro {agent_profile_id} não encontrado"))?;
        let team = self.list_team(&member.project_id)?;
        let mut options = requested.clone();
        let mut base_prompt = member_prompt(&member);
        if member.trust.can_assign_tasks {
            let names: Vec<String> = descendants(&team, agent_profile_id)
                .into_iter()
                .map(|m| format!("{} ({})", m.profile.name, m.role.title))
                .collect();
            base_prompt.push_str(
                "\n\nDelegação: você pode criar e atribuir tasks no board para quem reporta a você",
            );
            if names.is_empty() {
                base_prompt.push_str(" (ninguém ainda).");
            } else {
                base_prompt.push_str(": ");
                base_prompt.push_str(&names.join(", "));
                base_prompt.push('.');
            }
            base_prompt.push_str(" Use team_list para ver a carga de cada um e task_create para abrir tasks pequenas, com critérios de aceite verificáveis.");
        }
        options.system_prompt_append = Some(merge_prompt(
            base_prompt,
            requested.system_prompt_append.as_deref(),
        ));
        if options.model.is_none() {
            options.model = member
                .profile
                .model
                .clone()
                .or_else(|| member.role.default_model.clone());
        }
        if options.permission_mode.is_none() {
            options.permission_mode = member
                .profile
                .permission_mode
                .or(member.role.default_permission_mode);
        }
        if options.allowed_tools.is_none() {
            options.allowed_tools = member
                .profile
                .allowed_tools
                .clone()
                .or_else(|| member.role.default_tools.clone());
        }
        if options.max_turns.is_none() {
            options.max_turns = member.profile.max_turns;
        }
        if options.max_budget_usd.is_none() {
            options.max_budget_usd = member.profile.max_budget_usd;
        }
        if options.effort.is_none() {
            options.effort = member.profile.effort;
        }
        if member.trust.can_assign_tasks && options.board_tools.is_none() {
            options.board_tools = Some(true);
        }
        let delegates: BTreeMap<String, AgentDefinition> = team
            .iter()
            .filter(|m| m.reports_to_agent_id.as_deref() == Some(agent_profile_id))
            .map(|m| {
                (
                    agent_key(&m.profile.name),
                    AgentDefinition {
                        description: format!("{} · {}", m.role.title, m.role.specialty),
                        prompt: member_prompt(m),
                        tools: m
                            .profile
                            .allowed_tools
                            .clone()
                            .or_else(|| m.role.default_tools.clone()),
                        model: m
                            .profile
                            .model
                            .clone()
                            .or_else(|| m.role.default_model.clone()),
                        effort: m.profile.effort,
                    },
                )
            })
            .collect();
        if !delegates.is_empty() {
            let mut agents = options.agents.take().unwrap_or_default();
            for (k, v) in delegates {
                agents.entry(k).or_insert(v);
            }
            options.agents = Some(agents);
        }
        Ok(options)
    }
}

/// Todos que reportam a `boss`, direta ou indiretamente (ordem do time).
pub fn descendants<'a>(team: &'a [TeamMember], boss: &str) -> Vec<&'a TeamMember> {
    let mut out: Vec<&TeamMember> = Vec::new();
    let mut frontier = vec![boss.to_string()];
    while let Some(current) = frontier.pop() {
        for m in team
            .iter()
            .filter(|m| m.reports_to_agent_id.as_deref() == Some(current.as_str()))
        {
            if !out.iter().any(|o| o.profile.id == m.profile.id) {
                out.push(m);
                frontier.push(m.profile.id.clone());
            }
        }
    }
    out
}

fn reports_chain_contains(team: &[TeamMember], start: &str, target: &str) -> bool {
    let mut current = Some(start.to_string());
    let mut hops = 0;
    while let Some(id) = current {
        if id == target {
            return true;
        }
        hops += 1;
        if hops > team.len() {
            return false;
        }
        current = team
            .iter()
            .find(|m| m.profile.id == id)
            .and_then(|m| m.reports_to_agent_id.clone());
    }
    false
}

/// Texto que vai para o system prompt do membro (preset claude_code + append).
pub fn member_prompt(member: &TeamMember) -> String {
    let mut text = format!(
        "Você é {name}, {title} do time deste projeto. Especialidade: {specialty}.\n\nResponsabilidades:\n{resp}",
        name = member.profile.name,
        title = member.role.title,
        specialty = member.role.specialty,
        resp = member.role.responsibilities_md.trim()
    );
    if let Some(extra) = member
        .profile
        .instructions_md
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        text.push_str("\n\nInstruções específicas:\n");
        text.push_str(extra);
    }
    text.push_str("\n\nConfiança: ");
    text.push_str(match member.trust.autonomy {
        Autonomy::Supervised => "seu trabalho é aprovado pelo gestor humano.",
        Autonomy::Managed => "seu trabalho é aprovado por quem está acima de você no organograma (ou pelo gestor humano no topo).",
        Autonomy::Autonomous => "você é autônomo: quando nenhum chefe revisa, seu trabalho segue sem aprovação humana; capriche no resumo da entrega.",
    });
    if member.trust.can_approve {
        text.push_str(" Você revisa e aprova o trabalho de quem reporta a você.");
    }
    text
}

fn merge_prompt(base: String, extra: Option<&str>) -> String {
    match extra.map(str::trim).filter(|s| !s.is_empty()) {
        Some(extra) => format!("{base}\n\n{extra}"),
        None => base,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store_with_project() -> (Store, String) {
        let s = Store::open_in_memory().unwrap();
        let p = s.create_project("p", "/tmp/p").unwrap();
        (s, p.id)
    }

    #[test]
    fn seed_roles_are_listed_and_project_roles_are_scoped() {
        let (s, project) = store_with_project();
        let global = s.list_roles(None).unwrap();
        assert_eq!(global.len(), 8);
        assert_eq!(global[0].title, "Planejador");
        assert_eq!(
            global[1].default_permission_mode,
            Some(PermissionMode::AcceptEdits)
        );
        assert_eq!(global[1].default_tools.as_ref().unwrap()[0], "Read");

        let custom = s
            .create_role(
                Some(&project),
                &RoleInput {
                    title: "DBA".into(),
                    specialty: "Bancos".into(),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(custom.scope, RoleScope::Project);
        assert_eq!(s.list_roles(Some(&project)).unwrap().len(), 9);
        assert_eq!(s.list_roles(None).unwrap().len(), 8);

        let other = s.create_project("o", "/tmp/o").unwrap();
        assert_eq!(s.list_roles(Some(&other.id)).unwrap().len(), 8);

        let updated = s
            .update_role(
                &custom.id,
                &RoleInput {
                    title: "DBA sênior".into(),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(updated.title, "DBA sênior");
        assert!(s.delete_role(&custom.id).unwrap());
        assert!(s.create_role(None, &RoleInput::default()).is_err());
    }

    #[test]
    fn trust_resolves_from_member_then_role_and_approver_walks_the_org_chart() {
        let (s, project) = store_with_project();
        let add = |name: &str,
                   role: &str,
                   boss: Option<&str>,
                   trust: (Option<Autonomy>, Option<bool>)| {
            s.add_team_member(
                &project,
                &TeamMemberInput {
                    name: name.into(),
                    role_id: role.into(),
                    reports_to_agent_id: boss.map(str::to_string),
                    autonomy: trust.0,
                    can_approve: trust.1,
                    ..Default::default()
                },
            )
            .unwrap()
            .profile
            .id
        };
        // Gabi: cargo seed "Gestor de produto" (autônomo, delega, aprova) sem override.
        let gabi = add("Gabi", "role_gestor_produto", None, (None, None));
        // Rui: revisor, gerenciado, aprova (override); reporta a Gabi.
        let rui = add(
            "Rui",
            "role_revisor",
            Some(&gabi),
            (Some(Autonomy::Managed), Some(true)),
        );
        // Ana: implementadora gerenciada, reporta a Rui.
        let ana = add(
            "Ana",
            "role_implementador",
            Some(&rui),
            (Some(Autonomy::Managed), None),
        );
        // Téo: supervisionado (default do cargo), reporta a Ana.
        let teo = add("Téo", "role_testador", Some(&ana), (None, None));
        // Dani: gerenciada, reporta direto a você.
        let dani = add(
            "Dani",
            "role_pesquisador",
            None,
            (Some(Autonomy::Managed), None),
        );
        // Leo: autônomo sem chefe que aprove (reporta a Dani, que não aprova).
        let leo = add(
            "Leo",
            "role_documentador",
            Some(&dani),
            (Some(Autonomy::Autonomous), None),
        );

        let team = s.list_team(&project).unwrap();
        let by = |id: &str| team.iter().find(|m| m.profile.id == id).unwrap();
        assert_eq!(
            by(&gabi).trust,
            TrustPolicy {
                autonomy: Autonomy::Autonomous,
                can_assign_tasks: true,
                can_approve: true
            }
        );
        assert_eq!(by(&rui).trust.autonomy, Autonomy::Managed);
        assert!(by(&rui).trust.can_approve);
        assert!(!by(&rui).trust.can_assign_tasks);
        assert_eq!(by(&teo).trust, TrustPolicy::default());

        assert_eq!(
            resolve_approver(&team, &teo),
            Approver::Human,
            "supervisionado → você"
        );
        assert_eq!(
            resolve_approver(&team, &ana),
            Approver::Agent(rui.clone()),
            "gerenciada com chefe que aprova"
        );
        assert_eq!(
            resolve_approver(&team, &rui),
            Approver::Agent(gabi.clone()),
            "sobe até Gabi"
        );
        assert_eq!(
            resolve_approver(&team, &gabi),
            Approver::Auto,
            "autônoma no topo → auto-aprova"
        );
        assert_eq!(
            resolve_approver(&team, &dani),
            Approver::Human,
            "gerenciada no topo → você"
        );
        assert_eq!(
            resolve_approver(&team, &leo),
            Approver::Auto,
            "autônomo sem chefe aprovador → auto"
        );
        assert_eq!(resolve_approver(&team, "ninguem"), Approver::Human);

        // Override por membro vence o default do cargo; voltar a None herda de novo.
        let updated = s
            .update_team_member(
                &gabi,
                &TeamMemberInput {
                    name: "Gabi".into(),
                    role_id: "role_gestor_produto".into(),
                    autonomy: Some(Autonomy::Supervised),
                    can_approve: Some(false),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(updated.trust.autonomy, Autonomy::Supervised);
        assert!(!updated.trust.can_approve);
        assert!(updated.trust.can_assign_tasks, "herdado do cargo");
        let prompt = member_prompt(&updated);
        assert!(prompt.contains("aprovado pelo gestor humano"));
        assert!(member_prompt(by(&rui)).contains("Você revisa e aprova"));

        // Cargo novo com defaults de confiança.
        let role = s
            .create_role(
                Some(&project),
                &RoleInput {
                    title: "Líder técnico".into(),
                    default_autonomy: Some(Autonomy::Managed),
                    default_can_approve: Some(true),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(role.default_autonomy, Some(Autonomy::Managed));
        assert_eq!(role.default_can_approve, Some(true));
        assert_eq!(role.default_can_assign_tasks, None);
    }

    #[test]
    fn team_crud_delegation_and_run_options() {
        let (s, project) = store_with_project();
        let impl_ = s
            .add_team_member(
                &project,
                &TeamMemberInput {
                    name: "Ana Implementadora".into(),
                    role_id: "role_implementador".into(),
                    instructions_md: Some("Prefira Java 21.".into()),
                    max_budget_usd: Some(5.0),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(impl_.profile.avatar_seed, "AI");
        assert!(impl_.reports_to_agent_id.is_none());

        let tester = s
            .add_team_member(
                &project,
                &TeamMemberInput {
                    name: "Téo".into(),
                    role_id: "role_testador".into(),
                    reports_to_agent_id: Some(impl_.profile.id.clone()),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(
            tester.reports_to_agent_id.as_deref(),
            Some(impl_.profile.id.as_str())
        );
        assert_eq!(tester.profile.avatar_seed, "TÉ");

        // Reportar a alguém de fora do time ou criar ciclo é recusado.
        assert!(s
            .add_team_member(
                &project,
                &TeamMemberInput {
                    name: "x".into(),
                    role_id: "role_revisor".into(),
                    reports_to_agent_id: Some("agent_inexistente".into()),
                    ..Default::default()
                }
            )
            .is_err());
        assert!(s
            .update_team_member(
                &impl_.profile.id,
                &TeamMemberInput {
                    name: "Ana".into(),
                    role_id: "role_implementador".into(),
                    reports_to_agent_id: Some(tester.profile.id.clone()),
                    ..Default::default()
                }
            )
            .is_err());

        // Opções do SDK: cargo + instruções + delegado como subagente; UI prevalece.
        let options = s
            .agent_run_options(
                &impl_.profile.id,
                &RunOptions {
                    max_turns: Some(3),
                    ..Default::default()
                },
            )
            .unwrap();
        let prompt = options.system_prompt_append.unwrap();
        assert!(prompt.starts_with("Você é Ana Implementadora, Implementador"));
        assert!(prompt.contains("Escrever testes junto com o código"));
        assert!(prompt.contains("Prefira Java 21."));
        assert_eq!(options.permission_mode, Some(PermissionMode::AcceptEdits));
        assert_eq!(options.max_turns, Some(3));
        assert_eq!(options.max_budget_usd, Some(5.0));
        assert!(options.allowed_tools.unwrap().contains(&"Bash".to_string()));
        let agents = options.agents.unwrap();
        let teo = agents
            .get("t-o")
            .or_else(|| agents.values().next())
            .unwrap();
        assert!(teo.description.starts_with("Testador"));
        assert!(teo.prompt.contains("Você é Téo, Testador"));

        // Totais por membro acompanham os runs.
        let run = s
            .create_run_for_agent(
                &project,
                "x",
                &RunOptions::default(),
                Some(&impl_.profile.id),
            )
            .unwrap();
        assert_eq!(
            run.agent_profile_id.as_deref(),
            Some(impl_.profile.id.as_str())
        );
        let totals = s.team_totals(&project).unwrap();
        assert_eq!(totals.len(), 1);
        assert_eq!(totals[0].runs, 1);
        assert_eq!(totals[0].active_runs, 1);

        // Remover o chefe: o delegado passa a reportar ao gestor; o run fica sem agente.
        assert!(s.remove_team_member(&impl_.profile.id).unwrap());
        let team = s.list_team(&project).unwrap();
        assert_eq!(team.len(), 1);
        assert!(team[0].reports_to_agent_id.is_none());
        assert!(s
            .get_run(&run.id)
            .unwrap()
            .unwrap()
            .agent_profile_id
            .is_none());
        assert!(s.delete_role("role_testador").is_err(), "cargo em uso");
    }

    #[test]
    fn helpers() {
        assert_eq!(initials("Ana Implementadora"), "AI");
        assert_eq!(initials("Téo"), "TÉ");
        assert_eq!(initials(""), "");
        assert_eq!(agent_key("Ana  Implementadora!"), "ana-implementadora");
        assert_eq!(agent_key("***"), "membro");
    }
}
