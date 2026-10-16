-- Fase 1: aprovações (pedidos de permissão do agente e a decisão do usuário, com motivo).

CREATE TABLE approval (
    id                TEXT PRIMARY KEY,
    run_id            TEXT NOT NULL REFERENCES run(id) ON DELETE CASCADE,
    request_id        TEXT NOT NULL,
    tool_name         TEXT NOT NULL,
    tool_input_json   TEXT NOT NULL,
    reason            TEXT,
    decision          TEXT CHECK (decision IN ('allow', 'deny')),
    decision_message  TEXT,
    requested_at      TEXT NOT NULL,
    decided_at        TEXT,
    UNIQUE (run_id, request_id)
);

CREATE INDEX approval_run_idx ON approval(run_id, requested_at DESC);
