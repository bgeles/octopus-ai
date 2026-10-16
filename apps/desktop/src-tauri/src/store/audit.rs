//! Auditoria append-only: cada evento carrega o hash do anterior e o seu próprio
//! (`sha256(prev_hash | ts | actor | kind | project_id | payload_json)`). Editar uma linha
//! fora do app quebra a verificação da cadeia a partir dela.

use anyhow::Result;
use rusqlite::{params, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::{now, Store};

/// Hash "zero" do primeiro evento.
pub const GENESIS_HASH: &str = "0000000000000000000000000000000000000000000000000000000000000000";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEvent {
    pub seq: i64,
    pub ts: String,
    pub actor: String,
    pub kind: String,
    pub project_id: Option<String>,
    pub payload: Value,
    pub prev_hash: String,
    pub hash: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditVerification {
    pub ok: bool,
    pub events: u64,
    /// Primeiro evento cujo hash não confere (ou cujo prev_hash não bate com o anterior).
    pub first_broken_seq: Option<i64>,
    pub intact_before: u64,
    pub checked_at: String,
}

pub fn compute_hash(
    prev_hash: &str,
    ts: &str,
    actor: &str,
    kind: &str,
    project_id: Option<&str>,
    payload_json: &str,
) -> String {
    let mut hasher = Sha256::new();
    for part in [
        prev_hash,
        ts,
        actor,
        kind,
        project_id.unwrap_or(""),
        payload_json,
    ] {
        hasher.update(part.as_bytes());
        hasher.update([0u8]);
    }
    hex(&hasher.finalize())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

impl Store {
    /// Acrescenta um evento ao log, dentro de uma transação para o encadeamento ser atômico.
    pub fn audit(
        &self,
        actor: &str,
        kind: &str,
        project_id: Option<&str>,
        payload: Value,
    ) -> Result<AuditEvent> {
        let mut conn = self.conn.lock().expect("store mutex");
        let tx = conn.transaction()?;
        let event = Self::audit_in(&tx, actor, kind, project_id, payload)?;
        tx.commit()?;
        Ok(event)
    }

    pub(crate) fn audit_in(
        tx: &Transaction<'_>,
        actor: &str,
        kind: &str,
        project_id: Option<&str>,
        payload: Value,
    ) -> Result<AuditEvent> {
        let prev_hash: String = tx
            .query_row(
                "SELECT hash FROM audit_event ORDER BY seq DESC LIMIT 1",
                [],
                |r| r.get(0),
            )
            .unwrap_or_else(|_| GENESIS_HASH.to_string());
        let ts = now();
        let payload_json = serde_json::to_string(&payload)?;
        let hash = compute_hash(&prev_hash, &ts, actor, kind, project_id, &payload_json);
        tx.execute(
            "INSERT INTO audit_event (ts, actor, kind, project_id, payload_json, prev_hash, hash) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![ts, actor, kind, project_id, payload_json, prev_hash, hash],
        )?;
        let seq = tx.last_insert_rowid();
        Ok(AuditEvent {
            seq,
            ts,
            actor: actor.to_string(),
            kind: kind.to_string(),
            project_id: project_id.map(str::to_string),
            payload,
            prev_hash,
            hash,
        })
    }

    /// Eventos mais recentes primeiro; `kind_prefix` filtra por família (`policy.`, `approval.`...).
    pub fn list_audit_events(
        &self,
        project_id: Option<&str>,
        kind_prefix: Option<&str>,
        limit: u32,
    ) -> Result<Vec<AuditEvent>> {
        let conn = self.conn.lock().expect("store mutex");
        let prefix = format!("{}%", kind_prefix.unwrap_or(""));
        let mut stmt = conn.prepare(
            "SELECT seq, ts, actor, kind, project_id, payload_json, prev_hash, hash FROM audit_event
             WHERE (?1 IS NULL OR project_id = ?1 OR project_id IS NULL) AND kind LIKE ?2
             ORDER BY seq DESC LIMIT ?3",
        )?;
        let rows = stmt
            .query_map(params![project_id, prefix, limit], row_to_event)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn audit_count(&self) -> Result<u64> {
        let conn = self.conn.lock().expect("store mutex");
        Ok(conn.query_row("SELECT COUNT(*) FROM audit_event", [], |r| {
            r.get::<_, i64>(0)
        })? as u64)
    }

    /// Recalcula a cadeia inteira e aponta o primeiro evento adulterado.
    pub fn verify_audit(&self) -> Result<AuditVerification> {
        let conn = self.conn.lock().expect("store mutex");
        let mut stmt = conn.prepare("SELECT seq, ts, actor, kind, project_id, payload_json, prev_hash, hash FROM audit_event ORDER BY seq")?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, Option<String>>(4)?,
                r.get::<_, String>(5)?,
                r.get::<_, String>(6)?,
                r.get::<_, String>(7)?,
            ))
        })?;
        let mut expected_prev = GENESIS_HASH.to_string();
        let mut events = 0u64;
        let mut first_broken = None;
        for row in rows {
            let (seq, ts, actor, kind, project_id, payload_json, prev_hash, hash) = row?;
            if first_broken.is_none() {
                let recomputed = compute_hash(
                    &prev_hash,
                    &ts,
                    &actor,
                    &kind,
                    project_id.as_deref(),
                    &payload_json,
                );
                if prev_hash != expected_prev || recomputed != hash {
                    first_broken = Some(seq);
                }
            }
            expected_prev = hash;
            events += 1;
        }
        let intact_before = match first_broken {
            Some(seq) => (seq - 1).max(0) as u64,
            None => events,
        };
        Ok(AuditVerification {
            ok: first_broken.is_none(),
            events,
            first_broken_seq: first_broken,
            intact_before,
            checked_at: now(),
        })
    }

    /// JSONL do log inteiro (mais antigo primeiro), para verificação externa.
    pub fn export_audit_jsonl(&self) -> Result<String> {
        let conn = self.conn.lock().expect("store mutex");
        let mut stmt = conn.prepare("SELECT seq, ts, actor, kind, project_id, payload_json, prev_hash, hash FROM audit_event ORDER BY seq")?;
        let rows = stmt
            .query_map([], row_to_event)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let mut out = String::new();
        for event in rows {
            out.push_str(&serde_json::to_string(&event)?);
            out.push('\n');
        }
        Ok(out)
    }
}

fn row_to_event(r: &rusqlite::Row<'_>) -> rusqlite::Result<AuditEvent> {
    let payload_json: String = r.get(5)?;
    Ok(AuditEvent {
        seq: r.get(0)?,
        ts: r.get(1)?,
        actor: r.get(2)?,
        kind: r.get(3)?,
        project_id: r.get(4)?,
        payload: serde_json::from_str(&payload_json).unwrap_or(Value::Null),
        prev_hash: r.get(6)?,
        hash: r.get(7)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;

    #[test]
    fn chain_links_events_and_verifies() {
        let s = Store::open_in_memory().unwrap();
        assert!(s.verify_audit().unwrap().ok);
        let a = s
            .audit(
                "você",
                "config.sandbox",
                Some("proj_1"),
                serde_json::json!({"profile": "estrito"}),
            )
            .unwrap();
        assert_eq!(a.prev_hash, GENESIS_HASH);
        assert_eq!(a.hash.len(), 64);
        let b = s
            .audit(
                "política",
                "policy.deny",
                Some("proj_1"),
                serde_json::json!({"tool": "Bash"}),
            )
            .unwrap();
        assert_eq!(b.prev_hash, a.hash);
        let c = s
            .audit(
                "sistema",
                "run.finished",
                None,
                serde_json::json!({"runId": "r1"}),
            )
            .unwrap();
        assert_eq!(c.prev_hash, b.hash);

        let v = s.verify_audit().unwrap();
        assert!(v.ok);
        assert_eq!(v.events, 3);
        assert_eq!(v.intact_before, 3);

        let list = s.list_audit_events(Some("proj_1"), None, 10).unwrap();
        assert_eq!(
            list.iter().map(|e| e.seq).collect::<Vec<_>>(),
            vec![3, 2, 1],
            "mais recente primeiro; eventos sem projeto entram"
        );
        let only_policy = s.list_audit_events(None, Some("policy."), 10).unwrap();
        assert_eq!(only_policy.len(), 1);
        assert_eq!(only_policy[0].payload["tool"], "Bash");
        let other = s.list_audit_events(Some("proj_2"), None, 10).unwrap();
        assert_eq!(other.len(), 1, "só o evento global");
        assert_eq!(s.export_audit_jsonl().unwrap().lines().count(), 3);
    }

    #[test]
    fn tampering_breaks_verification_from_that_event_on() {
        let s = Store::open_in_memory().unwrap();
        for i in 0..5 {
            s.audit("você", "approval.allow", None, serde_json::json!({"i": i}))
                .unwrap();
        }
        {
            let conn = s.conn.lock().unwrap();
            conn.execute(
                "UPDATE audit_event SET payload_json = ?1 WHERE seq = 3",
                params![r#"{"i":99}"#],
            )
            .unwrap();
        }
        let v = s.verify_audit().unwrap();
        assert!(!v.ok);
        assert_eq!(v.first_broken_seq, Some(3));
        assert_eq!(v.intact_before, 2);
        assert_eq!(v.events, 5);

        // Apagar um evento do meio também quebra (prev_hash do seguinte não bate).
        let s2 = Store::open_in_memory().unwrap();
        for i in 0..4 {
            s2.audit("você", "x", None, serde_json::json!(i)).unwrap();
        }
        s2.conn
            .lock()
            .unwrap()
            .execute("DELETE FROM audit_event WHERE seq = 2", [])
            .unwrap();
        let v2 = s2.verify_audit().unwrap();
        assert_eq!(v2.first_broken_seq, Some(3));
    }

    #[test]
    fn hash_is_deterministic_and_sensitive() {
        let h1 = compute_hash(GENESIS_HASH, "t", "a", "k", None, "{}");
        let h2 = compute_hash(GENESIS_HASH, "t", "a", "k", None, "{}");
        let h3 = compute_hash(GENESIS_HASH, "t", "a", "k", Some("p"), "{}");
        assert_eq!(h1, h2);
        assert_ne!(h1, h3);
    }
}
