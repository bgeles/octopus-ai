-- Fase 0: projetos, runs e eventos de run.
-- Tabelas de tasks, workflows, agentes, memória e auditoria chegam nas fases seguintes.

CREATE TABLE project (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    path        TEXT NOT NULL,
    auth_mode   TEXT NOT NULL DEFAULT 'subscription' CHECK (auth_mode IN ('subscription', 'api_key')),
    created_at  TEXT NOT NULL
);

CREATE TABLE run (
    id                 TEXT PRIMARY KEY,
    project_id         TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    prompt             TEXT NOT NULL,
    options_json       TEXT NOT NULL DEFAULT '{}',
    status             TEXT NOT NULL CHECK (status IN ('queued', 'running', 'waiting_approval', 'completed', 'failed', 'interrupted')),
    claude_session_id  TEXT,
    model              TEXT,
    started_at         TEXT NOT NULL,
    ended_at           TEXT,
    cost_usd           REAL,
    input_tokens       INTEGER NOT NULL DEFAULT 0,
    output_tokens      INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
    num_turns          INTEGER,
    stop_reason        TEXT,
    result_text        TEXT,
    error_message      TEXT
);

CREATE INDEX run_project_started_idx ON run(project_id, started_at DESC);
CREATE INDEX run_session_idx ON run(claude_session_id);

CREATE TABLE run_event (
    run_id        TEXT NOT NULL REFERENCES run(id) ON DELETE CASCADE,
    seq           INTEGER NOT NULL,
    at            TEXT NOT NULL,
    kind          TEXT NOT NULL,
    payload_json  TEXT NOT NULL,
    PRIMARY KEY (run_id, seq)
);
