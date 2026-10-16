-- Fase 4: memória do projeto (observações capturadas por hooks, wiki com FTS5) e eventos de contexto.

CREATE TABLE memory_observation (
    id               TEXT PRIMARY KEY,
    project_id       TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    run_id           TEXT REFERENCES run(id) ON DELETE SET NULL,
    task_id          TEXT,
    agent_profile_id TEXT,
    kind             TEXT NOT NULL,
    title            TEXT NOT NULL,
    body             TEXT NOT NULL,
    tool_name        TEXT,
    redacted         INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT NOT NULL,
    consolidated_at  TEXT
);
CREATE INDEX idx_memory_observation_project ON memory_observation(project_id, created_at);
CREATE INDEX idx_memory_observation_run ON memory_observation(run_id);

-- Fonte da verdade são os arquivos .md em <dados>/projects/<id>/memory/wiki; esta tabela e o FTS são o índice.
CREATE TABLE memory_page (
    id               TEXT PRIMARY KEY,
    project_id       TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    kind             TEXT NOT NULL,
    slug             TEXT NOT NULL,
    title            TEXT NOT NULL,
    body_md          TEXT NOT NULL,
    score            REAL NOT NULL DEFAULT 0.5,
    access_count     INTEGER NOT NULL DEFAULT 0,
    last_accessed_at TEXT,
    source           TEXT NOT NULL DEFAULT 'manual',
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL,
    archived_at      TEXT,
    UNIQUE(project_id, slug)
);

CREATE TABLE memory_page_version (
    id         TEXT PRIMARY KEY,
    page_id    TEXT NOT NULL REFERENCES memory_page(id) ON DELETE CASCADE,
    title      TEXT NOT NULL,
    body_md    TEXT NOT NULL,
    reason     TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX idx_memory_page_version_page ON memory_page_version(page_id, created_at);

CREATE VIRTUAL TABLE memory_fts USING fts5(
    title, body_md,
    content='memory_page', content_rowid='rowid',
    tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER memory_page_ai AFTER INSERT ON memory_page BEGIN
    INSERT INTO memory_fts(rowid, title, body_md) VALUES (new.rowid, new.title, new.body_md);
END;
CREATE TRIGGER memory_page_ad AFTER DELETE ON memory_page BEGIN
    INSERT INTO memory_fts(memory_fts, rowid, title, body_md) VALUES ('delete', old.rowid, old.title, old.body_md);
END;
CREATE TRIGGER memory_page_au AFTER UPDATE OF title, body_md ON memory_page BEGIN
    INSERT INTO memory_fts(memory_fts, rowid, title, body_md) VALUES ('delete', old.rowid, old.title, old.body_md);
    INSERT INTO memory_fts(rowid, title, body_md) VALUES (new.rowid, new.title, new.body_md);
END;

CREATE TABLE context_event (
    id           TEXT PRIMARY KEY,
    project_id   TEXT NOT NULL,
    run_id       TEXT NOT NULL REFERENCES run(id) ON DELETE CASCADE,
    kind         TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at   TEXT NOT NULL
);
CREATE INDEX idx_context_event_run ON context_event(run_id, created_at);
