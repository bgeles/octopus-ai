//! Missão do projeto e objetivos (goal alignment, como no Paperclip): cada task pode apontar para um
//! objetivo; workflows têm um objetivo padrão; o "porquê" entra nos prompts e nas tools de delegação.

use anyhow::{Context, Result};
use rusqlite::{params, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

use super::models::Project;
use super::{new_id, now, Store};

pub const MAX_MISSION_CHARS: usize = 2_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum GoalStatus {
    #[default]
    Active,
    Done,
}

impl GoalStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            GoalStatus::Active => "active",
            GoalStatus::Done => "done",
        }
    }
    fn parse(raw: &str) -> Self {
        if raw == "done" {
            GoalStatus::Done
        } else {
            GoalStatus::Active
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Goal {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub description_md: String,
    pub parent_goal_id: Option<String>,
    pub status: GoalStatus,
    pub position: i64,
    pub created_at: String,
    pub updated_at: String,
}

impl Goal {
    const SELECT: &'static str = "SELECT id, project_id, title, description_md, parent_goal_id, status, position, created_at, updated_at FROM goal";
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Goal {
            id: row.get(0)?,
            project_id: row.get(1)?,
            title: row.get(2)?,
            description_md: row.get(3)?,
            parent_goal_id: row.get(4)?,
            status: GoalStatus::parse(&row.get::<_, String>(5)?),
            position: row.get(6)?,
            created_at: row.get(7)?,
            updated_at: row.get(8)?,
        })
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalInput {
    pub title: String,
    #[serde(default)]
    pub description_md: String,
    #[serde(default)]
    pub parent_goal_id: Option<String>,
    #[serde(default)]
    pub status: Option<GoalStatus>,
}

/// Objetivo com progresso: tasks do projeto ligadas a ele (de qualquer workflow).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalProgress {
    #[serde(flatten)]
    pub goal: Goal,
    pub tasks_total: u32,
    pub tasks_done: u32,
    pub workflows: u32,
}

impl Store {
    pub fn list_goals(&self, project_id: &str) -> Result<Vec<GoalProgress>> {
        let conn = self.conn.lock().expect("store mutex");
        let mut stmt = conn.prepare(&format!(
            "SELECT g.id, g.project_id, g.title, g.description_md, g.parent_goal_id, g.status, g.position, g.created_at, g.updated_at,
                    (SELECT COUNT(*) FROM task t WHERE t.goal_id = g.id),
                    (SELECT COUNT(*) FROM task t WHERE t.goal_id = g.id AND t.status = 'done'),
                    (SELECT COUNT(*) FROM workflow w WHERE w.goal_id = g.id)
             FROM goal g WHERE g.project_id = ?1 ORDER BY g.status, g.position, g.created_at{}",
            ""
        ))?;
        let rows = stmt
            .query_map(params![project_id], |r| {
                Ok(GoalProgress {
                    goal: Goal::from_row(r)?,
                    tasks_total: r.get::<_, i64>(9)? as u32,
                    tasks_done: r.get::<_, i64>(10)? as u32,
                    workflows: r.get::<_, i64>(11)? as u32,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn get_goal(&self, id: &str) -> Result<Option<Goal>> {
        let conn = self.conn.lock().expect("store mutex");
        Ok(conn
            .query_row(
                &format!("{} WHERE id = ?1", Goal::SELECT),
                params![id],
                Goal::from_row,
            )
            .optional()?)
    }

    fn check_parent(
        &self,
        project_id: &str,
        parent: Option<&str>,
        self_id: Option<&str>,
    ) -> Result<()> {
        let Some(parent) = parent else { return Ok(()) };
        if Some(parent) == self_id {
            anyhow::bail!("Um objetivo não pode ser pai de si mesmo");
        }
        let p = self
            .get_goal(parent)?
            .with_context(|| format!("Objetivo pai {parent} não encontrado"))?;
        if p.project_id != project_id {
            anyhow::bail!("O objetivo pai é de outro projeto");
        }
        // Sem ciclo: o pai não pode descender deste objetivo.
        if let Some(me) = self_id {
            let mut cur = p.parent_goal_id.clone();
            let mut hops = 0;
            while let Some(c) = cur {
                if c == me {
                    anyhow::bail!("Isso criaria um ciclo de objetivos");
                }
                hops += 1;
                if hops > 64 {
                    break;
                }
                cur = self.get_goal(&c)?.and_then(|g| g.parent_goal_id);
            }
        }
        Ok(())
    }

    pub fn create_goal(&self, project_id: &str, input: &GoalInput) -> Result<Goal> {
        let title = input.title.trim();
        if title.is_empty() {
            anyhow::bail!("Informe o título do objetivo");
        }
        self.check_parent(project_id, input.parent_goal_id.as_deref(), None)?;
        let id = new_id("goal");
        let ts = now();
        {
            let conn = self.conn.lock().expect("store mutex");
            let position: i64 = conn.query_row(
                "SELECT COALESCE(MAX(position), 0) + 1 FROM goal WHERE project_id = ?1",
                params![project_id],
                |r| r.get(0),
            )?;
            conn.execute(
                "INSERT INTO goal (id, project_id, title, description_md, parent_goal_id, status, position, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
                params![
                    id,
                    project_id,
                    title,
                    input.description_md.trim(),
                    input.parent_goal_id,
                    input.status.unwrap_or_default().as_str(),
                    position,
                    ts
                ],
            )?;
        }
        self.audit(
            "você",
            "board.goal.created",
            Some(project_id),
            serde_json::json!({"goalId": id, "title": title}),
        )?;
        self.get_goal(&id)?.context("objetivo sumiu após criar")
    }

    pub fn update_goal(&self, id: &str, input: &GoalInput) -> Result<Goal> {
        let title = input.title.trim();
        if title.is_empty() {
            anyhow::bail!("Informe o título do objetivo");
        }
        let current = self
            .get_goal(id)?
            .with_context(|| format!("Objetivo {id} não encontrado"))?;
        self.check_parent(
            &current.project_id,
            input.parent_goal_id.as_deref(),
            Some(id),
        )?;
        {
            let conn = self.conn.lock().expect("store mutex");
            conn.execute(
                "UPDATE goal SET title = ?2, description_md = ?3, parent_goal_id = ?4, status = ?5, updated_at = ?6 WHERE id = ?1",
                params![
                    id,
                    title,
                    input.description_md.trim(),
                    input.parent_goal_id,
                    input.status.unwrap_or(current.status).as_str(),
                    now()
                ],
            )?;
        }
        self.get_goal(id)?.context("objetivo sumiu após atualizar")
    }

    /// Remove o objetivo; workflows e tasks que apontavam para ele ficam sem objetivo (FK SET NULL).
    pub fn delete_goal(&self, id: &str) -> Result<bool> {
        let conn = self.conn.lock().expect("store mutex");
        Ok(conn.execute("DELETE FROM goal WHERE id = ?1", params![id])? > 0)
    }

    pub fn set_project_mission(&self, project_id: &str, mission: Option<&str>) -> Result<Project> {
        let mission = mission.map(str::trim).filter(|m| !m.is_empty());
        if mission.is_some_and(|m| m.chars().count() > MAX_MISSION_CHARS) {
            anyhow::bail!("Missão longa demais (máximo {MAX_MISSION_CHARS} caracteres)");
        }
        {
            let conn = self.conn.lock().expect("store mutex");
            let changed = conn.execute(
                "UPDATE project SET mission = ?2 WHERE id = ?1",
                params![project_id, mission],
            )?;
            if changed == 0 {
                anyhow::bail!("Projeto {project_id} não encontrado");
            }
        }
        self.audit(
            "você",
            "project.mission.updated",
            Some(project_id),
            serde_json::json!({"chars": mission.map(|m| m.chars().count()).unwrap_or(0)}),
        )?;
        self.get_project(project_id)?
            .with_context(|| format!("Projeto {project_id} não encontrado"))
    }

    /// Valida um objetivo para uma task/workflow do projeto; devolve o id.
    pub(crate) fn resolve_goal_for(&self, project_id: &str, goal_id: &str) -> Result<String> {
        let goal = self
            .get_goal(goal_id)?
            .with_context(|| format!("Objetivo {goal_id} não encontrado"))?;
        if goal.project_id != project_id {
            anyhow::bail!("O objetivo é de outro projeto");
        }
        Ok(goal.id)
    }
}

/// Acha um objetivo ativo por id ou título (sem distinguir maiúsculas).
pub fn find_goal<'a>(goals: &'a [GoalProgress], key: &str) -> Option<&'a Goal> {
    let key = key.trim();
    if key.is_empty() {
        return None;
    }
    goals.iter().map(|g| &g.goal).find(|g| {
        g.status == GoalStatus::Active && (g.id == key || g.title.eq_ignore_ascii_case(key))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::orchestration::{TaskInput, TaskStatus, WorkflowInput};

    #[test]
    fn goals_crud_progress_inheritance_and_mission() {
        let s = Store::open_in_memory().unwrap();
        let project = s.create_project("p", "/tmp/p").unwrap().id;
        assert!(s.create_goal(&project, &GoalInput::default()).is_err());
        let root = s
            .create_goal(
                &project,
                &GoalInput {
                    title: "Triagem 30% mais rápida".into(),
                    ..Default::default()
                },
            )
            .unwrap();
        let child = s
            .create_goal(
                &project,
                &GoalInput {
                    title: "Regras de roteamento".into(),
                    description_md: "Para onde cada lead vai".into(),
                    parent_goal_id: Some(root.id.clone()),
                    ..Default::default()
                },
            )
            .unwrap();
        assert!(
            s.update_goal(
                &root.id,
                &GoalInput {
                    title: "Triagem".into(),
                    parent_goal_id: Some(child.id.clone()),
                    ..Default::default()
                }
            )
            .is_err(),
            "ciclo"
        );
        let other = s.create_project("o", "/tmp/o").unwrap().id;
        assert!(
            s.create_goal(
                &other,
                &GoalInput {
                    title: "x".into(),
                    parent_goal_id: Some(root.id.clone()),
                    ..Default::default()
                }
            )
            .is_err(),
            "pai de outro projeto"
        );

        // Workflow com objetivo padrão; a task herda quando não informa; progresso conta tasks concluídas.
        let mut wf = s
            .create_workflow_from_template(&project, "research-synthesis", false)
            .unwrap();
        wf = s
            .update_workflow(
                &wf.id,
                &WorkflowInput {
                    name: wf.name.clone(),
                    stages: wf.stages.clone(),
                    use_worktrees: false,
                    max_parallel: 1,
                    goal_id: Some(child.id.clone()),
                },
            )
            .unwrap();
        assert_eq!(wf.goal_id.as_deref(), Some(child.id.as_str()));
        let t1 = s
            .create_task(
                &project,
                &wf.id,
                &TaskInput {
                    title: "A".into(),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(
            t1.goal_id.as_deref(),
            Some(child.id.as_str()),
            "herdou do workflow"
        );
        let t2 = s
            .create_task(
                &project,
                &wf.id,
                &TaskInput {
                    title: "B".into(),
                    goal_id: Some(root.id.clone()),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(t2.goal_id.as_deref(), Some(root.id.as_str()));
        assert!(s
            .create_task(
                &project,
                &wf.id,
                &TaskInput {
                    title: "C".into(),
                    goal_id: Some("goal_nope".into()),
                    ..Default::default()
                }
            )
            .is_err());
        s.move_task(&t1.id, None, TaskStatus::Done, None).unwrap();
        let goals = s.list_goals(&project).unwrap();
        let g_child = goals.iter().find(|g| g.goal.id == child.id).unwrap();
        assert_eq!(
            (g_child.tasks_done, g_child.tasks_total, g_child.workflows),
            (1, 1, 1)
        );
        let g_root = goals.iter().find(|g| g.goal.id == root.id).unwrap();
        assert_eq!((g_root.tasks_done, g_root.tasks_total), (0, 1));
        assert_eq!(
            find_goal(&goals, "regras de roteamento").map(|g| g.id.as_str()),
            Some(child.id.as_str())
        );
        assert_eq!(
            find_goal(&goals, &root.id).map(|g| g.title.as_str()),
            Some("Triagem 30% mais rápida")
        );

        // Concluir um objetivo tira-o da busca por título; excluir anula as referências.
        s.update_goal(
            &child.id,
            &GoalInput {
                title: child.title.clone(),
                status: Some(GoalStatus::Done),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(find_goal(&s.list_goals(&project).unwrap(), "regras de roteamento").is_none());
        assert!(s.delete_goal(&child.id).unwrap());
        assert!(s.get_task(&t1.id).unwrap().unwrap().goal_id.is_none());
        assert!(s.get_workflow(&wf.id).unwrap().unwrap().goal_id.is_none());

        // Missão do projeto: trim, limite, aparece em get/list e no backup.
        let p = s
            .set_project_mission(&project, Some("  Reduzir a triagem em 30%.  "))
            .unwrap();
        assert_eq!(p.mission.as_deref(), Some("Reduzir a triagem em 30%."));
        assert_eq!(
            s.list_projects()
                .unwrap()
                .iter()
                .find(|x| x.id == project)
                .unwrap()
                .mission
                .as_deref(),
            Some("Reduzir a triagem em 30%.")
        );
        assert!(s
            .set_project_mission(&project, Some(&"m".repeat(MAX_MISSION_CHARS + 1)))
            .is_err());
        assert!(s
            .set_project_mission(&project, Some("   "))
            .unwrap()
            .mission
            .is_none());
        s.set_project_mission(&project, Some("Missão X")).unwrap();
        let export = s.export_config("t").unwrap();
        assert_eq!(
            export
                .projects
                .iter()
                .find(|x| x.id == project)
                .unwrap()
                .mission
                .as_deref(),
            Some("Missão X")
        );
        let other_store = Store::open_in_memory().unwrap();
        other_store
            .import_config(&export, crate::store::config::ImportMode::Merge)
            .unwrap();
        assert_eq!(
            other_store
                .get_project(&project)
                .unwrap()
                .unwrap()
                .mission
                .as_deref(),
            Some("Missão X")
        );
    }
}
