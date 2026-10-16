-- Fase 5: MCP servers externos (globais ou do projeto) e vínculo por perfil de agente.

CREATE TABLE mcp_server (
    id               TEXT PRIMARY KEY,
    project_id       TEXT REFERENCES project(id) ON DELETE CASCADE,
    name             TEXT NOT NULL,
    transport        TEXT NOT NULL CHECK (transport IN ('stdio', 'sse', 'http')),
    config_json      TEXT NOT NULL,
    enabled          INTEGER NOT NULL DEFAULT 1,
    last_health_json TEXT,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_mcp_server_name ON mcp_server(COALESCE(project_id, ''), name);

ALTER TABLE agent_profile ADD COLUMN mcp_server_ids_json TEXT;
