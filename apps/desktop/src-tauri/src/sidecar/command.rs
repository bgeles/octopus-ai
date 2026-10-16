//! Resolve como iniciar o sidecar: binário empacotado, script de desenvolvimento ou override por env.

use std::path::{Path, PathBuf};

use anyhow::Result;

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
    /// 2. Binário empacotado ao lado do executável: `agent-runtime` (Fase 7).
    /// 3. Desenvolvimento (`debug_assertions`): `node <repo>/packages/agent-runtime/dist/main.js`.
    /// 4. Bundle de resources do app (`<Resources>/sidecar/agent-runtime/dist/main.js`), montado por
    ///    `scripts/bundle-sidecar.mjs` e executado com o `node` da máquina (ver [`find_node`]).
    pub fn resolve(
        exe_dir: Option<&Path>,
        repo_root: Option<&Path>,
        resource_dir: Option<&Path>,
    ) -> Result<Self> {
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

        if let Some(root) = repo_root {
            let script = root.join("packages/agent-runtime/dist/main.js");
            if script.is_file() {
                return Ok(Self::new(
                    find_node(),
                    vec![script.to_string_lossy().into_owned()],
                ));
            }
        }

        if let Some(resources) = resource_dir {
            let script = resources.join("sidecar/agent-runtime/dist/main.js");
            if script.is_file() {
                return Ok(Self::new(
                    find_node(),
                    vec![script.to_string_lossy().into_owned()],
                ));
            }
        }

        match repo_root {
            Some(root) => anyhow::bail!(
                "sidecar não compilado: {} não existe. Rode `npm run build -w @octopus/agent-runtime`.",
                root.join("packages/agent-runtime/dist/main.js").display()
            ),
            None => anyhow::bail!(
                "sidecar não encontrado: sem binário `agent-runtime` ao lado do executável nem `sidecar/agent-runtime/dist/main.js` nos resources{}",
                resource_dir
                    .map(|r| format!(" ({})", r.display()))
                    .unwrap_or_default()
            ),
        }
    }
}

/// Localiza o executável do Node. Um .app aberto pelo Finder não herda o PATH do shell, então,
/// além do PATH, olhamos os lugares usuais do Homebrew, do instalador oficial, do Volta e do nvm.
/// `OCTOPUS_NODE` força um caminho.
pub fn find_node() -> String {
    if let Ok(explicit) = std::env::var("OCTOPUS_NODE") {
        if !explicit.trim().is_empty() {
            return explicit;
        }
    }
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(path) = std::env::var_os("PATH") {
        candidates.extend(std::env::split_paths(&path).map(|dir| dir.join("node")));
    }
    candidates.extend(
        [
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
            "/opt/local/bin/node",
        ]
        .iter()
        .map(PathBuf::from),
    );
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        candidates.push(home.join(".volta/bin/node"));
        candidates.push(home.join(".local/bin/node"));
        // nvm: a versão mais alta instalada.
        if let Ok(entries) = std::fs::read_dir(home.join(".nvm/versions/node")) {
            let mut versions: Vec<PathBuf> = entries
                .flatten()
                .map(|e| e.path().join("bin/node"))
                .collect();
            versions.sort();
            candidates.extend(versions.into_iter().rev());
        }
    }
    candidates
        .into_iter()
        .find(|c| c.is_file())
        .map(|c| c.to_string_lossy().into_owned())
        .unwrap_or_else(|| "node".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefers_bundled_binary_when_present() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("agent-runtime"), b"#!/bin/sh\n").unwrap();
        let cmd = SidecarCommand::resolve(Some(dir.path()), None, None).unwrap();
        assert!(cmd.program.ends_with("agent-runtime"));
        assert!(cmd.args.is_empty());
    }

    #[test]
    fn falls_back_to_dev_script() {
        let repo = tempfile::tempdir().unwrap();
        let dist = repo.path().join("packages/agent-runtime/dist");
        std::fs::create_dir_all(&dist).unwrap();
        std::fs::write(dist.join("main.js"), b"").unwrap();
        let cmd = SidecarCommand::resolve(Some(repo.path()), Some(repo.path()), None).unwrap();
        assert!(cmd.program.ends_with("node"), "{}", cmd.program);
        assert!(cmd.args[0].ends_with("packages/agent-runtime/dist/main.js"));
    }

    #[test]
    fn uses_resource_bundle_in_release_layout() {
        let resources = tempfile::tempdir().unwrap();
        let dist = resources.path().join("sidecar/agent-runtime/dist");
        std::fs::create_dir_all(&dist).unwrap();
        std::fs::write(dist.join("main.js"), b"").unwrap();
        let cmd = SidecarCommand::resolve(None, None, Some(resources.path())).unwrap();
        assert!(cmd.program.ends_with("node"), "{}", cmd.program);
        assert!(cmd.args[0].ends_with("sidecar/agent-runtime/dist/main.js"));

        let err = SidecarCommand::resolve(None, None, Some(tempfile::tempdir().unwrap().path()))
            .unwrap_err()
            .to_string();
        assert!(err.contains("sidecar não encontrado"), "{err}");
    }

    #[test]
    fn find_node_returns_an_existing_file_or_plain_node() {
        let node = find_node();
        assert!(node == "node" || Path::new(&node).is_file(), "{node}");
    }

    #[test]
    fn errors_when_dev_script_missing() {
        let repo = tempfile::tempdir().unwrap();
        let err = SidecarCommand::resolve(None, Some(repo.path()), None)
            .unwrap_err()
            .to_string();
        assert!(err.contains("npm run build"), "{err}");
    }
}
