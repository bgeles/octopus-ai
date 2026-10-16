//! Motor de política PreToolUse: avalia as regras antes de cada ferramenta.
//! Ordem: `deny` vence, depois `ask`, depois `allow` explícito; sem regra → `pass` (fluxo normal do SDK).
//! Regras do projeto só podem apertar (deny/ask); `allow` só no escopo global.

use std::path::{Component, Path, PathBuf};

use anyhow::Result;
use regex::Regex;
use rusqlite::{params, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{new_id, now, Store};
use crate::protocol::HookDecision;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RuleKind {
    /// Regex sobre o comando do `Bash` (ou sentinela `@destructive-outside-project`).
    Command,
    /// Globs (separados por `|`) sobre `file_path` de Write/Edit/MultiEdit/NotebookEdit (ou `@outside-project`).
    Write,
    /// Globs/alternativas (`|`) sobre o nome da ferramenta.
    Tool,
    /// Globs sobre nomes de ferramentas MCP (`mcp__servidor__tool`).
    Mcp,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RuleAction {
    Allow,
    Deny,
    Ask,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RuleScope {
    Global,
    Project,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyRule {
    pub id: String,
    pub scope: RuleScope,
    pub project_id: Option<String>,
    pub kind: RuleKind,
    pub pattern: String,
    pub action: RuleAction,
    pub reason: String,
    pub enabled: bool,
    pub builtin: bool,
    pub position: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyRuleInput {
    pub kind: RuleKind,
    pub pattern: String,
    pub action: RuleAction,
    #[serde(default)]
    pub reason: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyDecision {
    /// `allow`, `deny`, `ask` ou `pass`.
    pub behavior: String,
    pub reason: Option<String>,
    pub rule_id: Option<String>,
}

impl PolicyDecision {
    pub fn pass() -> Self {
        PolicyDecision {
            behavior: "pass".into(),
            reason: None,
            rule_id: None,
        }
    }

    pub fn to_hook_decision(&self) -> HookDecision {
        HookDecision {
            behavior: self.behavior.clone(),
            reason: self.reason.clone(),
            updated_input: None,
        }
    }
}

pub struct PolicyContext<'a> {
    pub project_path: &'a Path,
    pub tool_name: &'a str,
    pub input: &'a Value,
}

const WRITE_TOOLS: &[&str] = &["Write", "Edit", "MultiEdit", "NotebookEdit"];

/// Avalia as regras habilitadas contra a chamada. Primeiro `deny`, depois `ask`, depois `allow`.
pub fn evaluate(rules: &[PolicyRule], ctx: &PolicyContext<'_>) -> PolicyDecision {
    let mut best: Option<&PolicyRule> = None;
    for rule in rules.iter().filter(|r| r.enabled) {
        if !matches(rule, ctx) {
            continue;
        }
        let rank = |a: RuleAction| match a {
            RuleAction::Deny => 3,
            RuleAction::Ask => 2,
            RuleAction::Allow => 1,
        };
        if best.is_none_or(|b| rank(rule.action) > rank(b.action)) {
            best = Some(rule);
        }
    }
    match best {
        None => PolicyDecision::pass(),
        Some(rule) => PolicyDecision {
            behavior: match rule.action {
                RuleAction::Allow => "allow",
                RuleAction::Deny => "deny",
                RuleAction::Ask => "ask",
            }
            .into(),
            reason: Some(if rule.reason.is_empty() {
                format!("Regra {}", rule.id)
            } else {
                rule.reason.clone()
            }),
            rule_id: Some(rule.id.clone()),
        },
    }
}

fn matches(rule: &PolicyRule, ctx: &PolicyContext<'_>) -> bool {
    match rule.kind {
        RuleKind::Command => {
            if ctx.tool_name != "Bash" {
                return false;
            }
            let Some(command) = ctx.input.get("command").and_then(Value::as_str) else {
                return false;
            };
            if rule.pattern == "@destructive-outside-project" {
                return destructive_outside_project(command, ctx.project_path);
            }
            Regex::new(&rule.pattern)
                .map(|re| re.is_match(command))
                .unwrap_or(false)
        }
        RuleKind::Write => {
            if !WRITE_TOOLS.contains(&ctx.tool_name) {
                return false;
            }
            let Some(path) = ctx
                .input
                .get("file_path")
                .or_else(|| ctx.input.get("notebook_path"))
                .and_then(Value::as_str)
            else {
                return false;
            };
            let resolved = resolve(ctx.project_path, path);
            if rule.pattern == "@outside-project" {
                return !is_inside(&resolved, ctx.project_path);
            }
            let text = resolved.to_string_lossy();
            rule.pattern
                .split('|')
                .map(str::trim)
                .any(|g| glob_match(g, &text) || glob_match(g, path))
        }
        RuleKind::Tool => rule
            .pattern
            .split('|')
            .map(str::trim)
            .any(|g| glob_match(g, ctx.tool_name)),
        RuleKind::Mcp => {
            ctx.tool_name.starts_with("mcp__")
                && rule
                    .pattern
                    .split('|')
                    .map(str::trim)
                    .any(|g| glob_match(g, ctx.tool_name))
        }
    }
}

fn glob_match(pattern: &str, text: &str) -> bool {
    let options = glob::MatchOptions {
        case_sensitive: false,
        require_literal_separator: false,
        require_literal_leading_dot: false,
    };
    glob::Pattern::new(pattern)
        .map(|p| p.matches_with(text, options))
        .unwrap_or(false)
}

/// `rm -rf`, `rm -r`, `rmdir`, `shred`, `mkfs`, `dd of=` apontando para fora do projeto (ou para a raiz/home).
fn destructive_outside_project(command: &str, project_path: &Path) -> bool {
    let re = Regex::new(
        r"(?x)
        (?:^|[;&|]\s*|\b)
        (?:sudo\s+)?
        (?:rm\s+(?:-[a-zA-Z]*[rRf][a-zA-Z]*\s+)+|rmdir\s+|shred\s+|mkfs(?:\.\w+)?\s+|dd\s+.*of=)
        (?P<targets>[^;&|]+)",
    )
    .expect("regex válida");
    for caps in re.captures_iter(command) {
        let targets = &caps["targets"];
        for raw in targets.split_whitespace() {
            if raw.starts_with('-') || raw.starts_with("of=") && !raw.starts_with("of=/") {
                continue;
            }
            let target = raw
                .trim_start_matches("of=")
                .trim_matches(|c| c == '"' || c == '\'');
            if target.is_empty() {
                continue;
            }
            if target == "/"
                || target == "~"
                || target.starts_with("~/")
                || target == "$HOME"
                || target.starts_with("$HOME/")
                || target == "*"
            {
                return true;
            }
            let resolved = resolve(project_path, target);
            if !is_inside(&resolved, project_path) {
                return true;
            }
        }
    }
    false
}

/// Resolve um caminho relativo ao projeto, normalizando `.` e `..` sem tocar no disco.
fn resolve(project_path: &Path, raw: &str) -> PathBuf {
    let path = Path::new(raw);
    let joined = if path.is_absolute() {
        path.to_path_buf()
    } else {
        project_path.join(path)
    };
    let mut out = PathBuf::new();
    for component in joined.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn is_inside(path: &Path, project_path: &Path) -> bool {
    let project = resolve(project_path, ".");
    path.starts_with(&project)
}

impl Store {
    const SELECT_RULES: &'static str = "SELECT id, scope, project_id, kind, pattern, action, reason, enabled, builtin, position, created_at, updated_at FROM policy_rule";

    /// Regras aplicáveis a um projeto: globais + as dele, na ordem de posição.
    pub fn list_policy_rules(&self, project_id: Option<&str>) -> Result<Vec<PolicyRule>> {
        let conn = self.conn.lock().expect("store mutex");
        let mut stmt = conn.prepare(&format!(
            "{} WHERE scope = 'global' OR project_id = ?1 ORDER BY scope DESC, position, created_at",
            Self::SELECT_RULES
        ))?;
        let rows = stmt
            .query_map(params![project_id], rule_from_row)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn get_policy_rule(&self, id: &str) -> Result<Option<PolicyRule>> {
        let conn = self.conn.lock().expect("store mutex");
        Ok(conn
            .query_row(
                &format!("{} WHERE id = ?1", Self::SELECT_RULES),
                params![id],
                rule_from_row,
            )
            .optional()?)
    }

    pub fn create_policy_rule(
        &self,
        project_id: Option<&str>,
        input: &PolicyRuleInput,
    ) -> Result<PolicyRule> {
        validate_rule(project_id, input)?;
        let id = new_id("rule");
        let ts = now();
        let scope = if project_id.is_some() {
            "project"
        } else {
            "global"
        };
        {
            let conn = self.conn.lock().expect("store mutex");
            let position: i64 = conn.query_row(
                "SELECT COALESCE(MAX(position), 0) + 1 FROM policy_rule",
                [],
                |r| r.get(0),
            )?;
            conn.execute(
                "INSERT INTO policy_rule (id, scope, project_id, kind, pattern, action, reason, enabled, builtin, position, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, ?9, ?10, ?10)",
                params![id, scope, project_id, kind_str(input.kind), input.pattern.trim(), action_str(input.action), input.reason.trim(), input.enabled as i64, position, ts],
            )?;
        }
        self.get_policy_rule(&id)?
            .ok_or_else(|| anyhow::anyhow!("regra sumiu após criar"))
    }

    pub fn update_policy_rule(&self, id: &str, input: &PolicyRuleInput) -> Result<PolicyRule> {
        let current = self
            .get_policy_rule(id)?
            .ok_or_else(|| anyhow::anyhow!("Regra {id} não encontrada"))?;
        validate_rule(current.project_id.as_deref(), input)?;
        {
            let conn = self.conn.lock().expect("store mutex");
            conn.execute(
                "UPDATE policy_rule SET kind = ?2, pattern = ?3, action = ?4, reason = ?5, enabled = ?6, updated_at = ?7 WHERE id = ?1",
                params![id, kind_str(input.kind), input.pattern.trim(), action_str(input.action), input.reason.trim(), input.enabled as i64, now()],
            )?;
        }
        self.get_policy_rule(id)?
            .ok_or_else(|| anyhow::anyhow!("regra sumiu após atualizar"))
    }

    pub fn set_policy_rule_enabled(&self, id: &str, enabled: bool) -> Result<PolicyRule> {
        {
            let conn = self.conn.lock().expect("store mutex");
            let changed = conn.execute(
                "UPDATE policy_rule SET enabled = ?2, updated_at = ?3 WHERE id = ?1",
                params![id, enabled as i64, now()],
            )?;
            if changed == 0 {
                anyhow::bail!("Regra {id} não encontrada");
            }
        }
        self.get_policy_rule(id)?
            .ok_or_else(|| anyhow::anyhow!("regra sumiu"))
    }

    /// Regras do catálogo (builtin) não são removidas, só desativadas.
    pub fn delete_policy_rule(&self, id: &str) -> Result<bool> {
        let conn = self.conn.lock().expect("store mutex");
        let builtin: Option<i64> = conn
            .query_row(
                "SELECT builtin FROM policy_rule WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )
            .optional()?;
        match builtin {
            None => Ok(false),
            Some(1) => anyhow::bail!("Regras do catálogo não podem ser removidas; desative-a"),
            Some(_) => Ok(conn.execute("DELETE FROM policy_rule WHERE id = ?1", params![id])? > 0),
        }
    }

    /// Avalia a política de um projeto para uma chamada de ferramenta.
    pub fn evaluate_policy(
        &self,
        project_id: &str,
        project_path: &Path,
        tool_name: &str,
        input: &Value,
    ) -> Result<PolicyDecision> {
        let rules = self.list_policy_rules(Some(project_id))?;
        Ok(evaluate(
            &rules,
            &PolicyContext {
                project_path,
                tool_name,
                input,
            },
        ))
    }
}

fn validate_rule(project_id: Option<&str>, input: &PolicyRuleInput) -> Result<()> {
    if input.pattern.trim().is_empty() {
        anyhow::bail!("Informe o padrão da regra");
    }
    if project_id.is_some() && input.action == RuleAction::Allow {
        anyhow::bail!(
            "Regras do projeto só podem apertar (negar ou perguntar); permitir só no escopo global"
        );
    }
    if input.kind == RuleKind::Command && !input.pattern.starts_with('@') {
        Regex::new(input.pattern.trim())
            .map_err(|e| anyhow::anyhow!("Expressão regular inválida: {e}"))?;
    }
    Ok(())
}

fn kind_str(kind: RuleKind) -> &'static str {
    match kind {
        RuleKind::Command => "command",
        RuleKind::Write => "write",
        RuleKind::Tool => "tool",
        RuleKind::Mcp => "mcp",
    }
}

fn action_str(action: RuleAction) -> &'static str {
    match action {
        RuleAction::Allow => "allow",
        RuleAction::Deny => "deny",
        RuleAction::Ask => "ask",
    }
}

fn rule_from_row(row: &Row<'_>) -> rusqlite::Result<PolicyRule> {
    let kind: String = row.get(3)?;
    let action: String = row.get(5)?;
    let scope: String = row.get(1)?;
    Ok(PolicyRule {
        id: row.get(0)?,
        scope: if scope == "project" {
            RuleScope::Project
        } else {
            RuleScope::Global
        },
        project_id: row.get(2)?,
        kind: match kind.as_str() {
            "write" => RuleKind::Write,
            "tool" => RuleKind::Tool,
            "mcp" => RuleKind::Mcp,
            _ => RuleKind::Command,
        },
        pattern: row.get(4)?,
        action: match action.as_str() {
            "allow" => RuleAction::Allow,
            "ask" => RuleAction::Ask,
            _ => RuleAction::Deny,
        },
        reason: row.get(6)?,
        enabled: row.get::<_, i64>(7)? != 0,
        builtin: row.get::<_, i64>(8)? != 0,
        position: row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store_with_project() -> (Store, String, PathBuf) {
        let s = Store::open_in_memory().unwrap();
        let path = PathBuf::from("/Users/dev/projetos/chat-core");
        let p = s
            .create_project("chat-core", path.to_str().unwrap())
            .unwrap();
        (s, p.id, path)
    }

    fn decide(s: &Store, project: &str, path: &Path, tool: &str, input: Value) -> PolicyDecision {
        s.evaluate_policy(project, path, tool, &input).unwrap()
    }

    #[test]
    fn seed_rules_cover_the_plan_cases() {
        let (s, project, path) = store_with_project();
        let rules = s.list_policy_rules(Some(&project)).unwrap();
        assert_eq!(rules.len(), 7);
        assert!(rules.iter().all(|r| r.builtin));

        // rm -rf fora do projeto é negado; dentro passa.
        let d = decide(
            &s,
            &project,
            &path,
            "Bash",
            serde_json::json!({"command": "rm -rf /tmp/x"}),
        );
        assert_eq!(
            (d.behavior.as_str(), d.rule_id.as_deref()),
            ("deny", Some("rule_destructive_outside"))
        );
        assert!(d.reason.unwrap().contains("fora da pasta do projeto"));
        assert_eq!(
            decide(
                &s,
                &project,
                &path,
                "Bash",
                serde_json::json!({"command": "rm -rf ./target && ls"})
            )
            .behavior,
            "pass"
        );
        assert_eq!(
            decide(
                &s,
                &project,
                &path,
                "Bash",
                serde_json::json!({"command": "rm -rf /Users/dev/projetos/chat-core/build"})
            )
            .behavior,
            "pass"
        );
        assert_eq!(
            decide(
                &s,
                &project,
                &path,
                "Bash",
                serde_json::json!({"command": "cd src && rm -rf ../../outro"})
            )
            .behavior,
            "deny"
        );
        assert_eq!(
            decide(
                &s,
                &project,
                &path,
                "Bash",
                serde_json::json!({"command": "sudo rm -rf /"})
            )
            .behavior,
            "deny"
        );
        assert_eq!(
            decide(
                &s,
                &project,
                &path,
                "Bash",
                serde_json::json!({"command": "rm -rf ~/Downloads/x"})
            )
            .behavior,
            "deny"
        );

        // git push protegido
        assert_eq!(
            decide(
                &s,
                &project,
                &path,
                "Bash",
                serde_json::json!({"command": "git push --force origin feature"})
            )
            .behavior,
            "deny"
        );
        assert_eq!(
            decide(
                &s,
                &project,
                &path,
                "Bash",
                serde_json::json!({"command": "git push origin main"})
            )
            .behavior,
            "deny"
        );
        assert_eq!(
            decide(
                &s,
                &project,
                &path,
                "Bash",
                serde_json::json!({"command": "git push origin feature/x"})
            )
            .behavior,
            "pass"
        );

        // escrita em segredos e fora do projeto
        assert_eq!(
            decide(
                &s,
                &project,
                &path,
                "Write",
                serde_json::json!({"file_path": ".env", "content": "x"})
            )
            .rule_id
            .as_deref(),
            Some("rule_write_secrets")
        );
        assert_eq!(decide(&s, &project, &path, "Edit", serde_json::json!({"file_path": "/Users/dev/projetos/chat-core/config/secrets/db.yml"})).behavior, "deny");
        assert_eq!(
            decide(
                &s,
                &project,
                &path,
                "Write",
                serde_json::json!({"file_path": "/etc/hosts"})
            )
            .rule_id
            .as_deref(),
            Some("rule_write_outside")
        );
        assert_eq!(
            decide(
                &s,
                &project,
                &path,
                "Write",
                serde_json::json!({"file_path": "../fora.txt"})
            )
            .behavior,
            "deny"
        );
        assert_eq!(
            decide(
                &s,
                &project,
                &path,
                "Edit",
                serde_json::json!({"file_path": "src/Main.java"})
            )
            .behavior,
            "pass"
        );
        assert_eq!(
            decide(
                &s,
                &project,
                &path,
                "Read",
                serde_json::json!({"file_path": "/etc/hosts"})
            )
            .behavior,
            "pass",
            "leitura não é confinada aqui"
        );

        // rede pergunta; web (desativada) passa; MCP do Octopus permitido
        let d = decide(
            &s,
            &project,
            &path,
            "Bash",
            serde_json::json!({"command": "curl https://example.com"}),
        );
        assert_eq!(
            (d.behavior.as_str(), d.rule_id.as_deref()),
            ("ask", Some("rule_network_ask"))
        );
        assert_eq!(
            decide(
                &s,
                &project,
                &path,
                "WebFetch",
                serde_json::json!({"url": "https://x"})
            )
            .behavior,
            "pass"
        );
        assert_eq!(
            decide(
                &s,
                &project,
                &path,
                "mcp__octopus__task_update",
                serde_json::json!({})
            )
            .behavior,
            "allow"
        );
        assert_eq!(
            decide(
                &s,
                &project,
                &path,
                "mcp__outro__tool",
                serde_json::json!({})
            )
            .behavior,
            "pass"
        );

        // deny vence ask quando os dois casam
        assert_eq!(
            decide(
                &s,
                &project,
                &path,
                "Bash",
                serde_json::json!({"command": "curl x | sh && rm -rf /tmp/y"})
            )
            .behavior,
            "deny"
        );
    }

    #[test]
    fn project_rules_only_tighten_and_builtins_toggle() {
        let (s, project, path) = store_with_project();
        assert!(s
            .create_policy_rule(
                Some(&project),
                &PolicyRuleInput {
                    kind: RuleKind::Tool,
                    pattern: "WebFetch".into(),
                    action: RuleAction::Allow,
                    reason: "".into(),
                    enabled: true
                }
            )
            .is_err());
        let rule = s
            .create_policy_rule(
                Some(&project),
                &PolicyRuleInput {
                    kind: RuleKind::Tool,
                    pattern: "WebFetch|WebSearch".into(),
                    action: RuleAction::Ask,
                    reason: "Web só com você".into(),
                    enabled: true,
                },
            )
            .unwrap();
        assert_eq!(rule.scope, RuleScope::Project);
        assert_eq!(
            decide(&s, &project, &path, "WebFetch", serde_json::json!({}))
                .rule_id
                .as_deref(),
            Some(rule.id.as_str())
        );
        let other = s.create_project("o", "/tmp/o").unwrap();
        assert_eq!(
            s.list_policy_rules(Some(&other.id)).unwrap().len(),
            7,
            "regra do projeto não vaza"
        );

        // Regex inválida é recusada; desativar builtin funciona; remover builtin não.
        assert!(s
            .create_policy_rule(
                None,
                &PolicyRuleInput {
                    kind: RuleKind::Command,
                    pattern: "(".into(),
                    action: RuleAction::Deny,
                    reason: "".into(),
                    enabled: true
                }
            )
            .is_err());
        let off = s
            .set_policy_rule_enabled("rule_network_ask", false)
            .unwrap();
        assert!(!off.enabled);
        assert_eq!(
            decide(
                &s,
                &project,
                &path,
                "Bash",
                serde_json::json!({"command": "curl x"})
            )
            .behavior,
            "pass"
        );
        assert!(s.delete_policy_rule("rule_network_ask").is_err());
        assert!(s.delete_policy_rule(&rule.id).unwrap());
        assert!(!s.delete_policy_rule("nope").unwrap());

        let updated = s
            .update_policy_rule(
                "rule_web_ask",
                &PolicyRuleInput {
                    kind: RuleKind::Tool,
                    pattern: "WebFetch".into(),
                    action: RuleAction::Deny,
                    reason: "sem web".into(),
                    enabled: true,
                },
            )
            .unwrap();
        assert_eq!(updated.action, RuleAction::Deny);
        assert_eq!(
            decide(&s, &project, &path, "WebFetch", serde_json::json!({})).behavior,
            "deny"
        );
    }
}
