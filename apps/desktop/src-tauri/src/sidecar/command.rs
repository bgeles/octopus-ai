//! Resolve como iniciar o sidecar: binário empacotado, script de desenvolvimento ou override por env.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

#[derive(Debug, Clone)]
pub struct SidecarCommand {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
}

impl SidecarCommand {
    pub fn new(program: impl Into<String>, args: Vec<String>) -> Self {
        Self {
            program: program.into(),
            args,
            cwd: None,
        }
    }

    pub(crate) fn to_tokio(&self) -> tokio::process::Command {
        let mut cmd = tokio::process::Command::new(&self.program);
        cmd.args(&self.args);
        if let Some(cwd) = &self.cwd {
            cmd.current_dir(cwd);
        }
        cmd
    }

    /// Ordem de resolução:
    /// 1. `OCTOPUS_SIDECAR_PROGRAM` (+ `OCTOPUS_SIDECAR_ARGS`, separado por espaços) — override explícito.
    /// 2. Binário empacotado ao lado do executável: `agent-runtime` (release).
    /// 3. Desenvolvimento: `node <repo>/packages/agent-runtime/dist/main.js`.
    pub fn resolve(exe_dir: Option<&Path>, repo_root: Option<&Path>) -> Result<Self> {
        if let Ok(program) = std::env::var("OCTOPUS_SIDECAR_PROGRAM") {
            let args = std::env::var("OCTOPUS_SIDECAR_ARGS")
                .map(|s| s.split_whitespace().map(str::to_string).collect())
                .unwrap_or_default();
            return Ok(Self::new(program, args));
        }

        if let Some(dir) = exe_dir {
            let bundled = dir.join("agent-runtime");
            if bundled.is_file() {
                return Ok(Self::new(bundled.to_string_lossy().into_owned(), vec![]));
            }
        }

        let root = repo_root
            .context("sem binário empacotado e sem raiz do repositório para o modo dev")?;
        let script = root.join("packages/agent-runtime/dist/main.js");
        if !script.is_file() {
            anyhow::bail!(
                "sidecar não compilado: {} não existe. Rode `npm run build -w @octopus/agent-runtime`.",
                script.display()
            );
        }
        Ok(Self::new(
            "node",
            vec![script.to_string_lossy().into_owned()],
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefers_bundled_binary_when_present() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("agent-runtime"), b"#!/bin/sh\n").unwrap();
        let cmd = SidecarCommand::resolve(Some(dir.path()), None).unwrap();
        assert!(cmd.program.ends_with("agent-runtime"));
        assert!(cmd.args.is_empty());
    }

    #[test]
    fn falls_back_to_dev_script() {
        let repo = tempfile::tempdir().unwrap();
        let dist = repo.path().join("packages/agent-runtime/dist");
        std::fs::create_dir_all(&dist).unwrap();
        std::fs::write(dist.join("main.js"), b"").unwrap();
        let cmd = SidecarCommand::resolve(Some(repo.path()), Some(repo.path())).unwrap();
        assert_eq!(cmd.program, "node");
        assert!(cmd.args[0].ends_with("packages/agent-runtime/dist/main.js"));
    }

    #[test]
    fn errors_when_dev_script_missing() {
        let repo = tempfile::tempdir().unwrap();
        let err = SidecarCommand::resolve(None, Some(repo.path()))
            .unwrap_err()
            .to_string();
        assert!(err.contains("npm run build"), "{err}");
    }
}
