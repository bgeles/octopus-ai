//! Diff da entrega de uma task (Fase 8): compara o worktree da task (ou a pasta do projeto, como
//! melhor esforço) com o commit base guardado no claim. Só `git`, sem dependência nativa.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;

use super::Store;

/// Limite por arquivo (antes/depois) para não estourar a UI.
pub const MAX_FILE_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub path: String,
    /// `added` | `modified` | `deleted` | `renamed`
    pub status: String,
    pub before: String,
    pub after: String,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskDiff {
    pub available: bool,
    pub reason: Option<String>,
    pub base: Option<String>,
    /// `worktree` (branch da task) ou `project` (pasta do projeto; pode incluir mudanças de fora).
    pub scope: String,
    pub files: Vec<FileDiff>,
}

impl TaskDiff {
    fn unavailable(reason: &str) -> Self {
        Self {
            available: false,
            reason: Some(reason.into()),
            base: None,
            scope: "none".into(),
            files: Vec::new(),
        }
    }
}

/// Caminho relativo à primeira raiz que o contém (worktree da task, depois a pasta do projeto);
/// compara também as formas canônicas, porque no macOS `/var` e `/private/var` são a mesma pasta.
/// Fora de todas as raízes, devolve o caminho como veio.
pub fn relativize(path: &str, roots: &[&str]) -> String {
    let candidate = Path::new(path);
    let canon = candidate.canonicalize().ok();
    for root in roots.iter().filter(|r| !r.is_empty()) {
        let root_path = Path::new(root);
        if let Ok(rel) = candidate.strip_prefix(root_path) {
            return rel.to_string_lossy().into_owned();
        }
        if let (Some(c), Ok(root_canon)) = (&canon, root_path.canonicalize()) {
            if let Ok(rel) = c.strip_prefix(&root_canon) {
                return rel.to_string_lossy().into_owned();
            }
        }
    }
    path.to_string()
}

/// HEAD do repositório em `dir` (`None` fora de um repo git ou sem commits).
pub fn git_head(dir: &Path) -> Option<String> {
    let out = Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(dir)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

fn git(dir: &Path, args: &[&str]) -> Result<std::process::Output> {
    Command::new("git")
        .args(args)
        .current_dir(dir)
        .output()
        .with_context(|| format!("executando git {}", args.join(" ")))
}

fn cap(mut text: String) -> (String, bool) {
    if text.len() <= MAX_FILE_BYTES {
        return (text, false);
    }
    let mut cut = MAX_FILE_BYTES;
    while !text.is_char_boundary(cut) {
        cut -= 1;
    }
    text.truncate(cut);
    (text, true)
}

/// Lista as mudanças de `dir` em relação a `base`: tracked (`git diff --name-status`) + untracked.
pub fn diff_against(dir: &Path, base: &str) -> Result<Vec<FileDiff>> {
    let root = dir.canonicalize().context("pasta do diff não existe")?;
    let tracked = git(&root, &["diff", "--name-status", "--find-renames", base])?;
    if !tracked.status.success() {
        anyhow::bail!(
            "git diff falhou: {}",
            String::from_utf8_lossy(&tracked.stderr).trim()
        );
    }
    let mut entries: Vec<(String, String, Option<String>)> = Vec::new(); // (status, path, old path)
    for line in String::from_utf8_lossy(&tracked.stdout).lines() {
        let mut parts = line.split('\t');
        let Some(code) = parts.next() else { continue };
        let status = match code.chars().next() {
            Some('A') => "added",
            Some('D') => "deleted",
            Some('R') => "renamed",
            _ => "modified",
        };
        if status == "renamed" {
            let old = parts.next().map(str::to_string);
            let Some(new) = parts.next() else { continue };
            entries.push((status.into(), new.to_string(), old));
        } else if let Some(path) = parts.next() {
            entries.push((status.into(), path.to_string(), None));
        }
    }
    let untracked = git(&root, &["ls-files", "--others", "--exclude-standard"])?;
    for line in String::from_utf8_lossy(&untracked.stdout).lines() {
        let path = line.trim();
        if !path.is_empty() && !entries.iter().any(|(_, p, _)| p == path) {
            entries.push(("added".into(), path.to_string(), None));
        }
    }
    entries.sort_by(|a, b| a.1.cmp(&b.1));
    let mut files = Vec::new();
    for (status, path, old) in entries {
        let full: PathBuf = root.join(&path);
        // Confinamento: nada fora da pasta do diff.
        if let Ok(canonical) = full.canonicalize() {
            if !canonical.starts_with(&root) {
                continue;
            }
        }
        let before = if status == "added" {
            String::new()
        } else {
            let spec = format!("{base}:{}", old.as_deref().unwrap_or(&path));
            let out = git(&root, &["show", &spec])?;
            if out.status.success() {
                String::from_utf8_lossy(&out.stdout).into_owned()
            } else {
                String::new()
            }
        };
        let after = if status == "deleted" {
            String::new()
        } else {
            std::fs::read(&full)
                .map(|b| String::from_utf8_lossy(&b).into_owned())
                .unwrap_or_default()
        };
        let (before, t1) = cap(before);
        let (after, t2) = cap(after);
        files.push(FileDiff {
            path,
            status,
            before,
            after,
            truncated: t1 || t2,
        });
    }
    Ok(files)
}

impl Store {
    /// Diff da entrega: worktree da task contra o commit base; sem worktree, a pasta do projeto (melhor esforço).
    pub fn task_diff(&self, task_id: &str) -> Result<TaskDiff> {
        let Some(task) = self.get_task(task_id)? else {
            anyhow::bail!("Task {task_id} não encontrada");
        };
        let Some(base) = task.base_commit.clone() else {
            return Ok(TaskDiff::unavailable(
                "A task ainda não rodou (sem commit base para comparar).",
            ));
        };
        let project = self
            .get_project(&task.project_id)?
            .with_context(|| format!("Projeto {} não encontrado", task.project_id))?;
        let (dir, scope, reason) = match task.worktree_path.as_deref() {
            Some(wt) if Path::new(wt).join(".git").exists() => (PathBuf::from(wt), "worktree", None),
            Some(_) => return Ok(TaskDiff::unavailable("O worktree desta task não existe mais.")),
            None => (
                PathBuf::from(&project.path),
                "project",
                Some("Sem worktree: o diff é da pasta do projeto e pode incluir mudanças fora desta task.".to_string()),
            ),
        };
        if git_head(&dir).is_none() {
            return Ok(TaskDiff::unavailable("A pasta não é um repositório git."));
        }
        let files = diff_against(&dir, &base)?;
        Ok(TaskDiff {
            available: true,
            reason,
            base: Some(base),
            scope: scope.into(),
            files,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(dir: &Path, args: &[&str]) {
        let out = Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    #[test]
    fn diff_lists_added_modified_and_deleted_files() {
        let dir = tempfile::tempdir().unwrap();
        assert!(git_head(dir.path()).is_none());
        run(dir.path(), &["init", "-q"]);
        std::fs::write(dir.path().join("a.txt"), "um\n").unwrap();
        std::fs::write(dir.path().join("b.txt"), "dois\n").unwrap();
        run(dir.path(), &["add", "."]);
        run(
            dir.path(),
            &[
                "-c",
                "user.email=t@t",
                "-c",
                "user.name=t",
                "commit",
                "-q",
                "-m",
                "init",
            ],
        );
        let base = git_head(dir.path()).unwrap();
        std::fs::write(dir.path().join("a.txt"), "um\nalterado\n").unwrap();
        std::fs::remove_file(dir.path().join("b.txt")).unwrap();
        std::fs::write(dir.path().join("NOTAS.md"), "# notas\n").unwrap();
        let files = diff_against(dir.path(), &base).unwrap();
        let by: std::collections::HashMap<_, _> =
            files.iter().map(|f| (f.path.as_str(), f)).collect();
        assert_eq!(by["NOTAS.md"].status, "added");
        assert_eq!(by["NOTAS.md"].after, "# notas\n");
        assert_eq!(by["a.txt"].status, "modified");
        assert_eq!(by["a.txt"].before, "um\n");
        assert_eq!(by["a.txt"].after, "um\nalterado\n");
        assert_eq!(by["b.txt"].status, "deleted");
        assert_eq!(by["b.txt"].before, "dois\n");
        assert!(files.iter().all(|f| !f.truncated));
    }

    #[test]
    fn relativize_strips_the_worktree_or_project_root() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().into_owned();
        std::fs::create_dir_all(dir.path().join("src")).unwrap();
        std::fs::write(dir.path().join("src/a.rs"), "").unwrap();
        let abs = format!("{root}/src/a.rs");
        assert_eq!(relativize(&abs, &[&root]), "src/a.rs");
        // Forma canônica (no macOS o tempdir fica em /var → /private/var).
        let canon = dir.path().canonicalize().unwrap().join("src/a.rs");
        assert_eq!(relativize(&canon.to_string_lossy(), &[&root]), "src/a.rs");
        assert_eq!(relativize("src/b.rs", &[&root]), "src/b.rs");
        assert_eq!(
            relativize("/outro/lugar/c.rs", &[&root]),
            "/outro/lugar/c.rs"
        );
    }

    #[test]
    fn cap_truncates_on_char_boundary() {
        let big = "é".repeat(MAX_FILE_BYTES);
        let (out, truncated) = cap(big);
        assert!(truncated);
        assert!(out.len() <= MAX_FILE_BYTES);
        assert!(std::str::from_utf8(out.as_bytes()).is_ok());
    }
}
