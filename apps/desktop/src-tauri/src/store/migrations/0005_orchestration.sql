-- Fase 2c: workflows (estágios com responsável e gate humano), tasks com dependências e histórico.

CREATE TABLE workflow (
    id             TEXT PRIMARY KEY,
    project_id     TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    name           TEXT NOT NULL,
    stages_json    TEXT NOT NULL,
    use_worktrees  INTEGER NOT NULL DEFAULT 0,
    max_parallel   INTEGER NOT NULL DEFAULT 1,
    created_at     TEXT NOT NULL
);

CREATE TABLE task (
    id                 TEXT PRIMARY KEY,
    project_id         TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    workflow_id        TEXT NOT NULL REFERENCES workflow(id) ON DELETE CASCADE,
    stage_id           TEXT NOT NULL,
    title              TEXT NOT NULL,
    description_md     TEXT NOT NULL DEFAULT '',
    acceptance_md      TEXT NOT NULL DEFAULT '',
    status             TEXT NOT NULL CHECK (status IN ('backlog', 'ready', 'running', 'waiting_approval', 'review', 'done', 'blocked', 'failed')),
    assigned_agent_id  TEXT REFERENCES agent_profile(id) ON DELETE SET NULL,
    depends_on_json    TEXT NOT NULL DEFAULT '[]',
    worktree_path      TEXT,
    lock_run_id        TEXT,
    last_note          TEXT,
    position           INTEGER NOT NULL DEFAULT 0,
    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL
);

CREATE INDEX task_project_status_idx ON task(project_id, status);

CREATE TABLE task_event (
    id          TEXT PRIMARY KEY,
    task_id     TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
    at          TEXT NOT NULL,
    kind        TEXT NOT NULL,
    from_stage  TEXT,
    to_stage    TEXT,
    run_id      TEXT,
    actor       TEXT NOT NULL DEFAULT 'sistema',
    note        TEXT
);

CREATE INDEX task_event_task_idx ON task_event(task_id, at);

ALTER TABLE run ADD COLUMN task_id TEXT REFERENCES task(id) ON DELETE SET NULL;
CREATE INDEX run_task_idx ON run(task_id);
