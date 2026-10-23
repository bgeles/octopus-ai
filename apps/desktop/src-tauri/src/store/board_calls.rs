//! Tools de delegação chamadas pelo agente durante um run (`run.board_call` → `board.result`):
//! `team_list`, `task_list`, `task_create` e `task_assign`. Toda checagem é feita aqui, no core:
//! quem chama precisa ter "pode criar e atribuir tasks" e só alcança quem reporta a ele.

use anyhow::{Context, Result};
use rusqlite::{params, OptionalExtension};
use serde_json::Value;

use super::orchestration::{Task, TaskInput, TaskStatus};
use super::team::{descendants, TeamMember};
use super::Store;
use crate::protocol::{BoardCallResult, BoardOp};

/// Limite de tasks abertas por membro (Configurações → Board).
pub const MAX_OPEN_TASKS_SETTING: &str = "board.maxOpenTasksPerAgent";
const DEFAULT_MAX_OPEN_TASKS: u32 = 10;
/// Tasks que um único run pode criar (freio contra loops de delegação).
pub const MAX_CREATED_PER_RUN: usize = 20;

fn open(t: &Task) -> bool {
    !matches!(t.status, TaskStatus::Done)
}

impl Store {
    pub fn max_open_tasks_per_agent(&self) -> u32 {
        self.get_setting(MAX_OPEN_TASKS_SETTING)
            .ok()
            .flatten()
            .and_then(|v| v.as_u64())
            .map(|n| n as u32)
            .unwrap_or(DEFAULT_MAX_OPEN_TASKS)
    }

    pub fn handle_board_call(
        &self,
        run_id: &str,
        op: BoardOp,
        args: &Value,
    ) -> Result<BoardCallResult> {
        let (project_id, agent_id): (String, Option<String>) = {
            let conn = self.conn.lock().expect("store mutex");
            conn.query_row(
                "SELECT project_id, agent_profile_id FROM run WHERE id = ?1",
                params![run_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?
            .with_context(|| format!("run {run_id} não encontrado"))?
        };
        let Some(agent_id) = agent_id else {
            return Ok(refuse(
                "Este run não é de um membro do time; só membros com \"pode criar e atribuir tasks\" delegam.",
            ));
        };
        let team = self.list_team(&project_id)?;
        let Some(me) = team.iter().find(|m| m.profile.id == agent_id) else {
            return Ok(refuse("Membro do run não está mais no time."));
        };
        if !me.trust.can_assign_tasks {
            return Ok(refuse(&format!(
                "{} não tem permissão para criar ou atribuir tasks (confiança do membro).",
                me.profile.name
            )));
        }
        let reports = descendants(&team, &agent_id);
        let tasks = self.list_tasks(&project_id)?;
        let str_arg = |k: &str| {
            args.get(k)
                .and_then(|v| v.as_str())
                .map(str::trim)
                .unwrap_or("")
                .to_string()
        };
        match op {
            BoardOp::TeamList => Ok(BoardCallResult {
                ok: true,
                content: team_list_markdown(&team, me, &reports, &tasks),
            }),
            BoardOp::TaskList => {
                let filter = str_arg("status");
                let mine: Vec<&Task> = tasks
                    .iter()
                    .filter(|t| match filter.as_str() {
                        "done" => t.status == TaskStatus::Done,
                        "mine" => t.created_by_agent_id.as_deref() == Some(agent_id.as_str()),
                        "all" => true,
                        _ => open(t),
                    })
                    .collect();
                Ok(BoardCallResult {
                    ok: true,
                    content: task_list_markdown(&mine, &team, &filter),
                })
            }
            BoardOp::TaskCreate => {
                let title = str_arg("title");
                if title.len() < 3 {
                    return Ok(refuse("Informe um título (ao menos 3 caracteres)."));
                }
                let Some(assignee) = resolve_member(&reports, &str_arg("assignee")) else {
                    return Ok(refuse(&format!(
                        "Responsável inválido: você só pode atribuir para quem reporta a você ({}).",
                        names(&reports)
                    )));
                };
                let created_by_run: usize = {
                    let conn = self.conn.lock().expect("store mutex");
                    conn.query_row(
                        "SELECT COUNT(*) FROM task_event WHERE run_id = ?1 AND kind = 'created_by_agent'",
                        params![run_id],
                        |r| r.get::<_, i64>(0),
                    )? as usize
                };
                if created_by_run >= MAX_CREATED_PER_RUN {
                    return Ok(refuse(&format!(
                        "Limite de {MAX_CREATED_PER_RUN} tasks criadas neste run; termine e peça outro run para continuar."
                    )));
                }
                let open_for = tasks
                    .iter()
                    .filter(|t| {
                        open(t)
                            && t.assigned_agent_id.as_deref() == Some(assignee.profile.id.as_str())
                    })
                    .count() as u32;
                let max_open = self.max_open_tasks_per_agent();
                if open_for >= max_open {
                    return Ok(refuse(&format!(
                        "{} já tem {open_for} tasks abertas (limite {max_open}); espere concluir ou escolha outra pessoa.",
                        assignee.profile.name
                    )));
                }
                let workflows = self.list_workflows(&project_id)?;
                let workflow = match args.get("workflow").and_then(|v| v.as_str()) {
                    Some(id) => workflows.iter().find(|w| w.id == id || w.name == id),
                    None => {
                        if workflows.len() == 1 {
                            workflows.first()
                        } else {
                            None
                        }
                    }
                };
                let Some(workflow) = workflow else {
                    return Ok(refuse(if workflows.is_empty() {
                        "O projeto ainda não tem workflow no board; peça ao gestor para criar um."
                    } else {
                        "O projeto tem mais de um workflow: informe `workflow` (id ou nome)."
                    }));
                };
                let stage_id = match args.get("stage").and_then(|v| v.as_str()) {
                    Some(name) => match workflow
                        .stages
                        .iter()
                        .find(|s| s.id == name || s.name.eq_ignore_ascii_case(name))
                    {
                        Some(s) => Some(s.id.clone()),
                        None => {
                            return Ok(refuse(&format!(
                                "Estágio \"{name}\" não existe; use um de: {}.",
                                workflow
                                    .stages
                                    .iter()
                                    .map(|s| s.name.as_str())
                                    .collect::<Vec<_>>()
                                    .join(", ")
                            )))
                        }
                    },
                    None => None,
                };
                let mut depends_on = Vec::new();
                if let Some(deps) = args.get("dependsOn").and_then(|v| v.as_array()) {
                    for dep in deps.iter().filter_map(|d| d.as_str()) {
                        if !tasks.iter().any(|t| t.id == dep) {
                            return Ok(refuse(&format!(
                                "Dependência {dep} não existe neste projeto."
                            )));
                        }
                        depends_on.push(dep.to_string());
                    }
                }
                let input = TaskInput {
                    title,
                    description_md: str_arg("description"),
                    acceptance_md: str_arg("acceptance"),
                    stage_id,
                    assigned_agent_id: Some(assignee.profile.id.clone()),
                    depends_on,
                    ready: args.get("ready").and_then(|v| v.as_bool()).unwrap_or(true),
                };
                let actor = format!("agente {}", me.profile.name);
                let task = self.create_task_as(
                    &project_id,
                    &workflow.id,
                    &input,
                    &actor,
                    Some(&agent_id),
                    Some(run_id),
                )?;
                let stage_name = workflow
                    .stages
                    .iter()
                    .find(|s| s.id == task.stage_id)
                    .map(|s| s.name.clone())
                    .unwrap_or_default();
                self.audit(
                    &actor,
                    "board.task.created_by_agent",
                    Some(&project_id),
                    serde_json::json!({"taskId": task.id, "title": task.title, "assignee": assignee.profile.name, "runId": run_id}),
                )?;
                Ok(BoardCallResult {
                    ok: true,
                    content: format!(
                        "Task {} criada no estágio {stage_name}, atribuída a {}{}{}.",
                        task.id,
                        assignee.profile.name,
                        if task.status == TaskStatus::Ready {
                            ", pronta para o scheduler"
                        } else {
                            ", no backlog"
                        },
                        if task.depends_on.is_empty() {
                            String::new()
                        } else {
                            format!(" (depende de {})", task.depends_on.join(", "))
                        }
                    ),
                })
            }
            BoardOp::TaskAssign => {
                let task_id = str_arg("taskId");
                let Some(task) = tasks.iter().find(|t| t.id == task_id) else {
                    return Ok(refuse(&format!("Task {task_id} não existe neste projeto.")));
                };
                if task.status == TaskStatus::Running || task.lock_run_id.is_some() {
                    return Ok(refuse(
                        "A task está em run; espere terminar antes de reatribuir.",
                    ));
                }
                let Some(assignee) = resolve_member(&reports, &str_arg("assignee")) else {
                    return Ok(refuse(&format!(
                        "Responsável inválido: você só pode atribuir para quem reporta a você ({}).",
                        names(&reports)
                    )));
                };
                let actor = format!("agente {}", me.profile.name);
                {
                    let mut conn = self.conn.lock().expect("store mutex");
                    let tx = conn.transaction()?;
                    tx.execute(
                        "UPDATE task SET assigned_agent_id = ?2, updated_at = ?3 WHERE id = ?1",
                        params![task.id, assignee.profile.id, super::now()],
                    )?;
                    super::orchestration::insert_task_event(
                        &tx,
                        &task.id,
                        "assigned",
                        Some(&task.stage_id),
                        Some(&task.stage_id),
                        Some(run_id),
                        &actor,
                        Some(&format!("atribuída a {}", assignee.profile.name)),
                    )?;
                    tx.commit()?;
                }
                Ok(BoardCallResult {
                    ok: true,
                    content: format!("Task {} agora é de {}.", task.id, assignee.profile.name),
                })
            }
        }
    }
}

fn refuse(message: &str) -> BoardCallResult {
    BoardCallResult {
        ok: false,
        content: message.to_string(),
    }
}

fn names(members: &[&TeamMember]) -> String {
    if members.is_empty() {
        "ninguém reporta a você".into()
    } else {
        members
            .iter()
            .map(|m| m.profile.name.clone())
            .collect::<Vec<_>>()
            .join(", ")
    }
}

/// Aceita id ou nome (sem distinguir maiúsculas) entre os subordinados.
fn resolve_member<'a>(reports: &[&'a TeamMember], key: &str) -> Option<&'a TeamMember> {
    let key = key.trim();
    if key.is_empty() {
        return None;
    }
    reports
        .iter()
        .copied()
        .find(|m| m.profile.id == key || m.profile.name.eq_ignore_ascii_case(key))
}

fn team_list_markdown(
    team: &[TeamMember],
    me: &TeamMember,
    reports: &[&TeamMember],
    tasks: &[Task],
) -> String {
    let open_for = |id: &str| {
        tasks
            .iter()
            .filter(|t| open(t) && t.assigned_agent_id.as_deref() == Some(id))
            .count()
    };
    let boss_name = |m: &TeamMember| {
        m.reports_to_agent_id
            .as_deref()
            .and_then(|b| team.iter().find(|x| x.profile.id == b))
            .map(|b| b.profile.name.clone())
            .unwrap_or_else(|| "você (gestor humano)".to_string())
    };
    let mut out = format!(
        "Time do projeto ({} membros). Você é {} ({}).\n",
        team.len(),
        me.profile.name,
        me.role.title
    );
    for m in team {
        let flags = [
            m.trust.can_approve.then_some("aprova quem reporta a ele"),
            m.trust.can_assign_tasks.then_some("delega"),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(", ");
        out.push_str(&format!(
            "- {} ({}) · {} · {} · {} task(s) aberta(s) · reporta a {}{}\n",
            m.profile.name,
            m.profile.id,
            m.role.title,
            m.role.specialty,
            open_for(&m.profile.id),
            if m.profile.id == me.profile.id {
                "seu gestor".to_string()
            } else {
                boss_name(m)
            },
            if flags.is_empty() {
                String::new()
            } else {
                format!(" · {flags}")
            }
        ));
    }
    out.push_str(&format!(
        "Você pode criar e atribuir tasks para: {}.",
        names(reports)
    ));
    out
}

fn task_list_markdown(tasks: &[&Task], team: &[TeamMember], filter: &str) -> String {
    let name_of = |id: Option<&str>| {
        id.and_then(|i| team.iter().find(|m| m.profile.id == i))
            .map(|m| m.profile.name.clone())
    };
    if tasks.is_empty() {
        return format!(
            "Nenhuma task{}.",
            match filter {
                "done" => " concluída",
                "mine" => " criada por você",
                "all" => "",
                _ => " aberta",
            }
        );
    }
    let mut out = format!("{} task(s):\n", tasks.len());
    for t in tasks {
        out.push_str(&format!(
            "- {} · \"{}\" · estágio {} · {} · responsável: {}{}{}\n",
            t.id,
            t.title,
            t.stage_id,
            t.status.as_str(),
            name_of(t.assigned_agent_id.as_deref()).unwrap_or_else(|| "ninguém".into()),
            match name_of(t.created_by_agent_id.as_deref()) {
                Some(n) => format!(" · criada por {n}"),
                None => String::new(),
            },
            if t.depends_on.is_empty() {
                String::new()
            } else {
                format!(" · depende de {}", t.depends_on.join(", "))
            }
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::RunOptions;
    use crate::store::team::{Autonomy, TeamMemberInput};

    fn setup() -> (Store, String, String, String, String) {
        let s = Store::open_in_memory().unwrap();
        let project = s.create_project("p", "/tmp/p").unwrap().id;
        let add = |name: &str, role: &str, boss: Option<&str>, assign: Option<bool>| {
            s.add_team_member(
                &project,
                &TeamMemberInput {
                    name: name.into(),
                    role_id: role.into(),
                    reports_to_agent_id: boss.map(str::to_string),
                    autonomy: Some(Autonomy::Managed),
                    can_assign_tasks: assign,
                    ..Default::default()
                },
            )
            .unwrap()
            .profile
            .id
        };
        let gabi = add("Gabi", "role_gestor_produto", None, None);
        let dani = add("Dani", "role_pesquisador", Some(&gabi), None);
        let teo = add("Téo", "role_testador", Some(&dani), None);
        let leo = add("Leo", "role_documentador", None, Some(false));
        s.create_workflow_from_template(&project, "research-synthesis", false)
            .unwrap();
        (s, project, gabi, dani, teo.clone() + "|" + &leo)
    }

    fn run_as(s: &Store, project: &str, agent: Option<&str>) -> String {
        s.create_run_full(project, "delegue", &RunOptions::default(), agent, None)
            .unwrap()
            .id
    }

    #[test]
    fn delegation_requires_trust_and_only_reaches_descendants() {
        let (s, project, gabi, dani, rest) = setup();
        let (teo, leo) = rest.split_once('|').unwrap();
        let run = run_as(&s, &project, Some(&gabi));

        // team_list lista todo mundo, com carga e para quem a Gabi pode delegar (Dani e Téo, não Leo).
        let list = s
            .handle_board_call(&run, BoardOp::TeamList, &serde_json::json!({}))
            .unwrap();
        assert!(list.ok);
        assert!(list.content.contains("Dani ("));
        assert!(list
            .content
            .contains("Você pode criar e atribuir tasks para: Dani, Téo."));

        // Cria para a Dani (por nome) e para o Téo (por id, neto no organograma).
        let created = s
            .handle_board_call(
                &run,
                BoardOp::TaskCreate,
                &serde_json::json!({"title": "Inventário", "description": "Liste as integrações.", "acceptance": "Tabela com fontes.", "assignee": "dani"}),
            )
            .unwrap();
        assert!(created.ok, "{}", created.content);
        assert!(created.content.contains("atribuída a Dani"));
        let tasks = s.list_tasks(&project).unwrap();
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].assigned_agent_id.as_deref(), Some(dani.as_str()));
        assert_eq!(tasks[0].created_by_agent_id.as_deref(), Some(gabi.as_str()));
        assert_eq!(tasks[0].status, TaskStatus::Ready);
        let events = s.list_task_events(&tasks[0].id).unwrap();
        assert_eq!(events[0].kind, "created_by_agent");
        assert_eq!(events[0].actor, "agente Gabi");
        let second = s
            .handle_board_call(
                &run,
                BoardOp::TaskCreate,
                &serde_json::json!({"title": "Testes do inventário", "assignee": teo, "dependsOn": [tasks[0].id], "ready": false}),
            )
            .unwrap();
        assert!(second.ok, "{}", second.content);
        let t2 = s
            .list_tasks(&project)
            .unwrap()
            .into_iter()
            .find(|t| t.title == "Testes do inventário")
            .unwrap();
        assert_eq!(t2.status, TaskStatus::Backlog);
        assert_eq!(t2.depends_on, vec![tasks[0].id.clone()]);

        // Recusas: fora do time dela, dependência inexistente, estágio inválido.
        let outside = s
            .handle_board_call(
                &run,
                BoardOp::TaskCreate,
                &serde_json::json!({"title": "Docs", "assignee": "Leo"}),
            )
            .unwrap();
        assert!(!outside.ok);
        assert!(outside
            .content
            .contains("só pode atribuir para quem reporta a você"));
        assert!(
            !s.handle_board_call(
                &run,
                BoardOp::TaskCreate,
                &serde_json::json!({"title": "X", "assignee": "Dani", "dependsOn": ["task_nope"]})
            )
            .unwrap()
            .ok
        );
        assert!(
            !s.handle_board_call(
                &run,
                BoardOp::TaskCreate,
                &serde_json::json!({"title": "X", "assignee": "Dani", "stage": "Inexistente"})
            )
            .unwrap()
            .ok
        );
        assert_eq!(s.list_tasks(&project).unwrap().len(), 2);

        // task_list: abertas (padrão), criadas por mim, concluídas.
        let open = s
            .handle_board_call(&run, BoardOp::TaskList, &serde_json::json!({}))
            .unwrap();
        assert!(open.content.starts_with("2 task(s)"));
        assert!(open.content.contains("criada por Gabi"));
        let done = s
            .handle_board_call(
                &run,
                BoardOp::TaskList,
                &serde_json::json!({"status": "done"}),
            )
            .unwrap();
        assert!(done.content.contains("Nenhuma task concluída"));

        // task_assign: reatribui dentro do time; recusa fora e em run.
        let assign = s
            .handle_board_call(
                &run,
                BoardOp::TaskAssign,
                &serde_json::json!({"taskId": t2.id, "assignee": "Dani"}),
            )
            .unwrap();
        assert!(assign.ok, "{}", assign.content);
        assert_eq!(
            s.get_task(&t2.id)
                .unwrap()
                .unwrap()
                .assigned_agent_id
                .as_deref(),
            Some(dani.as_str())
        );
        assert!(s
            .list_task_events(&t2.id)
            .unwrap()
            .iter()
            .any(|e| e.kind == "assigned" && e.actor == "agente Gabi"));
        assert!(
            !s.handle_board_call(
                &run,
                BoardOp::TaskAssign,
                &serde_json::json!({"taskId": t2.id, "assignee": leo})
            )
            .unwrap()
            .ok
        );
        let work = s
            .create_run_full(
                &project,
                "x",
                &RunOptions::default(),
                Some(&dani),
                Some(&tasks[0].id),
            )
            .unwrap();
        assert!(s.claim_task(&tasks[0].id, &work.id, None, None).unwrap());
        let busy = s
            .handle_board_call(
                &run,
                BoardOp::TaskAssign,
                &serde_json::json!({"taskId": tasks[0].id, "assignee": teo}),
            )
            .unwrap();
        assert!(!busy.ok);
        assert!(busy.content.contains("em run"));

        // Sem confiança (Leo) ou sem membro (run avulso): recusado.
        let leo_run = run_as(&s, &project, Some(leo));
        let denied = s
            .handle_board_call(
                &leo_run,
                BoardOp::TaskCreate,
                &serde_json::json!({"title": "Y", "assignee": "Dani"}),
            )
            .unwrap();
        assert!(!denied.ok);
        assert!(denied.content.contains("não tem permissão"));
        let anon = run_as(&s, &project, None);
        assert!(
            !s.handle_board_call(&anon, BoardOp::TeamList, &serde_json::json!({}))
                .unwrap()
                .ok
        );

        // Auditoria registra a criação por agente.
        let audit = s
            .list_audit_events(Some(&project), Some("board.task.created_by_agent"), 10)
            .unwrap();
        assert_eq!(audit.len(), 2);
        assert_eq!(audit[0].actor, "agente Gabi");
    }

    #[test]
    fn limits_per_member_and_per_run_are_enforced() {
        let (s, project, gabi, _dani, _rest) = setup();
        let run = run_as(&s, &project, Some(&gabi));
        s.set_setting(MAX_OPEN_TASKS_SETTING, &serde_json::json!(2))
            .unwrap();
        for i in 0..2 {
            let r = s
                .handle_board_call(
                    &run,
                    BoardOp::TaskCreate,
                    &serde_json::json!({"title": format!("Task {i}"), "assignee": "Dani"}),
                )
                .unwrap();
            assert!(r.ok, "{}", r.content);
        }
        let third = s
            .handle_board_call(
                &run,
                BoardOp::TaskCreate,
                &serde_json::json!({"title": "Task 3", "assignee": "Dani"}),
            )
            .unwrap();
        assert!(!third.ok);
        assert!(third.content.contains("já tem 2 tasks abertas (limite 2)"));
        // Para o Téo ainda dá; o limite por run é de criações, independente do membro.
        s.set_setting(MAX_OPEN_TASKS_SETTING, &serde_json::json!(100))
            .unwrap();
        for i in 0..(MAX_CREATED_PER_RUN - 2) {
            let r = s
                .handle_board_call(
                    &run,
                    BoardOp::TaskCreate,
                    &serde_json::json!({"title": format!("Mais {i}"), "assignee": "Téo"}),
                )
                .unwrap();
            assert!(r.ok, "{}", r.content);
        }
        let over = s
            .handle_board_call(
                &run,
                BoardOp::TaskCreate,
                &serde_json::json!({"title": "Uma a mais", "assignee": "Téo"}),
            )
            .unwrap();
        assert!(!over.ok);
        assert!(over
            .content
            .contains("Limite de 20 tasks criadas neste run"));
    }

    #[test]
    fn run_options_enable_board_tools_only_for_members_who_can_assign() {
        let (s, _project, gabi, dani, _rest) = setup();
        let gabi_opts = s.agent_run_options(&gabi, &RunOptions::default()).unwrap();
        assert_eq!(gabi_opts.board_tools, Some(true));
        let prompt = gabi_opts.system_prompt_append.unwrap();
        assert!(prompt.contains("Delegação: você pode criar e atribuir tasks"));
        assert!(prompt.contains("Dani (Pesquisador)") && prompt.contains("Téo (Testador)"));
        let dani_opts = s.agent_run_options(&dani, &RunOptions::default()).unwrap();
        assert_eq!(dani_opts.board_tools, None);
        assert!(!dani_opts
            .system_prompt_append
            .unwrap()
            .contains("Delegação:"));
    }
}
