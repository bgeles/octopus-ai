-- Fase 9: relatório consolidado do workflow (gerado ao concluir a última task ou sob demanda).
CREATE TABLE workflow_report (
    id              TEXT PRIMARY KEY,
    project_id      TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    workflow_id     TEXT NOT NULL REFERENCES workflow(id) ON DELETE CASCADE,
    generation      INTEGER NOT NULL DEFAULT 1,
    trigger         TEXT NOT NULL CHECK (trigger IN ('auto', 'manual')),
    title           TEXT NOT NULL,
    body_md         TEXT NOT NULL,
    summary_md      TEXT,
    summary_status  TEXT NOT NULL DEFAULT 'none' CHECK (summary_status IN ('none', 'pending', 'running', 'done', 'failed')),
    summary_run_id  TEXT,
    source_run_id   TEXT,
    cost_usd        REAL NOT NULL DEFAULT 0,
    tasks_total     INTEGER NOT NULL DEFAULT 0,
    tasks_done      INTEGER NOT NULL DEFAULT 0,
    members_json    TEXT NOT NULL DEFAULT '[]',
    tasks_json      TEXT NOT NULL DEFAULT '[]',
    started_at      TEXT,
    finished_at     TEXT,
    created_at      TEXT NOT NULL
);
CREATE INDEX workflow_report_wf_idx ON workflow_report(workflow_id, generation DESC);
CREATE INDEX workflow_report_project_idx ON workflow_report(project_id, created_at DESC);
