-- Fase 3: regras do motor de política (PreToolUse). Globais podem permitir; as do projeto só apertam.

CREATE TABLE policy_rule (
    id          TEXT PRIMARY KEY,
    scope       TEXT NOT NULL CHECK (scope IN ('global', 'project')),
    project_id  TEXT REFERENCES project(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL CHECK (kind IN ('command', 'write', 'tool', 'mcp')),
    pattern     TEXT NOT NULL,
    action      TEXT NOT NULL CHECK (action IN ('allow', 'deny', 'ask')),
    reason      TEXT NOT NULL DEFAULT '',
    enabled     INTEGER NOT NULL DEFAULT 1,
    builtin     INTEGER NOT NULL DEFAULT 0,
    position    INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

CREATE INDEX policy_rule_scope_idx ON policy_rule(scope, project_id, position);

INSERT INTO policy_rule (id, scope, kind, pattern, action, reason, enabled, builtin, position, created_at, updated_at) VALUES
('rule_destructive_outside', 'global', 'command', '@destructive-outside-project', 'deny', 'Comando destrutivo fora da pasta do projeto', 1, 1, 1, '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z'),
('rule_git_push_protected', 'global', 'command', 'git\s+push\b.*(--force\b|-f\b|\bmain\b|\bmaster\b)', 'deny', 'Push forçado ou para branch protegida', 1, 1, 2, '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z'),
('rule_write_secrets', 'global', 'write', '**/.env|**/.env.*|**/*.pem|**/id_rsa*|**/id_ed25519*|**/secrets/**', 'deny', 'Segredos nunca entram no repositório', 1, 1, 3, '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z'),
('rule_write_outside', 'global', 'write', '@outside-project', 'deny', 'Confinamento de caminhos à pasta do projeto', 1, 1, 4, '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z'),
('rule_network_ask', 'global', 'command', '\b(curl|wget|nc|ssh|scp)\b', 'ask', 'Saída de rede exige aprovação', 1, 1, 5, '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z'),
('rule_web_ask', 'global', 'tool', 'WebFetch|WebSearch', 'ask', 'Buscar na web só com você olhando', 0, 1, 6, '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z'),
('rule_mcp_octopus', 'global', 'mcp', 'mcp__octopus__*', 'allow', 'Ferramentas do próprio orquestrador', 1, 1, 7, '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z');
