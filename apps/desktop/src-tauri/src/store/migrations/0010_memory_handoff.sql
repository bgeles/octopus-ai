-- Fase 4: handoffs entre runs ("onde parei / o que falhou / o que falta"), consumidos uma única vez.

CREATE TABLE memory_handoff (
    id                 TEXT PRIMARY KEY,
    project_id         TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    task_id            TEXT,
    run_id             TEXT REFERENCES run(id) ON DELETE SET NULL,
    body_md            TEXT NOT NULL,
    source             TEXT NOT NULL DEFAULT 'agent',
    created_at         TEXT NOT NULL,
    consumed_by_run_id TEXT,
    consumed_at        TEXT
);
CREATE INDEX idx_memory_handoff_pending ON memory_handoff(project_id, task_id, consumed_at);
