-- Fase 3: perfis de sandbox (Seatbelt do Claude Code) por projeto e orçamentos mensais.

CREATE TABLE sandbox_profile (
    id             TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    description    TEXT NOT NULL DEFAULT '',
    builtin        INTEGER NOT NULL DEFAULT 0,
    settings_json  TEXT NOT NULL,
    position       INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL
);

INSERT INTO sandbox_profile (id, name, description, builtin, settings_json, position, created_at) VALUES
('sandbox_strict', 'Estrito', 'Comandos só dentro do sandbox; escrita só no projeto; sem rede fora da allowlist (vazia); leitura de credenciais negada.', 1,
 '{"enabled":true,"failIfUnavailable":true,"allowUnsandboxedCommands":false,"autoAllowBashIfSandboxed":false,"network":{"allowedDomains":[],"strictAllowlist":true},"filesystem":{"allowWrite":["${PROJECT}","${PROJECT}/.octopus/worktrees"],"denyRead":["~/.ssh","~/.aws","~/.config","~/.gnupg","~/.kube","~/.docker/config.json"]},"credentials":{"envVars":[{"name":"ANTHROPIC_API_KEY","mode":"mask","injectHosts":["api.anthropic.com"]}]}}', 1, '2026-10-16T00:00:00Z'),
('sandbox_dev', 'Dev padrão', 'Escrita só no projeto e leitura de credenciais negada; rede liberada para hosts comuns de desenvolvimento.', 1,
 '{"enabled":true,"failIfUnavailable":false,"allowUnsandboxedCommands":false,"network":{"allowedDomains":["github.com","api.github.com","objects.githubusercontent.com","registry.npmjs.org","registry.yarnpkg.com","pypi.org","files.pythonhosted.org","crates.io","static.crates.io","index.crates.io","repo.maven.apache.org","repo1.maven.org","plugins.gradle.org","services.gradle.org","registry-1.docker.io","auth.docker.io","production.cloudflare.docker.com"],"strictAllowlist":false},"filesystem":{"allowWrite":["${PROJECT}","${PROJECT}/.octopus/worktrees"],"denyRead":["~/.ssh","~/.aws","~/.config/gcloud","~/.gnupg","~/.kube"]},"credentials":{"envVars":[{"name":"ANTHROPIC_API_KEY","mode":"mask","injectHosts":["api.anthropic.com"]}]}}', 2, '2026-10-16T00:00:00Z'),
('sandbox_readonly', 'Somente leitura', 'Nenhuma escrita em disco pelos comandos; sem rede; leitura de credenciais negada. Para investigar e planejar.', 1,
 '{"enabled":true,"failIfUnavailable":true,"allowUnsandboxedCommands":false,"network":{"allowedDomains":[],"strictAllowlist":true},"filesystem":{"allowWrite":[],"denyWrite":["${PROJECT}"],"denyRead":["~/.ssh","~/.aws","~/.config","~/.gnupg","~/.kube"]},"credentials":{"envVars":[{"name":"ANTHROPIC_API_KEY","mode":"mask","injectHosts":["api.anthropic.com"]}]}}', 3, '2026-10-16T00:00:00Z');

ALTER TABLE project ADD COLUMN sandbox_profile_id TEXT REFERENCES sandbox_profile(id) ON DELETE SET NULL;
UPDATE project SET sandbox_profile_id = 'sandbox_dev' WHERE sandbox_profile_id IS NULL;

CREATE TABLE budget_policy (
    id          TEXT PRIMARY KEY,
    scope       TEXT NOT NULL CHECK (scope IN ('project', 'agent')),
    scope_id    TEXT NOT NULL,
    soft_usd    REAL,
    hard_usd    REAL,
    max_turns   INTEGER,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    UNIQUE (scope, scope_id)
);
