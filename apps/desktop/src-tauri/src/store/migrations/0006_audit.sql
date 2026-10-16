-- Fase 3: log de auditoria append-only com cadeia de hashes SHA-256.

CREATE TABLE audit_event (
    seq           INTEGER PRIMARY KEY AUTOINCREMENT,
    ts            TEXT NOT NULL,
    actor         TEXT NOT NULL,
    kind          TEXT NOT NULL,
    project_id    TEXT,
    payload_json  TEXT NOT NULL,
    prev_hash     TEXT NOT NULL,
    hash          TEXT NOT NULL
);

CREATE INDEX audit_event_kind_idx ON audit_event(kind, seq DESC);
CREATE INDEX audit_event_project_idx ON audit_event(project_id, seq DESC);
