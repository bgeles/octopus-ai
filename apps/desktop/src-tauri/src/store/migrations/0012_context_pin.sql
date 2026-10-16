-- Fase 4: pins de contexto, sempre injetados no brief de cada run do projeto.

CREATE TABLE context_pin (
    id         TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL CHECK (kind IN ('file', 'page', 'text')),
    ref        TEXT NOT NULL,
    label      TEXT NOT NULL,
    position   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);
CREATE INDEX idx_context_pin_project ON context_pin(project_id, position);
