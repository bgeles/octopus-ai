-- Fase 2b: time de agentes. Cargos (catálogo global + ajustes por projeto), perfis e membros do time.

CREATE TABLE role (
    id                       TEXT PRIMARY KEY,
    scope                    TEXT NOT NULL CHECK (scope IN ('global', 'project')),
    project_id               TEXT REFERENCES project(id) ON DELETE CASCADE,
    title                    TEXT NOT NULL,
    specialty                TEXT NOT NULL DEFAULT '',
    responsibilities_md      TEXT NOT NULL DEFAULT '',
    default_model            TEXT,
    default_permission_mode  TEXT,
    default_tools_json       TEXT,
    icon                     TEXT,
    position                 INTEGER NOT NULL DEFAULT 0,
    created_at               TEXT NOT NULL,
    updated_at               TEXT NOT NULL
);

CREATE TABLE agent_profile (
    id                  TEXT PRIMARY KEY,
    project_id          TEXT REFERENCES project(id) ON DELETE CASCADE,
    role_id             TEXT NOT NULL REFERENCES role(id),
    name                TEXT NOT NULL,
    avatar_seed         TEXT NOT NULL DEFAULT '',
    instructions_md     TEXT,
    model               TEXT,
    permission_mode     TEXT,
    allowed_tools_json  TEXT,
    max_turns           INTEGER,
    max_budget_usd      REAL,
    created_at          TEXT NOT NULL
);

CREATE TABLE team_member (
    id                   TEXT PRIMARY KEY,
    project_id           TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    agent_profile_id     TEXT NOT NULL REFERENCES agent_profile(id) ON DELETE CASCADE,
    reports_to_agent_id  TEXT REFERENCES agent_profile(id) ON DELETE SET NULL,
    position             INTEGER NOT NULL DEFAULT 0,
    created_at           TEXT NOT NULL,
    UNIQUE (project_id, agent_profile_id)
);

CREATE INDEX team_member_project_idx ON team_member(project_id, position);

ALTER TABLE run ADD COLUMN agent_profile_id TEXT REFERENCES agent_profile(id) ON DELETE SET NULL;
CREATE INDEX run_agent_idx ON run(agent_profile_id);

-- Catálogo inicial de cargos (escopo global).
INSERT INTO role (id, scope, title, specialty, responsibilities_md, default_permission_mode, default_tools_json, icon, position, created_at, updated_at) VALUES
('role_planejador', 'global', 'Planejador', 'Arquitetura e planos',
 '- Transformar o pedido em um plano com critérios de aceite claros.
- Decompor o trabalho em tasks pequenas, com dependências explícitas.
- Não alterar código: só ler, investigar e escrever o plano.', 'plan', '["Read","Glob","Grep"]', 'map', 1, '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z'),
('role_implementador', 'global', 'Implementador', 'Código e migrações',
 '- Executar uma task por vez, dentro da pasta do projeto.
- Escrever testes junto com o código, nunca depois.
- Pedir aprovação antes de comandos fora do projeto ou com rede.
- Ao concluir, resumir o que mudou e por quê.', 'acceptEdits', '["Read","Glob","Grep","Edit","Write","Bash"]', 'hammer', 2, '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z'),
('role_revisor', 'global', 'Revisor', 'Revisão de código e riscos',
 '- Revisar diffs em busca de bugs, riscos de segurança e desvios dos critérios de aceite.
- Apontar problemas com arquivo e linha; sugerir a correção.
- Nunca editar o código revisado.', 'plan', '["Read","Glob","Grep","Bash"]', 'search-check', 3, '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z'),
('role_testador', 'global', 'Testador', 'Testes e qualidade',
 '- Rodar a suíte de testes e ampliar a cobertura das mudanças recentes.
- Reportar falhas com passos para reproduzir.
- Editar apenas arquivos de teste.', 'acceptEdits', '["Read","Glob","Grep","Edit","Write","Bash"]', 'flask-conical', 4, '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z'),
('role_pesquisador', 'global', 'Pesquisador', 'Investigação e síntese',
 '- Investigar o código, a documentação e a web para responder a uma pergunta específica.
- Entregar uma síntese curta com fontes e incertezas.
- Não alterar arquivos do projeto.', 'plan', '["Read","Glob","Grep","WebSearch","WebFetch"]', 'telescope', 5, '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z'),
('role_documentador', 'global', 'Documentador', 'Documentação e comunicação',
 '- Manter README, docs e comentários alinhados ao código.
- Escrever em português claro, com exemplos curtos.
- Editar apenas documentação, salvo pedido explícito.', 'acceptEdits', '["Read","Glob","Grep","Edit","Write"]', 'book-open', 6, '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z'),
('role_seguranca', 'global', 'Segurança', 'Segurança e conformidade',
 '- Procurar segredos expostos, dependências vulneráveis e permissões excessivas.
- Classificar o risco de cada achado e propor a mitigação.
- Nunca executar comandos destrutivos.', 'plan', '["Read","Glob","Grep","Bash"]', 'shield', 7, '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z');
