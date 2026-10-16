//! Memória do projeto: observações capturadas por hooks (sanitizadas), wiki em markdown com índice
//! FTS5 e consolidação bruta ao fim de cada run (log de tarefas). Os arquivos `.md` em
//! `<dados>/projects/<id>/memory/wiki` são a fonte da verdade; o banco é índice reconstruível.

use anyhow::{Context, Result};
use regex::Regex;
use rusqlite::{params, OptionalExtension, Row, Transaction};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use super::{new_id, now, Store};
use crate::protocol::{MemoryCallResult, MemoryOp, ObservationKind};

/// Tamanho máximo do brief injetado no contexto do agente.
pub const MAX_BRIEF_CHARS: usize = 3_000;

pub const REDACTED: &str = "[redigido]";
pub const PAGE_KINDS: &[&str] = &[
    "decisions",
    "architecture",
    "pitfalls",
    "tasklog",
    "handoff",
    "note",
];

// ---------------------------------------------------------------------- sanitização

struct Rule {
    re: Regex,
    /// `true`: substitui só o grupo 2 (valor), mantendo o nome da chave.
    keep_key: bool,
}

static RULES: LazyLock<Vec<Rule>> = LazyLock::new(|| {
    let plain = |p: &str| Rule {
        re: Regex::new(p).expect("regex válida"),
        keep_key: false,
    };
    let kv = |p: &str| Rule {
        re: Regex::new(p).expect("regex válida"),
        keep_key: true,
    };
    vec![
        plain(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----"),
        plain(r"sk-ant-[A-Za-z0-9_\-]{8,}"),
        plain(r"\bsk-[A-Za-z0-9]{20,}"),
        plain(r"\bgh[pousr]_[A-Za-z0-9]{20,}"),
        plain(r"\bAKIA[0-9A-Z]{16}\b"),
        plain(r"\bxox[baprs]-[A-Za-z0-9\-]{10,}"),
        plain(r"\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}"),
        plain(r"(?i)\bbearer\s+[A-Za-z0-9._\-]{16,}"),
        // usuário:senha@host em URLs
        plain(r"://[^/\s:@]+:[^@\s/]+@"),
        kv(
            r#"(?i)\b([A-Z0-9_]*(?:api[_-]?key|token|secret|password|passwd|senha|credential)[A-Z0-9_]*)\s*[=:]\s*["']?([^\s"'&;,]{6,})"#,
        ),
    ]
});

/// Remove segredos conhecidos; devolve o texto e se algo foi redigido.
pub fn sanitize(text: &str) -> (String, bool) {
    let mut out = text.to_string();
    let mut redacted = false;
    for rule in RULES.iter() {
        if !rule.re.is_match(&out) {
            continue;
        }
        redacted = true;
        out = if rule.keep_key {
            rule.re
                .replace_all(&out, |c: &regex::Captures| {
                    format!("{}={}", &c[1], REDACTED)
                })
                .into_owned()
        } else {
            rule.re
                .replace_all(&out, |c: &regex::Captures| {
                    if c[0].starts_with("://") {
                        format!("://{REDACTED}@")
                    } else {
                        REDACTED.to_string()
                    }
                })
                .into_owned()
        };
    }
    (out, redacted)
}

pub fn slugify(title: &str) -> String {
    let mut s = String::new();
    let mut dash = false;
    for ch in title.chars() {
        let c = fold_char(ch);
        if c.is_ascii_alphanumeric() {
            s.push(c.to_ascii_lowercase());
            dash = false;
        } else if !dash && !s.is_empty() {
            s.push('-');
            dash = true;
        }
    }
    let s = s.trim_end_matches('-').to_string();
    if s.is_empty() {
        "pagina".into()
    } else {
        s.chars().take(80).collect()
    }
}

fn fold_char(ch: char) -> char {
    match ch {
        'á' | 'à' | 'â' | 'ã' | 'ä' | 'Á' | 'À' | 'Â' | 'Ã' | 'Ä' => 'a',
        'é' | 'è' | 'ê' | 'ë' | 'É' | 'È' | 'Ê' | 'Ë' => 'e',
        'í' | 'ì' | 'î' | 'ï' | 'Í' | 'Ì' | 'Î' | 'Ï' => 'i',
        'ó' | 'ò' | 'ô' | 'õ' | 'ö' | 'Ó' | 'Ò' | 'Ô' | 'Õ' | 'Ö' => 'o',
        'ú' | 'ù' | 'û' | 'ü' | 'Ú' | 'Ù' | 'Û' | 'Ü' => 'u',
        'ç' | 'Ç' => 'c',
        'ñ' | 'Ñ' => 'n',
        other => other,
    }
}

// ---------------------------------------------------------------------- modelos

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryObservation {
    pub id: String,
    pub project_id: String,
    pub run_id: Option<String>,
    pub task_id: Option<String>,
    pub agent_profile_id: Option<String>,
    pub kind: String,
    pub title: String,
    pub body: String,
    pub tool_name: Option<String>,
    pub redacted: bool,
    pub created_at: String,
    pub consolidated_at: Option<String>,
}

impl MemoryObservation {
    const SELECT: &'static str = "SELECT id, project_id, run_id, task_id, agent_profile_id, kind, title, body, tool_name, redacted, created_at, consolidated_at FROM memory_observation";
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get(0)?,
            project_id: row.get(1)?,
            run_id: row.get(2)?,
            task_id: row.get(3)?,
            agent_profile_id: row.get(4)?,
            kind: row.get(5)?,
            title: row.get(6)?,
            body: row.get(7)?,
            tool_name: row.get(8)?,
            redacted: row.get::<_, i64>(9)? != 0,
            created_at: row.get(10)?,
            consolidated_at: row.get(11)?,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryPage {
    pub id: String,
    pub project_id: String,
    pub kind: String,
    pub slug: String,
    pub title: String,
    pub body_md: String,
    pub score: f64,
    pub access_count: u64,
    pub last_accessed_at: Option<String>,
    pub source: String,
    pub created_at: String,
    pub updated_at: String,
    pub archived_at: Option<String>,
    pub versions: u64,
}

impl MemoryPage {
    const SELECT: &'static str = "SELECT p.id, p.project_id, p.kind, p.slug, p.title, p.body_md, p.score, p.access_count, p.last_accessed_at, p.source, p.created_at, p.updated_at, p.archived_at,
        (SELECT COUNT(*) FROM memory_page_version v WHERE v.page_id = p.id) FROM memory_page p";
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get(0)?,
            project_id: row.get(1)?,
            kind: row.get(2)?,
            slug: row.get(3)?,
            title: row.get(4)?,
            body_md: row.get(5)?,
            score: row.get(6)?,
            access_count: row.get::<_, i64>(7)? as u64,
            last_accessed_at: row.get(8)?,
            source: row.get(9)?,
            created_at: row.get(10)?,
            updated_at: row.get(11)?,
            archived_at: row.get(12)?,
            versions: row.get::<_, i64>(13)? as u64,
        })
    }

    /// Arquivo markdown da página na wiki.
    pub fn to_markdown(&self) -> String {
        format!(
            "---\nid: {}\nkind: {}\ntitle: {}\nscore: {:.3}\nsource: {}\ncreated_at: {}\nupdated_at: {}\narchived_at: {}\n---\n\n{}\n",
            self.id,
            self.kind,
            self.title.replace('\n', " "),
            self.score,
            self.source,
            self.created_at,
            self.updated_at,
            self.archived_at.as_deref().unwrap_or(""),
            self.body_md.trim_end()
        )
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryPageVersion {
    pub id: String,
    pub page_id: String,
    pub title: String,
    pub body_md: String,
    pub reason: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemorySearchHit {
    pub page: MemoryPage,
    pub snippet: String,
    pub rank: f64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryPageInput {
    pub project_id: String,
    #[serde(default)]
    pub page_id: Option<String>,
    pub kind: String,
    pub title: String,
    pub body_md: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextEvent {
    pub id: String,
    pub project_id: String,
    pub run_id: String,
    pub kind: String,
    pub payload: serde_json::Value,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryHandoff {
    pub id: String,
    pub project_id: String,
    pub task_id: Option<String>,
    pub run_id: Option<String>,
    pub body_md: String,
    pub source: String,
    pub created_at: String,
    pub consumed_by_run_id: Option<String>,
    pub consumed_at: Option<String>,
}

impl MemoryHandoff {
    const SELECT: &'static str = "SELECT id, project_id, task_id, run_id, body_md, source, created_at, consumed_by_run_id, consumed_at FROM memory_handoff";
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get(0)?,
            project_id: row.get(1)?,
            task_id: row.get(2)?,
            run_id: row.get(3)?,
            body_md: row.get(4)?,
            source: row.get(5)?,
            created_at: row.get(6)?,
            consumed_by_run_id: row.get(7)?,
            consumed_at: row.get(8)?,
        })
    }
}

/// O que entra no contexto do agente no início do run.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryBrief {
    pub text: String,
    pub items: Vec<String>,
}

// ---------------------------------------------------------------------- store

impl Store {
    /// Pasta da wiki do projeto; `None` em memória (sem arquivos).
    pub fn wiki_dir(&self, project_id: &str) -> Option<PathBuf> {
        self.data_dir.as_ref().map(|d| {
            d.join("projects")
                .join(project_id)
                .join("memory")
                .join("wiki")
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn record_observation_in(
        tx: &Transaction<'_>,
        project_id: &str,
        run_id: &str,
        kind: ObservationKind,
        title: &str,
        body: &str,
        tool_name: Option<&str>,
        at: &str,
    ) -> Result<()> {
        let (task_id, agent_id): (Option<String>, Option<String>) = tx
            .query_row(
                "SELECT task_id, agent_profile_id FROM run WHERE id = ?1",
                params![run_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?
            .unwrap_or((None, None));
        let (title, r1) = sanitize(title);
        let (body, r2) = sanitize(body);
        tx.execute(
            "INSERT INTO memory_observation (id, project_id, run_id, task_id, agent_profile_id, kind, title, body, tool_name, redacted, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                new_id("obs"),
                project_id,
                run_id,
                task_id,
                agent_id,
                kind.as_str(),
                title,
                body,
                tool_name,
                (r1 || r2) as i64,
                at
            ],
        )?;
        Ok(())
    }

    pub(crate) fn record_context_event_in(
        tx: &Transaction<'_>,
        project_id: &str,
        run_id: &str,
        kind: &str,
        payload: serde_json::Value,
        at: &str,
    ) -> Result<()> {
        tx.execute(
            "INSERT INTO context_event (id, project_id, run_id, kind, payload_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![new_id("ctx"), project_id, run_id, kind, payload.to_string(), at],
        )?;
        Ok(())
    }

    pub fn list_observations(
        &self,
        project_id: &str,
        run_id: Option<&str>,
        limit: usize,
    ) -> Result<Vec<MemoryObservation>> {
        let conn = self.conn.lock().expect("store mutex");
        let sql = format!(
            "{} WHERE project_id = ?1 AND (?2 IS NULL OR run_id = ?2) ORDER BY created_at DESC, rowid DESC LIMIT ?3",
            MemoryObservation::SELECT
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(
            params![project_id, run_id, limit as i64],
            MemoryObservation::from_row,
        )?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn list_context_events(&self, run_id: &str) -> Result<Vec<ContextEvent>> {
        let conn = self.conn.lock().expect("store mutex");
        let mut stmt = conn.prepare(
            "SELECT id, project_id, run_id, kind, payload_json, created_at FROM context_event WHERE run_id = ?1 ORDER BY created_at, rowid",
        )?;
        let rows = stmt.query_map(params![run_id], |r| {
            Ok(ContextEvent {
                id: r.get(0)?,
                project_id: r.get(1)?,
                run_id: r.get(2)?,
                kind: r.get(3)?,
                payload: serde_json::from_str(&r.get::<_, String>(4)?).unwrap_or_default(),
                created_at: r.get(5)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    // ------------------------------------------------------------------ páginas

    pub fn list_pages(&self, project_id: &str, include_archived: bool) -> Result<Vec<MemoryPage>> {
        let conn = self.conn.lock().expect("store mutex");
        let sql = format!(
            "{} WHERE p.project_id = ?1 AND (?2 OR p.archived_at IS NULL) ORDER BY p.updated_at DESC",
            MemoryPage::SELECT
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params![project_id, include_archived], MemoryPage::from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn get_page(&self, id: &str) -> Result<Option<MemoryPage>> {
        let conn = self.conn.lock().expect("store mutex");
        Ok(conn
            .query_row(
                &format!("{} WHERE p.id = ?1", MemoryPage::SELECT),
                params![id],
                MemoryPage::from_row,
            )
            .optional()?)
    }

    /// Marca páginas como usadas (recall/leitura): sobe o uso e o score.
    pub fn touch_pages(&self, ids: &[String]) -> Result<()> {
        let conn = self.conn.lock().expect("store mutex");
        for id in ids {
            conn.execute(
                "UPDATE memory_page SET access_count = access_count + 1, last_accessed_at = ?2, score = MIN(1.0, score + 0.05) WHERE id = ?1",
                params![id, now()],
            )?;
        }
        Ok(())
    }

    /// Cria ou atualiza uma página (nova versão + arquivo na wiki).
    pub fn save_page(
        &self,
        input: &MemoryPageInput,
        reason: &str,
        source: &str,
    ) -> Result<MemoryPage> {
        if !PAGE_KINDS.contains(&input.kind.as_str()) {
            anyhow::bail!("Tipo de página inválido: {}", input.kind);
        }
        if input.title.trim().is_empty() {
            anyhow::bail!("A página precisa de título");
        }
        let id = {
            let mut conn = self.conn.lock().expect("store mutex");
            let tx = conn.transaction()?;
            let id = Self::save_page_in(&tx, input, reason, source)?;
            tx.commit()?;
            id
        };
        let page = self.get_page(&id)?.context("página recém-gravada sumiu")?;
        self.write_wiki_file(&page)?;
        Ok(page)
    }

    pub(crate) fn save_page_in(
        tx: &Transaction<'_>,
        input: &MemoryPageInput,
        reason: &str,
        source: &str,
    ) -> Result<String> {
        let (title, _) = sanitize(input.title.trim());
        let (body, _) = sanitize(&input.body_md);
        let ts = now();
        let existing: Option<String> = match &input.page_id {
            Some(id) => tx
                .query_row(
                    "SELECT id FROM memory_page WHERE id = ?1",
                    params![id],
                    |r| r.get(0),
                )
                .optional()?,
            None => None,
        };
        let id = match existing {
            Some(id) => {
                tx.execute(
                    "UPDATE memory_page SET kind = ?2, title = ?3, body_md = ?4, updated_at = ?5 WHERE id = ?1",
                    params![id, input.kind, title, body, ts],
                )?;
                id
            }
            None => {
                let mut slug = slugify(&title);
                let taken: bool = tx.query_row(
                    "SELECT COUNT(*) FROM memory_page WHERE project_id = ?1 AND slug = ?2",
                    params![input.project_id, slug],
                    |r| r.get::<_, i64>(0),
                )? > 0;
                if taken {
                    slug = format!("{slug}-{}", &new_id("")[1..7]);
                }
                let id = new_id("page");
                tx.execute(
                    "INSERT INTO memory_page (id, project_id, kind, slug, title, body_md, source, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
                    params![id, input.project_id, input.kind, slug, title, body, source, ts],
                )?;
                id
            }
        };
        tx.execute(
            "INSERT INTO memory_page_version (id, page_id, title, body_md, reason, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![new_id("ver"), id, title, body, reason, ts],
        )?;
        Ok(id)
    }

    pub fn set_page_archived(&self, id: &str, archived: bool) -> Result<MemoryPage> {
        {
            let conn = self.conn.lock().expect("store mutex");
            let changed = conn.execute(
                "UPDATE memory_page SET archived_at = ?2 WHERE id = ?1",
                params![id, if archived { Some(now()) } else { None }],
            )?;
            if changed == 0 {
                anyhow::bail!("Página {id} não encontrada");
            }
        }
        let page = self.get_page(id)?.context("página sumiu")?;
        self.write_wiki_file(&page)?;
        Ok(page)
    }

    pub fn page_versions(&self, page_id: &str) -> Result<Vec<MemoryPageVersion>> {
        let conn = self.conn.lock().expect("store mutex");
        let mut stmt = conn.prepare(
            "SELECT id, page_id, title, body_md, reason, created_at FROM memory_page_version WHERE page_id = ?1 ORDER BY created_at DESC, rowid DESC",
        )?;
        let rows = stmt.query_map(params![page_id], |r| {
            Ok(MemoryPageVersion {
                id: r.get(0)?,
                page_id: r.get(1)?,
                title: r.get(2)?,
                body_md: r.get(3)?,
                reason: r.get(4)?,
                created_at: r.get(5)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Busca FTS5 (OR entre termos, prefixo) com reforço por score e recência.
    pub fn search_pages(
        &self,
        project_id: &str,
        query: &str,
        limit: usize,
    ) -> Result<Vec<MemorySearchHit>> {
        let Some(fts) = fts_query(query) else {
            return Ok(Vec::new());
        };
        let conn = self.conn.lock().expect("store mutex");
        let sql = format!(
            "{} JOIN memory_fts f ON f.rowid = p.rowid WHERE p.project_id = ?1 AND p.archived_at IS NULL AND memory_fts MATCH ?2
             ORDER BY bm25(memory_fts, 3.0, 1.0) LIMIT 50",
            MemoryPage::SELECT.replace(
                "FROM memory_page p",
                ", snippet(memory_fts, 1, '«', '»', '…', 18), bm25(memory_fts, 3.0, 1.0) FROM memory_page p"
            )
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params![project_id, fts], |r| {
            let page = MemoryPage::from_row(r)?;
            let snippet: String = r.get(14)?;
            let bm25: f64 = r.get(15)?;
            Ok((page, snippet, bm25))
        })?;
        let mut hits: Vec<MemorySearchHit> = rows
            .collect::<rusqlite::Result<Vec<_>>>()?
            .into_iter()
            .map(|(page, snippet, bm25)| {
                let rank = -bm25 * (0.5 + page.score);
                MemorySearchHit {
                    page,
                    snippet,
                    rank,
                }
            })
            .collect();
        hits.sort_by(|a, b| {
            b.rank
                .partial_cmp(&a.rank)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        hits.truncate(limit);
        Ok(hits)
    }

    fn write_wiki_file(&self, page: &MemoryPage) -> Result<()> {
        let Some(dir) = self.wiki_dir(&page.project_id) else {
            return Ok(());
        };
        let kind_dir = dir.join(&page.kind);
        std::fs::create_dir_all(&kind_dir)
            .with_context(|| format!("criando {}", kind_dir.display()))?;
        let path = kind_dir.join(format!("{}.md", page.slug));
        std::fs::write(&path, page.to_markdown())
            .with_context(|| format!("gravando {}", path.display()))?;
        Ok(())
    }

    /// Reconstrói o índice a partir dos arquivos da wiki (fonte da verdade). Devolve quantas páginas entraram.
    pub fn rebuild_memory_index(&self, project_id: &str) -> Result<usize> {
        let Some(dir) = self.wiki_dir(project_id) else {
            anyhow::bail!("Sem pasta de wiki (banco em memória)");
        };
        let mut files = Vec::new();
        collect_md(&dir, &mut files)?;
        let mut conn = self.conn.lock().expect("store mutex");
        let tx = conn.transaction()?;
        tx.execute(
            "DELETE FROM memory_page WHERE project_id = ?1",
            params![project_id],
        )?;
        let mut count = 0;
        for path in files {
            let text = std::fs::read_to_string(&path)?;
            let Some(doc) = parse_wiki_file(&text) else {
                continue;
            };
            let kind = path
                .parent()
                .and_then(|p| p.file_name())
                .and_then(|n| n.to_str())
                .filter(|k| PAGE_KINDS.contains(k))
                .map(str::to_string)
                .unwrap_or_else(|| doc.kind.clone());
            let slug = path
                .file_stem()
                .and_then(|s| s.to_str())
                .map(str::to_string)
                .unwrap_or_else(|| slugify(&doc.title));
            tx.execute(
                "INSERT INTO memory_page (id, project_id, kind, slug, title, body_md, score, source, created_at, updated_at, archived_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![doc.id, project_id, kind, slug, doc.title, doc.body, doc.score, doc.source, doc.created_at, doc.updated_at, doc.archived_at],
            )?;
            count += 1;
        }
        tx.execute("INSERT INTO memory_fts(memory_fts) VALUES ('rebuild')", [])?;
        tx.commit()?;
        Ok(count)
    }

    // ------------------------------------------------------------------ consolidação bruta

    /// Ao fim do run: registra uma entrada no log de tarefas do mês com pedido, resultado e arquivos
    /// tocados, e marca as observações como consolidadas. Sem LLM: é o fallback "bruto" do plano.
    pub(crate) fn consolidate_run_in(tx: &Transaction<'_>, run_id: &str) -> Result<Option<String>> {
        let Some((project_id, prompt, status, result_text, error_message, cost_usd, started_at, agent_id, task_id)) = tx
            .query_row(
                "SELECT project_id, prompt, status, result_text, error_message, cost_usd, started_at, agent_profile_id, task_id FROM run WHERE id = ?1",
                params![run_id],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, Option<String>>(3)?,
                        r.get::<_, Option<String>>(4)?,
                        r.get::<_, Option<f64>>(5)?,
                        r.get::<_, String>(6)?,
                        r.get::<_, Option<String>>(7)?,
                        r.get::<_, Option<String>>(8)?,
                    ))
                },
            )
            .optional()?
        else {
            return Ok(None);
        };
        let agent_name: Option<String> = match &agent_id {
            Some(id) => tx
                .query_row(
                    "SELECT name FROM agent_profile WHERE id = ?1",
                    params![id],
                    |r| r.get(0),
                )
                .optional()?,
            None => None,
        };
        let task_title: Option<String> = match &task_id {
            Some(id) => tx
                .query_row("SELECT title FROM task WHERE id = ?1", params![id], |r| {
                    r.get(0)
                })
                .optional()?,
            None => None,
        };
        let mut files: Vec<String> = Vec::new();
        let mut turn_notes: Vec<String> = Vec::new();
        {
            let mut stmt = tx.prepare(
                "SELECT kind, title, body, tool_name FROM memory_observation WHERE run_id = ?1 ORDER BY created_at, rowid",
            )?;
            let rows = stmt.query_map(params![run_id], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<String>>(3)?,
                ))
            })?;
            for row in rows {
                let (kind, title, body, tool_name) = row?;
                match (kind.as_str(), tool_name.as_deref()) {
                    ("tool_use", Some("Write" | "Edit" | "MultiEdit" | "NotebookEdit")) => {
                        if let Some(path) = title.split_whitespace().nth(1) {
                            if !files.iter().any(|f| f == path) {
                                files.push(path.to_string());
                            }
                        }
                    }
                    ("turn_end" | "subagent_end", _) if !body.trim().is_empty() => {
                        turn_notes.push(first_chars(body.trim(), 400));
                    }
                    _ => {}
                }
            }
        }
        let month = started_at.get(..7).unwrap_or("0000-00").to_string();
        let when = started_at
            .get(..16)
            .unwrap_or(&started_at)
            .replace('T', " ");
        let status_label = match status.as_str() {
            "completed" => "concluído",
            "failed" => "falhou",
            "interrupted" => "interrompido",
            other => other,
        };
        let mut entry = format!(
            "\n## {when} · run {} · {status_label}",
            &run_id[..run_id.len().min(12)]
        );
        if let Some(c) = cost_usd {
            entry.push_str(&format!(" · US$ {c:.2}"));
        }
        entry.push('\n');
        if let Some(name) = &agent_name {
            entry.push_str(&format!("**Membro:** {name}\n"));
        }
        if let Some(t) = &task_title {
            entry.push_str(&format!("**Task:** {t}\n"));
        }
        entry.push_str(&format!(
            "**Pedido:** {}\n",
            first_chars(prompt.trim(), 300)
        ));
        if let Some(r) = result_text.as_deref().filter(|s| !s.trim().is_empty()) {
            entry.push_str(&format!("**Resultado:** {}\n", first_chars(r.trim(), 600)));
        }
        if let Some(e) = error_message.as_deref().filter(|s| !s.trim().is_empty()) {
            entry.push_str(&format!("**Erro:** {}\n", first_chars(e.trim(), 300)));
        }
        if !files.is_empty() {
            entry.push_str(&format!("**Arquivos tocados:** {}\n", files.join(", ")));
        }
        if !turn_notes.is_empty() {
            entry.push_str(&format!(
                "**Notas do agente:** {}\n",
                turn_notes.join(" · ")
            ));
        }
        // Run de task que não terminou bem e sem handoff do agente: nota automática "onde parei".
        if status != "completed" {
            if let Some(tid) = &task_id {
                let has_handoff: i64 = tx.query_row(
                    "SELECT COUNT(*) FROM memory_handoff WHERE run_id = ?1",
                    params![run_id],
                    |r| r.get(0),
                )?;
                if has_handoff == 0 {
                    let mut body = format!("Run {status_label} sem handoff do agente.");
                    if let Some(e) = error_message.as_deref().filter(|s| !s.trim().is_empty()) {
                        body.push_str(&format!(
                            "\n\n**O que falhou:** {}",
                            first_chars(e.trim(), 400)
                        ));
                    }
                    if !turn_notes.is_empty() {
                        body.push_str(&format!(
                            "\n\n**Últimas notas do agente:** {}",
                            turn_notes.join(" · ")
                        ));
                    }
                    if !files.is_empty() {
                        body.push_str(&format!("\n\n**Arquivos tocados:** {}", files.join(", ")));
                    }
                    Self::create_handoff_in(
                        tx,
                        &project_id,
                        Some(tid),
                        Some(run_id),
                        &body,
                        "auto",
                    )?;
                }
            }
        }
        let slug = format!("log-de-tarefas-{month}");
        let existing: Option<(String, String)> = tx
            .query_row(
                "SELECT id, body_md FROM memory_page WHERE project_id = ?1 AND slug = ?2",
                params![project_id, slug],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let (page_id, body) = match existing {
            Some((id, body)) => (Some(id), format!("{}\n{entry}", body.trim_end())),
            None => (
                None,
                format!("Entradas geradas automaticamente ao fim de cada run (consolidação bruta).\n{entry}"),
            ),
        };
        let input = MemoryPageInput {
            project_id: project_id.clone(),
            page_id,
            kind: "tasklog".into(),
            title: format!("Log de tarefas — {month}"),
            body_md: body,
        };
        let id = Self::save_page_in(tx, &input, &format!("run {run_id}"), "auto")?;
        if input.page_id.is_none() {
            // slug previsível para o log mensal (save_page_in gera a partir do título)
            tx.execute(
                "UPDATE memory_page SET slug = ?2 WHERE id = ?1",
                params![id, slug],
            )?;
        }
        tx.execute(
            "UPDATE memory_observation SET consolidated_at = ?2 WHERE run_id = ?1 AND consolidated_at IS NULL",
            params![run_id, now()],
        )?;
        Ok(Some(id))
    }

    // ------------------------------------------------------------------ handoffs e recall

    pub(crate) fn create_handoff_in(
        tx: &Transaction<'_>,
        project_id: &str,
        task_id: Option<&str>,
        run_id: Option<&str>,
        body: &str,
        source: &str,
    ) -> Result<String> {
        let (body, _) = sanitize(body.trim());
        let id = new_id("hand");
        tx.execute(
            "INSERT INTO memory_handoff (id, project_id, task_id, run_id, body_md, source, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![id, project_id, task_id, run_id, body, source, now()],
        )?;
        Ok(id)
    }

    pub fn create_handoff(
        &self,
        project_id: &str,
        task_id: Option<&str>,
        run_id: Option<&str>,
        body: &str,
        source: &str,
    ) -> Result<MemoryHandoff> {
        if body.trim().is_empty() {
            anyhow::bail!("O handoff precisa de conteúdo");
        }
        let id = {
            let mut conn = self.conn.lock().expect("store mutex");
            let tx = conn.transaction()?;
            let id = Self::create_handoff_in(&tx, project_id, task_id, run_id, body, source)?;
            tx.commit()?;
            id
        };
        let conn = self.conn.lock().expect("store mutex");
        Ok(conn.query_row(
            &format!("{} WHERE id = ?1", MemoryHandoff::SELECT),
            params![id],
            MemoryHandoff::from_row,
        )?)
    }

    pub fn list_handoffs(&self, project_id: &str) -> Result<Vec<MemoryHandoff>> {
        let conn = self.conn.lock().expect("store mutex");
        let mut stmt = conn.prepare(&format!(
            "{} WHERE project_id = ?1 ORDER BY (consumed_at IS NOT NULL), created_at DESC",
            MemoryHandoff::SELECT
        ))?;
        let rows = stmt.query_map(params![project_id], MemoryHandoff::from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Monta o brief do run: handoff pendente da task (consumido por este run, claim único) e as
    /// páginas mais relevantes para o pedido. `None` quando a memória ainda está vazia.
    pub fn memory_brief(
        &self,
        project_id: &str,
        task_id: Option<&str>,
        prompt: &str,
        run_id: &str,
    ) -> Result<Option<MemoryBrief>> {
        let handoff: Option<MemoryHandoff> = {
            let mut conn = self.conn.lock().expect("store mutex");
            let tx = conn.transaction()?;
            let found = tx
                .query_row(
                    &format!(
                        "{} WHERE project_id = ?1 AND consumed_at IS NULL AND ((?2 IS NOT NULL AND task_id = ?2) OR (?2 IS NULL AND task_id IS NULL)) ORDER BY created_at DESC LIMIT 1",
                        MemoryHandoff::SELECT
                    ),
                    params![project_id, task_id],
                    MemoryHandoff::from_row,
                )
                .optional()?;
            if let Some(h) = &found {
                tx.execute(
                    "UPDATE memory_handoff SET consumed_by_run_id = ?2, consumed_at = ?3 WHERE id = ?1",
                    params![h.id, run_id, now()],
                )?;
            }
            tx.commit()?;
            found
        };
        let task_title: Option<String> = match task_id {
            Some(id) => {
                let conn = self.conn.lock().expect("store mutex");
                conn.query_row("SELECT title FROM task WHERE id = ?1", params![id], |r| {
                    r.get(0)
                })
                .optional()?
            }
            None => None,
        };
        let query = brief_query(prompt, task_title.as_deref());
        let mut pages: Vec<MemoryPage> = self
            .search_pages(project_id, &query, 3)?
            .into_iter()
            .map(|h| h.page)
            .collect();
        if pages.is_empty() {
            let conn = self.conn.lock().expect("store mutex");
            let mut stmt = conn.prepare(&format!(
                "{} WHERE p.project_id = ?1 AND p.archived_at IS NULL AND p.kind <> 'tasklog' ORDER BY p.score DESC, p.updated_at DESC LIMIT 2",
                MemoryPage::SELECT
            ))?;
            pages = stmt
                .query_map(params![project_id], MemoryPage::from_row)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
        }
        if handoff.is_none() && pages.is_empty() {
            return Ok(None);
        }
        let mut text = String::from(
            "## Memória do projeto (Octopus)
",
        );
        let mut items = Vec::new();
        if let Some(h) = &handoff {
            text.push_str(
                "
### Handoff pendente do run anterior desta task
",
            );
            text.push_str(&first_chars(&h.body_md, 800));
            text.push('\n');
            items.push(format!("handoff: {}", first_chars(&h.body_md, 60)));
        }
        if !pages.is_empty() {
            text.push_str(
                "
### Páginas relevantes
",
            );
            let budget = MAX_BRIEF_CHARS.saturating_sub(text.len() + 220);
            let per_page = (budget / pages.len()).clamp(200, 700);
            for p in &pages {
                text.push_str(&format!(
                    "- **{}** ({}): {}
",
                    p.title,
                    p.kind,
                    first_chars(&p.body_md, per_page)
                ));
                items.push(p.title.clone());
            }
        }
        text.push_str("
Use a tool memory_search para mais contexto, memory_write para registrar decisões/armadilhas e memory_handoff para deixar uma nota ao próximo run se não terminar.
");
        let ids: Vec<String> = pages.iter().map(|p| p.id.clone()).collect();
        self.touch_pages(&ids)?;
        Ok(Some(MemoryBrief { text, items }))
    }

    /// Responde a uma tool de memória chamada pelo agente (`run.memory_call`).
    pub fn handle_memory_call(
        &self,
        run_id: &str,
        op: MemoryOp,
        args: &serde_json::Value,
    ) -> Result<MemoryCallResult> {
        let (project_id, task_id): (String, Option<String>) = {
            let conn = self.conn.lock().expect("store mutex");
            conn.query_row(
                "SELECT project_id, task_id FROM run WHERE id = ?1",
                params![run_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?
            .with_context(|| format!("run {run_id} não encontrado"))?
        };
        let str_arg = |k: &str| {
            args.get(k)
                .and_then(|v| v.as_str())
                .map(str::trim)
                .unwrap_or("")
                .to_string()
        };
        match op {
            MemoryOp::Search => {
                let query = str_arg("query");
                let hits = self.search_pages(&project_id, &query, 5)?;
                if hits.is_empty() {
                    return Ok(MemoryCallResult {
                        ok: true,
                        content: format!("Nenhuma página da memória casa com \"{query}\"."),
                    });
                }
                let ids: Vec<String> = hits.iter().map(|h| h.page.id.clone()).collect();
                self.touch_pages(&ids)?;
                let mut out = format!(
                    "{} página(s):
",
                    hits.len()
                );
                for h in hits {
                    out.push_str(&format!(
                        "
## {} ({})
{}
",
                        h.page.title,
                        h.page.kind,
                        first_chars(&h.page.body_md, 900)
                    ));
                }
                Ok(MemoryCallResult {
                    ok: true,
                    content: out,
                })
            }
            MemoryOp::Write => {
                let kind = str_arg("kind");
                if !["decisions", "architecture", "pitfalls", "note"].contains(&kind.as_str()) {
                    return Ok(MemoryCallResult {
                        ok: false,
                        content: "Tipo inválido: use decisions, architecture, pitfalls ou note."
                            .into(),
                    });
                }
                let input = MemoryPageInput {
                    project_id: project_id.clone(),
                    page_id: None,
                    kind,
                    title: str_arg("title"),
                    body_md: str_arg("body"),
                };
                match self.save_page(&input, &format!("run {run_id} (agente)"), "agent") {
                    Ok(page) => {
                        self.audit(
                            "agente",
                            "memory.page",
                            Some(&project_id),
                            serde_json::json!({"pageId": page.id, "kind": page.kind, "title": page.title, "runId": run_id}),
                        )?;
                        Ok(MemoryCallResult {
                            ok: true,
                            content: format!(
                                "Página \"{}\" gravada na memória do projeto ({}).",
                                page.title, page.kind
                            ),
                        })
                    }
                    Err(e) => Ok(MemoryCallResult {
                        ok: false,
                        content: format!("Não gravei: {e:#}"),
                    }),
                }
            }
            MemoryOp::Handoff => {
                let body = str_arg("body");
                match self.create_handoff(
                    &project_id,
                    task_id.as_deref(),
                    Some(run_id),
                    &body,
                    "agent",
                ) {
                    Ok(_) => Ok(MemoryCallResult {
                        ok: true,
                        content: if task_id.is_some() {
                            "Handoff registrado: o próximo run desta task vai recebê-lo no início."
                                .into()
                        } else {
                            "Handoff registrado para o próximo run avulso deste projeto.".into()
                        },
                    }),
                    Err(e) => Ok(MemoryCallResult {
                        ok: false,
                        content: format!("Não registrei: {e:#}"),
                    }),
                }
            }
        }
    }

    /// Depois de `record_run_event` fechar a transação: grava o arquivo da página consolidada.
    pub fn flush_wiki_page(&self, page_id: &str) -> Result<()> {
        if let Some(page) = self.get_page(page_id)? {
            self.write_wiki_file(&page)?;
        }
        Ok(())
    }
}

fn first_chars(s: &str, n: usize) -> String {
    let one_line = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if one_line.chars().count() <= n {
        one_line
    } else {
        format!("{}…", one_line.chars().take(n).collect::<String>())
    }
}

/// Palavras do pedido (e da task) que valem como consulta de recall.
fn brief_query(prompt: &str, task_title: Option<&str>) -> String {
    let mut words: Vec<String> = Vec::new();
    for w in task_title
        .unwrap_or("")
        .split_whitespace()
        .chain(prompt.split_whitespace())
    {
        let w: String = w.chars().filter(|c| c.is_alphanumeric()).collect();
        if w.chars().count() >= 4 && !words.iter().any(|x| x.eq_ignore_ascii_case(&w)) {
            words.push(w);
        }
        if words.len() >= 16 {
            break;
        }
    }
    words.join(" ")
}

/// Monta a consulta FTS5: termos entre aspas com prefixo, unidos por OR.
pub fn fts_query(query: &str) -> Option<String> {
    let terms: Vec<String> = query
        .split(|c: char| !c.is_alphanumeric() && c != '_' && c != '-')
        .filter(|t| t.chars().count() >= 2)
        .map(|t| format!("\"{}\"*", t.replace('"', "")))
        .collect();
    if terms.is_empty() {
        None
    } else {
        Some(terms.join(" OR "))
    }
}

struct WikiDoc {
    id: String,
    kind: String,
    title: String,
    body: String,
    score: f64,
    source: String,
    created_at: String,
    updated_at: String,
    archived_at: Option<String>,
}

fn parse_wiki_file(text: &str) -> Option<WikiDoc> {
    let rest = text.strip_prefix("---\n")?;
    let end = rest.find("\n---\n")?;
    let (front, body) = (&rest[..end], &rest[end + 5..]);
    let mut doc = WikiDoc {
        id: String::new(),
        kind: "note".into(),
        title: String::new(),
        body: body.trim().to_string(),
        score: 0.5,
        source: "manual".into(),
        created_at: now(),
        updated_at: now(),
        archived_at: None,
    };
    for line in front.lines() {
        let Some((k, v)) = line.split_once(':') else {
            continue;
        };
        let v = v.trim();
        match k.trim() {
            "id" => doc.id = v.into(),
            "kind" => doc.kind = v.into(),
            "title" => doc.title = v.into(),
            "score" => doc.score = v.parse().unwrap_or(0.5),
            "source" => doc.source = v.into(),
            "created_at" => doc.created_at = v.into(),
            "updated_at" => doc.updated_at = v.into(),
            "archived_at" => doc.archived_at = if v.is_empty() { None } else { Some(v.into()) },
            _ => {}
        }
    }
    if doc.id.is_empty() {
        doc.id = new_id("page");
    }
    if doc.title.is_empty() {
        return None;
    }
    Some(doc)
}

fn collect_md(dir: &Path, out: &mut Vec<PathBuf>) -> Result<()> {
    if !dir.exists() {
        return Ok(());
    }
    for entry in std::fs::read_dir(dir)? {
        let path = entry?.path();
        if path.is_dir() {
            collect_md(&path, out)?;
        } else if path.extension().and_then(|e| e.to_str()) == Some("md") {
            out.push(path);
        }
    }
    out.sort();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{RunEvent, RunOptions};

    #[test]
    fn sanitize_redacts_known_secrets_and_keeps_keys() {
        let (out, red) = sanitize("ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnop e DATABASE_URL=postgres://app:s3cr3t-pass@localhost/db");
        assert!(red);
        assert!(!out.contains("abcdefghijklmnop"));
        assert!(!out.contains("s3cr3t"));
        assert!(out.contains("ANTHROPIC_API_KEY=[redigido]"));
        assert!(out.contains("://[redigido]@localhost"));
        let (plain, red2) = sanitize("Tests run: 42, Failures: 0");
        assert!(!red2);
        assert_eq!(plain, "Tests run: 42, Failures: 0");
        let (pem, _) =
            sanitize("x -----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY----- y");
        assert_eq!(pem, "x [redigido] y");
        let (pw, _) = sanitize("senha: hunter22!");
        assert_eq!(pw, "senha=[redigido]");
    }

    #[test]
    fn slugify_and_fts_query() {
        assert_eq!(
            slugify("Migrações sempre em Flyway versionado"),
            "migracoes-sempre-em-flyway-versionado"
        );
        assert_eq!(slugify("***"), "pagina");
        assert_eq!(
            fts_query("migração flyway").as_deref(),
            Some("\"migração\"* OR \"flyway\"*")
        );
        assert!(fts_query(" a ").is_none());
    }

    #[test]
    fn pages_roundtrip_with_versions_fts_and_wiki_files() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open_in_memory()
            .unwrap()
            .with_data_dir(dir.path().to_path_buf());
        let project = store.create_project("p", "/tmp/p").unwrap();
        let page = store
            .save_page(
                &MemoryPageInput {
                    project_id: project.id.clone(),
                    page_id: None,
                    kind: "decisions".into(),
                    title: "Migrações sempre em Flyway versionado".into(),
                    body_md:
                        "Toda alteração de esquema entra como migração Flyway. Token=abcdef123456"
                            .into(),
                },
                "criação",
                "manual",
            )
            .unwrap();
        assert_eq!(page.slug, "migracoes-sempre-em-flyway-versionado");
        assert_eq!(page.versions, 1);
        assert!(
            page.body_md.contains("Token=[redigido]"),
            "páginas também são sanitizadas"
        );
        let file = dir
            .path()
            .join("projects")
            .join(&project.id)
            .join("memory/wiki/decisions/migracoes-sempre-em-flyway-versionado.md");
        assert!(file.exists());
        assert!(std::fs::read_to_string(&file)
            .unwrap()
            .starts_with("---\nid: page_"));

        let updated = store
            .save_page(
                &MemoryPageInput {
                    project_id: project.id.clone(),
                    page_id: Some(page.id.clone()),
                    kind: "decisions".into(),
                    title: page.title.clone(),
                    body_md: "Nunca editar migração aplicada; criar V13+.".into(),
                },
                "edição",
                "manual",
            )
            .unwrap();
        assert_eq!(updated.versions, 2);
        assert_eq!(store.page_versions(&page.id).unwrap().len(), 2);

        // Busca com acento/sem acento e prefixo.
        let hits = store.search_pages(&project.id, "migracao", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert!(hits[0].snippet.contains("«"));
        assert!(store
            .search_pages(&project.id, "kubernetes", 10)
            .unwrap()
            .is_empty());

        // Segunda página com o mesmo título ganha slug diferente.
        let dup = store
            .save_page(
                &MemoryPageInput {
                    project_id: project.id.clone(),
                    page_id: None,
                    kind: "note".into(),
                    title: page.title.clone(),
                    body_md: "x".into(),
                },
                "c",
                "manual",
            )
            .unwrap();
        assert_ne!(dup.slug, page.slug);

        // Arquivar some da lista padrão e da busca; rebuild a partir dos arquivos restaura tudo.
        store.set_page_archived(&dup.id, true).unwrap();
        assert_eq!(store.list_pages(&project.id, false).unwrap().len(), 1);
        assert_eq!(store.list_pages(&project.id, true).unwrap().len(), 2);
        let n = store.rebuild_memory_index(&project.id).unwrap();
        assert_eq!(n, 2);
        let again = store.get_page(&page.id).unwrap().unwrap();
        assert_eq!(again.body_md, "Nunca editar migração aplicada; criar V13+.");
        assert_eq!(store.search_pages(&project.id, "V13", 10).unwrap().len(), 1);
        store.touch_pages(std::slice::from_ref(&page.id)).unwrap();
        assert_eq!(store.get_page(&page.id).unwrap().unwrap().access_count, 1);
    }

    #[test]
    fn brief_claims_the_pending_handoff_once_and_picks_relevant_pages() {
        let store = Store::open_in_memory().unwrap();
        let project = store.create_project("p", "/tmp/p").unwrap();
        assert!(store
            .memory_brief(&project.id, None, "qualquer coisa", "run_x")
            .unwrap()
            .is_none());
        store
            .save_page(
                &MemoryPageInput {
                    project_id: project.id.clone(),
                    page_id: None,
                    kind: "decisions".into(),
                    title: "Migrações em Flyway".into(),
                    body_md: "Toda alteração de esquema vira migração Flyway.".into(),
                },
                "c",
                "manual",
            )
            .unwrap();
        store
            .save_page(
                &MemoryPageInput {
                    project_id: project.id.clone(),
                    page_id: None,
                    kind: "pitfalls".into(),
                    title: "Postgres 16".into(),
                    body_md: "Os testes exigem Postgres 16 local.".into(),
                },
                "c",
                "manual",
            )
            .unwrap();
        let wf = store
            .create_workflow_from_template(&project.id, "research-synthesis", false)
            .unwrap();
        let task = store
            .create_task(
                &project.id,
                &wf.id,
                &crate::store::orchestration::TaskInput {
                    title: "Migração V12".into(),
                    ..Default::default()
                },
            )
            .unwrap();
        store
            .create_handoff(
                &project.id,
                Some(&task.id),
                None,
                "Onde parei: V12 criada; falta o índice.",
                "agent",
            )
            .unwrap();

        let brief = store
            .memory_brief(&project.id, Some(&task.id), "crie a migração", "run_1")
            .unwrap()
            .unwrap();
        assert!(brief.text.contains("Handoff pendente"));
        assert!(brief.text.contains("falta o índice"));
        assert!(brief.text.contains("Migrações em Flyway"), "{}", brief.text);
        assert!(
            !brief.text.contains("Postgres 16"),
            "só páginas relevantes ao pedido"
        );
        assert_eq!(
            brief.items[0],
            "handoff: Onde parei: V12 criada; falta o índice."
        );
        assert!(brief.text.len() <= MAX_BRIEF_CHARS);
        let handoffs = store.list_handoffs(&project.id).unwrap();
        assert_eq!(handoffs[0].consumed_by_run_id.as_deref(), Some("run_1"));

        // Segundo run: handoff já consumido; sem termo relevante cai nas páginas de maior score.
        let again = store
            .memory_brief(&project.id, Some(&task.id), "zzz", "run_2")
            .unwrap()
            .unwrap();
        assert!(!again.text.contains("Handoff pendente"));
        assert!(again.text.contains("Páginas relevantes"));
        assert_eq!(
            store
                .get_page(
                    &store
                        .list_pages(&project.id, false)
                        .unwrap()
                        .iter()
                        .find(|p| p.title == "Migrações em Flyway")
                        .unwrap()
                        .id
                )
                .unwrap()
                .unwrap()
                .access_count,
            2
        );
    }

    #[test]
    fn memory_calls_search_write_and_handoff() {
        let store = Store::open_in_memory().unwrap();
        let project = store.create_project("p", "/tmp/p").unwrap();
        let run = store
            .create_run(&project.id, "x", &RunOptions::default())
            .unwrap();
        let none = store
            .handle_memory_call(
                &run.id,
                MemoryOp::Search,
                &serde_json::json!({"query": "flyway"}),
            )
            .unwrap();
        assert!(none.ok && none.content.contains("Nenhuma página"));
        let bad = store
            .handle_memory_call(
                &run.id,
                MemoryOp::Write,
                &serde_json::json!({"kind": "tasklog", "title": "t", "body": "b"}),
            )
            .unwrap();
        assert!(!bad.ok);
        let ok = store.handle_memory_call(&run.id, MemoryOp::Write, &serde_json::json!({"kind": "decisions", "title": "Migrações em Flyway", "body": "Sempre versionadas. senha=abcdef12"})).unwrap();
        assert!(ok.ok, "{}", ok.content);
        let page = &store.list_pages(&project.id, false).unwrap()[0];
        assert_eq!(page.source, "agent");
        assert!(page.body_md.contains("senha=[redigido]"));
        let found = store
            .handle_memory_call(
                &run.id,
                MemoryOp::Search,
                &serde_json::json!({"query": "flyway"}),
            )
            .unwrap();
        assert!(found.content.contains("## Migrações em Flyway (decisions)"));
        let hand = store
            .handle_memory_call(
                &run.id,
                MemoryOp::Handoff,
                &serde_json::json!({"body": "Onde parei: nada."}),
            )
            .unwrap();
        assert!(hand.ok && hand.content.contains("run avulso"));
        assert_eq!(store.list_handoffs(&project.id).unwrap().len(), 1);
        let audit = store
            .list_audit_events(Some(&project.id), Some("memory."), 10)
            .unwrap();
        assert_eq!(audit[0].actor, "agente");
    }

    #[test]
    fn failed_task_run_without_handoff_gets_an_automatic_one() {
        let store = Store::open_in_memory().unwrap();
        let project = store.create_project("p", "/tmp/p").unwrap();
        let wf = store
            .create_workflow_from_template(&project.id, "research-synthesis", false)
            .unwrap();
        let task = store
            .create_task(
                &project.id,
                &wf.id,
                &crate::store::orchestration::TaskInput {
                    title: "T".into(),
                    ..Default::default()
                },
            )
            .unwrap();
        let run = store
            .create_run_full(
                &project.id,
                "p",
                &RunOptions::default(),
                None,
                Some(&task.id),
            )
            .unwrap();
        store
            .record_run_event(
                &run.id,
                1,
                "t",
                &RunEvent::Observation {
                    kind: ObservationKind::TurnEnd,
                    title: "Fim do turno".into(),
                    body: "Comecei a V12.".into(),
                    tool_name: None,
                    tool_use_id: None,
                    parent_tool_use_id: None,
                    agent_id: None,
                },
            )
            .unwrap();
        store
            .record_run_event(
                &run.id,
                2,
                "t",
                &RunEvent::Error {
                    message: "estourou o limite".into(),
                    fatal: true,
                },
            )
            .unwrap();
        let handoffs = store.list_handoffs(&project.id).unwrap();
        assert_eq!(handoffs.len(), 1);
        assert_eq!(handoffs[0].source, "auto");
        assert_eq!(handoffs[0].task_id.as_deref(), Some(task.id.as_str()));
        assert!(handoffs[0].body_md.contains("estourou o limite"));
        assert!(handoffs[0].body_md.contains("Comecei a V12."));
        // O próximo run da task recebe o handoff no brief.
        let brief = store
            .memory_brief(&project.id, Some(&task.id), "continue", "run_next")
            .unwrap()
            .unwrap();
        assert!(brief.text.contains("Comecei a V12."));
    }

    #[test]
    fn observations_are_sanitized_and_consolidated_into_the_task_log() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open_in_memory()
            .unwrap()
            .with_data_dir(dir.path().to_path_buf());
        let project = store.create_project("p", "/tmp/p").unwrap();
        let run = store
            .create_run(&project.id, "crie a migração V12", &RunOptions::default())
            .unwrap();
        let ev = |kind, title: &str, body: &str, tool: Option<&str>| RunEvent::Observation {
            kind,
            title: title.into(),
            body: body.into(),
            tool_name: tool.map(String::from),
            tool_use_id: None,
            parent_tool_use_id: None,
            agent_id: None,
        };
        store
            .record_run_event(
                &run.id,
                1,
                "2026-10-16T14:01:47Z",
                &ev(
                    ObservationKind::ToolUse,
                    "Write db/V12.sql",
                    "ok",
                    Some("Write"),
                ),
            )
            .unwrap();
        store
            .record_run_event(
                &run.id,
                2,
                "2026-10-16T14:01:58Z",
                &ev(
                    ObservationKind::ToolUse,
                    "Bash ./mvnw test",
                    "OK\nANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnop",
                    Some("Bash"),
                ),
            )
            .unwrap();
        store
            .record_run_event(
                &run.id,
                3,
                "2026-10-16T14:02:00Z",
                &ev(
                    ObservationKind::TurnEnd,
                    "Fim do turno",
                    "Criei a V12; falta o índice.",
                    None,
                ),
            )
            .unwrap();
        store
            .record_run_event(
                &run.id,
                4,
                "2026-10-16T14:02:03Z",
                &RunEvent::Compaction {
                    phase: crate::protocol::CompactionPhase::Post,
                    trigger: "auto".into(),
                    summary: Some("resumo".into()),
                },
            )
            .unwrap();
        let obs = store
            .list_observations(&project.id, Some(&run.id), 50)
            .unwrap();
        assert_eq!(obs.len(), 3);
        let bash = obs
            .iter()
            .find(|o| o.tool_name.as_deref() == Some("Bash"))
            .unwrap();
        assert!(bash.redacted);
        assert!(!bash.body.contains("abcdefghijklmnop"));
        assert!(obs.iter().all(|o| o.consolidated_at.is_none()));
        assert_eq!(
            store.list_context_events(&run.id).unwrap()[0].kind,
            "compaction_post"
        );

        store
            .record_run_event(
                &run.id,
                5,
                "2026-10-16T14:02:06Z",
                &RunEvent::Result {
                    session_id: "s".into(),
                    subtype: "success".into(),
                    is_error: false,
                    cost_usd: Some(0.4),
                    duration_ms: None,
                    num_turns: Some(3),
                    usage: None,
                    stop_reason: None,
                    result_text: Some("V12 criada e testes verdes".into()),
                },
            )
            .unwrap();
        let pages = store.list_pages(&project.id, false).unwrap();
        assert_eq!(pages.len(), 1);
        let log = &pages[0];
        assert_eq!(log.kind, "tasklog");
        assert!(log.slug.starts_with("log-de-tarefas-"));
        assert!(log.body_md.contains("**Pedido:** crie a migração V12"));
        assert!(log.body_md.contains("**Arquivos tocados:** db/V12.sql"));
        assert!(log.body_md.contains("**Notas do agente:** Criei a V12"));
        assert!(log.body_md.contains("US$ 0.40"));
        assert!(store
            .list_observations(&project.id, Some(&run.id), 50)
            .unwrap()
            .iter()
            .all(|o| o.consolidated_at.is_some()));
        // arquivo da wiki gravado após a transação
        let mut found = Vec::new();
        collect_md(&dir.path().join("projects"), &mut found).unwrap();
        assert_eq!(found.len(), 1);

        // Segundo run no mesmo mês acrescenta ao mesmo log.
        let run2 = store
            .create_run(&project.id, "outra", &RunOptions::default())
            .unwrap();
        store
            .record_run_event(
                &run2.id,
                1,
                "t",
                &RunEvent::Error {
                    message: "estourou".into(),
                    fatal: true,
                },
            )
            .unwrap();
        let pages = store.list_pages(&project.id, false).unwrap();
        assert_eq!(pages.len(), 1);
        assert!(pages[0].body_md.contains("**Erro:** estourou"));
        assert_eq!(pages[0].versions, 2);
    }
}
