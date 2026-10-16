-- Fase 5: skills (pastas com SKILL.md) do projeto e do usuário, com vínculo por perfil de agente.

CREATE TABLE skill (
    id          TEXT PRIMARY KEY,
    project_id  TEXT REFERENCES project(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    path        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    source      TEXT NOT NULL CHECK (source IN ('project', 'user', 'manual')),
    enabled     INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_skill_path ON skill(COALESCE(project_id, ''), path);

ALTER TABLE agent_profile ADD COLUMN skill_ids_json TEXT;
