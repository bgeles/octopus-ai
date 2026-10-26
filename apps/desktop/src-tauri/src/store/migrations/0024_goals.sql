-- Fase 9: missão do projeto e objetivos ligados a workflows e tasks (o "porquê" entra nos prompts).
ALTER TABLE project ADD COLUMN mission TEXT;
CREATE TABLE goal (
    id              TEXT PRIMARY KEY,
    project_id      TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    title           TEXT NOT NULL,
    description_md  TEXT NOT NULL DEFAULT '',
    parent_goal_id  TEXT REFERENCES goal(id) ON DELETE SET NULL,
    status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'done')),
    position        INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);
CREATE INDEX goal_project_idx ON goal(project_id, status, position);
ALTER TABLE workflow ADD COLUMN goal_id TEXT REFERENCES goal(id) ON DELETE SET NULL;
ALTER TABLE task ADD COLUMN goal_id TEXT REFERENCES goal(id) ON DELETE SET NULL;
CREATE INDEX task_goal_idx ON task(goal_id);
