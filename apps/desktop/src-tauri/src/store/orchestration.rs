//! Orquestração: workflows (estágios com responsável e gate humano), tasks com dependências,
//! histórico de movimentos e as transições que o scheduler e o agente (`task_update`) disparam.

use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{Context, Result};
use rusqlite::{params, OptionalExtension, Row, Transaction};
use serde::{Deserialize, Serialize};

use super::{new_id, now, Store};
use crate::protocol::{TaskContext, TaskStatusUpdate};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stage {
    pub id: String,
    pub name: String,
    /// Membro responsável (agent_profile). `None` = run avulso, ou gate humano.
    #[serde(default)]
    pub agent_profile_id: Option<String>,
    /// Gate humano: a task para em `waiting_approval` até você aprovar.
    #[serde(default)]
    pub gate: bool,
    /// Instrução extra do estágio para o prompt.
    #[serde(default)]
    pub instruction: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workflow {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub stages: Vec<Stage>,
    pub use_worktrees: bool,
    pub max_parallel: u32,
    pub created_at: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowInput {
    pub name: String,
    pub stages: Vec<Stage>,
    #[serde(default)]
    pub use_worktrees: bool,
    #[serde(default = "default_parallel")]
    pub max_parallel: u32,
}

fn default_parallel() -> u32 {
    1
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Backlog,
    Ready,
    Running,
    WaitingApproval,
    Review,
    Done,
    Blocked,
    Failed,
}

impl TaskStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            TaskStatus::Backlog => "backlog",
            TaskStatus::Ready => "ready",
            TaskStatus::Running => "running",
            TaskStatus::WaitingApproval => "waiting_approval",
            TaskStatus::Review => "review",
            TaskStatus::Done => "done",
            TaskStatus::Blocked => "blocked",
            TaskStatus::Failed => "failed",
        }
    }
    fn parse(value: &str) -> Self {
        match value {
            "ready" => TaskStatus::Ready,
            "running" => TaskStatus::Running,
            "waiting_approval" => TaskStatus::WaitingApproval,
            "review" => TaskStatus::Review,
            "done" => TaskStatus::Done,
            "blocked" => TaskStatus::Blocked,
            "failed" => TaskStatus::Failed,
            _ => TaskStatus::Backlog,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub project_id: String,
    pub workflow_id: String,
    pub stage_id: String,
    pub title: String,
    pub description_md: String,
    pub acceptance_md: String,
    pub status: TaskStatus,
    pub assigned_agent_id: Option<String>,
    pub depends_on: Vec<String>,
    pub worktree_path: Option<String>,
    pub lock_run_id: Option<String>,
    pub last_note: Option<String>,
    pub position: i64,
    pub created_at: String,
    pub updated_at: String,
    /// Entrega: resumo em markdown deixado pelo agente (ou o texto final do run).
    #[serde(default)]
    pub result_md: Option<String>,
    /// Arquivos que o run de entrega escreveu/editou (das observações da memória).
    #[serde(default)]
    pub files_changed: Vec<String>,
    #[serde(default)]
    pub result_run_id: Option<String>,
    /// Commit base no claim, para o diff da entrega.
    #[serde(default)]
    pub base_commit: Option<String>,
}

impl Task {
    const SELECT: &'static str = "SELECT id, project_id, workflow_id, stage_id, title, description_md, acceptance_md, status, assigned_agent_id, depends_on_json, worktree_path, lock_run_id, last_note, position, created_at, updated_at, result_md, files_changed_json, result_run_id, base_commit FROM task";

    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        let deps: String = row.get(9)?;
        Ok(Task {
            id: row.get(0)?,
            project_id: row.get(1)?,
            workflow_id: row.get(2)?,
            stage_id: row.get(3)?,
            title: row.get(4)?,
            description_md: row.get(5)?,
            acceptance_md: row.get(6)?,
            status: TaskStatus::parse(&row.get::<_, String>(7)?),
            assigned_agent_id: row.get(8)?,
            depends_on: serde_json::from_str(&deps).unwrap_or_default(),
            worktree_path: row.get(10)?,
            lock_run_id: row.get(11)?,
            last_note: row.get(12)?,
            position: row.get(13)?,
            created_at: row.get(14)?,
            updated_at: row.get(15)?,
            result_md: row.get(16)?,
            files_changed: row
                .get::<_, Option<String>>(17)?
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default(),
            result_run_id: row.get(18)?,
            base_commit: row.get(19)?,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskInput {
    pub title: String,
    #[serde(default)]
    pub description_md: String,
    #[serde(default)]
    pub acceptance_md: String,
    /// Estágio inicial; padrão: o primeiro do workflow.
    #[serde(default)]
    pub stage_id: Option<String>,
    #[serde(default)]
    pub assigned_agent_id: Option<String>,
    #[serde(default)]
    pub depends_on: Vec<String>,
    /// `true` entra em `ready` (o scheduler pega); `false` fica em `backlog`.
    #[serde(default = "default_true")]
    pub ready: bool,
}

fn default_true() -> bool {
    true
}

impl Default for TaskInput {
    fn default() -> Self {
        TaskInput {
            title: String::new(),
            description_md: String::new(),
            acceptance_md: String::new(),
            stage_id: None,
            assigned_agent_id: None,
            depends_on: Vec::new(),
            ready: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskEvent {
    pub id: String,
    pub task_id: String,
    pub at: String,
    pub kind: String,
    pub from_stage: Option<String>,
    pub to_stage: Option<String>,
    pub run_id: Option<String>,
    pub actor: String,
    pub note: Option<String>,
}

/// Modelos de workflow prontos. Os responsáveis são preenchidos pelo título do cargo dos membros do time.
/// (nome do estágio, título do cargo responsável, gate humano, instrução).
pub type TemplateStageDef = (&'static str, Option<&'static str>, bool, &'static str);
/// (id, nome, estágios).
pub type TemplateDef = (&'static str, &'static str, Vec<TemplateStageDef>);

pub fn workflow_templates() -> Vec<TemplateDef> {
    vec![
        (
            "plan-implement-review-approve",
            "Planejar → Implementar → Revisar → Aprovar",
            vec![
                ("Planejar", Some("Planejador"), false, "Produza um plano curto com critérios de aceite e os passos de implementação. Não altere código."),
                ("Implementar", Some("Implementador"), false, "Implemente seguindo o plano e os critérios de aceite, com testes."),
                ("Revisar", Some("Revisor"), false, "Revise o diff produzido; aponte problemas com arquivo e linha. Marque review se precisar de ajustes, done se estiver pronto."),
                ("Aprovar", None, true, "Aprovação humana."),
            ],
        ),
        (
            "research-synthesis",
            "Pesquisa paralela → Síntese",
            vec![
                ("Pesquisar", Some("Pesquisador"), false, "Investigue a pergunta e entregue achados com fontes."),
                ("Sintetizar", Some("Documentador"), false, "Sintetize os achados em um documento curto, claro, em português."),
            ],
        ),
    ]
}

impl Store {
    // ------------------------------------------------------------------ workflows

    pub fn list_workflows(&self, project_id: &str) -> Result<Vec<Workflow>> {
        let conn = self.conn.lock().expect("store mutex");
        let mut stmt = conn.prepare("SELECT id, project_id, name, stages_json, use_worktrees, max_parallel, created_at FROM workflow WHERE project_id = ?1 ORDER BY created_at")?;
        let rows = stmt
            .query_map(params![project_id], workflow_from_row)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn get_workflow(&self, id: &str) -> Result<Option<Workflow>> {
        let conn = self.conn.lock().expect("store mutex");
        Ok(conn
            .query_row(
                "SELECT id, project_id, name, stages_json, use_worktrees, max_parallel, created_at FROM workflow WHERE id = ?1",
                params![id],
                workflow_from_row,
            )
            .optional()?)
    }

    pub fn create_workflow(&self, project_id: &str, input: &WorkflowInput) -> Result<Workflow> {
        if input.name.trim().is_empty() {
            anyhow::bail!("Informe o nome do workflow");
        }
        if input.stages.is_empty() {
            anyhow::bail!("Um workflow precisa de pelo menos um estágio");
        }
        let id = new_id("wf");
        let conn = self.conn.lock().expect("store mutex");
        conn.execute(
            "INSERT INTO workflow (id, project_id, name, stages_json, use_worktrees, max_parallel, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![id, project_id, input.name.trim(), serde_json::to_string(&input.stages)?, input.use_worktrees as i64, input.max_parallel.max(1) as i64, now()],
        )?;
        drop(conn);
        self.get_workflow(&id)?.context("workflow sumiu após criar")
    }

    /// Cria um workflow a partir de um modelo, atribuindo cada estágio ao primeiro membro do time com o cargo indicado.
    pub fn create_workflow_from_template(
        &self,
        project_id: &str,
        template_id: &str,
        use_worktrees: bool,
    ) -> Result<Workflow> {
        let (_, name, stages) = workflow_templates()
            .into_iter()
            .find(|(id, _, _)| *id == template_id)
            .with_context(|| format!("Modelo {template_id} não existe"))?;
        let team = self.list_team(project_id)?;
        let stages: Vec<Stage> = stages
            .iter()
            .enumerate()
            .map(|(i, (stage_name, role_title, gate, instruction))| Stage {
                id: format!("stage_{}", i + 1),
                name: (*stage_name).to_string(),
                agent_profile_id: role_title.and_then(|title| {
                    team.iter()
                        .find(|m| m.role.title.eq_ignore_ascii_case(title))
                        .map(|m| m.profile.id.clone())
                }),
                gate: *gate,
                instruction: Some((*instruction).to_string()),
            })
            .collect();
        self.create_workflow(
            project_id,
            &WorkflowInput {
                name: name.to_string(),
                stages,
                use_worktrees,
                max_parallel: 1,
            },
        )
    }

    pub fn update_workflow(&self, id: &str, input: &WorkflowInput) -> Result<Workflow> {
        if input.name.trim().is_empty() {
            anyhow::bail!("Informe o nome do workflow");
        }
        if input.stages.is_empty() {
            anyhow::bail!("Um workflow precisa de pelo menos um estágio");
        }
        {
            let conn = self.conn.lock().expect("store mutex");
            let changed = conn.execute(
                "UPDATE workflow SET name = ?2, stages_json = ?3, use_worktrees = ?4, max_parallel = ?5 WHERE id = ?1",
                params![id, input.name.trim(), serde_json::to_string(&input.stages)?, input.use_worktrees as i64, input.max_parallel.max(1) as i64],
            )?;
            if changed == 0 {
                anyhow::bail!("Workflow {id} não encontrado");
            }
        }
        self.get_workflow(id)?
            .context("workflow sumiu após atualizar")
    }

    pub fn delete_workflow(&self, id: &str) -> Result<bool> {
        let conn = self.conn.lock().expect("store mutex");
        Ok(conn.execute("DELETE FROM workflow WHERE id = ?1", params![id])? > 0)
    }

    // ------------------------------------------------------------------ tasks

    pub fn list_tasks(&self, project_id: &str) -> Result<Vec<Task>> {
        let conn = self.conn.lock().expect("store mutex");
        let mut stmt = conn.prepare(&format!(
            "{} WHERE project_id = ?1 ORDER BY position, created_at",
            Task::SELECT
        ))?;
        let rows = stmt
            .query_map(params![project_id], Task::from_row)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn get_task(&self, id: &str) -> Result<Option<Task>> {
        let conn = self.conn.lock().expect("store mutex");
        Ok(conn
            .query_row(
                &format!("{} WHERE id = ?1", Task::SELECT),
                params![id],
                Task::from_row,
            )
            .optional()?)
    }

    pub fn create_task(
        &self,
        project_id: &str,
        workflow_id: &str,
        input: &TaskInput,
    ) -> Result<Task> {
        if input.title.trim().is_empty() {
            anyhow::bail!("Informe o título da task");
        }
        let workflow = self
            .get_workflow(workflow_id)?
            .with_context(|| format!("Workflow {workflow_id} não encontrado"))?;
        let stage_id = match &input.stage_id {
            Some(id) => {
                if !workflow.stages.iter().any(|s| &s.id == id) {
                    anyhow::bail!("Estágio {id} não existe neste workflow");
                }
                id.clone()
            }
            None => workflow.stages[0].id.clone(),
        };
        for dep in &input.depends_on {
            if self.get_task(dep)?.is_none() {
                anyhow::bail!("Dependência {dep} não encontrada");
            }
        }
        let id = new_id("task");
        let ts = now();
        {
            let mut conn = self.conn.lock().expect("store mutex");
            let tx = conn.transaction()?;
            let position: i64 = tx.query_row(
                "SELECT COALESCE(MAX(position), 0) + 1 FROM task WHERE project_id = ?1",
                params![project_id],
                |r| r.get(0),
            )?;
            tx.execute(
                "INSERT INTO task (id, project_id, workflow_id, stage_id, title, description_md, acceptance_md, status, assigned_agent_id, depends_on_json, position, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)",
                params![
                    id,
                    project_id,
                    workflow_id,
                    stage_id,
                    input.title.trim(),
                    input.description_md.trim(),
                    input.acceptance_md.trim(),
                    if input.ready { "ready" } else { "backlog" },
                    input.assigned_agent_id,
                    serde_json::to_string(&input.depends_on)?,
                    position,
                    ts
                ],
            )?;
            insert_event(
                &tx,
                &id,
                "created",
                None,
                Some(&stage_id),
                None,
                "você",
                None,
            )?;
            tx.commit()?;
        }
        self.get_task(&id)?.context("task sumiu após criar")
    }

    pub fn update_task(&self, id: &str, input: &TaskInput) -> Result<Task> {
        if input.title.trim().is_empty() {
            anyhow::bail!("Informe o título da task");
        }
        let current = self
            .get_task(id)?
            .with_context(|| format!("Task {id} não encontrada"))?;
        for dep in &input.depends_on {
            if dep == id {
                anyhow::bail!("Uma task não pode depender de si mesma");
            }
            if self.get_task(dep)?.is_none() {
                anyhow::bail!("Dependência {dep} não encontrada");
            }
        }
        let stage_id = input.stage_id.clone().unwrap_or(current.stage_id.clone());
        {
            let conn = self.conn.lock().expect("store mutex");
            conn.execute(
                "UPDATE task SET title = ?2, description_md = ?3, acceptance_md = ?4, stage_id = ?5, assigned_agent_id = ?6, depends_on_json = ?7, updated_at = ?8 WHERE id = ?1",
                params![id, input.title.trim(), input.description_md.trim(), input.acceptance_md.trim(), stage_id, input.assigned_agent_id, serde_json::to_string(&input.depends_on)?, now()],
            )?;
        }
        self.get_task(id)?.context("task sumiu após atualizar")
    }

    pub fn delete_task(&self, id: &str) -> Result<bool> {
        let conn = self.conn.lock().expect("store mutex");
        Ok(conn.execute("DELETE FROM task WHERE id = ?1", params![id])? > 0)
    }

    pub fn list_task_events(&self, task_id: &str) -> Result<Vec<TaskEvent>> {
        let conn = self.conn.lock().expect("store mutex");
        let mut stmt = conn.prepare("SELECT id, task_id, at, kind, from_stage, to_stage, run_id, actor, note FROM task_event WHERE task_id = ?1 ORDER BY at, rowid")?;
        let rows = stmt
            .query_map(params![task_id], |r| {
                Ok(TaskEvent {
                    id: r.get(0)?,
                    task_id: r.get(1)?,
                    at: r.get(2)?,
                    kind: r.get(3)?,
                    from_stage: r.get(4)?,
                    to_stage: r.get(5)?,
                    run_id: r.get(6)?,
                    actor: r.get(7)?,
                    note: r.get(8)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Movimento manual: muda estágio e/ou status (ex.: backlog → ready, bloquear, voltar um estágio).
    pub fn move_task(
        &self,
        id: &str,
        stage_id: Option<&str>,
        status: TaskStatus,
        note: Option<&str>,
    ) -> Result<Task> {
        let task = self
            .get_task(id)?
            .with_context(|| format!("Task {id} não encontrada"))?;
        if task.status == TaskStatus::Running {
            anyhow::bail!("A task está em run; interrompa o run antes de movê-la");
        }
        let target_stage = stage_id.unwrap_or(&task.stage_id).to_string();
        {
            let mut conn = self.conn.lock().expect("store mutex");
            let tx = conn.transaction()?;
            tx.execute(
                "UPDATE task SET stage_id = ?2, status = ?3, last_note = COALESCE(?4, last_note), updated_at = ?5 WHERE id = ?1",
                params![id, target_stage, status.as_str(), note, now()],
            )?;
            insert_event(
                &tx,
                id,
                "moved",
                Some(&task.stage_id),
                Some(&target_stage),
                None,
                "você",
                note,
            )?;
            tx.commit()?;
        }
        self.get_task(id)?.context("task sumiu após mover")
    }

    /// Gate humano aprovado: segue para o próximo estágio ou conclui.
    pub fn approve_task(&self, id: &str, note: Option<&str>) -> Result<Task> {
        let task = self
            .get_task(id)?
            .with_context(|| format!("Task {id} não encontrada"))?;
        if task.status != TaskStatus::WaitingApproval && task.status != TaskStatus::Review {
            anyhow::bail!("A task não está aguardando aprovação");
        }
        let workflow = self
            .get_workflow(&task.workflow_id)?
            .context("workflow da task")?;
        {
            let mut conn = self.conn.lock().expect("store mutex");
            let tx = conn.transaction()?;
            advance_task(
                &tx,
                &task,
                &workflow,
                "você",
                note.or(Some("aprovado")),
                true,
            )?;
            tx.commit()?;
        }
        self.get_task(id)?.context("task sumiu após aprovar")
    }

    /// Devolve a task a um estágio anterior (volta para `ready` ali).
    pub fn return_task(&self, id: &str, stage_id: &str, note: Option<&str>) -> Result<Task> {
        let task = self
            .get_task(id)?
            .with_context(|| format!("Task {id} não encontrada"))?;
        let workflow = self
            .get_workflow(&task.workflow_id)?
            .context("workflow da task")?;
        if !workflow.stages.iter().any(|s| s.id == stage_id) {
            anyhow::bail!("Estágio {stage_id} não existe neste workflow");
        }
        {
            let mut conn = self.conn.lock().expect("store mutex");
            let tx = conn.transaction()?;
            tx.execute(
                "UPDATE task SET stage_id = ?2, status = 'ready', last_note = COALESCE(?3, last_note), updated_at = ?4 WHERE id = ?1",
                params![id, stage_id, note, now()],
            )?;
            insert_event(
                &tx,
                id,
                "returned",
                Some(&task.stage_id),
                Some(stage_id),
                None,
                "você",
                note,
            )?;
            tx.commit()?;
        }
        self.get_task(id)?.context("task sumiu após devolver")
    }

    // ------------------------------------------------------------------ scheduler

    /// Tasks `ready` cujas dependências estão `done`, respeitando o paralelismo do workflow.
    pub fn runnable_tasks(&self, project_id: &str) -> Result<Vec<(Task, Workflow, Stage)>> {
        let tasks = self.list_tasks(project_id)?;
        let workflows = self.list_workflows(project_id)?;
        let mut out = Vec::new();
        for workflow in &workflows {
            let active = tasks
                .iter()
                .filter(|t| t.workflow_id == workflow.id && t.status == TaskStatus::Running)
                .count() as u32;
            let mut slots = workflow.max_parallel.saturating_sub(active);
            for task in tasks
                .iter()
                .filter(|t| t.workflow_id == workflow.id && t.status == TaskStatus::Ready)
            {
                if slots == 0 {
                    break;
                }
                let deps_done = task.depends_on.iter().all(|dep| {
                    tasks
                        .iter()
                        .any(|t| &t.id == dep && t.status == TaskStatus::Done)
                });
                if !deps_done {
                    continue;
                }
                let Some(stage) = workflow.stages.iter().find(|s| s.id == task.stage_id) else {
                    continue;
                };
                if stage.gate {
                    // Gate sem run: a task espera você.
                    continue;
                }
                out.push((task.clone(), workflow.clone(), stage.clone()));
                slots -= 1;
            }
        }
        Ok(out)
    }

    /// Tasks em estágio gate que ainda estão `ready` viram `waiting_approval` (sem run).
    pub fn park_gate_tasks(&self, project_id: &str) -> Result<usize> {
        let tasks = self.list_tasks(project_id)?;
        let workflows = self.list_workflows(project_id)?;
        let mut parked = 0;
        for task in tasks.iter().filter(|t| t.status == TaskStatus::Ready) {
            let Some(workflow) = workflows.iter().find(|w| w.id == task.workflow_id) else {
                continue;
            };
            let Some(stage) = workflow.stages.iter().find(|s| s.id == task.stage_id) else {
                continue;
            };
            if stage.gate {
                let conn = self.conn.lock().expect("store mutex");
                conn.execute(
                    "UPDATE task SET status = 'waiting_approval', updated_at = ?2 WHERE id = ?1",
                    params![task.id, now()],
                )?;
                parked += 1;
            }
        }
        Ok(parked)
    }

    /// Marca a task como em execução pelo run (checkout atômico: só se ainda estiver `ready`).
    pub fn claim_task(
        &self,
        task_id: &str,
        run_id: &str,
        worktree_path: Option<&str>,
        base_commit: Option<&str>,
    ) -> Result<bool> {
        let mut conn = self.conn.lock().expect("store mutex");
        let tx = conn.transaction()?;
        let changed = tx.execute(
            "UPDATE task SET status = 'running', lock_run_id = ?2, worktree_path = COALESCE(?3, worktree_path), base_commit = COALESCE(?5, base_commit), updated_at = ?4 WHERE id = ?1 AND status = 'ready'",
            params![task_id, run_id, worktree_path, now(), base_commit],
        )?;
        if changed > 0 {
            let stage: String = tx.query_row(
                "SELECT stage_id FROM task WHERE id = ?1",
                params![task_id],
                |r| r.get(0),
            )?;
            insert_event(
                &tx,
                task_id,
                "run_started",
                Some(&stage),
                Some(&stage),
                Some(run_id),
                "scheduler",
                None,
            )?;
        }
        tx.commit()?;
        Ok(changed > 0)
    }

    /// Falha ao iniciar o run (sidecar recusou, worktree falhou): a task fica `failed` com o motivo.
    pub fn fail_task(&self, task_id: &str, note: &str) -> Result<()> {
        let mut conn = self.conn.lock().expect("store mutex");
        let tx = conn.transaction()?;
        tx.execute(
            "UPDATE task SET status = 'failed', lock_run_id = NULL, last_note = ?2, updated_at = ?3 WHERE id = ?1",
            params![task_id, note, now()],
        )?;
        insert_event(
            &tx,
            task_id,
            "failed",
            None,
            None,
            None,
            "scheduler",
            Some(note),
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Texto da task para o prompt do run.
    pub fn task_prompt(task: &Task, stage: &Stage, workflow: &Workflow) -> String {
        let mut text = format!(
            "Task {id} do board \"{wf}\", estágio \"{stage}\".\n\n# {title}\n",
            id = task.id,
            wf = workflow.name,
            stage = stage.name,
            title = task.title
        );
        if !task.description_md.trim().is_empty() {
            text.push('\n');
            text.push_str(task.description_md.trim());
            text.push('\n');
        }
        if !task.acceptance_md.trim().is_empty() {
            text.push_str("\nCritérios de aceite:\n");
            text.push_str(task.acceptance_md.trim());
            text.push('\n');
        }
        if let Some(instruction) = stage
            .instruction
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            text.push_str("\nInstrução deste estágio: ");
            text.push_str(instruction);
            text.push('\n');
        }
        if let Some(note) = task
            .last_note
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            text.push_str("\nÚltima nota na task: ");
            text.push_str(note);
            text.push('\n');
        }
        text.push_str("\nAo terminar, chame a tool task_update com status \"done\" (concluiu este estágio), \"review\" (precisa de revisão) ou \"blocked\" (não consegue prosseguir), uma nota curta e, em `result`, o resumo da entrega em markdown: o que mudou, onde, e como verificar.");
        text
    }

    pub fn task_context(task: &Task, stage: &Stage) -> TaskContext {
        TaskContext {
            task_id: task.id.clone(),
            title: task.title.clone(),
            stage: stage.name.clone(),
            allowed_statuses: vec![
                TaskStatusUpdate::Done,
                TaskStatusUpdate::Review,
                TaskStatusUpdate::Blocked,
            ],
        }
    }

    /// Cria (ou reaproveita) o worktree da task em `<projeto>/.octopus/worktrees/<task>` com a branch `octopus/<task>`.
    pub fn ensure_worktree(project_path: &Path, task_id: &str) -> Result<PathBuf> {
        let inside = Command::new("git")
            .args(["rev-parse", "--is-inside-work-tree"])
            .current_dir(project_path)
            .output()
            .context("git não encontrado")?;
        if !inside.status.success() {
            anyhow::bail!(
                "{} não é um repositório git; desative worktrees neste workflow",
                project_path.display()
            );
        }
        let dir = project_path
            .join(".octopus")
            .join("worktrees")
            .join(task_id);
        if dir.join(".git").exists() {
            return Ok(dir);
        }
        std::fs::create_dir_all(dir.parent().unwrap())?;
        let output = Command::new("git")
            .args(["worktree", "add", "-B", &format!("octopus/{task_id}")])
            .arg(&dir)
            .arg("HEAD")
            .current_dir(project_path)
            .output()
            .context("executando git worktree add")?;
        if !output.status.success() {
            anyhow::bail!(
                "git worktree add falhou: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }
        Ok(dir)
    }

    // ------------------------------------------------------------------ transições por eventos de run

    /// `task_update` vindo do agente: guarda a nota e o status pedido; a transição acontece no fim do run.
    pub(crate) fn apply_task_update(
        tx: &Transaction<'_>,
        run_id: &str,
        status: TaskStatusUpdate,
        note: Option<&str>,
        result: Option<&str>,
    ) -> Result<()> {
        let task_id: Option<String> = tx
            .query_row(
                "SELECT task_id FROM run WHERE id = ?1",
                params![run_id],
                |r| r.get(0),
            )
            .optional()?
            .flatten();
        let Some(task_id) = task_id else {
            return Ok(());
        };
        let requested = match status {
            TaskStatusUpdate::Done => "done",
            TaskStatusUpdate::Review => "review",
            TaskStatusUpdate::Blocked => "blocked",
        };
        tx.execute(
            "UPDATE task SET last_note = COALESCE(?2, last_note), result_md = COALESCE(?4, result_md), updated_at = ?3 WHERE id = ?1",
            params![task_id, note, now(), result.map(str::trim).filter(|r| !r.is_empty())],
        )?;
        insert_event(
            tx,
            &task_id,
            "agent_update",
            None,
            None,
            Some(run_id),
            "agente",
            Some(&format!(
                "{requested}{}",
                note.map(|n| format!(": {n}")).unwrap_or_default()
            )),
        )?;
        Ok(())
    }

    /// Fim do run de uma task: avança, conclui, bloqueia ou falha conforme o resultado e o último `task_update`.
    /// O run foi parado pelo core (orçamento): a task que ele executava vai para Bloqueada
    /// com o motivo e solta o lock. Devolve o id da task, se havia uma.
    pub(crate) fn block_task_of_run(
        tx: &Transaction<'_>,
        run_id: &str,
        note: &str,
    ) -> Result<Option<String>> {
        let task: Option<(String, String)> = tx
            .query_row(
                "SELECT id, stage_id FROM task WHERE lock_run_id = ?1",
                params![run_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let Some((task_id, stage_id)) = task else {
            return Ok(None);
        };
        tx.execute(
            "UPDATE task SET status = 'blocked', lock_run_id = NULL, last_note = ?2, updated_at = ?3 WHERE id = ?1",
            params![task_id, note, now()],
        )?;
        insert_event(
            tx,
            &task_id,
            "blocked",
            Some(&stage_id),
            Some(&stage_id),
            Some(run_id),
            "orçamento",
            Some(note),
        )?;
        Ok(Some(task_id))
    }

    /// `summary` é o texto final do run (sucesso) ou a mensagem de erro (falha).
    pub(crate) fn finish_task_run(
        tx: &Transaction<'_>,
        run_id: &str,
        success: bool,
        summary: Option<&str>,
    ) -> Result<()> {
        let task_id: Option<String> = tx
            .query_row(
                "SELECT task_id FROM run WHERE id = ?1",
                params![run_id],
                |r| r.get(0),
            )
            .optional()?
            .flatten();
        let Some(task_id) = task_id else {
            return Ok(());
        };
        let task = tx
            .query_row(
                &format!("{} WHERE id = ?1", Task::SELECT),
                params![task_id],
                Task::from_row,
            )
            .optional()?;
        let Some(task) = task else { return Ok(()) };
        if task.lock_run_id.as_deref() != Some(run_id) {
            return Ok(());
        }
        let workflow = tx
            .query_row(
                "SELECT id, project_id, name, stages_json, use_worktrees, max_parallel, created_at FROM workflow WHERE id = ?1",
                params![task.workflow_id],
                workflow_from_row,
            )
            .optional()?;
        let Some(workflow) = workflow else {
            return Ok(());
        };
        // Último pedido do agente neste run.
        let last_update: Option<String> = tx
            .query_row(
                "SELECT note FROM task_event WHERE task_id = ?1 AND run_id = ?2 AND kind = 'agent_update' ORDER BY at DESC, rowid DESC LIMIT 1",
                params![task.id, run_id],
                |r| r.get(0),
            )
            .optional()?;
        let requested = last_update
            .as_deref()
            .map(|n| n.split(':').next().unwrap_or("").trim().to_string());
        if !success {
            let note = summary.unwrap_or("run falhou");
            tx.execute(
                "UPDATE task SET status = 'failed', lock_run_id = NULL, last_note = ?2, updated_at = ?3 WHERE id = ?1",
                params![task.id, note, now()],
            )?;
            insert_event(
                tx,
                &task.id,
                "run_failed",
                Some(&task.stage_id),
                Some(&task.stage_id),
                Some(run_id),
                "scheduler",
                Some(note),
            )?;
            return Ok(());
        }
        // Entrega: o resumo do agente (task_update.result) vence; senão o texto final do run.
        let project_path: String = tx
            .query_row(
                "SELECT path FROM project WHERE id = ?1",
                params![task.project_id],
                |r| r.get(0),
            )
            .optional()?
            .unwrap_or_default();
        let roots = [task.worktree_path.as_deref().unwrap_or(""), &project_path];
        let files: Vec<String> = super::memory::files_touched_in(tx, run_id)?
            .into_iter()
            .map(|f| super::task_diff::relativize(&f, &roots))
            .collect();
        tx.execute(
            "UPDATE task SET result_md = COALESCE(result_md, ?2), files_changed_json = ?3, result_run_id = ?4 WHERE id = ?1",
            params![
                task.id,
                summary.map(str::trim).filter(|s| !s.is_empty()),
                serde_json::to_string(&files)?,
                run_id
            ],
        )?;
        match requested.as_deref() {
            Some("blocked") => {
                tx.execute(
                    "UPDATE task SET status = 'blocked', lock_run_id = NULL, updated_at = ?2 WHERE id = ?1",
                    params![task.id, now()],
                )?;
                insert_event(
                    tx,
                    &task.id,
                    "blocked",
                    Some(&task.stage_id),
                    Some(&task.stage_id),
                    Some(run_id),
                    "agente",
                    task.last_note.as_deref(),
                )?;
            }
            Some("review") => {
                // Precisa de olhos humanos antes de seguir: para em waiting_approval no estágio atual.
                tx.execute(
                    "UPDATE task SET status = 'waiting_approval', lock_run_id = NULL, updated_at = ?2 WHERE id = ?1",
                    params![task.id, now()],
                )?;
                insert_event(
                    tx,
                    &task.id,
                    "run_finished",
                    Some(&task.stage_id),
                    Some(&task.stage_id),
                    Some(run_id),
                    "agente",
                    Some("pediu revisão"),
                )?;
            }
            _ => {
                advance_task(
                    tx,
                    &task,
                    &workflow,
                    "scheduler",
                    task.last_note.as_deref(),
                    false,
                )?;
                tx.execute(
                    "UPDATE task SET lock_run_id = NULL WHERE id = ?1",
                    params![task.id],
                )?;
                let _ = run_id;
            }
        }
        Ok(())
    }
}

/// Próximo estágio: gate → `waiting_approval`; estágio normal → `ready`; fim → `done`.
fn advance_task(
    tx: &Transaction<'_>,
    task: &Task,
    workflow: &Workflow,
    actor: &str,
    note: Option<&str>,
    human: bool,
) -> Result<()> {
    let index = workflow
        .stages
        .iter()
        .position(|s| s.id == task.stage_id)
        .unwrap_or(0);
    let next = workflow.stages.get(index + 1);
    let (stage_id, status) = match next {
        Some(stage) if stage.gate => (stage.id.clone(), "waiting_approval"),
        Some(stage) => (stage.id.clone(), "ready"),
        None => (task.stage_id.clone(), "done"),
    };
    tx.execute(
        "UPDATE task SET stage_id = ?2, status = ?3, lock_run_id = NULL, last_note = COALESCE(?4, last_note), updated_at = ?5 WHERE id = ?1",
        params![task.id, stage_id, status, note, now()],
    )?;
    let kind = if human {
        "approved"
    } else if status == "done" {
        "completed"
    } else {
        "advanced"
    };
    insert_event(
        tx,
        &task.id,
        kind,
        Some(&task.stage_id),
        Some(&stage_id),
        None,
        actor,
        note,
    )?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn insert_event(
    tx: &Transaction<'_>,
    task_id: &str,
    kind: &str,
    from: Option<&str>,
    to: Option<&str>,
    run_id: Option<&str>,
    actor: &str,
    note: Option<&str>,
) -> Result<()> {
    tx.execute(
        "INSERT INTO task_event (id, task_id, at, kind, from_stage, to_stage, run_id, actor, note) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![new_id("tev"), task_id, now(), kind, from, to, run_id, actor, note],
    )?;
    Ok(())
}

fn workflow_from_row(row: &Row<'_>) -> rusqlite::Result<Workflow> {
    let stages: String = row.get(3)?;
    Ok(Workflow {
        id: row.get(0)?,
        project_id: row.get(1)?,
        name: row.get(2)?,
        stages: serde_json::from_str(&stages).unwrap_or_default(),
        use_worktrees: row.get::<_, i64>(4)? != 0,
        max_parallel: row.get::<_, i64>(5)? as u32,
        created_at: row.get(6)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{RunEvent, RunOptions, Usage};
    use crate::store::team::TeamMemberInput;

    fn setup() -> (Store, String, Workflow) {
        let s = Store::open_in_memory().unwrap();
        let p = s.create_project("p", "/tmp/p").unwrap();
        for (name, role) in [
            ("Pedro", "role_planejador"),
            ("Ana", "role_implementador"),
            ("Rui", "role_revisor"),
        ] {
            s.add_team_member(
                &p.id,
                &TeamMemberInput {
                    name: name.into(),
                    role_id: role.into(),
                    ..Default::default()
                },
            )
            .unwrap();
        }
        let wf = s
            .create_workflow_from_template(&p.id, "plan-implement-review-approve", false)
            .unwrap();
        (s, p.id, wf)
    }

    fn result_event(ok: bool) -> RunEvent {
        RunEvent::Result {
            session_id: "s".into(),
            subtype: if ok { "success".into() } else { "error".into() },
            is_error: !ok,
            cost_usd: Some(0.1),
            duration_ms: None,
            num_turns: Some(1),
            usage: Some(Usage::default()),
            stop_reason: None,
            result_text: None,
        }
    }

    #[test]
    fn finish_task_run_fills_result_files_and_run() {
        use crate::protocol::ObservationKind;
        let (s, project, wf) = setup();
        let path = s.get_project(&project).unwrap().unwrap().path;
        let t = s
            .create_task(
                &project,
                &wf.id,
                &TaskInput {
                    title: "Entrega".into(),
                    ..Default::default()
                },
            )
            .unwrap();
        let run = s
            .create_run_full(&project, "x", &RunOptions::default(), None, Some(&t.id))
            .unwrap();
        assert!(s.claim_task(&t.id, &run.id, None, Some("abc123")).unwrap());
        assert_eq!(
            s.get_task(&t.id).unwrap().unwrap().base_commit.as_deref(),
            Some("abc123")
        );
        // O agente escreve dois arquivos (um deles duas vezes) e entrega com resumo.
        for (seq, file) in ["src/a.rs", "src/b.rs", "src/a.rs"].iter().enumerate() {
            s.record_run_event(
                &run.id,
                seq as u64,
                "t",
                &RunEvent::Observation {
                    kind: ObservationKind::ToolUse,
                    title: format!("Write {path}/{file}"),
                    body: String::new(),
                    tool_name: Some("Write".into()),
                    tool_use_id: None,
                    parent_tool_use_id: None,
                    agent_id: None,
                },
            )
            .unwrap();
        }
        s.record_run_event(
            &run.id,
            10,
            "t",
            &RunEvent::TaskUpdate {
                task_id: t.id.clone(),
                status: TaskStatusUpdate::Done,
                note: Some("feito".into()),
                result: Some("## Entrega\n\n- a.rs e b.rs".into()),
            },
        )
        .unwrap();
        // O resumo fica visível já na chamada, antes de o run terminar.
        assert_eq!(
            s.get_task(&t.id).unwrap().unwrap().result_md.as_deref(),
            Some("## Entrega\n\n- a.rs e b.rs")
        );
        s.record_run_event(&run.id, 11, "t", &result_event(true))
            .unwrap();
        let done = s.get_task(&t.id).unwrap().unwrap();
        assert_eq!(
            done.result_md.as_deref(),
            Some("## Entrega\n\n- a.rs e b.rs")
        );
        assert_eq!(done.files_changed, vec!["src/a.rs", "src/b.rs"]);
        assert_eq!(done.result_run_id.as_deref(), Some(run.id.as_str()));

        // Sem task_update: o texto final do run vira o resumo; run falho não grava entrega.
        let t2 = s
            .create_task(
                &project,
                &wf.id,
                &TaskInput {
                    title: "Sem resumo".into(),
                    ..Default::default()
                },
            )
            .unwrap();
        let run2 = s
            .create_run_full(&project, "x", &RunOptions::default(), None, Some(&t2.id))
            .unwrap();
        assert!(s.claim_task(&t2.id, &run2.id, None, None).unwrap());
        let mut ev = result_event(true);
        if let RunEvent::Result { result_text, .. } = &mut ev {
            *result_text = Some("  Terminei o plano.  ".into());
        }
        s.record_run_event(&run2.id, 0, "t", &ev).unwrap();
        let t2_now = s.get_task(&t2.id).unwrap().unwrap();
        assert_eq!(t2_now.result_md.as_deref(), Some("Terminei o plano."));
        assert!(t2_now.files_changed.is_empty());

        let t3 = s
            .create_task(
                &project,
                &wf.id,
                &TaskInput {
                    title: "Falha".into(),
                    ..Default::default()
                },
            )
            .unwrap();
        let run3 = s
            .create_run_full(&project, "x", &RunOptions::default(), None, Some(&t3.id))
            .unwrap();
        assert!(s.claim_task(&t3.id, &run3.id, None, None).unwrap());
        s.record_run_event(&run3.id, 0, "t", &result_event(false))
            .unwrap();
        let t3_now = s.get_task(&t3.id).unwrap().unwrap();
        assert_eq!(t3_now.status, TaskStatus::Failed);
        assert!(t3_now.result_md.is_none());
        assert!(t3_now.result_run_id.is_none());
    }

    #[test]
    fn template_assigns_team_members_by_role() {
        let (s, project, wf) = setup();
        assert_eq!(wf.stages.len(), 4);
        let team = s.list_team(&project).unwrap();
        let ana = team.iter().find(|m| m.profile.name == "Ana").unwrap();
        assert_eq!(
            wf.stages[1].agent_profile_id.as_deref(),
            Some(ana.profile.id.as_str())
        );
        assert!(wf.stages[3].gate);
        assert!(wf.stages[3].agent_profile_id.is_none());
        assert_eq!(s.list_workflows(&project).unwrap().len(), 1);
        assert!(s
            .create_workflow_from_template(&project, "nope", false)
            .is_err());
    }

    #[test]
    fn scheduler_respects_dependencies_parallelism_and_gates() {
        let (s, project, wf) = setup();
        let t1 = s
            .create_task(
                &project,
                &wf.id,
                &TaskInput {
                    title: "Primeira".into(),
                    ..Default::default()
                },
            )
            .unwrap();
        let t2 = s
            .create_task(
                &project,
                &wf.id,
                &TaskInput {
                    title: "Segunda".into(),
                    depends_on: vec![t1.id.clone()],
                    ..Default::default()
                },
            )
            .unwrap();
        let backlog = s
            .create_task(
                &project,
                &wf.id,
                &TaskInput {
                    title: "Depois".into(),
                    ready: false,
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(backlog.status, TaskStatus::Backlog);

        // Só a primeira pode rodar (a segunda depende dela; max_parallel = 1).
        let runnable = s.runnable_tasks(&project).unwrap();
        assert_eq!(
            runnable
                .iter()
                .map(|(t, _, _)| t.id.as_str())
                .collect::<Vec<_>>(),
            vec![t1.id.as_str()]
        );
        let (_, _, stage) = &runnable[0];
        assert_eq!(stage.name, "Planejar");

        // Claim atômico: segunda tentativa falha.
        let run = s
            .create_run_full(
                &project,
                "x",
                &RunOptions::default(),
                stage.agent_profile_id.as_deref(),
                Some(&t1.id),
            )
            .unwrap();
        assert!(s.claim_task(&t1.id, &run.id, None, None).unwrap());
        assert!(!s.claim_task(&t1.id, "outro", None, None).unwrap());
        assert_eq!(
            s.get_task(&t1.id).unwrap().unwrap().status,
            TaskStatus::Running
        );
        assert!(
            s.runnable_tasks(&project).unwrap().is_empty(),
            "slot ocupado"
        );

        // Agente pede done e o run termina com sucesso: avança para Implementar (ready).
        s.record_run_event(
            &run.id,
            0,
            "t",
            &RunEvent::TaskUpdate {
                task_id: t1.id.clone(),
                status: TaskStatusUpdate::Done,
                note: Some("plano pronto".into()),
                result: None,
            },
        )
        .unwrap();
        s.record_run_event(&run.id, 1, "t", &result_event(true))
            .unwrap();
        let t1_now = s.get_task(&t1.id).unwrap().unwrap();
        assert_eq!(t1_now.status, TaskStatus::Ready);
        assert_eq!(t1_now.stage_id, "stage_2");
        assert_eq!(t1_now.last_note.as_deref(), Some("plano pronto"));
        assert!(t1_now.lock_run_id.is_none());

        // Implementar → (review pedido) para em waiting_approval no mesmo estágio.
        let run2 = s
            .create_run_full(&project, "x", &RunOptions::default(), None, Some(&t1.id))
            .unwrap();
        assert!(s.claim_task(&t1.id, &run2.id, None, None).unwrap());
        s.record_run_event(
            &run2.id,
            0,
            "t",
            &RunEvent::TaskUpdate {
                task_id: t1.id.clone(),
                status: TaskStatusUpdate::Review,
                note: Some("olhem o diff".into()),
                result: None,
            },
        )
        .unwrap();
        s.record_run_event(&run2.id, 1, "t", &result_event(true))
            .unwrap();
        let t1_now = s.get_task(&t1.id).unwrap().unwrap();
        assert_eq!(t1_now.status, TaskStatus::WaitingApproval);
        assert_eq!(t1_now.stage_id, "stage_2");
        // Você aprova: segue para Revisar.
        let t1_now = s.approve_task(&t1.id, Some("ok")).unwrap();
        assert_eq!(
            (t1_now.stage_id.as_str(), t1_now.status),
            ("stage_3", TaskStatus::Ready)
        );
        // Revisar sem task_update: avança para Aprovar, que é gate → waiting_approval.
        let run3 = s
            .create_run_full(&project, "x", &RunOptions::default(), None, Some(&t1.id))
            .unwrap();
        assert!(s.claim_task(&t1.id, &run3.id, None, None).unwrap());
        s.record_run_event(&run3.id, 0, "t", &result_event(true))
            .unwrap();
        let t1_now = s.get_task(&t1.id).unwrap().unwrap();
        assert_eq!(
            (t1_now.stage_id.as_str(), t1_now.status),
            ("stage_4", TaskStatus::WaitingApproval)
        );
        // Gate não gera run.
        assert!(s
            .runnable_tasks(&project)
            .unwrap()
            .iter()
            .all(|(t, _, _)| t.id != t1.id));
        // A segunda ainda não roda: depende de t1 done.
        assert!(s.runnable_tasks(&project).unwrap().is_empty());
        let t1_now = s.approve_task(&t1.id, None).unwrap();
        assert_eq!(t1_now.status, TaskStatus::Done);
        // Agora a segunda é elegível.
        let runnable = s.runnable_tasks(&project).unwrap();
        assert_eq!(runnable.len(), 1);
        assert_eq!(runnable[0].0.id, t2.id);

        // Histórico registra tudo.
        let kinds: Vec<String> = s
            .list_task_events(&t1.id)
            .unwrap()
            .into_iter()
            .map(|e| e.kind)
            .collect();
        assert_eq!(
            kinds,
            vec![
                "created",
                "run_started",
                "agent_update",
                "advanced",
                "run_started",
                "agent_update",
                "run_finished",
                "approved",
                "run_started",
                "advanced",
                "approved"
            ]
        );
    }

    #[test]
    fn failures_block_and_return_tasks() {
        let (s, project, wf) = setup();
        let t = s
            .create_task(
                &project,
                &wf.id,
                &TaskInput {
                    title: "X".into(),
                    ..Default::default()
                },
            )
            .unwrap();
        let run = s
            .create_run_full(&project, "x", &RunOptions::default(), None, Some(&t.id))
            .unwrap();
        assert!(s.claim_task(&t.id, &run.id, None, None).unwrap());
        s.record_run_event(
            &run.id,
            0,
            "t",
            &RunEvent::Error {
                message: "sem credencial".into(),
                fatal: true,
            },
        )
        .unwrap();
        let t_now = s.get_task(&t.id).unwrap().unwrap();
        assert_eq!(t_now.status, TaskStatus::Failed);
        assert_eq!(t_now.last_note.as_deref(), Some("sem credencial"));

        // Devolver para o primeiro estágio a deixa pronta de novo.
        let t_now = s
            .return_task(&t.id, "stage_1", Some("tente de novo"))
            .unwrap();
        assert_eq!(t_now.status, TaskStatus::Ready);

        // Agente bloqueia.
        let run2 = s
            .create_run_full(&project, "x", &RunOptions::default(), None, Some(&t.id))
            .unwrap();
        assert!(s.claim_task(&t.id, &run2.id, None, None).unwrap());
        s.record_run_event(
            &run2.id,
            0,
            "t",
            &RunEvent::TaskUpdate {
                task_id: t.id.clone(),
                status: TaskStatusUpdate::Blocked,
                note: Some("falta acesso".into()),
                result: None,
            },
        )
        .unwrap();
        s.record_run_event(&run2.id, 1, "t", &result_event(true))
            .unwrap();
        assert_eq!(
            s.get_task(&t.id).unwrap().unwrap().status,
            TaskStatus::Blocked
        );

        // Movimento manual não vale com run em andamento; falha de start marca failed.
        let t_now = s.move_task(&t.id, None, TaskStatus::Ready, None).unwrap();
        assert_eq!(t_now.status, TaskStatus::Ready);
        s.fail_task(&t.id, "sidecar recusou").unwrap();
        assert_eq!(
            s.get_task(&t.id).unwrap().unwrap().status,
            TaskStatus::Failed
        );
        assert!(s
            .create_task(
                &project,
                &wf.id,
                &TaskInput {
                    title: "Y".into(),
                    depends_on: vec!["nope".into()],
                    ..Default::default()
                }
            )
            .is_err());
    }

    #[test]
    fn prompt_and_context_describe_the_task() {
        let (s, project, wf) = setup();
        let t = s
            .create_task(
                &project,
                &wf.id,
                &TaskInput {
                    title: "Criar V12".into(),
                    description_md: "Índice composto".into(),
                    acceptance_md: "- IT verde".into(),
                    ..Default::default()
                },
            )
            .unwrap();
        let prompt = Store::task_prompt(&t, &wf.stages[0], &wf);
        assert!(prompt.contains("# Criar V12"));
        assert!(prompt.contains("Índice composto"));
        assert!(prompt.contains("Critérios de aceite:\n- IT verde"));
        assert!(prompt.contains("Instrução deste estágio: Produza um plano"));
        assert!(prompt.contains("task_update"));
        let ctx = Store::task_context(&t, &wf.stages[0]);
        assert_eq!(ctx.task_id, t.id);
        assert_eq!(ctx.stage, "Planejar");
    }

    #[test]
    fn worktree_is_created_in_a_git_repo_and_refused_outside() {
        let dir = tempfile::tempdir().unwrap();
        assert!(Store::ensure_worktree(dir.path(), "task_x").is_err());
        let run = |args: &[&str]| {
            let out = Command::new("git")
                .args(args)
                .current_dir(dir.path())
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
        };
        run(&["init", "-q"]);
        run(&[
            "-c",
            "user.email=t@t",
            "-c",
            "user.name=t",
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            "init",
        ]);
        let wt = Store::ensure_worktree(dir.path(), "task_x").unwrap();
        assert!(wt.ends_with(".octopus/worktrees/task_x"));
        assert!(wt.join(".git").exists());
        // Idempotente.
        assert_eq!(Store::ensure_worktree(dir.path(), "task_x").unwrap(), wt);
    }
}
