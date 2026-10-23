//! Perfis de sandbox (traduzidos para `options.sandbox` do SDK) e orçamentos mensais
//! (soft avisa; hard impede novos runs, limita cada run via `maxBudgetUsd` e, quando o gasto
//! do mês somado à estimativa dos runs em andamento passa do limite, interrompe os runs ativos).

use anyhow::{Context, Result};
use chrono::{Datelike, Utc};
use rusqlite::{params, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

use super::models::Project;
use super::{new_id, now, Store};
use crate::protocol::{RunOptions, SandboxSettings};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxProfile {
    pub id: String,
    pub name: String,
    pub description: String,
    pub builtin: bool,
    /// Com placeholders `${PROJECT}` e `~` ainda não expandidos.
    pub settings: SandboxSettings,
    pub position: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BudgetScope {
    Project,
    Agent,
}

impl BudgetScope {
    fn as_str(&self) -> &'static str {
        match self {
            BudgetScope::Project => "project",
            BudgetScope::Agent => "agent",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetPolicy {
    pub id: String,
    pub scope: BudgetScope,
    pub scope_id: String,
    pub soft_usd: Option<f64>,
    pub hard_usd: Option<f64>,
    pub max_turns: Option<u32>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetInput {
    pub soft_usd: Option<f64>,
    pub hard_usd: Option<f64>,
    pub max_turns: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetLine {
    pub scope: BudgetScope,
    pub scope_id: String,
    pub label: String,
    pub spent_usd: f64,
    pub soft_usd: Option<f64>,
    pub hard_usd: Option<f64>,
    pub max_turns: Option<u32>,
    pub runs: u64,
    /// Parte de `spent_usd` que é estimativa de runs ainda em andamento.
    #[serde(default)]
    pub live_usd: f64,
    /// `ok`, `soft` (passou do aviso) ou `hard` (esgotado).
    pub level: String,
}

/// Orçamento estourado com runs em andamento: quem parar e por quê.
#[derive(Debug, Clone, PartialEq)]
pub struct BudgetOverrun {
    pub label: String,
    pub spent_usd: f64,
    pub hard_usd: f64,
    /// Runs ativos no escopo estourado (projeto inteiro ou só o membro).
    pub run_ids: Vec<String>,
}

impl BudgetOverrun {
    pub fn reason(&self) -> String {
        format!(
            "Orçamento mensal esgotado para {} durante o run: US$ {} de US$ {} (inclui estimativa dos runs em andamento).",
            self.label,
            usd(self.spent_usd),
            usd(self.hard_usd)
        )
    }
}

/// Dois decimais, ou quatro abaixo de 1 centavo (limites de teste não viram "0.00").
fn usd(v: f64) -> String {
    if v.abs() < 0.01 && v != 0.0 {
        format!("{v:.4}")
    } else {
        format!("{v:.2}")
    }
}

const ACTIVE: &str = "('queued', 'running', 'waiting_approval')";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetStatus {
    pub month: String,
    pub project: BudgetLine,
    pub agents: Vec<BudgetLine>,
}

fn month_start() -> String {
    let now = Utc::now();
    format!("{:04}-{:02}-01T00:00:00Z", now.year(), now.month())
}

fn level(spent: f64, soft: Option<f64>, hard: Option<f64>) -> &'static str {
    match (hard, soft) {
        (Some(h), _) if spent >= h => "hard",
        (_, Some(s)) if spent >= s => "soft",
        _ => "ok",
    }
}

/// Expande `${PROJECT}` e `~` nas listas de caminhos do perfil.
pub fn resolve_sandbox(settings: &SandboxSettings, project_path: &str) -> SandboxSettings {
    let home = std::env::var("HOME").unwrap_or_default();
    let expand = |list: &Option<Vec<String>>| -> Option<Vec<String>> {
        list.as_ref().map(|items| {
            items
                .iter()
                .map(|p| {
                    let p = p.replace("${PROJECT}", project_path);
                    if let Some(rest) = p.strip_prefix("~/") {
                        format!("{home}/{rest}")
                    } else if p == "~" {
                        home.clone()
                    } else {
                        p
                    }
                })
                .collect()
        })
    };
    let mut out = settings.clone();
    if let Some(fs) = out.filesystem.as_mut() {
        fs.allow_write = expand(&fs.allow_write);
        fs.deny_write = expand(&fs.deny_write);
        fs.deny_read = expand(&fs.deny_read);
        fs.allow_read = expand(&fs.allow_read);
    }
    out
}

impl Store {
    // ------------------------------------------------------------------ sandbox

    pub fn list_sandbox_profiles(&self) -> Result<Vec<SandboxProfile>> {
        let conn = self.conn.lock().expect("store mutex");
        let mut stmt = conn.prepare("SELECT id, name, description, builtin, settings_json, position FROM sandbox_profile ORDER BY position, name")?;
        let rows = stmt
            .query_map([], profile_from_row)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn get_sandbox_profile(&self, id: &str) -> Result<Option<SandboxProfile>> {
        let conn = self.conn.lock().expect("store mutex");
        Ok(conn
            .query_row(
                "SELECT id, name, description, builtin, settings_json, position FROM sandbox_profile WHERE id = ?1",
                params![id],
                profile_from_row,
            )
            .optional()?)
    }

    pub fn set_project_sandbox(&self, project_id: &str, profile_id: &str) -> Result<Project> {
        self.get_sandbox_profile(profile_id)?
            .with_context(|| format!("Perfil de sandbox {profile_id} não existe"))?;
        {
            let conn = self.conn.lock().expect("store mutex");
            let changed = conn.execute(
                "UPDATE project SET sandbox_profile_id = ?2 WHERE id = ?1",
                params![project_id, profile_id],
            )?;
            if changed == 0 {
                anyhow::bail!("Projeto {project_id} não encontrado");
            }
        }
        self.get_project(project_id)?.context("projeto sumiu")
    }

    /// `options.sandbox` pronto para o SDK, conforme o perfil do projeto (padrão: Dev padrão).
    pub fn sandbox_for_project(&self, project: &Project) -> Result<Option<SandboxSettings>> {
        let id = project
            .sandbox_profile_id
            .clone()
            .unwrap_or_else(|| "sandbox_dev".into());
        Ok(self
            .get_sandbox_profile(&id)?
            .map(|p| resolve_sandbox(&p.settings, &project.path)))
    }

    // ------------------------------------------------------------------ orçamentos

    pub fn list_budget_policies(&self) -> Result<Vec<BudgetPolicy>> {
        let conn = self.conn.lock().expect("store mutex");
        let mut stmt = conn.prepare("SELECT id, scope, scope_id, soft_usd, hard_usd, max_turns, created_at, updated_at FROM budget_policy ORDER BY scope, created_at")?;
        let rows = stmt
            .query_map([], budget_from_row)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn get_budget_policy(
        &self,
        scope: BudgetScope,
        scope_id: &str,
    ) -> Result<Option<BudgetPolicy>> {
        let conn = self.conn.lock().expect("store mutex");
        Ok(conn
            .query_row(
                "SELECT id, scope, scope_id, soft_usd, hard_usd, max_turns, created_at, updated_at FROM budget_policy WHERE scope = ?1 AND scope_id = ?2",
                params![scope.as_str(), scope_id],
                budget_from_row,
            )
            .optional()?)
    }

    /// Cria/atualiza; sem nenhum limite informado, remove a política.
    pub fn set_budget_policy(
        &self,
        scope: BudgetScope,
        scope_id: &str,
        input: &BudgetInput,
    ) -> Result<Option<BudgetPolicy>> {
        for v in [input.soft_usd, input.hard_usd].into_iter().flatten() {
            if v <= 0.0 || v.is_nan() {
                anyhow::bail!("Valores de orçamento devem ser positivos");
            }
        }
        if let (Some(s), Some(h)) = (input.soft_usd, input.hard_usd) {
            if s > h {
                anyhow::bail!("O aviso (soft) não pode ser maior que o limite (hard)");
            }
        }
        if input.soft_usd.is_none() && input.hard_usd.is_none() && input.max_turns.is_none() {
            let conn = self.conn.lock().expect("store mutex");
            conn.execute(
                "DELETE FROM budget_policy WHERE scope = ?1 AND scope_id = ?2",
                params![scope.as_str(), scope_id],
            )?;
            return Ok(None);
        }
        {
            let conn = self.conn.lock().expect("store mutex");
            conn.execute(
                "INSERT INTO budget_policy (id, scope, scope_id, soft_usd, hard_usd, max_turns, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
                 ON CONFLICT(scope, scope_id) DO UPDATE SET soft_usd = excluded.soft_usd, hard_usd = excluded.hard_usd, max_turns = excluded.max_turns, updated_at = excluded.updated_at",
                params![new_id("budget"), scope.as_str(), scope_id, input.soft_usd, input.hard_usd, input.max_turns.map(|n| n as i64), now()],
            )?;
        }
        self.get_budget_policy(scope, scope_id)
    }

    /// Gasto do mês: custo final do SDK quando existe, senão a estimativa pelos tokens
    /// (runs em andamento e runs interrompidos antes do resultado). Devolve também a parte ao vivo.
    fn month_spent(&self, project_id: &str, agent_id: Option<&str>) -> Result<(f64, u64, f64)> {
        let conn = self.conn.lock().expect("store mutex");
        let (spent, runs, live): (f64, i64, f64) = conn.query_row(
            &format!(
                "SELECT COALESCE(SUM(COALESCE(cost_usd, est_cost_usd)), 0), COUNT(*),
                    COALESCE(SUM(CASE WHEN cost_usd IS NULL AND status IN {ACTIVE} THEN est_cost_usd ELSE 0 END), 0)
                 FROM run WHERE project_id = ?1 AND started_at >= ?2 AND (?3 IS NULL OR agent_profile_id = ?3)"
            ),
            params![project_id, month_start(), agent_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )?;
        Ok((spent, runs as u64, live))
    }

    pub fn budget_status(&self, project_id: &str) -> Result<BudgetStatus> {
        let project = self
            .get_project(project_id)?
            .with_context(|| format!("Projeto {project_id} não encontrado"))?;
        let policy = self.get_budget_policy(BudgetScope::Project, project_id)?;
        let (spent, runs, live) = self.month_spent(project_id, None)?;
        let project_line = BudgetLine {
            scope: BudgetScope::Project,
            scope_id: project_id.to_string(),
            label: project.name.clone(),
            spent_usd: spent,
            soft_usd: policy.as_ref().and_then(|p| p.soft_usd),
            hard_usd: policy.as_ref().and_then(|p| p.hard_usd),
            max_turns: policy.as_ref().and_then(|p| p.max_turns),
            runs,
            live_usd: live,
            level: level(
                spent,
                policy.as_ref().and_then(|p| p.soft_usd),
                policy.as_ref().and_then(|p| p.hard_usd),
            )
            .into(),
        };
        let mut agents = Vec::new();
        for member in self.list_team(project_id)? {
            let policy = self.get_budget_policy(BudgetScope::Agent, &member.profile.id)?;
            let (spent, runs, live) = self.month_spent(project_id, Some(&member.profile.id))?;
            agents.push(BudgetLine {
                scope: BudgetScope::Agent,
                scope_id: member.profile.id.clone(),
                label: format!("{} · {}", member.profile.name, member.role.title),
                spent_usd: spent,
                soft_usd: policy.as_ref().and_then(|p| p.soft_usd),
                hard_usd: policy.as_ref().and_then(|p| p.hard_usd),
                max_turns: policy.as_ref().and_then(|p| p.max_turns),
                runs,
                live_usd: live,
                level: level(
                    spent,
                    policy.as_ref().and_then(|p| p.soft_usd),
                    policy.as_ref().and_then(|p| p.hard_usd),
                )
                .into(),
            });
        }
        Ok(BudgetStatus {
            month: month_start()[..7].to_string(),
            project: project_line,
            agents,
        })
    }

    /// Aplica orçamentos a um run prestes a começar: recusa se o hard do projeto ou do membro
    /// esgotou; senão limita `maxBudgetUsd` ao que resta e preenche `maxTurns` da política.
    pub fn apply_budget(
        &self,
        project_id: &str,
        agent_id: Option<&str>,
        mut options: RunOptions,
    ) -> Result<RunOptions> {
        let status = self.budget_status(project_id)?;
        let mut remaining: Option<f64> = None;
        let mut consider = |line: &BudgetLine| -> Result<()> {
            if let Some(hard) = line.hard_usd {
                let left = hard - line.spent_usd;
                if left <= 0.0 {
                    anyhow::bail!(
                        "Orçamento mensal esgotado para {}: US$ {:.2} gastos de US$ {:.2}. Aumente o limite em Segurança → Orçamentos.",
                        line.label,
                        line.spent_usd,
                        hard
                    );
                }
                remaining = Some(remaining.map_or(left, |r: f64| r.min(left)));
            }
            if options.max_turns.is_none() {
                options.max_turns = line.max_turns;
            }
            Ok(())
        };
        consider(&status.project)?;
        if let Some(agent) = agent_id {
            if let Some(line) = status.agents.iter().find(|a| a.scope_id == agent) {
                consider(line)?;
            }
        }
        if let Some(left) = remaining {
            let left = (left * 100.0).floor() / 100.0;
            options.max_budget_usd = Some(
                options
                    .max_budget_usd
                    .map_or(left, |b| b.min(left))
                    .max(0.01),
            );
        }
        Ok(options)
    }
}

impl Store {
    /// Depois de um evento com custo do run: o projeto ou o membro dele passou do limite?
    /// Devolve os runs ativos do escopo estourado (o próprio run incluído, se ainda ativo).
    pub fn budget_overrun(&self, run_id: &str) -> Result<Option<BudgetOverrun>> {
        let Some(run) = self.get_run(run_id)? else {
            return Ok(None);
        };
        let status = self.budget_status(&run.project_id)?;
        let mut lines = vec![&status.project];
        if let Some(agent) = run.agent_profile_id.as_deref() {
            lines.extend(status.agents.iter().filter(|a| a.scope_id == agent));
        }
        for line in lines {
            let Some(hard) = line.hard_usd else { continue };
            if line.spent_usd < hard {
                continue;
            }
            let agent = match line.scope {
                BudgetScope::Agent => Some(line.scope_id.as_str()),
                BudgetScope::Project => None,
            };
            let run_ids = self.active_runs_in_scope(&run.project_id, agent)?;
            if run_ids.is_empty() {
                continue;
            }
            return Ok(Some(BudgetOverrun {
                label: line.label.clone(),
                spent_usd: line.spent_usd,
                hard_usd: hard,
                run_ids,
            }));
        }
        Ok(None)
    }

    fn active_runs_in_scope(
        &self,
        project_id: &str,
        agent_id: Option<&str>,
    ) -> Result<Vec<String>> {
        let conn = self.conn.lock().expect("store mutex");
        let mut stmt = conn.prepare(&format!(
            "SELECT id FROM run WHERE project_id = ?1 AND status IN {ACTIVE} AND stop_cause IS NULL
                AND (?2 IS NULL OR agent_profile_id = ?2) ORDER BY started_at"
        ))?;
        let ids = stmt
            .query_map(params![project_id, agent_id], |r| r.get(0))?
            .collect::<rusqlite::Result<Vec<String>>>()?;
        Ok(ids)
    }

    /// Marca o run como interrompido por orçamento (antes de pedir ao sidecar que pare, para
    /// que o erro de interrupção que chega depois não o transforme em falha), fecha aprovações
    /// pendentes, bloqueia a task que ele executava e registra na auditoria.
    /// Devolve `false` se o run já tinha terminado ou já tinha sido parado.
    pub fn stop_run_for_budget(&self, run_id: &str, reason: &str) -> Result<bool> {
        let mut conn = self.conn.lock().expect("store mutex");
        let tx = conn.transaction()?;
        let changed = tx.execute(
            &format!(
                "UPDATE run SET status = 'interrupted', stop_cause = 'budget', error_message = ?2, ended_at = ?3
                 WHERE id = ?1 AND status IN {ACTIVE} AND stop_cause IS NULL"
            ),
            params![run_id, reason, now()],
        )?;
        if changed == 0 {
            return Ok(false);
        }
        super::close_pending_approvals(&tx, run_id)?;
        let task_id = Self::block_task_of_run(&tx, run_id, reason)?;
        let (project_id, est): (String, f64) = tx.query_row(
            "SELECT project_id, est_cost_usd FROM run WHERE id = ?1",
            params![run_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        Self::audit_in(
            &tx,
            "orçamento",
            "budget.hard_stop",
            Some(&project_id),
            serde_json::json!({"runId": run_id, "taskId": task_id, "estCostUsd": est, "reason": reason}),
        )?;
        tx.commit()?;
        Ok(true)
    }
}

fn profile_from_row(r: &Row<'_>) -> rusqlite::Result<SandboxProfile> {
    let json: String = r.get(4)?;
    Ok(SandboxProfile {
        id: r.get(0)?,
        name: r.get(1)?,
        description: r.get(2)?,
        builtin: r.get::<_, i64>(3)? != 0,
        settings: serde_json::from_str(&json).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(4, rusqlite::types::Type::Text, Box::new(e))
        })?,
        position: r.get(5)?,
    })
}

fn budget_from_row(r: &Row<'_>) -> rusqlite::Result<BudgetPolicy> {
    let scope: String = r.get(1)?;
    Ok(BudgetPolicy {
        id: r.get(0)?,
        scope: if scope == "agent" {
            BudgetScope::Agent
        } else {
            BudgetScope::Project
        },
        scope_id: r.get(2)?,
        soft_usd: r.get(3)?,
        hard_usd: r.get(4)?,
        max_turns: r.get::<_, Option<i64>>(5)?.map(|n| n as u32),
        created_at: r.get(6)?,
        updated_at: r.get(7)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{RunEvent, Usage};
    use crate::store::team::TeamMemberInput;

    fn finished(cost: f64) -> RunEvent {
        RunEvent::Result {
            session_id: "s".into(),
            subtype: "success".into(),
            is_error: false,
            cost_usd: Some(cost),
            duration_ms: None,
            num_turns: Some(1),
            usage: Some(Usage::default()),
            stop_reason: None,
            result_text: None,
        }
    }

    #[test]
    fn sandbox_profiles_are_seeded_and_resolved_for_the_project() {
        let s = Store::open_in_memory().unwrap();
        let profiles = s.list_sandbox_profiles().unwrap();
        assert_eq!(
            profiles.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(),
            vec!["sandbox_strict", "sandbox_dev", "sandbox_readonly"]
        );
        let p = s.create_project("p", "/Users/dev/proj").unwrap();
        assert_eq!(
            p.sandbox_profile_id.as_deref(),
            Some("sandbox_dev"),
            "padrão"
        );
        let dev = s.sandbox_for_project(&p).unwrap().unwrap();
        assert_eq!(
            dev.filesystem
                .as_ref()
                .unwrap()
                .allow_write
                .as_ref()
                .unwrap()[0],
            "/Users/dev/proj"
        );
        let home = std::env::var("HOME").unwrap();
        assert!(dev
            .filesystem
            .as_ref()
            .unwrap()
            .deny_read
            .as_ref()
            .unwrap()
            .iter()
            .any(|d| d == &format!("{home}/.ssh")));
        assert!(dev
            .network
            .as_ref()
            .unwrap()
            .allowed_domains
            .as_ref()
            .unwrap()
            .contains(&"github.com".to_string()));

        let p = s.set_project_sandbox(&p.id, "sandbox_strict").unwrap();
        let strict = s.sandbox_for_project(&p).unwrap().unwrap();
        assert_eq!(strict.fail_if_unavailable, Some(true));
        assert_eq!(
            strict.network.as_ref().unwrap().strict_allowlist,
            Some(true)
        );
        assert!(strict
            .network
            .as_ref()
            .unwrap()
            .allowed_domains
            .as_ref()
            .unwrap()
            .is_empty());
        assert!(s.set_project_sandbox(&p.id, "nope").is_err());
        // Serializa em camelCase como o SDK espera.
        let json = serde_json::to_value(&strict).unwrap();
        assert_eq!(json["allowUnsandboxedCommands"], false);
        assert_eq!(
            json["credentials"]["envVars"][0]["injectHosts"][0],
            "api.anthropic.com"
        );
    }

    fn usage(input: u64, output: u64, message: Option<&str>, parent: Option<&str>) -> RunEvent {
        RunEvent::Usage {
            usage: Usage {
                input_tokens: input,
                output_tokens: output,
                cache_read_tokens: 0,
                cache_creation_tokens: 0,
            },
            context_window: None,
            message_id: message.map(str::to_string),
            parent_tool_use_id: parent.map(str::to_string),
        }
    }

    #[test]
    fn live_estimate_counts_each_message_once_including_subagents() {
        let s = Store::open_in_memory().unwrap();
        let p = s.create_project("p", "/tmp/p").unwrap();
        let options = RunOptions {
            model: Some("claude-sonnet-5-5".into()),
            ..Default::default()
        };
        let run = s.create_run(&p.id, "x", &options).unwrap();
        s.set_run_status(&run.id, crate::store::models::RunStatus::Running)
            .unwrap();
        // 100k de entrada + 10k de saída no Sonnet 5.5 = 0,2 + 0,1 = 0,30.
        s.record_run_event(&run.id, 1, "t", &usage(100_000, 10_000, Some("m1"), None))
            .unwrap();
        // Mesmo id repetido (outro bloco da mesma mensagem): não soma de novo.
        s.record_run_event(&run.id, 2, "t", &usage(100_000, 10_000, Some("m1"), None))
            .unwrap();
        // O mesmo id com menos saída também não soma; com mais saída, soma só a diferença.
        s.record_run_event(&run.id, 21, "t", &usage(100_000, 5_000, Some("m1"), None))
            .unwrap();
        s.record_run_event(&run.id, 22, "t", &usage(100_000, 20_000, Some("m1"), None))
            .unwrap();
        assert!(
            (s.get_run(&run.id).unwrap().unwrap().est_cost_usd - 0.4).abs() < 1e-9,
            "0,2 de entrada + 0,2 de saída"
        );
        s.record_run_event(&run.id, 23, "t", &usage(100_000, 10_000, Some("m1"), None))
            .unwrap();
        // Subagente: soma no custo, mas não mexe no medidor de contexto.
        s.record_run_event(
            &run.id,
            3,
            "t",
            &usage(100_000, 10_000, Some("m2"), Some("toolu_x")),
        )
        .unwrap();
        let r = s.get_run(&run.id).unwrap().unwrap();
        assert!((r.est_cost_usd - 0.7).abs() < 1e-9, "{}", r.est_cost_usd);
        assert_eq!(r.input_tokens, 100_000);
        let status = s.budget_status(&p.id).unwrap();
        assert!((status.project.spent_usd - 0.7).abs() < 1e-9);
        assert!((status.project.live_usd - 0.7).abs() < 1e-9);
        // O custo final do SDK substitui a estimativa e sai do "ao vivo".
        s.record_run_event(&run.id, 4, "t", &finished(0.55))
            .unwrap();
        let status = s.budget_status(&p.id).unwrap();
        assert!((status.project.spent_usd - 0.55).abs() < 1e-9);
        assert_eq!(status.project.live_usd, 0.0);
    }

    #[test]
    fn overrun_mid_run_stops_active_runs_and_blocks_the_task() {
        use crate::store::models::RunStatus;
        use crate::store::orchestration::{TaskInput, TaskStatus};
        let s = Store::open_in_memory().unwrap();
        let p = s.create_project("p", "/tmp/p").unwrap();
        let other = s.create_project("q", "/tmp/q").unwrap();
        s.set_budget_policy(
            BudgetScope::Project,
            &p.id,
            &BudgetInput {
                hard_usd: Some(1.0),
                ..Default::default()
            },
        )
        .unwrap();
        let options = RunOptions {
            model: Some("claude-opus-5-5".into()),
            ..Default::default()
        };
        let wf = s
            .create_workflow_from_template(&p.id, "research-synthesis", false)
            .unwrap();
        let task = s
            .create_task(
                &p.id,
                &wf.id,
                &TaskInput {
                    title: "Migração".into(),
                    ..Default::default()
                },
            )
            .unwrap();
        let a = s.create_run(&p.id, "a", &options).unwrap();
        let b = s.create_run(&p.id, "b", &options).unwrap();
        let elsewhere = s.create_run(&other.id, "c", &options).unwrap();
        for r in [&a, &b, &elsewhere] {
            s.set_run_status(&r.id, RunStatus::Running).unwrap();
        }
        assert!(s.claim_task(&task.id, &a.id, None, None).unwrap());

        // 100k de saída no Opus 5.5 = US$ 2,00 > limite de 1,00... mas só depois do segundo run somar.
        s.record_run_event(&a.id, 1, "t", &usage(0, 30_000, Some("a1"), None))
            .unwrap();
        assert!(s.budget_overrun(&a.id).unwrap().is_none(), "0,60 < 1,00");
        s.record_run_event(&b.id, 1, "t", &usage(0, 25_000, Some("b1"), None))
            .unwrap();
        let overrun = s.budget_overrun(&b.id).unwrap().expect("1,10 >= 1,00");
        assert_eq!(
            overrun.run_ids,
            vec![a.id.clone(), b.id.clone()],
            "só o projeto estourado"
        );
        assert!((overrun.spent_usd - 1.1).abs() < 1e-9);
        assert!(overrun.reason().contains("US$ 1.10 de US$ 1.00"));
        assert_eq!(super::usd(0.0008), "0.0008");
        assert_eq!(super::usd(0.0), "0.00");

        assert!(s.stop_run_for_budget(&a.id, &overrun.reason()).unwrap());
        assert!(
            !s.stop_run_for_budget(&a.id, &overrun.reason()).unwrap(),
            "idempotente"
        );
        assert!(s.stop_run_for_budget(&b.id, &overrun.reason()).unwrap());

        let t = s.get_task(&task.id).unwrap().unwrap();
        assert_eq!(t.status, TaskStatus::Blocked);
        assert!(t.lock_run_id.is_none());
        assert!(t.last_note.unwrap().contains("Orçamento mensal esgotado"));

        // O erro de interrupção e um result tardio do SDK não apagam o motivo.
        s.record_run_event(
            &a.id,
            2,
            "t",
            &RunEvent::Error {
                message: "Run interrompido: aborted".into(),
                fatal: true,
            },
        )
        .unwrap();
        s.record_run_event(&b.id, 2, "t", &finished(0.4)).unwrap();
        let ra = s.get_run(&a.id).unwrap().unwrap();
        assert_eq!(ra.status, RunStatus::Interrupted);
        assert_eq!(ra.stop_cause.as_deref(), Some("budget"));
        assert!(ra.error_message.unwrap().contains("Orçamento"));
        assert_eq!(
            s.get_run(&b.id).unwrap().unwrap().status,
            RunStatus::Interrupted
        );
        assert_eq!(
            s.get_task(&task.id).unwrap().unwrap().status,
            TaskStatus::Blocked,
            "o erro tardio não refaz a task"
        );
        // Nada mais ativo: sem novo estouro; e o outro projeto seguiu rodando.
        assert!(s.budget_overrun(&a.id).unwrap().is_none());
        assert_eq!(
            s.get_run(&elsewhere.id).unwrap().unwrap().status,
            RunStatus::Running
        );
        let events = s
            .list_audit_events(Some(&p.id), Some("budget."), 50)
            .unwrap();
        assert_eq!(
            events
                .iter()
                .filter(|e| e.kind == "budget.hard_stop")
                .count(),
            2
        );
    }

    #[test]
    fn budgets_status_and_enforcement() {
        let s = Store::open_in_memory().unwrap();
        let p = s.create_project("p", "/tmp/p").unwrap();
        let ana = s
            .add_team_member(
                &p.id,
                &TeamMemberInput {
                    name: "Ana".into(),
                    role_id: "role_implementador".into(),
                    ..Default::default()
                },
            )
            .unwrap();
        // Sem política: tudo ok e sem limites.
        let status = s.budget_status(&p.id).unwrap();
        assert_eq!(status.project.level, "ok");
        assert_eq!(status.agents.len(), 1);
        let opts = s
            .apply_budget(&p.id, Some(&ana.profile.id), RunOptions::default())
            .unwrap();
        assert!(opts.max_budget_usd.is_none());

        // Política do projeto: soft 1, hard 2, 10 turnos; da Ana: hard 0.5.
        s.set_budget_policy(
            BudgetScope::Project,
            &p.id,
            &BudgetInput {
                soft_usd: Some(1.0),
                hard_usd: Some(2.0),
                max_turns: Some(10),
            },
        )
        .unwrap();
        s.set_budget_policy(
            BudgetScope::Agent,
            &ana.profile.id,
            &BudgetInput {
                hard_usd: Some(0.5),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(s
            .set_budget_policy(
                BudgetScope::Project,
                &p.id,
                &BudgetInput {
                    soft_usd: Some(3.0),
                    hard_usd: Some(2.0),
                    max_turns: None
                }
            )
            .is_err());
        assert!(s
            .set_budget_policy(
                BudgetScope::Project,
                &p.id,
                &BudgetInput {
                    soft_usd: Some(-1.0),
                    ..Default::default()
                }
            )
            .is_err());

        let opts = s
            .apply_budget(&p.id, Some(&ana.profile.id), RunOptions::default())
            .unwrap();
        assert_eq!(
            opts.max_budget_usd,
            Some(0.5),
            "min(restante projeto 2, restante Ana 0.5)"
        );
        assert_eq!(opts.max_turns, Some(10));
        let opts = s
            .apply_budget(
                &p.id,
                None,
                RunOptions {
                    max_budget_usd: Some(0.3),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(opts.max_budget_usd, Some(0.3), "pedido menor prevalece");

        // Gastos do mês: run da Ana de 0.6 esgota o dela e passa do soft do projeto.
        let run = s
            .create_run_for_agent(&p.id, "x", &RunOptions::default(), Some(&ana.profile.id))
            .unwrap();
        s.record_run_event(&run.id, 0, "t", &finished(0.6)).unwrap();
        let status = s.budget_status(&p.id).unwrap();
        assert_eq!(status.project.level, "ok");
        assert_eq!(status.agents[0].level, "hard");
        assert!(s
            .apply_budget(&p.id, Some(&ana.profile.id), RunOptions::default())
            .unwrap_err()
            .to_string()
            .contains("esgotado para Ana"));
        // Sem membro ainda dá: restante do projeto 1.4.
        let opts = s.apply_budget(&p.id, None, RunOptions::default()).unwrap();
        assert_eq!(opts.max_budget_usd, Some(1.4));

        let run2 = s.create_run(&p.id, "y", &RunOptions::default()).unwrap();
        s.record_run_event(&run2.id, 0, "t", &finished(0.5))
            .unwrap();
        assert_eq!(s.budget_status(&p.id).unwrap().project.level, "soft");
        let run3 = s.create_run(&p.id, "z", &RunOptions::default()).unwrap();
        s.record_run_event(&run3.id, 0, "t", &finished(1.0))
            .unwrap();
        let status = s.budget_status(&p.id).unwrap();
        assert_eq!(status.project.level, "hard");
        assert_eq!(status.project.runs, 3);
        assert!(s.apply_budget(&p.id, None, RunOptions::default()).is_err());

        // Remover a política (sem limites) libera.
        assert!(s
            .set_budget_policy(BudgetScope::Project, &p.id, &BudgetInput::default())
            .unwrap()
            .is_none());
        assert!(s.apply_budget(&p.id, None, RunOptions::default()).is_ok());
        assert_eq!(s.list_budget_policies().unwrap().len(), 1);
    }
}
