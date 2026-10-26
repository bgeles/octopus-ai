//! Orquestração: workflows (estágios com responsável e gate humano), tasks com dependências,
//! histórico de movimentos e as transições que o scheduler e o agente (`task_update`) disparam.

use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{Context, Result};
use rusqlite::{params, OptionalExtension, Row, Transaction};
use serde::{Deserialize, Serialize};

use std::collections::HashSet;

use super::team::{resolve_approver, Approver};
use super::{new_id, now, Store};
use crate::protocol::{TaskContext, TaskMode, TaskStatusUpdate};

/// Contexto extra dos prompts de task e de revisão: comentários seus na task (e, adiante, missão e objetivo).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PromptContext {
    /// Últimos comentários do gestor, em ordem cronológica.
    pub comments: Vec<TaskEvent>,
    /// Missão do projeto e objetivo da task (ou do workflow): o "porquê".
    pub mission: Option<String>,
    pub goal: Option<super::goals::Goal>,
}

pub const MAX_COMMENT_CHARS: usize = 4_000;
const PROMPT_COMMENTS: usize = 5;

/// Filtro do scheduler: só um membro e/ou ignorando pausas (usado por "Rodar agora").
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TaskFilter {
    pub only_agent: Option<String>,
    pub ignore_pause: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stage {
    pub id: String,
    pub name: String,
    /// Membro responsável (agent_profile). `None` = run avulso, ou gate humano.
    #[serde(default)]
    pub agent_profile_id: Option<String>,
    /// Gate: a task para aqui até alguém aprovar (quem, decide `approver`).
    #[serde(default)]
    pub gate: bool,
    /// Instrução extra do estágio para o prompt.
    #[serde(default)]
    pub instruction: Option<String>,
    /// Quem aprova neste gate: você (`human`, padrão) ou a política de confiança do responsável (`policy`).
    #[serde(default)]
    pub approver: StageApprover,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum StageApprover {
    #[default]
    Human,
    Policy,
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
    /// Objetivo padrão das tasks deste workflow.
    #[serde(default)]
    pub goal_id: Option<String>,
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
    #[serde(default)]
    pub goal_id: Option<String>,
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
    /// Membro revisando a task (status `review`).
    #[serde(default)]
    pub approver_agent_id: Option<String>,
    /// Vezes que um agente devolveu a task; acima do limite, sobe para você.
    #[serde(default)]
    pub return_count: u32,
    /// Runs de revisão já tentados para a revisão atual.
    #[serde(default)]
    pub review_attempts: u32,
    /// Membro (agente) que criou a task pelas tools de delegação; `None` = você.
    #[serde(default)]
    pub created_by_agent_id: Option<String>,
    /// Objetivo da task (herda do workflow quando não informado).
    #[serde(default)]
    pub goal_id: Option<String>,
    /// Commit base no claim, para o diff da entrega.
    #[serde(default)]
    pub base_commit: Option<String>,
}

impl Task {
    const SELECT: &'static str = "SELECT id, project_id, workflow_id, stage_id, title, description_md, acceptance_md, status, assigned_agent_id, depends_on_json, worktree_path, lock_run_id, last_note, position, created_at, updated_at, result_md, files_changed_json, result_run_id, base_commit, approver_agent_id, return_count, review_attempts, created_by_agent_id, goal_id FROM task";

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
            approver_agent_id: row.get(20)?,
            return_count: row.get::<_, i64>(21)? as u32,
            review_attempts: row.get::<_, i64>(22)? as u32,
            created_by_agent_id: row.get(23)?,
            goal_id: row.get(24)?,
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
    /// Objetivo; `None` herda o do workflow.
    #[serde(default)]
    pub goal_id: Option<String>,
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
            goal_id: None,
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
        let mut stmt = conn.prepare("SELECT id, project_id, name, stages_json, use_worktrees, max_parallel, created_at, goal_id FROM workflow WHERE project_id = ?1 ORDER BY created_at")?;
        let rows = stmt
            .query_map(params![project_id], workflow_from_row)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn get_workflow(&self, id: &str) -> Result<Option<Workflow>> {
        let conn = self.conn.lock().expect("store mutex");
        Ok(conn
            .query_row(
                "SELECT id, project_id, name, stages_json, use_worktrees, max_parallel, created_at, goal_id FROM workflow WHERE id = ?1",
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
        let goal_id = match input.goal_id.as_deref() {
            Some(g) => Some(self.resolve_goal_for(project_id, g)?),
            None => None,
        };
        let id = new_id("wf");
        let conn = self.conn.lock().expect("store mutex");
        conn.execute(
            "INSERT INTO workflow (id, project_id, name, stages_json, use_worktrees, max_parallel, created_at, goal_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![id, project_id, input.name.trim(), serde_json::to_string(&input.stages)?, input.use_worktrees as i64, input.max_parallel.max(1) as i64, now(), goal_id],
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
                approver: StageApprover::Human,
            })
            .collect();
        self.create_workflow(
            project_id,
            &WorkflowInput {
                name: name.to_string(),
                stages,
                use_worktrees,
                max_parallel: 1,
                goal_id: None,
            },
        )
    }

    pub fn update_workflow(&self, id: &str, input: &WorkflowInput) -> Result<Workflow> {
        let current = self
            .get_workflow(id)?
            .with_context(|| format!("Workflow {id} não encontrado"))?;
        let goal_id = match input.goal_id.as_deref() {
            Some(g) => Some(self.resolve_goal_for(&current.project_id, g)?),
            None => None,
        };
        if input.name.trim().is_empty() {
            anyhow::bail!("Informe o nome do workflow");
        }
        if input.stages.is_empty() {
            anyhow::bail!("Um workflow precisa de pelo menos um estágio");
        }
        {
            let conn = self.conn.lock().expect("store mutex");
            let changed = conn.execute(
                "UPDATE workflow SET name = ?2, stages_json = ?3, use_worktrees = ?4, max_parallel = ?5, goal_id = ?6 WHERE id = ?1",
                params![id, input.name.trim(), serde_json::to_string(&input.stages)?, input.use_worktrees as i64, input.max_parallel.max(1) as i64, goal_id],
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
        self.create_task_as(project_id, workflow_id, input, "você", None, None)
    }

    /// Cria a task em nome de alguém: você (`actor` "você") ou um membro pelas tools de delegação
    /// (`created_by` = agente; o evento sai como `created_by_agent`).
    pub(crate) fn create_task_as(
        &self,
        project_id: &str,
        workflow_id: &str,
        input: &TaskInput,
        actor: &str,
        created_by: Option<&str>,
        run_id: Option<&str>,
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
        let goal_id = match input.goal_id.as_deref() {
            Some(g) => Some(self.resolve_goal_for(project_id, g)?),
            None => workflow.goal_id.clone(),
        };
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
                "INSERT INTO task (id, project_id, workflow_id, stage_id, title, description_md, acceptance_md, status, assigned_agent_id, depends_on_json, position, created_at, updated_at, created_by_agent_id, goal_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12, ?13, ?14)",
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
                    ts,
                    created_by,
                    goal_id
                ],
            )?;
            insert_event(
                &tx,
                &id,
                if created_by.is_some() {
                    "created_by_agent"
                } else {
                    "created"
                },
                None,
                Some(&stage_id),
                run_id,
                actor,
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
        let goal_id = match input.goal_id.as_deref() {
            Some(g) => Some(self.resolve_goal_for(&current.project_id, g)?),
            None => current.goal_id.clone(),
        };
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
                "UPDATE task SET title = ?2, description_md = ?3, acceptance_md = ?4, stage_id = ?5, assigned_agent_id = ?6, depends_on_json = ?7, updated_at = ?8, goal_id = ?9 WHERE id = ?1",
                params![id, input.title.trim(), input.description_md.trim(), input.acceptance_md.trim(), stage_id, input.assigned_agent_id, serde_json::to_string(&input.depends_on)?, now(), goal_id],
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
            // Só quando a task acabou de virar `done` (mover uma concluída de novo não gera relatório).
            if status == TaskStatus::Done && task.status != TaskStatus::Done {
                Store::maybe_complete_workflow_in(&tx, &task.workflow_id, None)?;
            }
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
            // Override humano: limpa a revisão em andamento (o run de revisão, se houver, é interrompido pelo comando).
            tx.execute(
                "UPDATE task SET approver_agent_id = NULL, lock_run_id = NULL, return_count = 0, review_attempts = 0 WHERE id = ?1",
                params![task.id],
            )?;
            advance_task(
                &tx,
                &task,
                &workflow,
                "você",
                note.or(Some("aprovado")),
                true,
                task.assigned_agent_id.as_deref(),
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
                "UPDATE task SET stage_id = ?2, status = 'ready', last_note = COALESCE(?3, last_note), approver_agent_id = NULL, lock_run_id = NULL, review_attempts = 0, updated_at = ?4 WHERE id = ?1",
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
        self.runnable_tasks_with(project_id, &TaskFilter::default())
    }

    /// Membros pausados do projeto (não recebem trabalho novo).
    fn paused_agents(&self, project_id: &str, filter: &TaskFilter) -> Result<HashSet<String>> {
        if filter.ignore_pause {
            return Ok(HashSet::new());
        }
        Ok(self
            .list_team(project_id)?
            .into_iter()
            .filter(|m| m.profile.paused_at.is_some())
            .map(|m| m.profile.id)
            .collect())
    }

    /// Como `runnable_tasks`, com filtro: só um membro (`only_agent`, pelo responsável efetivo —
    /// atribuído, senão o do estágio) e/ou ignorando pausas ("Rodar agora").
    pub fn runnable_tasks_with(
        &self,
        project_id: &str,
        filter: &TaskFilter,
    ) -> Result<Vec<(Task, Workflow, Stage)>> {
        let tasks = self.list_tasks(project_id)?;
        let workflows = self.list_workflows(project_id)?;
        let paused = self.paused_agents(project_id, filter)?;
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
                let effective = task
                    .assigned_agent_id
                    .as_deref()
                    .or(stage.agent_profile_id.as_deref());
                // Membro pausado: a task continua pronta, sem consumir slot nem bloquear as outras.
                if effective.is_some_and(|a| paused.contains(a)) {
                    continue;
                }
                if let Some(only) = filter.only_agent.as_deref() {
                    if effective != Some(only) {
                        continue;
                    }
                }
                out.push((task.clone(), workflow.clone(), stage.clone()));
                slots -= 1;
            }
        }
        Ok(out)
    }

    /// Tasks em estágio gate que ainda estão `ready` entram no gate (sem run): esperam você,
    /// um revisor do organograma, ou seguem auto-aprovadas, conforme o gate e a confiança.
    pub fn park_gate_tasks(&self, project_id: &str) -> Result<usize> {
        let tasks = self.list_tasks(project_id)?;
        let workflows = self.list_workflows(project_id)?;
        let mut parked = 0;
        for task in tasks.iter().filter(|t| t.status == TaskStatus::Ready) {
            let Some(workflow) = workflows.iter().find(|w| w.id == task.workflow_id) else {
                continue;
            };
            let Some(index) = workflow.stages.iter().position(|s| s.id == task.stage_id) else {
                continue;
            };
            if workflow.stages[index].gate {
                // Quem fez o trabalho que chega ao gate: o atribuído ou o responsável do estágio anterior.
                let worker = task.assigned_agent_id.clone().or_else(|| {
                    workflow.stages[..index]
                        .iter()
                        .rev()
                        .find_map(|s| s.agent_profile_id.clone())
                });
                let mut conn = self.conn.lock().expect("store mutex");
                let tx = conn.transaction()?;
                enter_gate(
                    &tx,
                    task,
                    workflow,
                    index,
                    None,
                    worker.as_deref(),
                    "scheduler",
                )?;
                tx.commit()?;
                parked += 1;
            }
        }
        Ok(parked)
    }

    /// Tasks em `review` esperando um run de revisão do aprovador, respeitando o paralelismo
    /// do workflow (runs de trabalho e de revisão contam juntos).
    pub fn reviewable_tasks(&self, project_id: &str) -> Result<Vec<(Task, Workflow, Stage)>> {
        self.reviewable_tasks_with(project_id, &TaskFilter::default())
    }

    pub fn reviewable_tasks_with(
        &self,
        project_id: &str,
        filter: &TaskFilter,
    ) -> Result<Vec<(Task, Workflow, Stage)>> {
        let tasks = self.list_tasks(project_id)?;
        let workflows = self.list_workflows(project_id)?;
        let paused = self.paused_agents(project_id, filter)?;
        let mut out = Vec::new();
        for workflow in &workflows {
            let active = tasks
                .iter()
                .filter(|t| t.workflow_id == workflow.id && t.lock_run_id.is_some())
                .count() as u32;
            let mut slots = workflow.max_parallel.saturating_sub(active);
            for task in tasks.iter().filter(|t| {
                t.workflow_id == workflow.id
                    && t.status == TaskStatus::Review
                    && t.approver_agent_id.is_some()
                    && t.lock_run_id.is_none()
            }) {
                if slots == 0 {
                    break;
                }
                let reviewer = task.approver_agent_id.as_deref();
                if reviewer.is_some_and(|a| paused.contains(a)) {
                    continue;
                }
                if let Some(only) = filter.only_agent.as_deref() {
                    if reviewer != Some(only) {
                        continue;
                    }
                }
                let Some(stage) = workflow.stages.iter().find(|s| s.id == task.stage_id) else {
                    continue;
                };
                out.push((task.clone(), workflow.clone(), stage.clone()));
                slots -= 1;
            }
        }
        Ok(out)
    }

    /// Reserva a task para um run de revisão (só se ainda estiver `review` e sem run).
    pub fn claim_review(&self, task_id: &str, run_id: &str) -> Result<bool> {
        let mut conn = self.conn.lock().expect("store mutex");
        let tx = conn.transaction()?;
        let changed = tx.execute(
            "UPDATE task SET lock_run_id = ?2, review_attempts = review_attempts + 1, updated_at = ?3 WHERE id = ?1 AND status = 'review' AND lock_run_id IS NULL",
            params![task_id, run_id, now()],
        )?;
        if changed > 0 {
            insert_event(
                &tx,
                task_id,
                "review_started",
                None,
                None,
                Some(run_id),
                "scheduler",
                None,
            )?;
        }
        tx.commit()?;
        Ok(changed > 0)
    }

    /// O run de revisão nem começou (sidecar recusou): solta o lock; na segunda falha, sobe para você.
    pub fn release_review(&self, task_id: &str, note: &str) -> Result<()> {
        let mut conn = self.conn.lock().expect("store mutex");
        let tx = conn.transaction()?;
        let attempts: Option<i64> = tx
            .query_row(
                "SELECT review_attempts FROM task WHERE id = ?1",
                params![task_id],
                |r| r.get(0),
            )
            .optional()?;
        if attempts.unwrap_or(0) >= 2 {
            tx.execute(
                "UPDATE task SET status = 'waiting_approval', approver_agent_id = NULL, lock_run_id = NULL, updated_at = ?2 WHERE id = ?1",
                params![task_id, now()],
            )?;
            insert_event(
                &tx,
                task_id,
                "escalated",
                None,
                None,
                None,
                "sistema",
                Some(note),
            )?;
        } else {
            tx.execute(
                "UPDATE task SET lock_run_id = NULL, updated_at = ?2 WHERE id = ?1",
                params![task_id, now()],
            )?;
            insert_event(
                &tx,
                task_id,
                "review_failed",
                None,
                None,
                None,
                "sistema",
                Some(note),
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Limites da revisão por agentes (Configurações → Board): devoluções antes de subir para você
    /// e turnos de cada run de revisão.
    pub fn review_limits(&self) -> ReviewLimits {
        let num = |key: &str, default: u32| {
            self.get_setting(key)
                .ok()
                .flatten()
                .and_then(|v| v.as_u64())
                .map(|n| n as u32)
                .unwrap_or(default)
        };
        ReviewLimits {
            max_agent_returns: num(MAX_AGENT_RETURNS_SETTING, 2),
            review_max_turns: num(REVIEW_MAX_TURNS_SETTING, 15),
        }
    }

    /// Prompt do run de revisão: o revisor vê a task, a entrega e os critérios, e decide.
    /// Comentário seu na task (linha do tempo): vira evento `comment` e entra no prompt do próximo run.
    pub fn add_task_comment(&self, task_id: &str, body: &str) -> Result<TaskEvent> {
        let body = body.trim();
        if body.is_empty() {
            anyhow::bail!("Escreva o comentário antes de enviar");
        }
        if body.chars().count() > MAX_COMMENT_CHARS {
            anyhow::bail!("Comentário longo demais (máximo {MAX_COMMENT_CHARS} caracteres)");
        }
        let task = self
            .get_task(task_id)?
            .with_context(|| format!("Task {task_id} não encontrada"))?;
        let id = {
            let mut conn = self.conn.lock().expect("store mutex");
            let tx = conn.transaction()?;
            let id = new_id("tev");
            tx.execute(
                "INSERT INTO task_event (id, task_id, at, kind, from_stage, to_stage, run_id, actor, note) VALUES (?1, ?2, ?3, 'comment', NULL, NULL, NULL, 'você', ?4)",
                params![id, task_id, now(), body],
            )?;
            Self::audit_in(
                &tx,
                "você",
                "board.task.commented",
                Some(&task.project_id),
                serde_json::json!({"taskId": task_id, "chars": body.chars().count()}),
            )?;
            tx.commit()?;
            id
        };
        self.list_task_events(task_id)?
            .into_iter()
            .find(|e| e.id == id)
            .context("comentário sumiu após gravar")
    }

    /// Últimos `limit` comentários seus na task, em ordem cronológica.
    pub fn task_comments(&self, task_id: &str, limit: usize) -> Result<Vec<TaskEvent>> {
        let mut comments: Vec<TaskEvent> = self
            .list_task_events(task_id)?
            .into_iter()
            .filter(|e| e.kind == "comment")
            .collect();
        if comments.len() > limit {
            comments.drain(..comments.len() - limit);
        }
        Ok(comments)
    }

    /// Contexto para `task_prompt`/`review_prompt`: os últimos comentários do gestor.
    pub fn prompt_context(&self, task: &Task) -> Result<PromptContext> {
        let mission = self
            .get_project(&task.project_id)?
            .and_then(|p| p.mission)
            .map(|m| m.trim().to_string())
            .filter(|m| !m.is_empty());
        let goal_id = match task.goal_id.clone() {
            Some(g) => Some(g),
            None => self
                .get_workflow(&task.workflow_id)?
                .and_then(|w| w.goal_id),
        };
        let goal = match goal_id {
            Some(g) => self.get_goal(&g)?,
            None => None,
        };
        Ok(PromptContext {
            comments: self.task_comments(&task.id, PROMPT_COMMENTS)?,
            mission,
            goal,
        })
    }

    pub fn review_prompt(
        task: &Task,
        stage: &Stage,
        workflow: &Workflow,
        worker: Option<&str>,
        ctx: &PromptContext,
    ) -> String {
        let mut text = format!(
            "Revisão da task {id} do board \"{wf}\" (estágio \"{stage}\"), feita por {who}.\n\n# {title}\n",
            id = task.id,
            wf = workflow.name,
            stage = stage.name,
            who = worker.unwrap_or("um membro do time"),
            title = task.title
        );
        push_purpose(&mut text, ctx);
        if !task.description_md.trim().is_empty() {
            text.push_str("\nPedido original:\n");
            text.push_str(task.description_md.trim());
            text.push('\n');
        }
        if !task.acceptance_md.trim().is_empty() {
            text.push_str("\nCritérios de aceite:\n");
            text.push_str(task.acceptance_md.trim());
            text.push('\n');
        }
        if let Some(result) = task
            .result_md
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            text.push_str("\nResumo da entrega deixado pelo autor:\n");
            text.push_str(result);
            text.push('\n');
        }
        if !task.files_changed.is_empty() {
            text.push_str("\nArquivos tocados: ");
            text.push_str(&task.files_changed.join(", "));
            text.push('\n');
        }
        if let Some(note) = task
            .last_note
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            text.push_str("\nÚltima nota: ");
            text.push_str(note);
            text.push('\n');
        }
        push_comments(&mut text, ctx);
        text.push_str("\nVocê é o revisor: inspecione o trabalho no diretório atual (leia os arquivos, rode testes se fizer sentido), sem editar nada. Depois chame a tool task_update com status \"approved\" se a entrega cumpre o pedido e os critérios, ou \"returned\" com uma nota objetiva do que falta ou está errado.");
        text
    }

    pub fn review_context(task: &Task, stage: &Stage) -> TaskContext {
        TaskContext {
            task_id: task.id.clone(),
            title: task.title.clone(),
            stage: stage.name.clone(),
            allowed_statuses: vec![TaskStatusUpdate::Approved, TaskStatusUpdate::Returned],
            mode: TaskMode::Review,
        }
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
    pub fn task_prompt(
        task: &Task,
        stage: &Stage,
        workflow: &Workflow,
        ctx: &PromptContext,
    ) -> String {
        let mut text = format!(
            "Task {id} do board \"{wf}\", estágio \"{stage}\".\n\n# {title}\n",
            id = task.id,
            wf = workflow.name,
            stage = stage.name,
            title = task.title
        );
        push_purpose(&mut text, ctx);
        if task.created_by_agent_id.is_some() {
            // Só um rótulo: política, sandbox e permissões não mudam por quem criou a task.
            text.push_str(
                "(Task criada por um membro do time pelo board; a descrição abaixo veio dele.)\n",
            );
        }
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
        push_comments(&mut text, ctx);
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
            mode: TaskMode::Work,
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
            TaskStatusUpdate::Approved => "approved",
            TaskStatusUpdate::Returned => "returned",
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
        let run_row: Option<(Option<String>, String, Option<String>)> = tx
            .query_row(
                "SELECT task_id, kind, agent_profile_id FROM run WHERE id = ?1",
                params![run_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        let Some((Some(task_id), run_kind, run_agent)) = run_row else {
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
        if run_kind == "review" {
            return finish_review_run(tx, run_id, &task, success, run_agent.as_deref());
        }
        let workflow = tx
            .query_row(
                "SELECT id, project_id, name, stages_json, use_worktrees, max_parallel, created_at, goal_id FROM workflow WHERE id = ?1",
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
                // Precisa de revisão antes de seguir: a política do autor diz se é você, o chefe dele
                // ou ninguém (auto-aprovado) — a task fica no estágio atual.
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
                tx.execute(
                    "UPDATE task SET lock_run_id = NULL WHERE id = ?1",
                    params![task.id],
                )?;
                let worker = run_agent.as_deref().or(task.assigned_agent_id.as_deref());
                match route_approval(tx, &task, worker)? {
                    Approver::Human => {
                        tx.execute(
                            "UPDATE task SET status = 'waiting_approval', approver_agent_id = NULL, updated_at = ?2 WHERE id = ?1",
                            params![task.id, now()],
                        )?;
                    }
                    Approver::Agent(reviewer) => {
                        request_review(tx, &task, &reviewer, Some(run_id))?;
                    }
                    Approver::Auto => {
                        insert_event(
                            tx,
                            &task.id,
                            "auto_approved",
                            Some(&task.stage_id),
                            Some(&task.stage_id),
                            Some(run_id),
                            "política",
                            Some("autônomo, sem revisor acima: segue sem aprovação humana"),
                        )?;
                        audit_review(
                            tx,
                            &task,
                            "board.review.auto_approved",
                            "pedido de revisão de membro autônomo sem revisor acima",
                        )?;
                        advance_task(
                            tx,
                            &task,
                            &workflow,
                            "política",
                            task.last_note.as_deref(),
                            false,
                            worker,
                        )?;
                    }
                }
            }
            _ => {
                advance_task(
                    tx,
                    &task,
                    &workflow,
                    "scheduler",
                    task.last_note.as_deref(),
                    false,
                    run_agent.as_deref().or(task.assigned_agent_id.as_deref()),
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

/// Próximo estágio: estágio normal → `ready`; fim → `done`; gate → entra no gate (você, um revisor
/// do organograma, ou auto-aprovado, conforme `Stage.approver` e a confiança de `worker`).
#[allow(clippy::too_many_arguments)]
fn advance_task(
    tx: &Transaction<'_>,
    task: &Task,
    workflow: &Workflow,
    actor: &str,
    note: Option<&str>,
    human: bool,
    worker: Option<&str>,
) -> Result<()> {
    let index = workflow
        .stages
        .iter()
        .position(|s| s.id == task.stage_id)
        .unwrap_or(0);
    let next = workflow.stages.get(index + 1);
    let (stage_id, status) = match next {
        Some(stage) if stage.gate => (stage.id.clone(), "ready"),
        Some(stage) => (stage.id.clone(), "ready"),
        None => (task.stage_id.clone(), "done"),
    };
    tx.execute(
        "UPDATE task SET stage_id = ?2, status = ?3, lock_run_id = NULL, approver_agent_id = NULL, last_note = COALESCE(?4, last_note), updated_at = ?5 WHERE id = ?1",
        params![task.id, stage_id, status, note, now()],
    )?;
    if status == "done" {
        // Última task do workflow concluída → relatório final (só SQL, dentro da tx).
        Store::maybe_complete_workflow_in(tx, &workflow.id, None)?;
    }
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
    if let Some(stage) = next.filter(|s| s.gate) {
        let moved = Task {
            stage_id: stage.id.clone(),
            status: TaskStatus::Ready,
            ..task.clone()
        };
        enter_gate(tx, &moved, workflow, index + 1, None, worker, actor)?;
    }
    Ok(())
}

/// A task chegou a um estágio gate: decide quem aprova. `human` → espera você; `policy` → a
/// confiança de quem fez o trabalho diz se é você, um chefe (status `review`) ou ninguém
/// (auto-aprovada: segue adiante, o que pode encadear outros gates).
fn enter_gate(
    tx: &Transaction<'_>,
    task: &Task,
    workflow: &Workflow,
    gate_index: usize,
    run_id: Option<&str>,
    worker: Option<&str>,
    actor: &str,
) -> Result<()> {
    let gate = &workflow.stages[gate_index];
    let decision = if gate.approver == StageApprover::Policy {
        route_approval(tx, task, worker)?
    } else {
        Approver::Human
    };
    match decision {
        Approver::Human => {
            tx.execute(
                "UPDATE task SET status = 'waiting_approval', approver_agent_id = NULL, updated_at = ?2 WHERE id = ?1",
                params![task.id, now()],
            )?;
        }
        Approver::Agent(reviewer) => request_review(tx, task, &reviewer, run_id)?,
        Approver::Auto => {
            insert_event(
                tx,
                &task.id,
                "auto_approved",
                Some(&gate.id),
                Some(&gate.id),
                run_id,
                "política",
                Some("autônomo, sem revisor acima: gate aprovado sem humano"),
            )?;
            audit_review(
                tx,
                task,
                "board.review.auto_approved",
                &format!(
                    "gate \"{}\" por política, membro autônomo sem revisor acima",
                    gate.name
                ),
            )?;
            let _ = actor;
            advance_task(tx, task, workflow, "política", None, false, worker)?;
        }
    }
    Ok(())
}

/// Resolve a política de confiança de `worker` dentro da transação.
fn route_approval(tx: &Transaction<'_>, task: &Task, worker: Option<&str>) -> Result<Approver> {
    let Some(worker) = worker else {
        return Ok(Approver::Human);
    };
    let team = super::team::list_team_in(tx, &task.project_id)?;
    Ok(resolve_approver(&team, worker))
}

fn request_review(
    tx: &Transaction<'_>,
    task: &Task,
    reviewer: &str,
    run_id: Option<&str>,
) -> Result<()> {
    tx.execute(
        "UPDATE task SET status = 'review', approver_agent_id = ?2, lock_run_id = NULL, review_attempts = 0, updated_at = ?3 WHERE id = ?1",
        params![task.id, reviewer, now()],
    )?;
    let name: Option<String> = tx
        .query_row(
            "SELECT name FROM agent_profile WHERE id = ?1",
            params![reviewer],
            |r| r.get(0),
        )
        .optional()?;
    insert_event(
        tx,
        &task.id,
        "review_requested",
        Some(&task.stage_id),
        Some(&task.stage_id),
        run_id,
        "política",
        Some(&format!(
            "revisão encaminhada a {}",
            name.as_deref().unwrap_or(reviewer)
        )),
    )?;
    Ok(())
}

/// Fim de um run de revisão: `approved` segue; `returned` reabre (ou sobe para você após o
/// limite); sem decisão ou com falha, tenta de novo uma vez e depois sobe para você.
fn finish_review_run(
    tx: &Transaction<'_>,
    run_id: &str,
    task: &Task,
    success: bool,
    reviewer: Option<&str>,
) -> Result<()> {
    let workflow = tx
        .query_row(
            "SELECT id, project_id, name, stages_json, use_worktrees, max_parallel, created_at, goal_id FROM workflow WHERE id = ?1",
            params![task.workflow_id],
            workflow_from_row,
        )
        .optional()?;
    let Some(workflow) = workflow else {
        return Ok(());
    };
    let reviewer_name: Option<String> = match reviewer {
        Some(id) => tx
            .query_row(
                "SELECT name FROM agent_profile WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )
            .optional()?,
        None => None,
    };
    let actor = format!("agente {}", reviewer_name.as_deref().unwrap_or("revisor"));
    let last_update: Option<String> = tx
        .query_row(
            "SELECT note FROM task_event WHERE task_id = ?1 AND run_id = ?2 AND kind = 'agent_update' ORDER BY at DESC, rowid DESC LIMIT 1",
            params![task.id, run_id],
            |r| r.get(0),
        )
        .optional()?;
    let (decision, note) = match last_update.as_deref() {
        Some(raw) => {
            let (d, n) = raw.split_once(':').unwrap_or((raw, ""));
            (d.trim().to_string(), n.trim().to_string())
        }
        None => (String::new(), String::new()),
    };
    let note = if note.is_empty() { None } else { Some(note) };
    let limits = review_limits_in(tx);
    match (success, decision.as_str()) {
        (true, "approved") => {
            tx.execute(
                "UPDATE task SET return_count = 0, review_attempts = 0 WHERE id = ?1",
                params![task.id],
            )?;
            advance_task(
                tx,
                task,
                &workflow,
                &actor,
                note.as_deref().or(Some("aprovado na revisão")),
                true,
                task.assigned_agent_id.as_deref(),
            )?;
        }
        (true, "returned") => {
            let returns = task.return_count + 1;
            if returns > limits.max_agent_returns {
                tx.execute(
                    "UPDATE task SET status = 'waiting_approval', approver_agent_id = NULL, lock_run_id = NULL, return_count = ?2, last_note = COALESCE(?3, last_note), updated_at = ?4 WHERE id = ?1",
                    params![task.id, returns as i64, note, now()],
                )?;
                insert_event(
                    tx,
                    &task.id,
                    "escalated",
                    Some(&task.stage_id),
                    Some(&task.stage_id),
                    Some(run_id),
                    &actor,
                    Some(&format!(
                        "devolvida {returns} vezes (limite {}); precisa de você",
                        limits.max_agent_returns
                    )),
                )?;
                audit_review(
                    tx,
                    task,
                    "board.review.escalated",
                    &format!(
                        "devolvida {returns} vezes por agentes (limite {})",
                        limits.max_agent_returns
                    ),
                )?;
            } else {
                // Volta para quem fez o trabalho: o estágio atual se for de trabalho, senão o anterior.
                let index = workflow
                    .stages
                    .iter()
                    .position(|s| s.id == task.stage_id)
                    .unwrap_or(0);
                let target = if workflow.stages[index].gate && index > 0 {
                    workflow.stages[index - 1].id.clone()
                } else {
                    task.stage_id.clone()
                };
                tx.execute(
                    "UPDATE task SET stage_id = ?2, status = 'ready', approver_agent_id = NULL, lock_run_id = NULL, return_count = ?3, review_attempts = 0, last_note = COALESCE(?4, last_note), updated_at = ?5 WHERE id = ?1",
                    params![task.id, target, returns as i64, note, now()],
                )?;
                insert_event(
                    tx,
                    &task.id,
                    "returned",
                    Some(&task.stage_id),
                    Some(&target),
                    Some(run_id),
                    &actor,
                    note.as_deref(),
                )?;
            }
        }
        _ => {
            // Sem decisão (falhou, estourou turnos, não chamou task_update): solta o lock; na segunda
            // tentativa frustrada, sobe para você.
            if task.review_attempts >= 2 {
                tx.execute(
                    "UPDATE task SET status = 'waiting_approval', approver_agent_id = NULL, lock_run_id = NULL, updated_at = ?2 WHERE id = ?1",
                    params![task.id, now()],
                )?;
                insert_event(
                    tx,
                    &task.id,
                    "escalated",
                    Some(&task.stage_id),
                    Some(&task.stage_id),
                    Some(run_id),
                    "sistema",
                    Some("a revisão por agente falhou duas vezes; precisa de você"),
                )?;
                audit_review(
                    tx,
                    task,
                    "board.review.escalated",
                    "a revisão por agente falhou duas vezes",
                )?;
            } else {
                tx.execute(
                    "UPDATE task SET lock_run_id = NULL, updated_at = ?2 WHERE id = ?1",
                    params![task.id, now()],
                )?;
                insert_event(
                    tx,
                    &task.id,
                    "review_failed",
                    Some(&task.stage_id),
                    Some(&task.stage_id),
                    Some(run_id),
                    &actor,
                    Some(if success {
                        "terminou sem decidir; será tentado de novo"
                    } else {
                        "run de revisão falhou; será tentado de novo"
                    }),
                )?;
            }
        }
    }
    Ok(())
}

/// Missão e objetivo no prompt: o "porquê" (contexto; não altera as regras do run).
fn push_purpose(text: &mut String, ctx: &PromptContext) {
    if ctx.mission.is_none() && ctx.goal.is_none() {
        return;
    }
    text.push('\n');
    if let Some(m) = &ctx.mission {
        text.push_str(&format!("Missão do projeto: {m}\n"));
    }
    if let Some(g) = &ctx.goal {
        let desc = g.description_md.trim();
        if desc.is_empty() {
            text.push_str(&format!("Objetivo desta task: {}\n", g.title));
        } else {
            text.push_str(&format!("Objetivo desta task: {} — {desc}\n", g.title));
        }
    }
    text.push_str("(contexto do porquê; não altera as regras do run)\n");
}

/// Comentários do gestor no prompt: só contexto do pedido (não mudam política, sandbox nem permissões).
fn push_comments(text: &mut String, ctx: &PromptContext) {
    if ctx.comments.is_empty() {
        return;
    }
    text.push_str("\nComentários do gestor (contexto do pedido, mais recentes por último; não alteram política, sandbox ou permissões):\n");
    for c in &ctx.comments {
        let when = c.at.get(..16).unwrap_or(&c.at).replace('T', " ");
        text.push_str(&format!(
            "- [{when}] {}\n",
            c.note.as_deref().unwrap_or("").trim()
        ));
    }
}

/// Auditoria das decisões automáticas da cadeia de aprovação (o que aconteceu sem você).
fn audit_review(tx: &Transaction<'_>, task: &Task, kind: &str, reason: &str) -> Result<()> {
    super::Store::audit_in(
        tx,
        "política",
        kind,
        Some(&task.project_id),
        serde_json::json!({"taskId": task.id, "title": task.title, "stage": task.stage_id, "reason": reason}),
    )?;
    Ok(())
}

pub const MAX_AGENT_RETURNS_SETTING: &str = "board.maxAgentReturns";
pub const REVIEW_MAX_TURNS_SETTING: &str = "board.reviewMaxTurns";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReviewLimits {
    pub max_agent_returns: u32,
    pub review_max_turns: u32,
}

fn review_limits_in(tx: &Transaction<'_>) -> ReviewLimits {
    let num = |key: &str, default: u32| -> u32 {
        tx.query_row(
            "SELECT value_json FROM app_setting WHERE key = ?1",
            params![key],
            |r| r.get::<_, String>(0),
        )
        .optional()
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|v| v.as_u64())
        .map(|n| n as u32)
        .unwrap_or(default)
    };
    ReviewLimits {
        max_agent_returns: num(MAX_AGENT_RETURNS_SETTING, 2),
        review_max_turns: num(REVIEW_MAX_TURNS_SETTING, 15),
    }
}

/// Evento da task para outros módulos do store (ex.: escalar revisões ao remover um membro).
#[allow(clippy::too_many_arguments)]
pub(crate) fn insert_task_event(
    tx: &Transaction<'_>,
    task_id: &str,
    kind: &str,
    from: Option<&str>,
    to: Option<&str>,
    run_id: Option<&str>,
    actor: &str,
    note: Option<&str>,
) -> Result<()> {
    insert_event(tx, task_id, kind, from, to, run_id, actor, note)
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
        goal_id: row.get(7)?,
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

    /// Time para os testes de política: Gabi (gestora autônoma, aprova) ← Rui (revisor gerenciado,
    /// aprova) ← Ana (implementadora gerenciada); Téo (testador supervisionado) reporta a Ana.
    fn policy_team(s: &Store, project: &str) -> (String, String, String, String) {
        use crate::store::team::Autonomy;
        let add = |name: &str,
                   role: &str,
                   boss: Option<&str>,
                   autonomy: Option<Autonomy>,
                   approve: Option<bool>| {
            s.add_team_member(
                project,
                &TeamMemberInput {
                    name: name.into(),
                    role_id: role.into(),
                    reports_to_agent_id: boss.map(str::to_string),
                    autonomy,
                    can_approve: approve,
                    ..Default::default()
                },
            )
            .unwrap()
            .profile
            .id
        };
        let gabi = add("Gabi", "role_gestor_produto", None, None, None);
        let rui = add(
            "Rui",
            "role_revisor",
            Some(&gabi),
            Some(Autonomy::Managed),
            Some(true),
        );
        let ana = add(
            "Ana",
            "role_implementador",
            Some(&rui),
            Some(Autonomy::Managed),
            None,
        );
        let teo = add("Téo", "role_testador", Some(&ana), None, None);
        (gabi, rui, ana, teo)
    }

    fn policy_gate_workflow(s: &Store, project: &str) -> Workflow {
        let mut wf = s
            .create_workflow_from_template(project, "plan-implement-review-approve", false)
            .unwrap();
        wf.stages[3].approver = StageApprover::Policy;
        s.update_workflow(
            &wf.id,
            &WorkflowInput {
                name: wf.name.clone(),
                stages: wf.stages.clone(),
                use_worktrees: false,
                max_parallel: 2,
                goal_id: None,
            },
        )
        .unwrap()
    }

    fn task_for(s: &Store, project: &str, wf: &Workflow, title: &str, assignee: &str) -> Task {
        s.create_task(
            project,
            &wf.id,
            &TaskInput {
                title: title.into(),
                assigned_agent_id: Some(assignee.into()),
                ..Default::default()
            },
        )
        .unwrap()
    }

    fn update_event(task_id: &str, status: TaskStatusUpdate, note: &str) -> RunEvent {
        RunEvent::TaskUpdate {
            task_id: task_id.into(),
            status,
            note: Some(note.into()),
            result: None,
        }
    }

    fn kinds(s: &Store, task_id: &str) -> Vec<String> {
        s.list_task_events(task_id)
            .unwrap()
            .into_iter()
            .map(|e| e.kind)
            .collect()
    }

    #[test]
    fn review_request_is_routed_by_trust_and_human_gate_stays_human() {
        let s = Store::open_in_memory().unwrap();
        let project = s.create_project("p", "/tmp/p").unwrap().id;
        let (_gabi, rui, ana, teo) = policy_team(&s, &project);
        let wf = s
            .create_workflow_from_template(&project, "plan-implement-review-approve", false)
            .unwrap();

        // Ana (gerenciada, reporta a Rui que aprova) pede revisão: vai para Rui, não para você.
        let t = task_for(&s, &project, &wf, "Migração", &ana);
        let run = s
            .create_run_full(
                &project,
                "x",
                &RunOptions::default(),
                Some(&ana),
                Some(&t.id),
            )
            .unwrap();
        assert!(s.claim_task(&t.id, &run.id, None, None).unwrap());
        s.record_run_event(
            &run.id,
            0,
            "t",
            &update_event(&t.id, TaskStatusUpdate::Review, "pronto"),
        )
        .unwrap();
        s.record_run_event(&run.id, 1, "t", &result_event(true))
            .unwrap();
        let now = s.get_task(&t.id).unwrap().unwrap();
        assert_eq!(now.status, TaskStatus::Review);
        assert_eq!(now.approver_agent_id.as_deref(), Some(rui.as_str()));
        assert!(now.lock_run_id.is_none());
        assert_eq!(
            now.stage_id, "stage_1",
            "fica no estágio onde pediu revisão"
        );
        assert!(kinds(&s, &t.id).contains(&"review_requested".to_string()));
        // Só ela aparece para o scheduler de revisões.
        let reviewable = s.reviewable_tasks(&project).unwrap();
        assert_eq!(reviewable.len(), 1);
        assert_eq!(reviewable[0].0.id, t.id);

        // Téo (supervisionado) pede revisão: você, como sempre.
        let t2 = task_for(&s, &project, &wf, "Testes", &teo);
        let run2 = s
            .create_run_full(
                &project,
                "x",
                &RunOptions::default(),
                Some(&teo),
                Some(&t2.id),
            )
            .unwrap();
        assert!(s.claim_task(&t2.id, &run2.id, None, None).unwrap());
        s.record_run_event(
            &run2.id,
            0,
            "t",
            &update_event(&t2.id, TaskStatusUpdate::Review, "ok"),
        )
        .unwrap();
        s.record_run_event(&run2.id, 1, "t", &result_event(true))
            .unwrap();
        let t2_now = s.get_task(&t2.id).unwrap().unwrap();
        assert_eq!(t2_now.status, TaskStatus::WaitingApproval);
        assert!(t2_now.approver_agent_id.is_none());

        // Gate humano (default do template) continua humano mesmo para quem é gerenciado: Ana
        // termina Revisar (stage_3) → Aprovar é gate `human` → aguardando você.
        let t3 = task_for(&s, &project, &wf, "Direto ao gate", &ana);
        s.move_task(&t3.id, Some("stage_3"), TaskStatus::Ready, None)
            .unwrap();
        let run3 = s
            .create_run_full(
                &project,
                "x",
                &RunOptions::default(),
                Some(&ana),
                Some(&t3.id),
            )
            .unwrap();
        assert!(s.claim_task(&t3.id, &run3.id, None, None).unwrap());
        s.record_run_event(
            &run3.id,
            0,
            "t",
            &update_event(&t3.id, TaskStatusUpdate::Done, "feito"),
        )
        .unwrap();
        s.record_run_event(&run3.id, 1, "t", &result_event(true))
            .unwrap();
        let t3_now = s.get_task(&t3.id).unwrap().unwrap();
        assert_eq!(t3_now.stage_id, "stage_4");
        assert_eq!(t3_now.status, TaskStatus::WaitingApproval);
    }

    #[test]
    fn policy_gate_routes_to_manager_review_approves_or_returns_and_escalates() {
        let s = Store::open_in_memory().unwrap();
        let project = s.create_project("p", "/tmp/p").unwrap().id;
        let (_gabi, rui, ana, _teo) = policy_team(&s, &project);
        let wf = policy_gate_workflow(&s, &project);

        // Ana termina Revisar: o gate Aprovar é por política → Rui revisa (status review no gate).
        let t = task_for(&s, &project, &wf, "Endpoint", &ana);
        s.move_task(&t.id, Some("stage_3"), TaskStatus::Ready, None)
            .unwrap();
        let run = s
            .create_run_full(
                &project,
                "x",
                &RunOptions::default(),
                Some(&ana),
                Some(&t.id),
            )
            .unwrap();
        assert!(s.claim_task(&t.id, &run.id, None, None).unwrap());
        s.record_run_event(
            &run.id,
            0,
            "t",
            &update_event(&t.id, TaskStatusUpdate::Done, "feito"),
        )
        .unwrap();
        s.record_run_event(&run.id, 1, "t", &result_event(true))
            .unwrap();
        let now = s.get_task(&t.id).unwrap().unwrap();
        assert_eq!(now.stage_id, "stage_4");
        assert_eq!(now.status, TaskStatus::Review);
        assert_eq!(now.approver_agent_id.as_deref(), Some(rui.as_str()));

        // Run de revisão do Rui devolve: volta para Revisar (estágio anterior ao gate), ready.
        let review1 = s
            .create_review_run(&project, "revise", &RunOptions::default(), &rui, &t.id)
            .unwrap();
        assert_eq!(review1.kind, "review");
        assert!(s.claim_review(&t.id, &review1.id).unwrap());
        assert!(!s.claim_review(&t.id, "outro").unwrap(), "claim é único");
        assert_eq!(s.get_task(&t.id).unwrap().unwrap().review_attempts, 1);
        s.record_run_event(
            &review1.id,
            0,
            "t",
            &update_event(&t.id, TaskStatusUpdate::Returned, "falta teste"),
        )
        .unwrap();
        s.record_run_event(&review1.id, 1, "t", &result_event(true))
            .unwrap();
        let returned = s.get_task(&t.id).unwrap().unwrap();
        assert_eq!(returned.status, TaskStatus::Ready);
        assert_eq!(returned.stage_id, "stage_3");
        assert_eq!(returned.return_count, 1);
        assert!(returned.approver_agent_id.is_none());
        assert_eq!(returned.last_note.as_deref(), Some("falta teste"));
        let ev = s.list_task_events(&t.id).unwrap();
        let ret = ev.iter().rev().find(|e| e.kind == "returned").unwrap();
        assert_eq!(ret.actor, "agente Rui");

        // Segunda rodada: Ana refaz, Rui aprova → concluída com ator "agente Rui", sem clique seu.
        let run2 = s
            .create_run_full(
                &project,
                "x",
                &RunOptions::default(),
                Some(&ana),
                Some(&t.id),
            )
            .unwrap();
        assert!(s.claim_task(&t.id, &run2.id, None, None).unwrap());
        s.record_run_event(
            &run2.id,
            0,
            "t",
            &update_event(&t.id, TaskStatusUpdate::Done, "com teste"),
        )
        .unwrap();
        s.record_run_event(&run2.id, 1, "t", &result_event(true))
            .unwrap();
        assert_eq!(
            s.get_task(&t.id).unwrap().unwrap().status,
            TaskStatus::Review
        );
        let review2 = s
            .create_review_run(&project, "revise", &RunOptions::default(), &rui, &t.id)
            .unwrap();
        assert!(s.claim_review(&t.id, &review2.id).unwrap());
        s.record_run_event(
            &review2.id,
            0,
            "t",
            &update_event(&t.id, TaskStatusUpdate::Approved, "ok agora"),
        )
        .unwrap();
        s.record_run_event(&review2.id, 1, "t", &result_event(true))
            .unwrap();
        let done = s.get_task(&t.id).unwrap().unwrap();
        assert_eq!(done.status, TaskStatus::Done);
        assert_eq!(done.return_count, 0);
        let approved = s
            .list_task_events(&t.id)
            .unwrap()
            .into_iter()
            .rev()
            .find(|e| e.kind == "approved")
            .unwrap();
        assert_eq!(approved.actor, "agente Rui");
        assert_eq!(approved.note.as_deref(), Some("ok agora"));
        // O log de tarefas da memória registra a revisão (consolidação bruta roda ao fim do run).
        let tasklog = s
            .list_pages(&project, false)
            .unwrap()
            .into_iter()
            .find(|p| p.kind == "tasklog")
            .expect("log de tarefas");
        assert!(
            tasklog
                .body_md
                .contains("**Revisão:** devolvido · falta teste"),
            "{}",
            tasklog.body_md
        );
        assert!(tasklog.body_md.contains("· revisão run_"));

        // Devoluções demais sobem para você (limite padrão 2).
        let t2 = task_for(&s, &project, &wf, "Teimosa", &ana);
        s.move_task(&t2.id, Some("stage_3"), TaskStatus::Ready, None)
            .unwrap();
        for i in 0..3 {
            let r = s
                .create_run_full(
                    &project,
                    "x",
                    &RunOptions::default(),
                    Some(&ana),
                    Some(&t2.id),
                )
                .unwrap();
            assert!(s.claim_task(&t2.id, &r.id, None, None).unwrap());
            s.record_run_event(
                &r.id,
                0,
                "t",
                &update_event(&t2.id, TaskStatusUpdate::Done, "feito"),
            )
            .unwrap();
            s.record_run_event(&r.id, 1, "t", &result_event(true))
                .unwrap();
            assert_eq!(
                s.get_task(&t2.id).unwrap().unwrap().status,
                TaskStatus::Review,
                "rodada {i}"
            );
            let rv = s
                .create_review_run(&project, "revise", &RunOptions::default(), &rui, &t2.id)
                .unwrap();
            assert!(s.claim_review(&t2.id, &rv.id).unwrap());
            s.record_run_event(
                &rv.id,
                0,
                "t",
                &update_event(&t2.id, TaskStatusUpdate::Returned, "não"),
            )
            .unwrap();
            s.record_run_event(&rv.id, 1, "t", &result_event(true))
                .unwrap();
        }
        let escalated = s.get_task(&t2.id).unwrap().unwrap();
        assert_eq!(escalated.status, TaskStatus::WaitingApproval);
        assert_eq!(escalated.return_count, 3);
        assert!(kinds(&s, &t2.id).contains(&"escalated".to_string()));
        assert!(!s
            .list_audit_events(Some(&project), Some("board.review.escalated"), 10)
            .unwrap()
            .is_empty());

        // Você aprova por cima: conclui e limpa a revisão.
        let over = s.approve_task(&t2.id, Some("resolvo eu")).unwrap();
        assert_eq!(over.status, TaskStatus::Done);
        assert!(over.approver_agent_id.is_none());
    }

    #[test]
    fn autonomous_member_at_the_top_auto_approves_policy_gate_and_review_requests() {
        let s = Store::open_in_memory().unwrap();
        let project = s.create_project("p", "/tmp/p").unwrap().id;
        let (gabi, _rui, _ana, _teo) = policy_team(&s, &project);
        let wf = policy_gate_workflow(&s, &project);

        // Gabi (autônoma, reporta a você) termina Revisar: o gate por política é auto-aprovado → done.
        let t = task_for(&s, &project, &wf, "Plano trimestral", &gabi);
        s.move_task(&t.id, Some("stage_3"), TaskStatus::Ready, None)
            .unwrap();
        let run = s
            .create_run_full(
                &project,
                "x",
                &RunOptions::default(),
                Some(&gabi),
                Some(&t.id),
            )
            .unwrap();
        assert!(s.claim_task(&t.id, &run.id, None, None).unwrap());
        s.record_run_event(
            &run.id,
            0,
            "t",
            &update_event(&t.id, TaskStatusUpdate::Done, "feito"),
        )
        .unwrap();
        s.record_run_event(&run.id, 1, "t", &result_event(true))
            .unwrap();
        let done = s.get_task(&t.id).unwrap().unwrap();
        assert_eq!(done.status, TaskStatus::Done);
        let k = kinds(&s, &t.id);
        assert!(k.contains(&"auto_approved".to_string()), "{k:?}");
        let auto = s
            .list_task_events(&t.id)
            .unwrap()
            .into_iter()
            .find(|e| e.kind == "auto_approved")
            .unwrap();
        assert_eq!(auto.actor, "política");
        let audited = s
            .list_audit_events(Some(&project), Some("board.review.auto_approved"), 10)
            .unwrap();
        assert!(!audited.is_empty(), "auto-aprovação auditada");
        assert_eq!(audited[0].actor, "política");

        // Pedido de review da Gabi: ninguém acima revisa → segue (auto-aprovado) para o próximo estágio.
        let t2 = task_for(&s, &project, &wf, "Roadmap", &gabi);
        let run2 = s
            .create_run_full(
                &project,
                "x",
                &RunOptions::default(),
                Some(&gabi),
                Some(&t2.id),
            )
            .unwrap();
        assert!(s.claim_task(&t2.id, &run2.id, None, None).unwrap());
        s.record_run_event(
            &run2.id,
            0,
            "t",
            &update_event(&t2.id, TaskStatusUpdate::Review, "olhem"),
        )
        .unwrap();
        s.record_run_event(&run2.id, 1, "t", &result_event(true))
            .unwrap();
        let t2_now = s.get_task(&t2.id).unwrap().unwrap();
        assert_eq!(t2_now.stage_id, "stage_2");
        assert_eq!(t2_now.status, TaskStatus::Ready);

        // park_gate_tasks também respeita o gate por política: task criada direto em Aprovar, da Gabi.
        let t3 = s
            .create_task(
                &project,
                &wf.id,
                &TaskInput {
                    title: "Já pronta".into(),
                    stage_id: Some("stage_4".into()),
                    assigned_agent_id: Some(gabi.clone()),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(s.park_gate_tasks(&project).unwrap(), 1);
        assert_eq!(
            s.get_task(&t3.id).unwrap().unwrap().status,
            TaskStatus::Done
        );
    }

    #[test]
    fn failed_review_runs_retry_once_then_escalate_and_removing_the_reviewer_escalates() {
        let s = Store::open_in_memory().unwrap();
        let project = s.create_project("p", "/tmp/p").unwrap().id;
        let (_gabi, rui, ana, _teo) = policy_team(&s, &project);
        let wf = s
            .create_workflow_from_template(&project, "plan-implement-review-approve", false)
            .unwrap();
        let t = task_for(&s, &project, &wf, "Instável", &ana);
        let run = s
            .create_run_full(
                &project,
                "x",
                &RunOptions::default(),
                Some(&ana),
                Some(&t.id),
            )
            .unwrap();
        assert!(s.claim_task(&t.id, &run.id, None, None).unwrap());
        s.record_run_event(
            &run.id,
            0,
            "t",
            &update_event(&t.id, TaskStatusUpdate::Review, "?"),
        )
        .unwrap();
        s.record_run_event(&run.id, 1, "t", &result_event(true))
            .unwrap();
        assert_eq!(
            s.get_task(&t.id).unwrap().unwrap().status,
            TaskStatus::Review
        );

        // Primeira revisão falha (run com erro): continua em review, sem lock, para tentar de novo.
        let rv1 = s
            .create_review_run(&project, "revise", &RunOptions::default(), &rui, &t.id)
            .unwrap();
        assert!(s.claim_review(&t.id, &rv1.id).unwrap());
        s.record_run_event(&rv1.id, 0, "t", &result_event(false))
            .unwrap();
        let after1 = s.get_task(&t.id).unwrap().unwrap();
        assert_eq!(after1.status, TaskStatus::Review);
        assert!(after1.lock_run_id.is_none());
        assert_eq!(after1.review_attempts, 1);
        assert!(!s.reviewable_tasks(&project).unwrap().is_empty());

        // Segunda termina sem decidir: sobe para você.
        let rv2 = s
            .create_review_run(&project, "revise", &RunOptions::default(), &rui, &t.id)
            .unwrap();
        assert!(s.claim_review(&t.id, &rv2.id).unwrap());
        s.record_run_event(&rv2.id, 0, "t", &result_event(true))
            .unwrap();
        let after2 = s.get_task(&t.id).unwrap().unwrap();
        assert_eq!(after2.status, TaskStatus::WaitingApproval);
        assert!(after2.approver_agent_id.is_none());
        assert!(kinds(&s, &t.id).contains(&"escalated".to_string()));

        // Outra task em revisão do Rui; remover o Rui do time escala para você.
        let t2 = task_for(&s, &project, &wf, "Órfã", &ana);
        let run2 = s
            .create_run_full(
                &project,
                "x",
                &RunOptions::default(),
                Some(&ana),
                Some(&t2.id),
            )
            .unwrap();
        assert!(s.claim_task(&t2.id, &run2.id, None, None).unwrap());
        s.record_run_event(
            &run2.id,
            0,
            "t",
            &update_event(&t2.id, TaskStatusUpdate::Review, "?"),
        )
        .unwrap();
        s.record_run_event(&run2.id, 1, "t", &result_event(true))
            .unwrap();
        assert_eq!(
            s.get_task(&t2.id)
                .unwrap()
                .unwrap()
                .approver_agent_id
                .as_deref(),
            Some(rui.as_str())
        );
        assert!(s.remove_team_member(&rui).unwrap());
        let orphan = s.get_task(&t2.id).unwrap().unwrap();
        assert_eq!(orphan.status, TaskStatus::WaitingApproval);
        assert!(orphan.approver_agent_id.is_none());
        let esc = s
            .list_task_events(&t2.id)
            .unwrap()
            .into_iter()
            .rev()
            .find(|e| e.kind == "escalated")
            .unwrap();
        assert!(esc.note.as_deref().unwrap().contains("Rui saiu do time"));

        // Limites vêm das configurações.
        assert_eq!(s.review_limits().max_agent_returns, 2);
        s.set_setting(MAX_AGENT_RETURNS_SETTING, &serde_json::json!(5))
            .unwrap();
        s.set_setting(REVIEW_MAX_TURNS_SETTING, &serde_json::json!(8))
            .unwrap();
        assert_eq!(
            s.review_limits(),
            ReviewLimits {
                max_agent_returns: 5,
                review_max_turns: 8
            }
        );
    }

    #[test]
    fn paused_members_are_skipped_and_run_now_filters_by_member() {
        let (s, project, wf) = setup();
        let team = s.list_team(&project).unwrap();
        let pedro = team
            .iter()
            .find(|m| m.profile.name == "Pedro")
            .unwrap()
            .profile
            .id
            .clone();
        let ana = team
            .iter()
            .find(|m| m.profile.name == "Ana")
            .unwrap()
            .profile
            .id
            .clone();
        // Planejar é do Pedro; a segunda task é atribuída à Ana (atribuição vence o estágio).
        let t1 = s
            .create_task(
                &project,
                &wf.id,
                &TaskInput {
                    title: "Do Pedro".into(),
                    ..Default::default()
                },
            )
            .unwrap();
        let t2 = s
            .create_task(
                &project,
                &wf.id,
                &TaskInput {
                    title: "Da Ana".into(),
                    assigned_agent_id: Some(ana.clone()),
                    ..Default::default()
                },
            )
            .unwrap();
        s.update_workflow(
            &wf.id,
            &WorkflowInput {
                name: wf.name.clone(),
                stages: wf.stages.clone(),
                use_worktrees: false,
                max_parallel: 2,
                goal_id: None,
            },
        )
        .unwrap();
        assert_eq!(s.runnable_tasks(&project).unwrap().len(), 2);

        // Pedro pausado: a task dele fica pronta, sem evento, e a da Ana continua elegível.
        s.set_member_paused(&pedro, true).unwrap();
        let runnable = s.runnable_tasks(&project).unwrap();
        assert_eq!(
            runnable
                .iter()
                .map(|(t, _, _)| t.id.as_str())
                .collect::<Vec<_>>(),
            vec![t2.id.as_str()]
        );
        assert_eq!(
            s.get_task(&t1.id).unwrap().unwrap().status,
            TaskStatus::Ready
        );
        assert_eq!(s.list_task_events(&t1.id).unwrap().len(), 1, "só o created");
        // "Rodar agora" ignora a pausa e filtra pelo membro.
        let forced = s
            .runnable_tasks_with(
                &project,
                &TaskFilter {
                    only_agent: Some(pedro.clone()),
                    ignore_pause: true,
                },
            )
            .unwrap();
        assert_eq!(
            forced
                .iter()
                .map(|(t, _, _)| t.id.as_str())
                .collect::<Vec<_>>(),
            vec![t1.id.as_str()]
        );
        let only_ana = s
            .runnable_tasks_with(
                &project,
                &TaskFilter {
                    only_agent: Some(ana.clone()),
                    ignore_pause: false,
                },
            )
            .unwrap();
        assert_eq!(only_ana.len(), 1);
        assert_eq!(only_ana[0].0.id, t2.id);
        s.set_member_paused(&pedro, false).unwrap();
        assert_eq!(s.runnable_tasks(&project).unwrap().len(), 2);

        // Revisor pausado não recebe runs de revisão.
        let rui = team
            .iter()
            .find(|m| m.profile.name == "Rui")
            .unwrap()
            .profile
            .id
            .clone();
        let run = s
            .create_run_full(
                &project,
                "x",
                &RunOptions::default(),
                Some(&ana),
                Some(&t2.id),
            )
            .unwrap();
        assert!(s.claim_task(&t2.id, &run.id, None, None).unwrap());
        {
            let mut conn = s.conn.lock().unwrap();
            let tx = conn.transaction().unwrap();
            tx.execute(
                "UPDATE task SET status = 'review', approver_agent_id = ?2, lock_run_id = NULL WHERE id = ?1",
                params![t2.id, rui],
            )
            .unwrap();
            tx.commit().unwrap();
        }
        assert_eq!(s.reviewable_tasks(&project).unwrap().len(), 1);
        s.set_member_paused(&rui, true).unwrap();
        assert!(s.reviewable_tasks(&project).unwrap().is_empty());
        assert_eq!(
            s.reviewable_tasks_with(
                &project,
                &TaskFilter {
                    only_agent: Some(rui.clone()),
                    ignore_pause: true
                }
            )
            .unwrap()
            .len(),
            1
        );
    }

    #[test]
    fn prompts_carry_mission_and_goal() {
        use crate::store::goals::GoalInput;
        let (s, project, wf) = setup();
        s.set_project_mission(&project, Some("Reduzir a triagem em 30%."))
            .unwrap();
        let goal = s
            .create_goal(
                &project,
                &GoalInput {
                    title: "Regras de roteamento".into(),
                    description_md: "para onde cada lead vai".into(),
                    ..Default::default()
                },
            )
            .unwrap();
        s.update_workflow(
            &wf.id,
            &WorkflowInput {
                name: wf.name.clone(),
                stages: wf.stages.clone(),
                use_worktrees: false,
                max_parallel: 1,
                goal_id: Some(goal.id.clone()),
            },
        )
        .unwrap();
        let t = s
            .create_task(
                &project,
                &wf.id,
                &TaskInput {
                    title: "Com porquê".into(),
                    ..Default::default()
                },
            )
            .unwrap();
        let ctx = s.prompt_context(&t).unwrap();
        assert_eq!(ctx.mission.as_deref(), Some("Reduzir a triagem em 30%."));
        assert_eq!(
            ctx.goal.as_ref().map(|g| g.id.as_str()),
            Some(goal.id.as_str()),
            "herdado do workflow"
        );
        let prompt = Store::task_prompt(&t, &wf.stages[0], &wf, &ctx);
        assert!(prompt.contains("Missão do projeto: Reduzir a triagem em 30%."));
        assert!(
            prompt.contains("Objetivo desta task: Regras de roteamento — para onde cada lead vai")
        );
        assert!(prompt.contains("não altera as regras do run"));
        assert!(
            Store::review_prompt(&t, &wf.stages[0], &wf, Some("Ana"), &ctx)
                .contains("Objetivo desta task")
        );
        assert!(
            !Store::task_prompt(&t, &wf.stages[0], &wf, &PromptContext::default())
                .contains("Missão do projeto")
        );
    }

    #[test]
    fn comments_are_recorded_and_only_the_last_five_enter_the_prompts() {
        let (s, project, wf) = setup();
        let t = s
            .create_task(
                &project,
                &wf.id,
                &TaskInput {
                    title: "Com comentários".into(),
                    ..Default::default()
                },
            )
            .unwrap();
        assert!(s.add_task_comment(&t.id, "   ").is_err());
        assert!(s
            .add_task_comment(&t.id, &"x".repeat(MAX_COMMENT_CHARS + 1))
            .is_err());
        assert!(s.add_task_comment("task_nope", "oi").is_err());
        for i in 1..=6 {
            let ev = s
                .add_task_comment(&t.id, &format!("  comentário {i}  "))
                .unwrap();
            assert_eq!(ev.kind, "comment");
            assert_eq!(ev.actor, "você");
            assert_eq!(ev.note.as_deref(), Some(format!("comentário {i}").as_str()));
        }
        let all = s.list_task_events(&t.id).unwrap();
        assert_eq!(all.iter().filter(|e| e.kind == "comment").count(), 6);
        assert_eq!(
            s.get_task(&t.id).unwrap().unwrap().updated_at,
            t.updated_at,
            "comentar não reordena a task"
        );
        let ctx = s.prompt_context(&t).unwrap();
        assert_eq!(ctx.comments.len(), 5);
        assert_eq!(ctx.comments[0].note.as_deref(), Some("comentário 2"));
        assert_eq!(ctx.comments[4].note.as_deref(), Some("comentário 6"));
        let prompt = Store::task_prompt(&t, &wf.stages[0], &wf, &ctx);
        assert!(prompt.contains("Comentários do gestor"));
        assert!(!prompt.contains("comentário 1\n") && prompt.contains("comentário 6"));
        assert!(prompt.find("comentário 2").unwrap() < prompt.find("comentário 6").unwrap());
        let review = Store::review_prompt(&t, &wf.stages[0], &wf, Some("Ana"), &ctx);
        assert!(review.contains("Comentários do gestor") && review.contains("comentário 6"));
        assert!(
            !Store::task_prompt(&t, &wf.stages[0], &wf, &PromptContext::default())
                .contains("Comentários do gestor")
        );
        assert!(!s
            .list_audit_events(Some(&project), Some("board.task.commented"), 10)
            .unwrap()
            .is_empty());
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
        let prompt = Store::task_prompt(&t, &wf.stages[0], &wf, &PromptContext::default());
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
