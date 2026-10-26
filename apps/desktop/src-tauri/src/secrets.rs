//! Segredos do app: a API key de cada projeto fica no Keychain do macOS (crate `keyring`),
//! nunca no SQLite, no export de configurações nem na auditoria.

use anyhow::{Context, Result};
use std::collections::HashMap;
use std::sync::Mutex;

use crate::protocol::RunOptions;
use crate::store::models::{AuthMode, Project};

/// Serviço usado no Keychain; a conta é `project:<id>:anthropic_api_key`.
pub const KEYCHAIN_SERVICE: &str = "ai.octopus.desktop";
pub const API_KEY_ENV: &str = "ANTHROPIC_API_KEY";

pub trait SecretStore: Send + Sync {
    fn set(&self, key: &str, value: &str) -> Result<()>;
    fn get(&self, key: &str) -> Result<Option<String>>;
    fn delete(&self, key: &str) -> Result<()>;
    fn has(&self, key: &str) -> Result<bool> {
        Ok(self.get(key)?.is_some())
    }
}

pub fn project_api_key_name(project_id: &str) -> String {
    format!("project:{project_id}:anthropic_api_key")
}

/// Keychain do macOS via `keyring` (apple-native).
pub struct KeychainSecrets;

impl SecretStore for KeychainSecrets {
    fn set(&self, key: &str, value: &str) -> Result<()> {
        keyring::Entry::new(KEYCHAIN_SERVICE, key)
            .context("abrir entrada do Keychain")?
            .set_password(value)
            .context("gravar no Keychain")
    }

    fn get(&self, key: &str) -> Result<Option<String>> {
        match keyring::Entry::new(KEYCHAIN_SERVICE, key)
            .context("abrir entrada do Keychain")?
            .get_password()
        {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e).context("ler do Keychain"),
        }
    }

    fn delete(&self, key: &str) -> Result<()> {
        match keyring::Entry::new(KEYCHAIN_SERVICE, key)
            .context("abrir entrada do Keychain")?
            .delete_credential()
        {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e).context("remover do Keychain"),
        }
    }
}

/// Em memória: testes e ambientes sem Keychain (`OCTOPUS_SECRETS=memory`).
#[derive(Default)]
pub struct MemorySecrets {
    inner: Mutex<HashMap<String, String>>,
}

impl SecretStore for MemorySecrets {
    fn set(&self, key: &str, value: &str) -> Result<()> {
        self.inner.lock().unwrap().insert(key.into(), value.into());
        Ok(())
    }
    fn get(&self, key: &str) -> Result<Option<String>> {
        Ok(self.inner.lock().unwrap().get(key).cloned())
    }
    fn delete(&self, key: &str) -> Result<()> {
        self.inner.lock().unwrap().remove(key);
        Ok(())
    }
}

/// Escolhe o store conforme o ambiente.
pub fn default_secret_store() -> Box<dyn SecretStore> {
    if std::env::var("OCTOPUS_SECRETS").as_deref() == Ok("memory") {
        Box::new(MemorySecrets::default())
    } else {
        Box::new(KeychainSecrets)
    }
}

/// Devolve as opções que vão **só para o sidecar**: para projetos em modo API key, injeta
/// `ANTHROPIC_API_KEY` em `env`. O chamador nunca persiste o resultado (o run gravado fica
/// com as opções sem a chave).
pub fn options_for_sidecar(
    project: &Project,
    options: &RunOptions,
    secrets: &dyn SecretStore,
) -> Result<RunOptions> {
    let mut out = options.clone();
    if project.auth_mode == AuthMode::ApiKey {
        let key = secrets
            .get(&project_api_key_name(&project.id))?
            .filter(|k| !k.trim().is_empty())
            .with_context(|| {
                format!(
                    "O projeto {} usa API key, mas nenhuma chave está no Keychain. Informe em Segurança → Autenticação ou mude para o login do Claude Code.",
                    project.name
                )
            })?;
        out.env
            .get_or_insert_with(Default::default)
            .insert(API_KEY_ENV.into(), key);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(mode: AuthMode) -> Project {
        Project {
            id: "p1".into(),
            name: "demo".into(),
            path: "/tmp/demo".into(),
            auth_mode: mode,
            created_at: "t".into(),
            sandbox_profile_id: None,
            mission: None,
        }
    }

    #[test]
    fn memory_store_roundtrip() {
        let s = MemorySecrets::default();
        assert!(!s.has("k").unwrap());
        s.set("k", "v").unwrap();
        assert_eq!(s.get("k").unwrap().as_deref(), Some("v"));
        s.delete("k").unwrap();
        assert!(!s.has("k").unwrap());
    }

    #[test]
    fn subscription_projects_get_no_env() {
        let s = MemorySecrets::default();
        let out = options_for_sidecar(&project(AuthMode::Subscription), &RunOptions::default(), &s)
            .unwrap();
        assert!(out.env.is_none());
    }

    #[test]
    fn api_key_projects_inject_the_key_only_in_the_copy() {
        let s = MemorySecrets::default();
        s.set(&project_api_key_name("p1"), "sk-ant-teste").unwrap();
        let original = RunOptions::default();
        let out = options_for_sidecar(&project(AuthMode::ApiKey), &original, &s).unwrap();
        assert_eq!(
            out.env
                .as_ref()
                .unwrap()
                .get(API_KEY_ENV)
                .map(String::as_str),
            Some("sk-ant-teste")
        );
        assert!(
            original.env.is_none(),
            "as opções persistidas não levam a chave"
        );
    }

    #[test]
    fn api_key_projects_without_a_key_are_refused() {
        let s = MemorySecrets::default();
        let err = options_for_sidecar(&project(AuthMode::ApiKey), &RunOptions::default(), &s)
            .unwrap_err();
        assert!(err.to_string().contains("nenhuma chave está no Keychain"));
    }
}
