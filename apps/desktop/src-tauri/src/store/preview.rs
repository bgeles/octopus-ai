//! Perfil de execução (Fase 5): defaults do projeto e o preview do `RunOptions` final, com a origem
//! de cada campo e os hooks declarativos que o Octopus registra. O preview não tem efeitos
//! colaterais: não cria run, não consome handoff, não sobe o uso das páginas nem monta plugin.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use super::Store;
use crate::protocol::{MemoryOptions, RunOptions};
use crate::secrets::{project_api_key_name, SecretStore, API_KEY_ENV};
use crate::store::models::AuthMode;

/// Chave de preferência por projeto: `project.<id>.defaults`.
pub fn defaults_key(project_id: &str) -> String {
    format!("project.{project_id}.defaults")
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDefaults {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_turns: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewNote {
    pub field: String,
    pub value: String,
    /// cargo · membro · projeto · segurança · orçamento · memória · harness · contexto · autenticação · pedido
    pub origin: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HookInfo {
    pub event: String,
    pub description: String,
    pub origin: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunPreview {
    pub options: RunOptions,
    pub notes: Vec<PreviewNote>,
    pub hooks: Vec<HookInfo>,
    /// Skills que entrariam no plugin local (montado só ao iniciar o run).
    pub plugin_skills: Vec<String>,
}

fn note(notes: &mut Vec<PreviewNote>, field: &str, value: impl Into<String>, origin: &str) {
    notes.push(PreviewNote {
        field: field.into(),
        value: value.into(),
        origin: origin.into(),
    });
}

impl Store {
    pub fn project_defaults(&self, project_id: &str) -> Result<ProjectDefaults> {
        Ok(self
            .get_setting(&defaults_key(project_id))?
            .and_then(|v| serde_json::from_value(v).ok())
            .unwrap_or_default())
    }

    /// Aplica modelo e máximo de turnos do projeto onde o run (ou o membro) não definiu.
    pub fn apply_project_defaults(
        &self,
        project_id: &str,
        options: &mut RunOptions,
    ) -> Result<ProjectDefaults> {
        let defaults = self.project_defaults(project_id)?;
        if options.model.is_none() {
            options.model = defaults.model.clone();
        }
        if options.max_turns.is_none() {
            options.max_turns = defaults.max_turns;
        }
        Ok(defaults)
    }

    /// Monta, sem efeitos colaterais, o `RunOptions` que um run com este pedido receberia.
    pub fn preview_run_options(
        &self,
        secrets: &dyn SecretStore,
        project_id: &str,
        agent_profile_id: Option<&str>,
        prompt: &str,
        requested: &RunOptions,
    ) -> Result<RunPreview> {
        let project = self
            .get_project(project_id)?
            .with_context(|| format!("Projeto {project_id} não encontrado"))?;
        let mut notes = Vec::new();
        let member = match agent_profile_id {
            Some(id) => Some(
                self.get_team_member_by_agent(id)?
                    .with_context(|| format!("Membro {id} não encontrado"))?,
            ),
            None => None,
        };

        // 1. Pedido + cargo/membro.
        let mut options = match agent_profile_id {
            Some(id) => self.agent_run_options(id, requested)?,
            None => requested.clone(),
        };
        if let Some(m) = &member {
            let from = |profile: bool| if profile { "membro" } else { "cargo" };
            if let Some(model) = &options.model {
                let origin = if requested.model.is_some() {
                    "pedido"
                } else {
                    from(m.profile.model.is_some())
                };
                note(&mut notes, "model", model.clone(), origin);
            }
            if let Some(mode) = &options.permission_mode {
                let origin = if requested.permission_mode.is_some() {
                    "pedido"
                } else {
                    from(m.profile.permission_mode.is_some())
                };
                note(
                    &mut notes,
                    "permissionMode",
                    serde_json::to_value(mode)?
                        .as_str()
                        .unwrap_or("")
                        .to_string(),
                    origin,
                );
            }
            if let Some(tools) = &options.allowed_tools {
                let origin = if requested.allowed_tools.is_some() {
                    "pedido"
                } else {
                    from(m.profile.allowed_tools.is_some())
                };
                note(&mut notes, "allowedTools", tools.join(", "), origin);
            }
            if let Some(t) = options.max_turns {
                note(
                    &mut notes,
                    "maxTurns",
                    t.to_string(),
                    if requested.max_turns.is_some() {
                        "pedido"
                    } else {
                        "membro"
                    },
                );
            }
            if let Some(b) = options.max_budget_usd {
                note(
                    &mut notes,
                    "maxBudgetUsd",
                    format!("{b:.2}"),
                    if requested.max_budget_usd.is_some() {
                        "pedido"
                    } else {
                        "membro"
                    },
                );
            }
            if let Some(agents) = &options.agents {
                note(
                    &mut notes,
                    "agents",
                    agents.keys().cloned().collect::<Vec<_>>().join(", "),
                    "time (delegados)",
                );
            }
            if let Some(append) = &options.system_prompt_append {
                note(
                    &mut notes,
                    "systemPrompt.append",
                    format!("{} caracteres (cargo + membro)", append.chars().count()),
                    "cargo + membro",
                );
            }
        } else {
            if let Some(model) = &options.model {
                note(&mut notes, "model", model.clone(), "pedido");
            }
            if let Some(mode) = &options.permission_mode {
                note(
                    &mut notes,
                    "permissionMode",
                    serde_json::to_value(mode)?
                        .as_str()
                        .unwrap_or("")
                        .to_string(),
                    "pedido",
                );
            }
            if let Some(t) = options.max_turns {
                note(&mut notes, "maxTurns", t.to_string(), "pedido");
            }
        }

        // 2. Defaults do projeto.
        let before = (options.model.clone(), options.max_turns);
        let defaults = self.apply_project_defaults(project_id, &mut options)?;
        if before.0.is_none() {
            if let Some(m) = &options.model {
                note(&mut notes, "model", m.clone(), "projeto");
            }
        }
        if before.1.is_none() {
            if let Some(t) = options.max_turns {
                note(&mut notes, "maxTurns", t.to_string(), "projeto");
            }
        }
        if options.model.is_none() {
            note(&mut notes, "model", "padrão do Claude Code", "padrão");
        }
        let _ = defaults;

        // 3. Segurança: política, sandbox, orçamento.
        options.policy_hooks = Some(true);
        let rules = self.list_policy_rules(Some(project_id))?;
        let enabled = rules.iter().filter(|r| r.enabled).count();
        let project_rules = rules
            .iter()
            .filter(|r| r.enabled && r.project_id.is_some())
            .count();
        note(
            &mut notes,
            "policyHooks",
            format!(
                "true · {enabled} regras ativas ({} globais, {project_rules} do projeto)",
                enabled - project_rules
            ),
            "segurança",
        );
        options.sandbox = self.sandbox_for_project(&project)?;
        let profile_name = self
            .list_sandbox_profiles()?
            .into_iter()
            .find(|p| Some(&p.id) == project.sandbox_profile_id.as_ref())
            .map(|p| p.name)
            .unwrap_or_else(|| "Dev padrão".into());
        note(&mut notes, "sandbox", profile_name, "segurança");
        let budget_before = options.max_budget_usd;
        options = self.apply_budget(project_id, agent_profile_id, options)?;
        if options.max_budget_usd != budget_before {
            note(
                &mut notes,
                "maxBudgetUsd",
                options
                    .max_budget_usd
                    .map(|b| format!("{b:.2} (limitado ao restante do mês)"))
                    .unwrap_or_default(),
                "orçamento",
            );
        }

        // 4. Memória e contexto.
        let memory = options.memory.get_or_insert_with(MemoryOptions::default);
        memory.tools = Some(true);
        let brief = self.memory_brief_with(project_id, None, prompt, None, false)?;
        match &brief {
            Some(b) => {
                memory.brief = Some(b.text.clone());
                memory.brief_items = Some(b.items.clone());
                note(
                    &mut notes,
                    "memory.brief",
                    format!(
                        "{} caracteres · {}",
                        b.text.chars().count(),
                        b.items.join(" · ")
                    ),
                    "memória",
                );
            }
            None => note(
                &mut notes,
                "memory.brief",
                "nada ainda (memória vazia para este pedido)",
                "memória",
            ),
        }
        note(
            &mut notes,
            "memory.capture",
            if memory.capture {
                "observações por hooks"
            } else {
                "desligada"
            },
            "memória",
        );
        if options.setting_sources.is_none() {
            options.setting_sources = self.project_setting_sources(project_id)?;
        }
        note(
            &mut notes,
            "settingSources",
            match &options.setting_sources {
                None => "padrão do Claude Code (usuário + projeto)".to_string(),
                Some(s) if s.is_empty() => "nenhuma (sem CLAUDE.md nem rules)".to_string(),
                Some(s) => s
                    .iter()
                    .map(|x| format!("{x:?}").to_lowercase())
                    .collect::<Vec<_>>()
                    .join(", "),
            },
            "contexto",
        );

        // 5. Harness: MCP servers e skills.
        if options.mcp_servers.is_none() {
            options.mcp_servers = self.mcp_servers_for_run(project_id, agent_profile_id)?;
        }
        let mut servers: Vec<String> = vec!["octopus (sdk)".into()];
        if let Some(map) = &options.mcp_servers {
            servers.extend(map.iter().map(|(n, c)| format!("{n} ({})", c.transport())));
        }
        note(&mut notes, "mcpServers", servers.join(", "), "harness");
        let plugin_skills: Vec<String> = self
            .plugin_skills(
                project_id,
                agent_profile_id,
                options.setting_sources.as_deref(),
            )?
            .into_iter()
            .map(|s| s.name)
            .collect();
        note(
            &mut notes,
            "plugins",
            if plugin_skills.is_empty() {
                "nenhum plugin (skills do projeto já entram pelo settingSources)".to_string()
            } else {
                format!("1 local · skills {}", plugin_skills.join(", "))
            },
            "harness",
        );

        // 6. Autenticação (valor nunca aparece).
        if project.auth_mode == AuthMode::ApiKey {
            let has = secrets.has(&project_api_key_name(project_id))?;
            options.env.get_or_insert_with(Default::default).insert(
                API_KEY_ENV.into(),
                if has {
                    "••• (Keychain)".into()
                } else {
                    "(sem chave no Keychain!)".into()
                },
            );
            note(
                &mut notes,
                "env",
                format!(
                    "{API_KEY_ENV}={}",
                    if has {
                        "••• do Keychain"
                    } else {
                        "AUSENTE: o run vai falhar"
                    }
                ),
                "autenticação",
            );
        } else {
            note(
                &mut notes,
                "env",
                "login do Claude Code (sem chave)",
                "autenticação",
            );
        }

        // Hooks declarativos que o sidecar registra para estas opções.
        let mut hooks = vec![HookInfo {
            event: "PreToolUse".into(),
            description: format!("Motor de política em Rust ({enabled} regras ativas): nega, pergunta ou deixa passar antes de cada ferramenta"),
            origin: "Segurança · Política".into(),
        }];
        if brief.is_some() {
            hooks.push(HookInfo { event: "UserPromptSubmit".into(), description: "Injeta o brief de memória (handoff pendente, páginas relevantes, pins) uma vez por run".into(), origin: "Memória · Contexto".into() });
        }
        if memory.capture {
            hooks.push(HookInfo {
                event: "PostToolUse".into(),
                description: "Observação por ferramenta (sanitizada) para a memória".into(),
                origin: "Memória".into(),
            });
            hooks.push(HookInfo {
                event: "Stop · SubagentStop".into(),
                description: "Resumo do turno e dos subagentes vira observação".into(),
                origin: "Memória".into(),
            });
            hooks.push(HookInfo {
                event: "PreCompact · PostCompact".into(),
                description: "Registra compactações e o resumo gerado".into(),
                origin: "Memória · Contexto".into(),
            });
            hooks.push(HookInfo {
                event: "InstructionsLoaded".into(),
                description: "Lista CLAUDE.md e rules carregados".into(),
                origin: "Memória · Contexto".into(),
            });
            hooks.push(HookInfo {
                event: "SessionEnd".into(),
                description: "Fecha o run; consolidação da memória em seguida".into(),
                origin: "Memória".into(),
            });
        }

        Ok(RunPreview {
            options,
            notes,
            hooks,
            plugin_skills,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secrets::MemorySecrets;
    use crate::store::team::TeamMemberInput;

    #[test]
    fn preview_has_no_side_effects_and_explains_origins() {
        let store = Store::open_in_memory().unwrap();
        let secrets = MemorySecrets::default();
        let project = store.create_project("p", "/tmp/p").unwrap();
        store
            .update_project_auth(&project.id, AuthMode::ApiKey)
            .unwrap();
        store
            .add_team_member(
                &project.id,
                &TeamMemberInput {
                    name: "Ana".into(),
                    role_id: "role_implementador".into(),
                    model: Some("claude-opus-5-5".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        let ana = store.list_team(&project.id).unwrap()[0].profile.id.clone();
        store
            .set_setting(
                &defaults_key(&project.id),
                &serde_json::json!({"maxTurns": 12}),
            )
            .unwrap();
        store
            .create_handoff(&project.id, None, None, "Onde parei: x.", "agent")
            .unwrap();

        let preview = store
            .preview_run_options(
                &secrets,
                &project.id,
                Some(&ana),
                "crie a migração",
                &RunOptions::default(),
            )
            .unwrap();
        let origin = |field: &str| {
            preview
                .notes
                .iter()
                .filter(|n| n.field == field)
                .map(|n| n.origin.clone())
                .collect::<Vec<_>>()
        };
        assert_eq!(origin("model"), vec!["membro"]);
        assert_eq!(preview.options.model.as_deref(), Some("claude-opus-5-5"));
        assert_eq!(origin("maxTurns"), vec!["projeto"]);
        assert_eq!(preview.options.max_turns, Some(12));
        assert!(origin("permissionMode").contains(&"cargo".to_string()));
        assert_eq!(preview.options.policy_hooks, Some(true));
        assert!(preview
            .notes
            .iter()
            .any(|n| n.field == "sandbox" && n.value == "Dev padrão"));
        assert!(preview
            .options
            .memory
            .as_ref()
            .unwrap()
            .brief
            .as_deref()
            .unwrap()
            .contains("Onde parei: x."));
        // Sem chave: aviso, nunca um valor real.
        assert_eq!(
            preview.options.env.as_ref().unwrap()[API_KEY_ENV],
            "(sem chave no Keychain!)"
        );
        secrets
            .set(&project_api_key_name(&project.id), "sk-ant-real")
            .unwrap();
        let again = store
            .preview_run_options(
                &secrets,
                &project.id,
                Some(&ana),
                "crie a migração",
                &RunOptions::default(),
            )
            .unwrap();
        assert_eq!(
            again.options.env.as_ref().unwrap()[API_KEY_ENV],
            "••• (Keychain)"
        );
        assert!(!serde_json::to_string(&again)
            .unwrap()
            .contains("sk-ant-real"));
        assert!(again.hooks.iter().any(|h| h.event == "PreToolUse"));
        assert!(again.hooks.iter().any(|h| h.event == "UserPromptSubmit"));
        // Nada mudou: handoff continua pendente e nenhum run foi criado.
        assert!(store.list_handoffs(&project.id).unwrap()[0]
            .consumed_at
            .is_none());
        assert!(store.list_runs(&project.id, 10).unwrap().is_empty());
        // Sem membro e sem defaults de modelo: origem "padrão".
        store
            .set_setting(&defaults_key(&project.id), &serde_json::Value::Null)
            .unwrap();
        let plain = store
            .preview_run_options(
                &secrets,
                &project.id,
                None,
                "oi",
                &RunOptions {
                    max_turns: Some(3),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(origin_of(&plain, "model"), vec!["padrão"]);
        assert_eq!(origin_of(&plain, "maxTurns"), vec!["pedido"]);
    }

    fn origin_of(p: &RunPreview, field: &str) -> Vec<String> {
        p.notes
            .iter()
            .filter(|n| n.field == field)
            .map(|n| n.origin.clone())
            .collect()
    }

    #[test]
    fn project_defaults_fill_only_missing_values() {
        let store = Store::open_in_memory().unwrap();
        let project = store.create_project("p", "/tmp/p").unwrap();
        store
            .set_setting(
                &defaults_key(&project.id),
                &serde_json::json!({"model": "claude-sonnet-5-5", "maxTurns": 20}),
            )
            .unwrap();
        let mut o = RunOptions {
            max_turns: Some(5),
            ..Default::default()
        };
        let d = store.apply_project_defaults(&project.id, &mut o).unwrap();
        assert_eq!(d.model.as_deref(), Some("claude-sonnet-5-5"));
        assert_eq!(o.model.as_deref(), Some("claude-sonnet-5-5"));
        assert_eq!(o.max_turns, Some(5));
    }
}
