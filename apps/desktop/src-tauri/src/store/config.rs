//! Backup local de configurações: export/import em JSON legível e cópias versionadas em disco.
//!
//! O export cobre só configuração (projetos, preferências e, nas fases seguintes, cargos, time,
//! workflows etc.). Nunca inclui runs, eventos, aprovações, chaves ou memória.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::models::{AuthMode, Project};
use super::{new_id, now, Store};

/// Versão do formato do arquivo exportado. Incrementa em mudanças incompatíveis.
pub const CONFIG_SCHEMA_VERSION: u32 = 1;
/// Quantas cópias automáticas ficam guardadas.
pub const MAX_SNAPSHOTS: usize = 20;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigExport {
    pub schema_version: u32,
    pub exported_at: String,
    pub app_version: String,
    #[serde(default)]
    pub settings: BTreeMap<String, Value>,
    #[serde(default)]
    pub projects: Vec<Project>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ImportMode {
    /// Acrescenta o que não existe; mantém o que já está igual ou em conflito.
    Merge,
    /// O arquivo passa a ser a verdade: atualiza, acrescenta e remove o que não está nele.
    Replace,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    pub schema_version: u32,
    pub exported_at: String,
    pub projects_new: Vec<String>,
    pub projects_same: Vec<String>,
    /// Mesmo id ou mesma pasta, dados diferentes.
    pub projects_conflict: Vec<String>,
    /// Projetos locais ausentes do arquivo (removidos no modo `replace`, junto com o histórico).
    pub projects_removed: Vec<String>,
    pub settings: usize,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub projects_added: usize,
    pub projects_updated: usize,
    pub projects_removed: usize,
    pub settings_applied: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SnapshotReason {
    Auto,
    Manual,
    PreRestore,
}

impl SnapshotReason {
    pub fn as_str(&self) -> &'static str {
        match self {
            SnapshotReason::Auto => "auto",
            SnapshotReason::Manual => "manual",
            SnapshotReason::PreRestore => "pre-restore",
        }
    }
    fn parse(value: &str) -> Self {
        match value {
            "manual" => SnapshotReason::Manual,
            "pre-restore" => SnapshotReason::PreRestore,
            _ => SnapshotReason::Auto,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupSnapshot {
    pub id: String,
    pub created_at: String,
    pub path: String,
    pub schema_version: u32,
    pub reason: SnapshotReason,
    pub size_bytes: u64,
}

impl Store {
    // ------------------------------------------------------------------ preferências

    pub fn get_setting(&self, key: &str) -> Result<Option<Value>> {
        let conn = self.conn.lock().expect("store mutex");
        let raw: Option<String> = conn
            .query_row(
                "SELECT value_json FROM app_setting WHERE key = ?1",
                params![key],
                |r| r.get(0),
            )
            .optional()?;
        Ok(raw.map(|s| serde_json::from_str(&s)).transpose()?)
    }

    pub fn set_setting(&self, key: &str, value: &Value) -> Result<()> {
        let conn = self.conn.lock().expect("store mutex");
        conn.execute(
            "INSERT INTO app_setting (key, value_json, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
            params![key, serde_json::to_string(value)?, now()],
        )?;
        Ok(())
    }

    pub fn delete_setting(&self, key: &str) -> Result<bool> {
        let conn = self.conn.lock().expect("store mutex");
        Ok(conn.execute("DELETE FROM app_setting WHERE key = ?1", params![key])? > 0)
    }

    pub fn list_settings(&self) -> Result<BTreeMap<String, Value>> {
        let conn = self.conn.lock().expect("store mutex");
        let mut stmt = conn.prepare("SELECT key, value_json FROM app_setting ORDER BY key")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        let mut map = BTreeMap::new();
        for row in rows {
            let (key, raw) = row?;
            map.insert(key, serde_json::from_str(&raw)?);
        }
        Ok(map)
    }

    // ------------------------------------------------------------------ export / import

    pub fn export_config(&self, app_version: &str) -> Result<ConfigExport> {
        Ok(ConfigExport {
            schema_version: CONFIG_SCHEMA_VERSION,
            exported_at: now(),
            app_version: app_version.to_string(),
            settings: self.list_settings()?,
            projects: self.list_projects()?,
        })
    }

    pub fn preview_import(&self, export: &ConfigExport) -> Result<ImportPreview> {
        let local = self.list_projects()?;
        let mut preview = ImportPreview {
            schema_version: export.schema_version,
            exported_at: export.exported_at.clone(),
            settings: export.settings.len(),
            ..Default::default()
        };
        for incoming in &export.projects {
            match local
                .iter()
                .find(|p| p.id == incoming.id || p.path == incoming.path)
            {
                None => preview.projects_new.push(incoming.name.clone()),
                Some(existing) if same_project(existing, incoming) => {
                    preview.projects_same.push(incoming.name.clone())
                }
                Some(existing) => preview
                    .projects_conflict
                    .push(format!("{} ↔ {}", incoming.name, existing.name)),
            }
        }
        for existing in &local {
            if !export
                .projects
                .iter()
                .any(|p| p.id == existing.id || p.path == existing.path)
            {
                preview.projects_removed.push(existing.name.clone());
            }
        }
        Ok(preview)
    }

    pub fn import_config(&self, export: &ConfigExport, mode: ImportMode) -> Result<ImportResult> {
        if export.schema_version > CONFIG_SCHEMA_VERSION {
            anyhow::bail!(
                "arquivo exportado por uma versão mais nova (schema {}); esta versão lê até {}",
                export.schema_version,
                CONFIG_SCHEMA_VERSION
            );
        }
        let local = self.list_projects()?;
        let mut result = ImportResult::default();
        {
            let mut conn = self.conn.lock().expect("store mutex");
            let tx = conn.transaction()?;
            for incoming in &export.projects {
                let existing = local
                    .iter()
                    .find(|p| p.id == incoming.id || p.path == incoming.path);
                match (existing, mode) {
                    (None, _) => {
                        tx.execute(
                            "INSERT INTO project (id, name, path, auth_mode, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                            params![incoming.id, incoming.name, incoming.path, incoming.auth_mode.as_str(), incoming.created_at],
                        )?;
                        result.projects_added += 1;
                    }
                    (Some(existing), ImportMode::Replace) if !same_project(existing, incoming) => {
                        tx.execute(
                            "UPDATE project SET name = ?2, path = ?3, auth_mode = ?4 WHERE id = ?1",
                            params![
                                existing.id,
                                incoming.name,
                                incoming.path,
                                incoming.auth_mode.as_str()
                            ],
                        )?;
                        result.projects_updated += 1;
                    }
                    _ => {}
                }
            }
            if mode == ImportMode::Replace {
                for existing in &local {
                    if !export
                        .projects
                        .iter()
                        .any(|p| p.id == existing.id || p.path == existing.path)
                    {
                        tx.execute("DELETE FROM project WHERE id = ?1", params![existing.id])?;
                        result.projects_removed += 1;
                    }
                }
                tx.execute("DELETE FROM app_setting", [])?;
            }
            for (key, value) in &export.settings {
                tx.execute(
                    "INSERT INTO app_setting (key, value_json, updated_at) VALUES (?1, ?2, ?3)
                     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
                    params![key, serde_json::to_string(value)?, now()],
                )?;
                result.settings_applied += 1;
            }
            tx.commit()?;
        }
        Ok(result)
    }

    // ------------------------------------------------------------------ cópias em disco

    /// Pasta das cópias (`<dados>/backups`), ou `None` em bancos em memória.
    pub fn backup_dir(&self) -> Option<&Path> {
        self.backup_dir.as_deref()
    }

    /// Grava uma cópia da configuração atual e poda as mais antigas (só as automáticas contam para o limite).
    pub fn write_snapshot(
        &self,
        reason: SnapshotReason,
        app_version: &str,
    ) -> Result<BackupSnapshot> {
        let dir = self
            .backup_dir
            .clone()
            .context("backups indisponíveis para um banco em memória")?;
        std::fs::create_dir_all(&dir).with_context(|| format!("criando {}", dir.display()))?;
        let export = self.export_config(app_version)?;
        let stamp = export.exported_at.replace([':', '.'], "-");
        let id = new_id("bkp");
        let path = dir.join(format!("octopus-config-{stamp}-{}.json", reason.as_str()));
        let json = serde_json::to_string_pretty(&export)?;
        std::fs::write(&path, &json).with_context(|| format!("gravando {}", path.display()))?;
        let snapshot = BackupSnapshot {
            id,
            created_at: export.exported_at.clone(),
            path: path.to_string_lossy().into_owned(),
            schema_version: export.schema_version,
            reason,
            size_bytes: json.len() as u64,
        };
        {
            let conn = self.conn.lock().expect("store mutex");
            conn.execute(
                "INSERT INTO backup_snapshot (id, created_at, path, schema_version, reason, size_bytes) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![snapshot.id, snapshot.created_at, snapshot.path, snapshot.schema_version, snapshot.reason.as_str(), snapshot.size_bytes as i64],
            )?;
        }
        self.prune_snapshots()?;
        Ok(snapshot)
    }

    fn prune_snapshots(&self) -> Result<()> {
        let all = self.list_snapshots()?;
        let automatic: Vec<&BackupSnapshot> = all
            .iter()
            .filter(|s| s.reason == SnapshotReason::Auto)
            .collect();
        if automatic.len() <= MAX_SNAPSHOTS {
            return Ok(());
        }
        for old in &automatic[MAX_SNAPSHOTS..] {
            let _ = std::fs::remove_file(&old.path);
            let conn = self.conn.lock().expect("store mutex");
            conn.execute("DELETE FROM backup_snapshot WHERE id = ?1", params![old.id])?;
        }
        Ok(())
    }

    /// Cópias registradas, mais recentes primeiro. Cópias cujo arquivo sumiu são removidas do registro.
    pub fn list_snapshots(&self) -> Result<Vec<BackupSnapshot>> {
        let rows = {
            let conn = self.conn.lock().expect("store mutex");
            let mut stmt = conn.prepare(
                "SELECT id, created_at, path, schema_version, reason, size_bytes FROM backup_snapshot ORDER BY created_at DESC",
            )?;
            let collected = stmt
                .query_map([], |r| {
                    Ok(BackupSnapshot {
                        id: r.get(0)?,
                        created_at: r.get(1)?,
                        path: r.get(2)?,
                        schema_version: r.get::<_, i64>(3)? as u32,
                        reason: SnapshotReason::parse(&r.get::<_, String>(4)?),
                        size_bytes: r.get::<_, i64>(5)? as u64,
                    })
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            collected
        };
        let (present, gone): (Vec<_>, Vec<_>) =
            rows.into_iter().partition(|s| Path::new(&s.path).is_file());
        if !gone.is_empty() {
            let conn = self.conn.lock().expect("store mutex");
            for s in gone {
                conn.execute("DELETE FROM backup_snapshot WHERE id = ?1", params![s.id])?;
            }
        }
        Ok(present)
    }

    pub fn get_snapshot(&self, id: &str) -> Result<Option<BackupSnapshot>> {
        Ok(self.list_snapshots()?.into_iter().find(|s| s.id == id))
    }

    /// Restaura uma cópia registrada, gravando antes uma cópia `pre-restore`.
    pub fn restore_snapshot(
        &self,
        id: &str,
        mode: ImportMode,
        app_version: &str,
    ) -> Result<ImportResult> {
        let snapshot = self
            .get_snapshot(id)?
            .with_context(|| format!("cópia {id} não encontrada"))?;
        let export = read_export(Path::new(&snapshot.path))?;
        self.write_snapshot(SnapshotReason::PreRestore, app_version)?;
        self.import_config(&export, mode)
    }
}

pub fn read_export(path: &Path) -> Result<ConfigExport> {
    let text =
        std::fs::read_to_string(path).with_context(|| format!("lendo {}", path.display()))?;
    let export: ConfigExport = serde_json::from_str(&text)
        .with_context(|| format!("{} não é um export válido", path.display()))?;
    Ok(export)
}

pub fn default_backup_dir(db_path: &Path) -> Option<PathBuf> {
    db_path.parent().map(|p| p.join("backups"))
}

fn same_project(a: &Project, b: &Project) -> bool {
    a.id == b.id && a.name == b.name && a.path == b.path && a.auth_mode == b.auth_mode
}

impl AuthMode {
    pub fn parse_opt(value: &str) -> Option<Self> {
        match value {
            "subscription" => Some(AuthMode::Subscription),
            "api_key" => Some(AuthMode::ApiKey),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn disk_store() -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("octopus.db")).unwrap();
        (dir, store)
    }

    #[test]
    fn settings_roundtrip_and_list() {
        let s = Store::open_in_memory().unwrap();
        assert!(s.get_setting("theme").unwrap().is_none());
        s.set_setting("theme", &serde_json::json!("dark")).unwrap();
        s.set_setting(
            "onboarding.completed_at",
            &serde_json::json!("2026-10-16T18:00:00Z"),
        )
        .unwrap();
        s.set_setting("theme", &serde_json::json!("light")).unwrap();
        assert_eq!(
            s.get_setting("theme").unwrap(),
            Some(serde_json::json!("light"))
        );
        assert_eq!(s.list_settings().unwrap().len(), 2);
        assert!(s.delete_setting("theme").unwrap());
        assert!(!s.delete_setting("theme").unwrap());
    }

    #[test]
    fn export_import_merge_and_replace() {
        let a = Store::open_in_memory().unwrap();
        let p1 = a.create_project("alpha", "/tmp/alpha").unwrap();
        a.create_project("beta", "/tmp/beta").unwrap();
        a.set_setting("theme", &serde_json::json!("dark")).unwrap();
        let export = a.export_config("0.1.0").unwrap();
        assert_eq!(export.schema_version, CONFIG_SCHEMA_VERSION);
        assert_eq!(export.projects.len(), 2);
        // Roundtrip JSON (é o que vai para o arquivo).
        let json = serde_json::to_string_pretty(&export).unwrap();
        assert!(!json.contains("run_event"));
        let parsed: ConfigExport = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, export);

        // Outro banco: alpha existe com nome diferente, gamma só aqui.
        let b = Store::open_in_memory().unwrap();
        let conn_insert = |id: &str, name: &str, path: &str| {
            let conn = b.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO project (id, name, path, auth_mode, created_at) VALUES (?1, ?2, ?3, 'subscription', 't')",
                params![id, name, path],
            )
            .unwrap();
        };
        conn_insert(&p1.id, "alpha-renomeado", "/tmp/alpha");
        conn_insert("proj_gamma", "gamma", "/tmp/gamma");
        b.set_setting("theme", &serde_json::json!("light")).unwrap();
        b.set_setting("local-only", &serde_json::json!(1)).unwrap();

        let preview = b.preview_import(&export).unwrap();
        assert_eq!(preview.projects_new, vec!["beta"]);
        assert!(preview.projects_same.is_empty());
        assert_eq!(preview.projects_conflict, vec!["alpha ↔ alpha-renomeado"]);
        assert_eq!(preview.projects_removed, vec!["gamma"]);
        assert_eq!(preview.settings, 1);

        let merged = b.import_config(&export, ImportMode::Merge).unwrap();
        assert_eq!(
            merged,
            ImportResult {
                projects_added: 1,
                projects_updated: 0,
                projects_removed: 0,
                settings_applied: 1
            }
        );
        let names: Vec<String> = b
            .list_projects()
            .unwrap()
            .into_iter()
            .map(|p| p.name)
            .collect();
        assert!(
            names.contains(&"alpha-renomeado".to_string()),
            "merge mantém o conflito local"
        );
        assert!(names.contains(&"gamma".to_string()));
        assert_eq!(
            b.get_setting("theme").unwrap(),
            Some(serde_json::json!("dark"))
        );
        assert!(b.get_setting("local-only").unwrap().is_some());

        let replaced = b.import_config(&export, ImportMode::Replace).unwrap();
        assert_eq!(
            replaced,
            ImportResult {
                projects_added: 0,
                projects_updated: 1,
                projects_removed: 1,
                settings_applied: 1
            }
        );
        let mut names: Vec<String> = b
            .list_projects()
            .unwrap()
            .into_iter()
            .map(|p| p.name)
            .collect();
        names.sort();
        assert_eq!(names, vec!["alpha", "beta"]);
        assert!(
            b.get_setting("local-only").unwrap().is_none(),
            "replace limpa preferências ausentes"
        );
    }

    #[test]
    fn rejects_newer_schema() {
        let s = Store::open_in_memory().unwrap();
        let export = ConfigExport {
            schema_version: CONFIG_SCHEMA_VERSION + 1,
            exported_at: "t".into(),
            app_version: "9".into(),
            settings: BTreeMap::new(),
            projects: vec![],
        };
        assert!(s.import_config(&export, ImportMode::Merge).is_err());
    }

    #[test]
    fn snapshots_are_written_listed_pruned_and_restored() {
        let (dir, s) = disk_store();
        assert_eq!(s.backup_dir().unwrap(), dir.path().join("backups"));
        s.create_project("alpha", "/tmp/alpha").unwrap();
        let first = s.write_snapshot(SnapshotReason::Manual, "0.1.0").unwrap();
        assert!(Path::new(&first.path).is_file());
        assert_eq!(first.reason, SnapshotReason::Manual);
        assert!(first.size_bytes > 0);

        for _ in 0..(MAX_SNAPSHOTS + 3) {
            s.write_snapshot(SnapshotReason::Auto, "0.1.0").unwrap();
        }
        let list = s.list_snapshots().unwrap();
        let autos = list
            .iter()
            .filter(|x| x.reason == SnapshotReason::Auto)
            .count();
        assert_eq!(
            autos, MAX_SNAPSHOTS,
            "poda mantém só as últimas automáticas"
        );
        assert!(
            list.iter().any(|x| x.id == first.id),
            "a manual não é podada"
        );
        assert_eq!(
            std::fs::read_dir(dir.path().join("backups"))
                .unwrap()
                .count(),
            MAX_SNAPSHOTS + 1
        );

        // Muda a configuração e restaura a primeira cópia: volta ao estado antigo e gera pre-restore.
        s.create_project("beta", "/tmp/beta").unwrap();
        let result = s
            .restore_snapshot(&first.id, ImportMode::Replace, "0.1.0")
            .unwrap();
        assert_eq!(result.projects_removed, 1);
        let names: Vec<String> = s
            .list_projects()
            .unwrap()
            .into_iter()
            .map(|p| p.name)
            .collect();
        assert_eq!(names, vec!["alpha"]);
        assert!(s
            .list_snapshots()
            .unwrap()
            .iter()
            .any(|x| x.reason == SnapshotReason::PreRestore));

        // Arquivo apagado por fora some da lista.
        std::fs::remove_file(&first.path).unwrap();
        assert!(s.get_snapshot(&first.id).unwrap().is_none());
        assert!(s
            .restore_snapshot(&first.id, ImportMode::Merge, "0.1.0")
            .is_err());
    }

    #[test]
    fn in_memory_store_has_no_backups() {
        let s = Store::open_in_memory().unwrap();
        assert!(s.backup_dir().is_none());
        assert!(s.write_snapshot(SnapshotReason::Auto, "0.1.0").is_err());
    }
}
