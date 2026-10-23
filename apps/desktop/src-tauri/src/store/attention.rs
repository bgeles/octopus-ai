//! O que pede atenção do gestor agora (Fase 7): runs ativos, aprovações pendentes e tasks
//! esperando você. Alimenta o ícone da menu bar e as notificações nativas.

use anyhow::Result;
use rusqlite::params;
use serde::{Deserialize, Serialize};

use super::Store;
use crate::protocol::{RunEvent, TaskStatusUpdate};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveRunInfo {
    pub run_id: String,
    pub project_name: String,
    pub label: String,
    pub started_at: String,
    pub waiting_approval: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attention {
    pub active_runs: Vec<ActiveRunInfo>,
    pub pending_approvals: u64,
    pub waiting_tasks: u64,
    pub scheduler_paused: bool,
}

impl Attention {
    /// Título ao lado do ícone: número de runs ativos e um ponto quando algo espera você.
    pub fn tray_title(&self) -> String {
        let n = self.active_runs.len();
        let waiting = self.pending_approvals + self.waiting_tasks > 0;
        match (n, waiting) {
            (0, false) => String::new(),
            (0, true) => "●".into(),
            (n, false) => n.to_string(),
            (n, true) => format!("{n} ●"),
        }
    }

    pub fn tooltip(&self) -> String {
        let mut parts = vec![match self.active_runs.len() {
            0 => "nenhum run ativo".to_string(),
            1 => "1 run ativo".to_string(),
            n => format!("{n} runs ativos"),
        }];
        if self.pending_approvals > 0 {
            parts.push(plural(
                self.pending_approvals,
                "aprovação pendente",
                "aprovações pendentes",
            ));
        }
        if self.waiting_tasks > 0 {
            parts.push(plural(
                self.waiting_tasks,
                "task aguardando você",
                "tasks aguardando você",
            ));
        }
        format!("Octopus · {}", parts.join(" · "))
    }
}

fn plural(n: u64, one: &str, many: &str) -> String {
    if n == 1 {
        format!("1 {one}")
    } else {
        format!("{n} {many}")
    }
}

/// Preferências de notificação (chaves `notifications.*`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationPrefs {
    pub approvals: bool,
    pub tasks: bool,
    pub runs: bool,
}

impl Default for NotificationPrefs {
    fn default() -> Self {
        Self {
            approvals: true,
            tasks: true,
            runs: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DesktopNotification {
    pub title: String,
    pub body: String,
    /// Tela que a notificação abre ao ser clicada.
    pub view: &'static str,
}

fn first_chars(s: &str, n: usize) -> String {
    let one: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if one.chars().count() <= n {
        one
    } else {
        format!("{}…", one.chars().take(n).collect::<String>())
    }
}

/// Decide se um evento vira notificação do macOS. `agent` é o nome do membro, se houver.
pub fn notification_for(
    event: &RunEvent,
    project: &str,
    agent: Option<&str>,
    prompt: &str,
    prefs: NotificationPrefs,
) -> Option<DesktopNotification> {
    let who = agent.unwrap_or("O agente");
    match event {
        RunEvent::PermissionRequest {
            tool_name, input, ..
        } if prefs.approvals => {
            let detail = input
                .get("command")
                .or_else(|| input.get("file_path"))
                .and_then(|v| v.as_str())
                .map(|s| format!(" {}", first_chars(s, 60)))
                .unwrap_or_default();
            Some(DesktopNotification {
                title: format!("Aprovação pendente · {project}"),
                body: format!("{who} quer usar {tool_name}{detail}. Abra o Octopus para decidir."),
                view: "approvals",
            })
        }
        RunEvent::TaskUpdate {
            status: status @ (TaskStatusUpdate::Review | TaskStatusUpdate::Blocked),
            note,
            ..
        } if prefs.tasks => Some(DesktopNotification {
            title: format!(
                "{} · {project}",
                if *status == TaskStatusUpdate::Review {
                    "Task pede revisão"
                } else {
                    "Task bloqueada"
                }
            ),
            body: note
                .as_deref()
                .map(|n| first_chars(n, 120))
                .unwrap_or_else(|| format!("{who} terminou o estágio e espera você.")),
            view: "board",
        }),
        RunEvent::Result {
            is_error, cost_usd, ..
        } if prefs.runs => Some(DesktopNotification {
            title: format!(
                "{} · {project}",
                if *is_error {
                    "Run falhou"
                } else {
                    "Run concluído"
                }
            ),
            body: format!(
                "{}{}",
                first_chars(prompt, 80),
                cost_usd
                    .map(|c| format!(" · US$ {c:.2}"))
                    .unwrap_or_default()
            ),
            view: "run",
        }),
        RunEvent::Error {
            fatal: true,
            message,
        } if prefs.runs => Some(DesktopNotification {
            title: format!("Run falhou · {project}"),
            body: first_chars(message, 120),
            view: "run",
        }),
        _ => None,
    }
}

impl Store {
    pub fn notification_prefs(&self) -> Result<NotificationPrefs> {
        let d = NotificationPrefs::default();
        let get = |key: &str, default: bool| -> Result<bool> {
            Ok(self
                .get_setting(key)?
                .and_then(|v| v.as_bool())
                .unwrap_or(default))
        };
        Ok(NotificationPrefs {
            approvals: get("notifications.approvals", d.approvals)?,
            tasks: get("notifications.tasks", d.tasks)?,
            runs: get("notifications.runs", d.runs)?,
        })
    }

    pub fn attention(&self) -> Result<Attention> {
        let paused = self
            .get_setting(crate::scheduler::PAUSED_SETTING)?
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let conn = self.conn.lock().expect("store mutex");
        let mut stmt = conn.prepare(
            "SELECT r.id, p.name, r.prompt, r.started_at, r.status, a.name
             FROM run r JOIN project p ON p.id = r.project_id LEFT JOIN agent_profile a ON a.id = r.agent_profile_id
             WHERE r.status IN ('queued', 'running', 'waiting_approval') AND r.kind = 'agent'
             ORDER BY r.started_at",
        )?;
        let active_runs = stmt
            .query_map([], |r| {
                let prompt: String = r.get(2)?;
                let agent: Option<String> = r.get(5)?;
                let label = match agent {
                    Some(a) => format!("{a} · {}", first_chars(&prompt, 40)),
                    None => first_chars(&prompt, 48),
                };
                Ok(ActiveRunInfo {
                    run_id: r.get(0)?,
                    project_name: r.get(1)?,
                    label,
                    started_at: r.get(3)?,
                    waiting_approval: r.get::<_, String>(4)? == "waiting_approval",
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(stmt);
        let pending_approvals: i64 = conn.query_row(
            "SELECT COUNT(*) FROM approval a JOIN run r ON r.id = a.run_id WHERE a.decision IS NULL AND r.status = 'waiting_approval'",
            params![],
            |r| r.get(0),
        )?;
        let waiting_tasks: i64 = conn.query_row(
            "SELECT COUNT(*) FROM task WHERE status = 'waiting_approval'",
            params![],
            |r| r.get(0),
        )?;
        Ok(Attention {
            active_runs,
            pending_approvals: pending_approvals as u64,
            waiting_tasks: waiting_tasks as u64,
            scheduler_paused: paused,
        })
    }

    /// Projeto, nome do membro e pedido do run (para o texto da notificação).
    pub fn run_notification_context(
        &self,
        run_id: &str,
    ) -> Result<Option<(String, Option<String>, String)>> {
        use rusqlite::OptionalExtension;
        let conn = self.conn.lock().expect("store mutex");
        Ok(conn
            .query_row(
                "SELECT p.name, a.name, r.prompt, r.kind FROM run r JOIN project p ON p.id = r.project_id LEFT JOIN agent_profile a ON a.id = r.agent_profile_id WHERE r.id = ?1",
                params![run_id],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?)),
            )
            .optional()?
            .filter(|(_, _, _, kind)| kind == "agent")
            .map(|(p, a, prompt, _)| (p, a, prompt)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::RunOptions;

    #[test]
    fn titles_and_tooltips() {
        let mut a = Attention::default();
        assert_eq!(a.tray_title(), "");
        assert_eq!(a.tooltip(), "Octopus · nenhum run ativo");
        a.pending_approvals = 1;
        assert_eq!(a.tray_title(), "●");
        a.active_runs.push(ActiveRunInfo {
            run_id: "r".into(),
            project_name: "p".into(),
            label: "x".into(),
            started_at: "t".into(),
            waiting_approval: true,
        });
        a.active_runs.push(a.active_runs[0].clone());
        a.waiting_tasks = 2;
        assert_eq!(a.tray_title(), "2 ●");
        assert_eq!(
            a.tooltip(),
            "Octopus · 2 runs ativos · 1 aprovação pendente · 2 tasks aguardando você"
        );
    }

    #[test]
    fn notifications_follow_preferences() {
        let prefs = NotificationPrefs::default();
        let perm = RunEvent::PermissionRequest {
            request_id: "p1".into(),
            tool_name: "Bash".into(),
            input: serde_json::json!({"command": "./mvnw -q test"}),
            reason: None,
        };
        let n = notification_for(&perm, "chat-core", Some("Ana"), "x", prefs).unwrap();
        assert_eq!(n.title, "Aprovação pendente · chat-core");
        assert_eq!(
            n.body,
            "Ana quer usar Bash ./mvnw -q test. Abra o Octopus para decidir."
        );
        assert_eq!(n.view, "approvals");
        assert!(notification_for(
            &perm,
            "p",
            None,
            "x",
            NotificationPrefs {
                approvals: false,
                ..prefs
            }
        )
        .is_none());
        let review = RunEvent::TaskUpdate {
            task_id: "t".into(),
            status: TaskStatusUpdate::Review,
            note: Some("V12 pronta".into()),
            result: None,
        };
        assert_eq!(
            notification_for(&review, "p", None, "x", prefs)
                .unwrap()
                .body,
            "V12 pronta"
        );
        let done = RunEvent::TaskUpdate {
            task_id: "t".into(),
            status: TaskStatusUpdate::Done,
            note: None,
            result: None,
        };
        assert!(notification_for(&done, "p", None, "x", prefs).is_none());
        let result = RunEvent::Result {
            session_id: "s".into(),
            subtype: "success".into(),
            is_error: false,
            cost_usd: Some(0.42),
            duration_ms: None,
            num_turns: None,
            usage: None,
            stop_reason: None,
            result_text: None,
        };
        assert!(
            notification_for(&result, "p", None, "rodar testes", prefs).is_none(),
            "runs desligado por padrão"
        );
        let on = NotificationPrefs {
            runs: true,
            ..prefs
        };
        assert_eq!(
            notification_for(&result, "p", None, "rodar testes", on)
                .unwrap()
                .body,
            "rodar testes · US$ 0.42"
        );
    }

    #[test]
    fn attention_counts_active_runs_approvals_and_waiting_tasks() {
        let store = Store::open_in_memory().unwrap();
        let project = store.create_project("chat-core", "/tmp/p").unwrap();
        let run = store
            .create_run(
                &project.id,
                "rodar os testes de integração",
                &RunOptions::default(),
            )
            .unwrap();
        store
            .record_run_event(
                &run.id,
                0,
                "2026-10-16T10:00:00Z",
                &RunEvent::SessionInit {
                    session_id: "s".into(),
                    model: "m".into(),
                    tools: vec![],
                    mcp_servers: vec![],
                    permission_mode: None,
                    skills: vec![],
                },
            )
            .unwrap();
        store
            .record_run_event(
                &run.id,
                1,
                "t",
                &RunEvent::PermissionRequest {
                    request_id: "p1".into(),
                    tool_name: "Bash".into(),
                    input: serde_json::json!({}),
                    reason: None,
                },
            )
            .unwrap();
        let consolidation = store
            .create_consolidation_run(&project.id, "c", &RunOptions::default())
            .unwrap();
        let _ = consolidation;
        let a = store.attention().unwrap();
        assert_eq!(a.active_runs.len(), 1, "run de consolidação não conta");
        assert!(a.active_runs[0].waiting_approval);
        assert_eq!(a.active_runs[0].project_name, "chat-core");
        assert_eq!(a.pending_approvals, 1);
        assert_eq!(a.waiting_tasks, 0);
        assert!(!a.scheduler_paused);
        assert_eq!(
            store.run_notification_context(&run.id).unwrap().unwrap().0,
            "chat-core"
        );
        store
            .set_setting("notifications.runs", &serde_json::json!(true))
            .unwrap();
        assert!(store.notification_prefs().unwrap().runs);
    }
}
