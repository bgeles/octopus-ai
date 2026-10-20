-- Hooks livres (Harness → Hooks): comandos de shell do usuário em eventos do agente.
CREATE TABLE custom_hook (
    id          TEXT PRIMARY KEY,
    -- NULL = vale para todos os projetos.
    project_id  TEXT REFERENCES project(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    event       TEXT NOT NULL,
    -- Regex sobre o nome da ferramenta (PreToolUse/PostToolUse); NULL = todas.
    matcher     TEXT,
    command     TEXT NOT NULL,
    timeout_sec INTEGER NOT NULL DEFAULT 30,
    enabled     INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);
CREATE INDEX custom_hook_project ON custom_hook(project_id);
