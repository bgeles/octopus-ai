//! Verificações com o Claude de verdade (custam dinheiro; ficam fora do `cargo test` normal):
//! `cargo test real_ -- --ignored --nocapture --test-threads=1`.
//!
//! Cada teste sobe o sidecar compilado (`packages/agent-runtime/dist/main.js`), monta as opções
//! como o `start_run` faz e repete o laço de notificações do app (`lib.rs`): grava os eventos,
//! decide os hooks de política, responde à memória e confere o orçamento a cada custo.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::mpsc;

use crate::protocol::{
    CustomHookEvent, EffortLevel, HookOutcome, McpCheckParams, McpServerConfig,
    PermissionDecideParams, PermissionDecision, PermissionMode, RunEvent, RunOptions,
    RunStartParams, SettingSource,
};
use crate::sidecar::command::find_node;
use crate::sidecar::{Sidecar, SidecarCommand, SidecarNotification};
use crate::store::harness::McpServerInput;
use crate::store::hooks::CustomHookInput;
use crate::store::models::RunStatus;
use crate::store::security::{BudgetInput, BudgetScope};
use crate::store::Store;

/// Modelo barato para as verificações.
const MODEL: &str = "claude-haiku-5-5";

fn manifest() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

async fn real_sidecar() -> (Arc<Sidecar>, mpsc::Receiver<SidecarNotification>) {
    let main_js = manifest()
        .join("../../../packages/agent-runtime/dist/main.js")
        .canonicalize()
        .expect("sidecar compilado (npm run build -w @octopus/agent-runtime)");
    let (sidecar, notifications) = Sidecar::spawn(SidecarCommand::new(
        find_node(),
        vec![main_js.to_string_lossy().into_owned()],
    ))
    .await
    .unwrap();
    sidecar.hello().await.unwrap();
    (sidecar, notifications)
}

/// Repete o laço do app até o run terminar. `allow` decide os pedidos de permissão.
async fn drive(
    store: &Store,
    sidecar: &Sidecar,
    notifications: &mut mpsc::Receiver<SidecarNotification>,
    run_id: &str,
    allow: impl Fn(&str) -> bool,
) -> Vec<RunEvent> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(300);
    let mut events = Vec::new();
    loop {
        let n = tokio::time::timeout_at(deadline, notifications.recv())
            .await
            .expect("timeout esperando o run")
            .expect("canal fechado");
        match n {
            SidecarNotification::Hook(hook) => {
                let decision = crate::decide_hook(store, &hook);
                eprintln!("política {} → {}", hook.tool_name, decision.behavior);
                sidecar
                    .decide_hook(crate::protocol::HookDecideParams {
                        run_id: hook.run_id.clone(),
                        hook_id: hook.hook_id.clone(),
                        decision,
                    })
                    .await
                    .unwrap();
            }
            SidecarNotification::MemoryCall(call) => {
                let result = store
                    .handle_memory_call(&call.run_id, call.op, &call.args)
                    .unwrap();
                sidecar
                    .memory_result(crate::protocol::MemoryResultParams {
                        run_id: call.run_id.clone(),
                        call_id: call.call_id.clone(),
                        result,
                    })
                    .await
                    .unwrap();
            }
            SidecarNotification::RunEvent(ev) if ev.run_id == run_id => {
                eprintln!("[{}] {}", ev.seq, describe(&ev.event));
                store
                    .record_run_event(&ev.run_id, ev.seq, &ev.at, &ev.event)
                    .unwrap();
                if let RunEvent::PermissionRequest {
                    request_id,
                    tool_name,
                    ..
                } = &ev.event
                {
                    let ok = allow(tool_name);
                    eprintln!(
                        "permissão {tool_name} → {}",
                        if ok { "permite" } else { "nega" }
                    );
                    sidecar
                        .decide_permission(PermissionDecideParams {
                            run_id: run_id.to_string(),
                            request_id: request_id.clone(),
                            decision: if ok {
                                PermissionDecision::Allow {
                                    updated_input: None,
                                }
                            } else {
                                PermissionDecision::Deny {
                                    message: "teste: não permitido".into(),
                                }
                            },
                        })
                        .await
                        .unwrap();
                }
                if matches!(ev.event, RunEvent::Usage { .. } | RunEvent::Result { .. }) {
                    if let Some(stopped) = crate::enforce_budget(store, sidecar, run_id).await {
                        eprintln!("orçamento parou {:?}: {}", stopped.run_ids, stopped.reason);
                    }
                }
                let terminal = ev.event.is_terminal();
                events.push(ev.event);
                if terminal {
                    return events;
                }
            }
            SidecarNotification::Exited(code) => panic!("sidecar saiu: {code:?}"),
            _ => {}
        }
    }
}

fn describe(e: &RunEvent) -> String {
    match e {
        RunEvent::ToolUse { name, .. } => format!("tool_use {name}"),
        RunEvent::ToolResult {
            content, is_error, ..
        } => format!(
            "tool_result{} {}",
            if *is_error { " (erro)" } else { "" },
            content.chars().take(120).collect::<String>()
        ),
        RunEvent::HookRan {
            name,
            outcome,
            message,
            ..
        } => format!("hook_ran {name} {outcome:?} {message:?}"),
        RunEvent::Result {
            usage: Some(u),
            cost_usd,
            ..
        } => format!(
            "result US$ {cost_usd:?} · total in {} out {} cache_read {} cache_write {}",
            u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_creation_tokens
        ),
        RunEvent::Result {
            cost_usd,
            result_text,
            ..
        } => format!("result US$ {cost_usd:?} {result_text:?}"),
        RunEvent::Error { message, .. } => format!("error {message}"),
        RunEvent::Usage {
            usage,
            message_id,
            parent_tool_use_id,
            ..
        } => format!(
            "usage {message_id:?}{} in {} out {} cache_read {} cache_write {}",
            if parent_tool_use_id.is_some() {
                " (sub)"
            } else {
                ""
            },
            usage.input_tokens,
            usage.output_tokens,
            usage.cache_read_tokens,
            usage.cache_creation_tokens
        ),
        other => other.kind().to_string(),
    }
}

fn project_dir() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    // `git init` para o Claude Code tratar a pasta como projeto.
    assert!(std::process::Command::new("git")
        .args(["init", "-q"])
        .current_dir(dir.path())
        .status()
        .unwrap()
        .success());
    dir
}

/// Harness com o Claude de verdade: MCP server real (com health check), skill do projeto
/// carregada, hook livre que bloqueia o Bash e esforço escolhido chegando ao SDK.
#[tokio::test]
#[ignore = "usa o Claude de verdade (custa dinheiro); rode com --ignored"]
async fn real_harness_mcp_skill_hook_and_effort() {
    let (sidecar, mut notifications) = real_sidecar().await;
    let store = Store::open_in_memory().unwrap();
    let dir = project_dir();
    let root = dir.path();
    let project = store
        .create_project("verificacao", root.to_str().unwrap())
        .unwrap();

    // MCP server stdio local, testado pelo mesmo caminho do botão "Testar".
    let config = McpServerConfig::Stdio {
        command: find_node(),
        args: Some(vec![manifest()
            .join("tests/fixtures/palavra_mcp.mjs")
            .to_string_lossy()
            .into_owned()]),
        env: None,
    };
    let check = sidecar
        .mcp_check(McpCheckParams {
            name: "palavras".into(),
            config: config.clone(),
        })
        .await
        .unwrap();
    eprintln!("mcp.check: {check:?}");
    assert!(check.ok, "{:?}", check.error);
    assert_eq!(check.tools[0].name, "palavra");
    store
        .save_mcp_server(&McpServerInput {
            id: None,
            project_id: Some(project.id.clone()),
            name: "palavras".into(),
            config,
            enabled: true,
        })
        .unwrap();

    // Skill do projeto: o Claude Code carrega sozinho com settingSources "project".
    let skill_dir = root.join(".claude/skills/frase-de-teste");
    std::fs::create_dir_all(&skill_dir).unwrap();
    std::fs::write(
        skill_dir.join("SKILL.md"),
        "---\nname: frase-de-teste\ndescription: Use quando pedirem a frase de teste do projeto.\n---\n\nA frase de teste do projeto é: o polvo tem oito braços.\n",
    )
    .unwrap();

    // Hook livre: guarda o JSON do evento (para conferir o esforço) e bloqueia o Bash.
    store
        .save_custom_hook(&CustomHookInput {
            id: None,
            project_id: Some(project.id.clone()),
            name: "Bloquear Bash".into(),
            event: CustomHookEvent::PreToolUse,
            matcher: Some("Bash".into()),
            command: r#"cat > "$CLAUDE_PROJECT_DIR/hook-input.json"; echo "Bash bloqueado pelo hook de teste" >&2; exit 2"#.into(),
            timeout_sec: 10,
            enabled: true,
        })
        .unwrap();

    let mut options = RunOptions {
        model: Some(MODEL.into()),
        effort: Some(EffortLevel::Low),
        permission_mode: Some(PermissionMode::Default),
        max_turns: Some(8),
        setting_sources: Some(vec![SettingSource::Project]),
        policy_hooks: Some(true),
        ..Default::default()
    };
    options.mcp_servers = store.mcp_servers_for_run(&project.id, None).unwrap();
    options.custom_hooks = store.custom_hooks_for_run(&project.id).unwrap();
    let prompt = "Faça exatamente isto, em ordem:\n1. Chame a tool mcp__palavras__palavra.\n2. Rode `echo oi` com a ferramenta Bash (se for bloqueado, siga).\n3. Responda numa linha só: PALAVRA=<palavra da tool>; BASH=<bloqueado ou ok>.";
    let run = store.create_run(&project.id, prompt, &options).unwrap();
    sidecar
        .start_run(RunStartParams {
            run_id: run.id.clone(),
            cwd: project.path.clone(),
            prompt: prompt.into(),
            options,
        })
        .await
        .unwrap();
    let events = drive(&store, &sidecar, &mut notifications, &run.id, |tool| {
        tool.starts_with("mcp__palavras__")
    })
    .await;

    let init = events
        .iter()
        .find_map(|e| match e {
            RunEvent::SessionInit {
                mcp_servers,
                skills,
                tools,
                ..
            } => Some((mcp_servers.clone(), skills.clone(), tools.clone())),
            _ => None,
        })
        .expect("session_init");
    eprintln!("init: mcp {:?} · skills {:?}", init.0, init.1);
    assert!(
        init.0
            .iter()
            .any(|s| s.name == "palavras" && s.status == "connected"),
        "MCP server não conectou: {:?}",
        init.0
    );
    assert!(init.2.iter().any(|t| t == "mcp__palavras__palavra"));
    assert!(
        init.1.iter().any(|s| s == "frase-de-teste"),
        "skill do projeto não carregou: {:?}",
        init.1
    );

    let hook_blocked = events.iter().any(|e| {
        matches!(
            e,
            RunEvent::HookRan {
                outcome: HookOutcome::Blocked,
                ..
            }
        )
    });
    assert!(hook_blocked, "o hook livre não bloqueou o Bash");
    let input: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(root.join("hook-input.json")).unwrap())
            .unwrap();
    eprintln!(
        "entrada do hook: tool {} · effort {}",
        input["tool_name"], input["effort"]
    );
    assert_eq!(input["tool_name"], "Bash");
    assert_eq!(
        input["effort"]["level"], "low",
        "o esforço não chegou ao SDK"
    );
    assert_eq!(
        store
            .list_audit_events(Some(&project.id), Some("hook."), 10)
            .unwrap()
            .len(),
        1
    );

    let done = store.get_run(&run.id).unwrap().unwrap();
    eprintln!(
        "run {:?} · custo US$ {:?} · estimado US$ {:.4} · {:?}",
        done.status, done.cost_usd, done.est_cost_usd, done.result_text
    );
    assert_eq!(
        done.status,
        RunStatus::Completed,
        "{:?}",
        done.error_message
    );
    let text = done.result_text.unwrap_or_default().to_lowercase();
    assert!(text.contains("abacaxi"), "a tool MCP não respondeu: {text}");
    // A estimativa ao vivo acompanha o custo final do SDK (medido: 0,0028 × 0,00278).
    let final_cost = done.cost_usd.expect("custo final");
    assert!(
        (done.est_cost_usd - final_cost).abs() / final_cost < 0.15,
        "estimativa {:.5} longe do custo final {final_cost:.5}",
        done.est_cost_usd
    );
    sidecar.shutdown().await;
}

/// Orçamento com o Claude de verdade: um limite abaixo do custo da primeira resposta faz o
/// core interromper o run no meio, com o motivo preservado depois do erro do SDK.
#[tokio::test]
#[ignore = "usa o Claude de verdade (custa dinheiro); rode com --ignored"]
async fn real_budget_stops_the_run_midway() {
    let (sidecar, mut notifications) = real_sidecar().await;
    let store = Store::open_in_memory().unwrap();
    let dir = project_dir();
    let project = store
        .create_project("orcamento", dir.path().to_str().unwrap())
        .unwrap();
    store
        .set_budget_policy(
            BudgetScope::Project,
            &project.id,
            &BudgetInput {
                hard_usd: Some(0.0005),
                ..Default::default()
            },
        )
        .unwrap();
    let options = RunOptions {
        model: Some(MODEL.into()),
        effort: Some(EffortLevel::Low),
        max_turns: Some(10),
        setting_sources: Some(vec![]),
        ..Default::default()
    };
    // O `apply_budget` do `start_run` ainda deixa este run começar (nada gasto no mês).
    let options = store.apply_budget(&project.id, None, options).unwrap();
    let prompt = "Use a ferramenta Bash para rodar `sleep 1`, cinco vezes, uma chamada por vez. Depois diga 'fim'.";
    let run = store.create_run(&project.id, prompt, &options).unwrap();
    sidecar
        .start_run(RunStartParams {
            run_id: run.id.clone(),
            cwd: project.path.clone(),
            prompt: prompt.into(),
            options,
        })
        .await
        .unwrap();
    let events = drive(&store, &sidecar, &mut notifications, &run.id, |_| true).await;
    let stopped = store.get_run(&run.id).unwrap().unwrap();
    let bash_calls = events
        .iter()
        .filter(|e| matches!(e, RunEvent::ToolUse { name, .. } if name == "Bash"))
        .count();
    eprintln!(
        "run {:?} · stop_cause {:?} · estimado US$ {:.4} · {} Bash · {:?}",
        stopped.status, stopped.stop_cause, stopped.est_cost_usd, bash_calls, stopped.error_message
    );
    assert_eq!(stopped.status, RunStatus::Interrupted);
    assert_eq!(stopped.stop_cause.as_deref(), Some("budget"));
    assert!(bash_calls < 5, "o run deveria parar antes de terminar");
    assert!(stopped
        .error_message
        .unwrap()
        .contains("Orçamento mensal esgotado"));
    let audit = store
        .list_audit_events(Some(&project.id), Some("budget."), 10)
        .unwrap();
    assert_eq!(audit.len(), 1);
    assert!(Path::new(&project.path).exists());
    sidecar.shutdown().await;
}
