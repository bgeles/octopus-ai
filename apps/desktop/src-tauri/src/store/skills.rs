//! Skills (Fase 5): pastas com `SKILL.md` no projeto (`.claude/skills`) e no usuário
//! (`~/.claude/skills`), com interruptor por skill e vínculo por membro. As ativas que o Claude
//! Code não carrega sozinho viram um plugin local montado em `<dados>/projects/<id>/harness`.

use anyhow::{Context, Result};
use rusqlite::{params, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use super::memory::slugify;
use super::{new_id, now, Store};
use crate::protocol::{SdkPlugin, SettingSource};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Skill {
    pub id: String,
    /// `None` = skill do usuário (`~/.claude/skills`), vale para todos os projetos.
    pub project_id: Option<String>,
    pub name: String,
    /// Pasta da skill (contém `SKILL.md`).
    pub path: String,
    pub description: String,
    /// `project` (`.claude/skills` do projeto), `user` (`~/.claude/skills`) ou `manual` (criada no app).
    pub source: String,
    pub enabled: bool,
    pub created_at: String,
    pub updated_at: String,
}

impl Skill {
    const SELECT: &'static str = "SELECT id, project_id, name, path, description, source, enabled, created_at, updated_at FROM skill";
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get(0)?,
            project_id: row.get(1)?,
            name: row.get(2)?,
            path: row.get(3)?,
            description: row.get(4)?,
            source: row.get(5)?,
            enabled: row.get::<_, i64>(6)? != 0,
            created_at: row.get(7)?,
            updated_at: row.get(8)?,
        })
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInput {
    #[serde(default)]
    pub skill_id: Option<String>,
    pub project_id: String,
    pub name: String,
    pub content: String,
}

/// `name`/`description` do frontmatter YAML simples; fallback: nome da pasta e primeiro parágrafo.
pub fn parse_skill_md(text: &str, dir_name: &str) -> (String, String) {
    let mut name = None;
    let mut description = None;
    let mut body = text;
    if let Some(rest) = text.strip_prefix("---\n") {
        if let Some(end) = rest.find("\n---") {
            for line in rest[..end].lines() {
                if let Some((k, v)) = line.split_once(':') {
                    let v = v.trim().trim_matches('"').trim_matches('\'').to_string();
                    match k.trim() {
                        "name" if !v.is_empty() => name = Some(v),
                        "description" if !v.is_empty() => description = Some(v),
                        _ => {}
                    }
                }
            }
            body = rest[end + 4..]
                .trim_start_matches('-')
                .trim_start_matches('\n');
        }
    }
    let description = description.unwrap_or_else(|| {
        body.lines()
            .map(str::trim)
            .find(|l| !l.is_empty() && !l.starts_with('#'))
            .unwrap_or("")
            .chars()
            .take(200)
            .collect()
    });
    (name.unwrap_or_else(|| dir_name.to_string()), description)
}

fn user_skills_dir() -> Option<PathBuf> {
    directories::BaseDirs::new().map(|b| b.home_dir().join(".claude").join("skills"))
}

fn scan_dir(dir: &Path) -> Vec<(String, PathBuf, String, String)> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let md = path.join("SKILL.md");
        if !path.is_dir() || !md.is_file() {
            continue;
        }
        let dir_name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("skill")
            .to_string();
        let text = std::fs::read_to_string(&md).unwrap_or_default();
        let (name, description) = parse_skill_md(&text, &dir_name);
        out.push((dir_name, path, name, description));
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

impl Store {
    pub fn list_skills(&self, project_id: &str) -> Result<Vec<Skill>> {
        let conn = self.conn.lock().expect("store mutex");
        let mut stmt = conn.prepare(&format!(
            "{} WHERE project_id IS NULL OR project_id = ?1 ORDER BY (project_id IS NULL), name",
            Skill::SELECT
        ))?;
        let rows = stmt.query_map(params![project_id], Skill::from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn get_skill(&self, id: &str) -> Result<Option<Skill>> {
        let conn = self.conn.lock().expect("store mutex");
        Ok(conn
            .query_row(
                &format!("{} WHERE id = ?1", Skill::SELECT),
                params![id],
                Skill::from_row,
            )
            .optional()?)
    }

    /// Varre `.claude/skills` do projeto e `~/.claude/skills`: insere novas, atualiza nome/descrição,
    /// remove as que sumiram do disco. O interruptor `enabled` é preservado.
    pub fn scan_skills(&self, project_id: &str) -> Result<Vec<Skill>> {
        self.scan_skills_with(project_id, user_skills_dir().as_deref())
    }

    pub fn scan_skills_with(
        &self,
        project_id: &str,
        user_dir: Option<&Path>,
    ) -> Result<Vec<Skill>> {
        let project = self
            .get_project(project_id)?
            .with_context(|| format!("Projeto {project_id} não encontrado"))?;
        let project_dir = Path::new(&project.path).join(".claude").join("skills");
        let mut found: Vec<(Option<String>, String, PathBuf, String, String)> =
            scan_dir(&project_dir)
                .into_iter()
                .map(|(_, path, name, desc)| {
                    (
                        Some(project_id.to_string()),
                        "project".to_string(),
                        path,
                        name,
                        desc,
                    )
                })
                .collect();
        if let Some(dir) = user_dir {
            found.extend(
                scan_dir(dir)
                    .into_iter()
                    .map(|(_, path, name, desc)| (None, "user".to_string(), path, name, desc)),
            );
        }
        let mut conn = self.conn.lock().expect("store mutex");
        let tx = conn.transaction()?;
        let ts = now();
        let mut seen: Vec<String> = Vec::new();
        for (pid, source, path, name, description) in found {
            let path_s = path.to_string_lossy().to_string();
            seen.push(path_s.clone());
            let existing: Option<String> = tx
                .query_row(
                    "SELECT id FROM skill WHERE COALESCE(project_id, '') = COALESCE(?1, '') AND path = ?2",
                    params![pid, path_s],
                    |r| r.get(0),
                )
                .optional()?;
            match existing {
                Some(id) => {
                    tx.execute(
                        "UPDATE skill SET name = ?2, description = ?3, updated_at = ?4 WHERE id = ?1",
                        params![id, name, description, ts],
                    )?;
                }
                None => {
                    tx.execute(
                        "INSERT INTO skill (id, project_id, name, path, description, source, enabled, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?7)",
                        params![new_id("skill"), pid, name, path_s, description, source, ts],
                    )?;
                }
            }
        }
        // Remove o que sumiu do disco (deste projeto e do usuário).
        let mut stmt = tx.prepare(&format!(
            "{} WHERE project_id IS NULL OR project_id = ?1",
            Skill::SELECT
        ))?;
        let current: Vec<Skill> = stmt
            .query_map(params![project_id], Skill::from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(stmt);
        for s in current {
            if !seen.contains(&s.path) && !Path::new(&s.path).join("SKILL.md").is_file() {
                tx.execute("DELETE FROM skill WHERE id = ?1", params![s.id])?;
            }
        }
        tx.commit()?;
        drop(conn);
        self.list_skills(project_id)
    }

    pub fn set_skill_enabled(&self, id: &str, enabled: bool) -> Result<Skill> {
        {
            let conn = self.conn.lock().expect("store mutex");
            let changed = conn.execute(
                "UPDATE skill SET enabled = ?2, updated_at = ?3 WHERE id = ?1",
                params![id, enabled as i64, now()],
            )?;
            if changed == 0 {
                anyhow::bail!("Skill {id} não encontrada");
            }
        }
        self.get_skill(id)?.context("skill sumiu")
    }

    pub fn read_skill(&self, id: &str) -> Result<String> {
        let skill = self
            .get_skill(id)?
            .with_context(|| format!("Skill {id} não encontrada"))?;
        Ok(std::fs::read_to_string(
            Path::new(&skill.path).join("SKILL.md"),
        )?)
    }

    /// Cria ou atualiza `<projeto>/.claude/skills/<slug>/SKILL.md` (confinado à pasta do projeto).
    pub fn save_skill(&self, input: &SkillInput) -> Result<Skill> {
        let project = self
            .get_project(&input.project_id)?
            .with_context(|| format!("Projeto {} não encontrado", input.project_id))?;
        let name = input.name.trim();
        if name.is_empty() {
            anyhow::bail!("A skill precisa de nome");
        }
        if input.content.trim().is_empty() {
            anyhow::bail!("O SKILL.md não pode ser vazio");
        }
        let dir = match &input.skill_id {
            Some(id) => {
                let existing = self
                    .get_skill(id)?
                    .with_context(|| format!("Skill {id} não encontrada"))?;
                PathBuf::from(existing.path)
            }
            None => Path::new(&project.path)
                .join(".claude")
                .join("skills")
                .join(slugify(name)),
        };
        let base = Path::new(&project.path).canonicalize()?;
        std::fs::create_dir_all(&dir)?;
        let canonical = dir.canonicalize()?;
        if input.skill_id.is_none() && !canonical.starts_with(&base) {
            anyhow::bail!("A skill precisa ficar dentro da pasta do projeto");
        }
        let content = if input.content.starts_with("---\n") {
            input.content.clone()
        } else {
            format!(
                "---\nname: {name}\ndescription: {}\n---\n\n{}",
                first_line(&input.content),
                input.content.trim_start()
            )
        };
        std::fs::write(canonical.join("SKILL.md"), content)?;
        let listed = self.scan_skills_with(&input.project_id, user_skills_dir().as_deref())?;
        listed
            .into_iter()
            .find(|s| Path::new(&s.path) == canonical.as_path() || s.path == dir.to_string_lossy())
            .context("skill gravada não apareceu na varredura")
    }

    /// Skills que entram no plugin local: ativas, escolhidas pelo membro (ou todas) e que o Claude
    /// Code não carrega sozinho (as do projeto só quando `settingSources` exclui `project`).
    pub fn plugin_skills(
        &self,
        project_id: &str,
        agent_profile_id: Option<&str>,
        setting_sources: Option<&[SettingSource]>,
    ) -> Result<Vec<Skill>> {
        let chosen: Option<Vec<String>> = match agent_profile_id {
            Some(id) => {
                let conn = self.conn.lock().expect("store mutex");
                conn.query_row(
                    "SELECT skill_ids_json FROM agent_profile WHERE id = ?1",
                    params![id],
                    |r| r.get::<_, Option<String>>(0),
                )
                .optional()?
                .flatten()
                .and_then(|s| serde_json::from_str(&s).ok())
            }
            None => None,
        };
        let project_auto_loaded =
            setting_sources.is_none_or(|s| s.contains(&SettingSource::Project));
        Ok(self
            .list_skills(project_id)?
            .into_iter()
            .filter(|s| s.enabled)
            .filter(|s| chosen.as_ref().is_none_or(|ids| ids.contains(&s.id)))
            .filter(|s| !(project_auto_loaded && s.project_id.is_some()))
            .filter(|s| Path::new(&s.path).join("SKILL.md").is_file())
            .collect())
    }

    /// Monta o plugin local com as skills de `plugin_skills`. `None` sem skills.
    pub fn materialize_plugin(
        &self,
        project_id: &str,
        agent_profile_id: Option<&str>,
        setting_sources: Option<&[SettingSource]>,
    ) -> Result<Option<SdkPlugin>> {
        let Some(data_dir) = &self.data_dir else {
            return Ok(None);
        };
        let skills = self.plugin_skills(project_id, agent_profile_id, setting_sources)?;
        let plugin_dir = data_dir
            .join("projects")
            .join(project_id)
            .join("harness")
            .join(format!("plugin-{}", agent_profile_id.unwrap_or("project")));
        if plugin_dir.exists() {
            std::fs::remove_dir_all(&plugin_dir)?;
        }
        if skills.is_empty() {
            return Ok(None);
        }
        let skills_dir = plugin_dir.join("skills");
        std::fs::create_dir_all(plugin_dir.join(".claude-plugin"))?;
        std::fs::create_dir_all(&skills_dir)?;
        std::fs::write(
            plugin_dir.join(".claude-plugin").join("plugin.json"),
            serde_json::to_string_pretty(&serde_json::json!({
                "name": "octopus-skills",
                "version": "0.1.0",
                "description": format!("Skills ativas no Octopus para {}", agent_profile_id.unwrap_or("o projeto")),
            }))?,
        )?;
        for s in &skills {
            let link = skills_dir.join(slugify(&s.name));
            #[cfg(unix)]
            std::os::unix::fs::symlink(&s.path, &link)?;
            #[cfg(not(unix))]
            copy_dir(Path::new(&s.path), &link)?;
        }
        Ok(Some(SdkPlugin::local(
            plugin_dir.to_string_lossy().to_string(),
        )))
    }
}

fn first_line(text: &str) -> String {
    text.lines()
        .map(str::trim)
        .find(|l| !l.is_empty() && !l.starts_with('#'))
        .unwrap_or("")
        .chars()
        .take(120)
        .collect()
}

#[cfg(not(unix))]
fn copy_dir(from: &Path, to: &Path) -> Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.path().is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_skill(root: &Path, dir: &str, text: &str) {
        let d = root.join(dir);
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("SKILL.md"), text).unwrap();
    }

    #[test]
    fn parses_frontmatter_with_fallbacks() {
        assert_eq!(
            parse_skill_md(
                "---\nname: flyway-migration\ndescription: \"Cria migrações\"\n---\n# Flyway\n",
                "pasta"
            ),
            ("flyway-migration".into(), "Cria migrações".into())
        );
        assert_eq!(
            parse_skill_md("# Título\n\nPrimeiro parágrafo explica.\n", "pasta"),
            ("pasta".into(), "Primeiro parágrafo explica.".into())
        );
        assert_eq!(
            parse_skill_md("---\ndescription: só desc\n---\n", "x"),
            ("x".into(), "só desc".into())
        );
    }

    #[test]
    fn scans_project_and_user_skills_and_builds_the_plugin() {
        let project_dir = tempfile::tempdir().unwrap();
        let user_dir = tempfile::tempdir().unwrap();
        let data_dir = tempfile::tempdir().unwrap();
        write_skill(
            &project_dir.path().join(".claude/skills"),
            "flyway-migration",
            "---\nname: flyway-migration\ndescription: Cria migrações Flyway\n---\nPassos…",
        );
        write_skill(
            &project_dir.path().join(".claude/skills"),
            "java-review",
            "# Java review\n\nRevisa Java 21.",
        );
        write_skill(
            user_dir.path(),
            "commit-ptbr",
            "---\nname: commit-ptbr\ndescription: Commits em pt-BR\n---\n",
        );
        std::fs::create_dir_all(user_dir.path().join("sem-skill-md")).unwrap();
        let store = Store::open_in_memory()
            .unwrap()
            .with_data_dir(data_dir.path().to_path_buf());
        let project = store
            .create_project("p", project_dir.path().to_str().unwrap())
            .unwrap();

        let skills = store
            .scan_skills_with(&project.id, Some(user_dir.path()))
            .unwrap();
        assert_eq!(
            skills
                .iter()
                .map(|s| (s.name.as_str(), s.source.as_str()))
                .collect::<Vec<_>>(),
            vec![
                ("flyway-migration", "project"),
                ("java-review", "project"),
                ("commit-ptbr", "user")
            ]
        );
        assert_eq!(skills[1].description, "Revisa Java 21.");
        let commit = skills
            .iter()
            .find(|s| s.name == "commit-ptbr")
            .unwrap()
            .clone();

        // Plugin: com settingSources padrão só entram as do usuário; desabilitada sai; sem fontes de projeto entram todas.
        let plugin = store
            .materialize_plugin(&project.id, None, None)
            .unwrap()
            .unwrap();
        let plugin_dir = PathBuf::from(&plugin.path);
        assert!(plugin_dir.join(".claude-plugin/plugin.json").is_file());
        assert!(
            plugin_dir.join("skills/commit-ptbr/SKILL.md").is_file(),
            "symlink para a skill do usuário"
        );
        assert!(
            !plugin_dir.join("skills/flyway-migration").exists(),
            "skills do projeto já são carregadas pelo Claude Code"
        );
        store.set_skill_enabled(&commit.id, false).unwrap();
        assert!(store
            .materialize_plugin(&project.id, None, None)
            .unwrap()
            .is_none());
        assert!(!plugin_dir.exists(), "plugin vazio é removido");
        let all = store
            .materialize_plugin(&project.id, None, Some(&[SettingSource::Local]))
            .unwrap()
            .unwrap();
        assert!(PathBuf::from(&all.path)
            .join("skills/flyway-migration/SKILL.md")
            .is_file());
        assert!(PathBuf::from(&all.path).join("skills/java-review").exists());

        // Rescan preserva o interruptor e remove o que sumiu.
        std::fs::remove_dir_all(project_dir.path().join(".claude/skills/java-review")).unwrap();
        let again = store
            .scan_skills_with(&project.id, Some(user_dir.path()))
            .unwrap();
        assert_eq!(again.len(), 2);
        assert!(
            !again
                .iter()
                .find(|s| s.name == "commit-ptbr")
                .unwrap()
                .enabled
        );

        // Salvar cria dentro do projeto com frontmatter; ler devolve o conteúdo; fora do projeto é recusado.
        let created = store
            .save_skill(&SkillInput {
                skill_id: None,
                project_id: project.id.clone(),
                name: "Release notes".into(),
                content: "Gera notas de versão a partir do git log.\n\n1. Rode git log.".into(),
            })
            .unwrap();
        assert_eq!(created.name, "Release notes");
        assert!(created.path.ends_with(".claude/skills/release-notes"));
        let text = store.read_skill(&created.id).unwrap();
        assert!(text.starts_with(
            "---\nname: Release notes\ndescription: Gera notas de versão a partir do git log.\n---"
        ));
        let edited = store
            .save_skill(&SkillInput {
                skill_id: Some(created.id.clone()),
                project_id: project.id.clone(),
                name: "Release notes".into(),
                content: "---\nname: release-notes\ndescription: Notas\n---\nNovo corpo".into(),
            })
            .unwrap();
        assert_eq!(edited.name, "release-notes");
        assert!(
            store
                .save_skill(&SkillInput {
                    skill_id: None,
                    project_id: project.id.clone(),
                    name: "../../fora".into(),
                    content: "x".into()
                })
                .is_ok(),
            "slug neutraliza o caminho"
        );
        assert!(store
            .list_skills(&project.id)
            .unwrap()
            .iter()
            .all(|s| s.project_id.is_none()
                || s.path.starts_with(project_dir.path().to_str().unwrap())));
    }
}
