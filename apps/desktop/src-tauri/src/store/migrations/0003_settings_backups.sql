-- Fase 2a: preferências do app, estado do onboarding e cópias locais de configuração.

CREATE TABLE app_setting (
    key         TEXT PRIMARY KEY,
    value_json  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

CREATE TABLE backup_snapshot (
    id              TEXT PRIMARY KEY,
    created_at      TEXT NOT NULL,
    path            TEXT NOT NULL,
    schema_version  INTEGER NOT NULL,
    reason          TEXT NOT NULL CHECK (reason IN ('auto', 'manual', 'pre-restore')),
    size_bytes      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX backup_snapshot_created_idx ON backup_snapshot(created_at DESC);
