# Octopus AI — Orquestrador de Projetos com Agentes de IA (macOS)

## Contexto

O diretório `octopus-ai` está vazio: projeto greenfield. O objetivo é um app desktop macOS que orquestra agentes de IA por projeto, cobrindo memória, instruções de agentes, skills, harness, MCPs e sessões, com acompanhamento visual das etapas, dos agentes trabalhando e das definições de orquestração, além de gestão de contexto e segurança de execução.

Decisões já tomadas com o usuário:

| Decisão | Escolha |
|---|---|
| Stack | Tauri 2 + React (UI), core em Rust, sidecar Node/TS rodando o Claude Agent SDK |
| Runtime de agente (v1) | Somente Claude Code / Claude Agent SDK (camada de adapter preparada para outros) |
| Memória e sandbox | Construir próprios, usando ai-memory e ai-jail apenas como inspiração |
| Escopo | Local, um usuário, vários projetos. Sem auth/multiusuário na v1 |
| Autenticação Claude | Suportar login do Claude Code (assinatura, uso pessoal) e API key, selecionável por projeto |

Ambiente verificado nesta máquina: macOS 27 (Apple Silicon), Xcode 16 / Swift 6, Node 23.1, npm 11, Homebrew, Docker 27, Claude Code 2.1.296 autenticado. Rust **não** instalado (resolve com `brew install rustup`). `pnpm`, `bun`, `container` (Apple) não instalados. `@anthropic-ai/claude-agent-sdk` atual: 0.3.300.

### O que levar das referências

- **ai-memory**: arquivos markdown como fonte da verdade + SQLite (FTS5) como índice derivado e reconstruível; pipeline capture → consolidate → recall → handoff; captura via hooks com sanitização de segredos; sem LLM por padrão, LLM opcional para consolidar; decaimento por uso.
- **ai-jail**: deny-by-default de rede com allowlist de hosts; credenciais "fantasma" (mask) injetadas só no host certo; config em camadas (projeto só pode apertar, global pode afrouxar); fail-closed; audit log com hash chain; rotular risco de cada permissão perigosa.
- **Paperclip**: modelo Projeto → Goals → Tasks (issues) com checkout atômico e locks; Runs com logs e custo por run; aprovações como estágio; orçamento por agente/projeto com hard stop; adapters por runtime; heartbeats/rotinas; activity log imutável.

### Fatos do Claude Agent SDK que moldam o desenho (verificados na doc)

- `query({prompt, options})` em TS; options relevantes: `cwd`, `model`, `permissionMode` (`default|acceptEdits|bypassPermissions|plan|dontAsk|auto`), `canUseTool`, `hooks`, `mcpServers` (`stdio|sse|http|sdk`), `agents` (subagentes programáticos), `allowedTools`, `resume`/`forkSession`/`continue`, `settingSources`, `systemPrompt` (preset `claude_code` + append), `maxTurns`, `env`, `sandbox`, `includePartialMessages`, `abortController`, `persistSession`.
- Hooks in-process (TS): `PreToolUse` (allow/deny/ask/defer + `updatedInput`), `PostToolUse`, `PostToolUseFailure`, `UserPromptSubmit`, `Stop`, `SubagentStart/Stop`, `PreCompact/PostCompact`, `PermissionRequest`, `SessionStart/End`, `Notification`, `InstructionsLoaded`, `WorktreeCreate/Remove`, `TaskCreated/Completed`, `ConfigChange`, etc.
- Sessões ficam em `~/.claude/projects/<cwd-codificado>/*.jsonl`; `listSessions()`, `getSessionMessages()`, `renameSession()`, `tagSession()` existem. Mensagens de subagentes trazem `parent_tool_use_id` (árvore reconstruível).
- Sandbox nativo do Claude Code (Seatbelt no macOS): `sandbox.enabled`, `allowUnsandboxedCommands`, `failIfUnavailable`, `filesystem.allowWrite/denyWrite/denyRead/allowRead`, `network.allowedDomains/deniedDomains/strictAllowlist`, `credentials` (deny/mask com `injectHosts`), `excludedCommands`. Cobre só comandos shell; Read/Edit/MCP/hooks rodam fora e dependem de permission rules.
- Aviso de licença: login claude.ai só para uso próprio; distribuição a terceiros exige API key. Modo `--bare`/sem keychain exige `ANTHROPIC_API_KEY`.

## Arquitetura

```
┌──────────────────────────── octopus-ai.app (Tauri 2) ────────────────────────────┐
│  UI React/TS (WebView nativo)                                                     │
│   Dashboard · Board do projeto · Run ao vivo · Agentes · Memória · Contexto       │
│   Segurança/Aprovações · Sessões · MCPs & Skills · Settings                        │
│                      ▲ tauri invoke / events (tipado via tauri-specta)             │
│  Core Rust (src-tauri)                                                             │
│   orchestrator (scheduler de tasks→runs, DAG, locks, worktrees)                    │
│   policy (motor PreToolUse, budgets, sandbox profile → SDK settings)               │
│   store (SQLite: projetos, agentes, tasks, runs, sessões, aprovações, custos)      │
│   memory (wiki markdown + FTS5, consolidação, recall, handoffs)                    │
│   audit (log append-only com hash chain) · secrets (Keychain)                     │
│   sidecar (supervisor do processo Node, JSON-RPC NDJSON por stdio)                 │
│                      ▲ stdio NDJSON                                                │
│  Sidecar Node/TS "agent-runtime"                                                   │
│   host do @anthropic-ai/claude-agent-sdk: query/resume/fork/interrupt,             │
│   hooks → encaminha ao Rust e aguarda decisão; canUseTool → UI;                     │
│   MCP in-process (`sdk`) expondo memória e tasks ao agente                          │
└────────────────────────────────────────────────────────────────────────────────────┘
          │ spawn                                        │ dados
   claude (binário nativo bundlado pelo SDK)      ~/Library/Application Support/octopus-ai/
                                                   octopus.db · projects/<id>/memory/wiki/*.md
                                                   raw/ · handoffs/ · audit.log
```

Por que esta divisão: o Agent SDK só existe em TS/Python e os hooks/canUseTool/MCP in-process precisam rodar no mesmo processo do SDK, logo o sidecar Node é obrigatório. Tudo que é estado, política e orquestração fica em Rust, para que o sidecar seja descartável/reiniciável e o core seja portável para Linux depois.

### Layout do repositório (npm workspaces)

```
octopus-ai/
  package.json                 # workspaces: apps/*, packages/*
  apps/desktop/
    src/                       # React + Vite + TS, Tailwind, shadcn/ui, Zustand, TanStack Query, xyflow (grafo), Monaco (editor)
    src-tauri/
      src/main.rs
      src/commands/            # comandos tauri (specta)
      src/orchestrator/        # scheduler, run lifecycle, worktrees
      src/policy/              # regras PreToolUse, budgets, sandbox profile
      src/store/               # SQLite (rusqlite + migrations)
      src/memory/              # wiki, fts, consolidação, recall
      src/sidecar/             # supervisor + JSON-RPC
      src/audit/               # hash chain
      binaries/                # agent-runtime-<target-triple> (sidecar)
      capabilities/default.json
      tauri.conf.json
  packages/agent-runtime/      # sidecar TS: @anthropic-ai/claude-agent-sdk, JSON-RPC NDJSON
  packages/protocol/           # JSON Schema do protocolo Rust↔sidecar↔UI (fonte única; gera TS com json-schema-to-typescript e Rust com typify/schemars)
  docs/                        # ADRs, protocolo, guia de políticas
```

### Protocolo Rust ↔ sidecar (NDJSON JSON-RPC 2.0)

- Requests Rust→sidecar: `run.start {runId, cwd, prompt, options}`, `run.send {runId, prompt}`, `run.interrupt`, `run.resume {sessionId, fork}`, `permission.decide {requestId, allow|deny, updatedInput?}`, `hook.decide {hookId, output}`, `sessions.list {cwd}`, `sessions.messages {sessionId}`.
- Notificações sidecar→Rust: `run.message {runId, sdkMessage}` (stream completo, inclui `parent_tool_use_id`), `run.permissionRequest`, `run.hook {event, input}` (bloqueante: Rust responde com `hook.decide`), `run.result {sessionId, cost, usage, stopReason}`, `run.error`.
- Rust re-emite para a UI como eventos Tauri `run:<runId>` e persiste o que importa (tool calls, custo, usage, hook decisions).

### Modelo de dados (SQLite, migrations em Rust)

- `project` (id, name, path, auth_mode `subscription|api_key`, default_agent_id, sandbox_profile_id, settings_json)
- `role` (id, scope `global|project`, project_id nullable, title, specialty, responsibilities_md, default_model, default_permission_mode, default_tools_json, icon, position)
- `agent_profile` (id, project_id nullable=global, role_id, name, avatar_seed, instructions_md, model, effort, permission_mode, allowed_tools_json, mcp_server_ids, skill_ids, subagents_json, max_turns, max_budget_usd)
- `team_member` (id, project_id, agent_profile_id, reports_to_agent_id nullable=gestor, position)
- `workflow` (id, project_id, name, stages_json: lista de estágios com agente responsável, gate humano sim/não, paralelismo)
- `task` (id, project_id, workflow_id, stage, title, description_md, status `backlog|ready|running|waiting_approval|review|done|blocked|failed`, assigned_agent_id, depends_on_json, acceptance_md, worktree_path, lock_run_id)
- `run` (id, task_id, project_id, agent_id, claude_session_id, status, started_at, ended_at, cost_usd, input_tokens, output_tokens, cache_read_tokens, model, stop_reason, transcript_path)
- `session` (claude_session_id, project_id, cwd, title, tags_json, created_at, last_used_at, forked_from)
- `approval` (id, run_id, kind `permission|stage_gate|budget`, tool_name, tool_input_json, reason, decision, decided_at)
- `mcp_server` (id, scope, name, transport, config_json, enabled, last_health)
- `skill` (id, scope, name, path, description)
- `memory_page` (id, project_id, slug, title, path, tier `fact|episode|handoff`, score, created_at, last_accessed_at) + tabela virtual FTS5 `memory_fts`
- `memory_observation` (id, run_id, kind, content_sanitized, created_at, consolidated_at)
- `context_pin` (id, project_id, kind `file|page|text`, ref, always_inject)
- `audit_event` (seq, ts, actor, kind, payload_json, prev_hash, hash)
- `budget_policy` (scope `project|agent|task`, scope_id, soft_usd, hard_usd, max_turns)
- `app_setting` (key PK, value_json, updated_at): preferências e estado do onboarding (`onboarding.completed_at`, `onboarding.checks_json`)
- `backup_snapshot` (id, created_at, path, schema_version, reason `auto|manual|pre-restore`, size_bytes)

## Funcionalidades por domínio

### Sessões e visão ao vivo dos agentes
- Lista de sessões por projeto via `listSessions()` do SDK, com renomear/taguear, retomar (`resume`) e bifurcar (`forkSession`).
- Painel de run ao vivo: transcript em streaming (`includePartialMessages`), árvore de tool calls, árvore de subagentes por `parent_tool_use_id`, botão interromper (`abortController`), custo e tokens acumulados, aprovações pendentes inline.
- Grafo de orquestração (xyflow): estágios do workflow, agente responsável em cada nó, runs ativos pulsando.

### Projetos, agentes e orquestração
- Projeto aponta para um repositório local; board Kanban por estágios do workflow; tasks com dependências (DAG) e critérios de aceite.
- Agente = perfil declarativo (instruções, modelo, ferramentas, permission mode, MCPs, skills, subagentes). Instruções viram `systemPrompt: {type:'preset', preset:'claude_code', append}`; subagentes viram `options.agents`.
- Scheduler em Rust: pega tasks `ready` cujas dependências estão `done`, respeita concorrência por projeto, faz checkout atômico (lock), cria `git worktree` por task (opcional por workflow), abre um run e, ao terminar, move a task para o próximo estágio ou para `waiting_approval` se o estágio tem gate humano.
- Templates de workflow iniciais: "Planejar → Implementar → Revisar → Aprovar", "Pesquisa paralela → Síntese".

### Modelo de time: cargos, especialidades e responsabilidades (inspirado no Paperclip, decidido em 16/10/2026)

O Paperclip apresenta agentes como funcionários de uma empresa: organograma com cargos, títulos e linhas de reporte, metas ligadas a issues, aprovações como governança, orçamentos com hard stop, heartbeats e activity log. Do que ele traz, o Octopus já cobria tasks com dependências e locks, runs com custo e orçamento, aprovações, audit log e adapters; faltava a **apresentação de time**. A metáfora escolhida é **"você gerencia o time"**: o usuário é o gestor; cada agente é um membro do time com cargo, especialidade e responsabilidades; a delegação entre agentes (subagentes) aparece como subordinação no organograma. Não há agente-CEO.

- **Cargo (`role`)**: título (ex.: Implementador), especialidade em uma linha (ex.: "Código Java/Spring e migrações"), responsabilidades em markdown (3 a 5 frases que viram parte do `systemPrompt.append`), modelo e permission mode padrão, ferramentas padrão, ícone. Escopo global (catálogo) ou do projeto (ajustes locais). Catálogo inicial: Planejador, Implementador, Revisor, Testador, Pesquisador, Documentador, Segurança.
- **Membro do time (`team_member`)**: um `agent_profile` colocado no time de um projeto, com `reports_to_agent_id` (a quem reporta; `null` = reporta ao gestor) e `position` para a ordem no organograma. O perfil herda do cargo e pode sobrescrever instruções, modelo, ferramentas e orçamento.
- **Telas**: *Time* (organograma com o gestor no topo e cards de membro; status ao vivo quando há run; custo do mês vs. orçamento), *Ficha do membro* (responsabilidades, como trabalha, delegação, histórico de runs e custo) e *Board* (Kanban por estágio com avatar do responsável em cada card). A entrada de navegação "Agentes" passa a chamar-se **Time**.
- **Regras visuais (Grafite)**: avatar monocromático com iniciais sobre `--surface` e borda `--mist` (o acento vermelho fica para run ativo, ação primária e alertas); título do cargo em Plus Jakarta Sans; especialidade em eyebrow; responsabilidades em até 3 linhas no card; chips de ferramentas; barra fina de custo do mês sobre o orçamento; organograma com linhas em `--mist` ligando gestor → membros → delegados. Pranchas: `Time`, `AgenteFicha` e `BoardTime` no artefato Design.
- **Fora de escopo por decisão (16/10/2026)**: metas (goals) ligadas às tasks e heartbeats/rotinas do Paperclip. Reavaliar na Fase 7 ou depois.

### Segurança de execução (camadas)
1. **Sandbox nativo do Claude Code**: perfil de sandbox por projeto no app → traduzido para `options.sandbox`/settings (`enabled: true`, `allowUnsandboxedCommands: false`, `failIfUnavailable: true`, `filesystem.allowWrite` = só o projeto/worktree, `denyRead` para `~/.ssh`, `~/.aws`, `~/.config` etc., `network.allowedDomains` com allowlist, `strictAllowlist`, `credentials` deny/mask com `injectHosts`). Perfis prontos: `estrito`, `dev-padrão`, `somente-leitura`.
2. **Motor de política em Rust via `PreToolUse`**: deny de comandos destrutivos fora do projeto, bloqueio de escrita em `.env`/segredos, bloqueio de `git push` em branches protegidas, confinamento de caminhos ao projeto, lista de MCP tools permitidas. Decisão `allow|deny|ask`; `ask` vira aprovação na UI (`canUseTool`). Regras do projeto só podem apertar; afrouxar só no escopo global (padrão ai-jail).
3. **Orçamentos**: `maxTurns` e `maxBudgetUsd` por run, soft/hard stop por projeto/agente; hard stop interrompe o run e marca a task `blocked`.
4. **Auditoria**: todo evento (tool call, decisão de hook, aprovação, início/fim de run, alteração de política) no `audit_event` com hash encadeado SHA-256; viewer com verificação de integridade.
5. **Segredos**: API keys no Keychain (`keyring` crate); nunca em JSON de config; variáveis passam ao sidecar por `env` apenas quando o projeto está em `api_key`.
6. **Isolamento forte (fase posterior, opcional)**: runner alternativo que executa sidecar + `claude` dentro de um container Linux (Apple `container` em macOS 26+ ou Docker) com bind mount só do projeto e rede filtrada, para tasks marcadas como não confiáveis.

### Memória (própria, inspirada em ai-memory)
- Armazenamento: `projects/<id>/memory/wiki/*.md` é a fonte da verdade (versionado em git interno); `memory_fts` é índice derivado e reconstruível (`rebuild-index`).
- Captura: hooks `PostToolUse` (edições, comandos), `Stop` (resumo do turno), `SubagentStop`, `SessionEnd`; `memory_observation` guarda conteúdo sanitizado (regex de tokens/keys/senhas antes de gravar).
- Consolidação: ao fim do run, um passo opcional com modelo barato (`claude-haiku-5-5`) transforma observações em páginas (decisões, arquitetura, armadilhas, log de tarefas) e marca contradições; sem LLM configurado, grava resumo bruto. Nada é apagado, páginas têm histórico.
- Recall: busca FTS5 + ranking por recência/uso; no `SessionStart`/`UserPromptSubmit` injeta um brief (top-k páginas + handoff pendente) como `additionalContext`; o agente também acessa via MCP in-process (`createSdkMcpServer`) com tools `memory_search`, `memory_write`, `memory_handoff`, `task_update`.
- Handoff: ao terminar/interromper um run, gera nota "onde parei / o que falhou / o que falta"; o próximo run da mesma task recebe e consome (claim único).
- Decaimento: `score` cai com o tempo e sobe com acesso; páginas frias podem ser arquivadas manualmente.

### Gestão de contexto
- Medidor de contexto por run: soma `input_tokens + cache_read_input_tokens` da última mensagem do assistente vs. janela do modelo; alerta em 70%/90%.
- Pins de contexto (arquivos, páginas de memória, texto) sempre injetados no início da sessão.
- Visibilidade do que entrou: hook `InstructionsLoaded` lista CLAUDE.md/rules carregados; `PreCompact/PostCompact` registra compactações e o resumo gerado; `settingSources` controlado por projeto para decidir se carrega `~/.claude`, `.claude/` do projeto ou nada.
- Ações: compactar agora (enviar prompt `/compact`), bifurcar sessão para começar limpo mantendo histórico, excluir caminhos de leitura.

### Skills, MCPs e harness
- Registro de MCP servers (stdio/http/sse) global e por projeto, teste de conexão, vínculo por perfil de agente → `options.mcpServers`.
- Registro de skills (pastas com `SKILL.md`) globais e por projeto, com editor; vínculo por perfil → `options.plugins`/`settingSources`.
- Harness: editor de hooks declarativos (regras de política acima), permission mode, sandbox profile, `maxTurns`, modelo/effort; preview do `options` final que será enviado ao SDK.

### Autenticação
- Por projeto: `subscription` usa o login existente do Claude Code (sidecar herda keychain do usuário) ou `api_key` (do Keychain do app, passado via `env.ANTHROPIC_API_KEY`). Tela de settings mostra qual modo está ativo e o aviso de licença para distribuição.

### Onboarding e backup local de configurações (decidido em 16/10/2026)

Com o build de teste em mãos, quem instala o app precisa ser guiado e poder guardar o que configurou. "Por hora" tudo é local: sincronização e nuvem ficam fora de escopo.

- **Onboarding** (primeira abertura, ou sempre que um pré-requisito faltar): tela de boas-vindas em 4 passos no tema Grafite.
  1. *Ambiente*: Node encontrado (reusa `find_node()` do supervisor; mostra o caminho ou instrui a instalar e permite apontar via `OCTOPUS_NODE`), sidecar respondendo (`runtime.hello`) e Claude Code autenticado (teste real: `run.start` curto em modo `plan` com `maxTurns: 1`, ou o estado de auth do SDK quando houver), com o aviso de licença do login pessoal.
  2. *Autenticação padrão*: assinatura ou API key (a chave em si é informada por projeto em Segurança → Autenticação e vai para o Keychain).
  3. *Primeiro projeto*: reusa `AddProjectDialog`, com a opção "importar um backup" em vez de começar do zero.
  4. *Tema*: Sistema, Claro ou Escuro.
  Entrada "Refazer onboarding" em Settings; cada checagem vira depois um item de status na tela Segurança/Settings.
- **Backup local de configurações**: exportar/importar `octopus-config-<data>.json` legível, com `schemaVersion`, contendo `project` (sem segredos), `role`, `agent_profile`, `team_member`, `workflow`, `mcp_server` (config sem credenciais), `skill`, `budget_policy`, `context_pin` e preferências do app (tema, modo de auth padrão, último projeto). Nunca inclui runs, eventos, aprovações, API keys ou memória. Cópias automáticas versionadas em `~/Library/Application Support/ai.octopus.desktop/backups/` a cada mudança de configuração (com debounce), mantendo as últimas 20; restauração com preview (o que entra, o que conflita por id/path) nos modos "mesclar" e "substituir configurações". Comandos Rust `config_export`, `config_import`, `config_backups_list`, `config_backup_restore`; o formato do export é a base do futuro sync.
- **Fora de escopo por decisão (16/10/2026)**: backup em nuvem/sincronização entre máquinas e backup de runs e memória (reavaliar depois da Fase 4).

## Fases de implementação

Dois princípios transversais, definidos pelo usuário:

- **Proposta visual no Claude Design**: antes de codar cada conjunto de telas, a proposta de UI (fluxos, layout, estados) é feita como artefato do tipo Design (Claude Design) e aprovada; a implementação React segue o design aprovado. A primeira proposta cobre as telas da Fase 0 e 1 (Run ao vivo, Sessões, Aprovações) e o shell de navegação.
- **Testes automatizados desde o início**: a Fase 0 já entrega `cargo test` (store, supervisor, protocolo), `vitest` no sidecar (parser de mensagens, JSON-RPC) e no UI (componentes), um teste Playwright/WebDriver do fluxo principal e um workflow de CI (GitHub Actions, macOS runner) que roda tudo. Cada fase seguinte adiciona seus testes junto com o código, nunca depois.

### Fase 0a — Proposta visual (Claude Design)
- Artefato Design com: shell do app (sidebar de projetos, barra de runs ativos), tela Run ao vivo (transcript, árvore de tool calls/subagentes, medidor de contexto e custo, aprovações inline), lista de Sessões, inbox de Aprovações. Tema claro/escuro.
- Pronto quando: usuário aprova o design; os componentes e tokens viram a base do `apps/desktop/src`.

### Fase 0 — Fundação (scaffold funcional de ponta a ponta)
- Instalar Rust (`brew install rustup && rustup-init`) e `@tauri-apps/cli`; `npm create tauri-app` com React+TS+Vite em `apps/desktop`.
- `packages/agent-runtime`: sidecar TS com JSON-RPC NDJSON e um `run.start` que faz `query()` e repassa mensagens. Em dev roda com `node`; em release compila com Node SEA ou `bun build --compile` (lembrar `extractFromBunfs()` para o binário do SDK) e registra em `bundle.externalBin`.
- Rust: supervisor do sidecar, SQLite com migrations, comandos `project.*`, `run.start/stop`, eventos para UI, tipos gerados a partir de `packages/protocol`.
- UI: tela única "Run" com prompt, transcript ao vivo, interromper, seguindo o design da Fase 0a.
- Testes: `cargo test` (migrations, repositório de runs, framing NDJSON, supervisor com sidecar fake), `vitest` (sidecar: redução de mensagens do SDK, roteamento JSON-RPC; UI: componentes do transcript), Playwright no fluxo "iniciar run → ver streaming", CI em GitHub Actions.
- Pronto quando: abrir o app, escolher uma pasta, mandar um prompt e ver o Claude trabalhar em streaming, com `session_id` e custo persistidos, e a suíte de testes verde localmente e no CI.

### Tema visual (decidido em 15/10/2026): Grafite

Minimalista, quase monocromático, um único acento que preserva a identidade TIVIT. Substitui os tokens atuais de `apps/desktop/src/index.css` (bloco `@theme`) e passa a valer para as novas pranchas do Claude Design.

| Token | Claro | Escuro |
|---|---|---|
| fundo (`--color-paper`) | `#FAFAF9` | `#0B0B0C` |
| superfície (`--color-surface`) | `#FFFFFF` | `#151517` |
| texto (`--color-ink`) | `#111111` | `#ECECEA` |
| texto secundário (`--color-slate`) | `#6B6B6B` | `#A1A19D` |
| linhas (`--color-mist`) | `#D6D3D1` | `#2A2A2D` |
| acento (`--color-brand`) | `#E4002B` | `#FF3355` |
| sucesso | `#2E7D4F` | `#4CAF78` |
| aviso | `#C98A1B` | `#E0A63A` |

Fontes mantidas: Plus Jakarta Sans (display), Inter (corpo), JetBrains Mono (código). Regras: sem gradientes, radii 6–16px, sombras quase ausentes, vermelho só para ação primária, estado ativo e alertas. Tema escuro via `prefers-color-scheme` e toggle manual (`data-theme`).

Aplicação: primeiro passo da Fase 1, antes das pranchas novas: atualizar `@theme` e adicionar o bloco escuro em `index.css`, ajustar o shell (sidebar deixa de ser preta fixa e segue a superfície escura do tema), repintar as três pranchas existentes no artefato Design e só então desenhar as da Fase 1.

### Fase 1 — Sessões, aprovações e visão ao vivo (concluída em 16/10/2026, tag `fase-1`)
- Lista de sessões (`listSessions`), retomar, bifurcar, renomear, taguear.
- `canUseTool` → aprovação na UI com diff/preview do input; `permissionMode` por run.
- Árvore de tool calls e subagentes, medidor de custo/tokens.

### Fase 2 — Onboarding, time e orquestração (concluída em 16/10/2026 na branch `fase-2/onboarding-time-orquestracao`)
- **2a — Onboarding e backup local (primeira iteração; prancha no Design antes: `Onboarding.dc.html` com os 4 passos e `Backup.dc.html` com lista de cópias, exportar/importar e preview de restauração)**: tabelas `app_setting` e `backup_snapshot`, tela de boas-vindas com as checagens de ambiente, export/import e cópias automáticas.
- **2b — Time (telas aprovadas no Design na Fase 1, iteração 03)**: catálogo de cargos com seed, CRUD de membros do time, tela Time com organograma (xyflow) e cards de membro, Ficha do membro, Board Kanban com responsável por card; nav "Agentes" vira "Time". Perfil de agente vira `options` do SDK (instruções do cargo + do membro em `systemPrompt.append`, `agents` para os delegados).
- **2c — Orquestração**: CRUD de projetos, workflows e tasks; scheduler (locks, DAG, concorrência, worktrees, gates humanos); templates de workflow; grafo de estágios.
- MCP in-process com `task_update` para o agente mover a própria task.
- Entregue: migrations 0003–0005 (`app_setting`, `backup_snapshot`, `role`, `agent_profile`, `team_member`, `workflow`, `task`, `task_event`), scheduler em Rust (`scheduler.rs`, tick a cada 4 s + `scheduler_tick` manual, pausa por preferência), `RunOptions.agents` e `taskContext` no protocolo, tool MCP `task_update` no sidecar, telas Onboarding, Configurações, Time, Ficha do membro e Board. Fora: grafo xyflow (o organograma e a faixa de estágios são CSS), edição visual de estágios (só por modelo e comando `update_workflow`), heartbeats/metas (decisão de 16/10).

### Fase 3 — Segurança de execução (concluída em 16/10/2026 na branch `fase-3/seguranca`)
- Pranchas no Design antes das telas: `Seguranca.dc.html` (sandbox, política, autenticação, orçamentos) e `Auditoria.dc.html`.
- **01 — Auditoria**: migration 0006 (`audit_event` append-only, hash SHA-256 de `prev_hash|ts|actor|kind|project|payload`, gênese `0…0`), eventos de run, aprovações e configurações, verificação de integridade, exportação JSONL, aba Auditoria com filtros por família.
- **02 — Motor de política PreToolUse**: `RunOptions.policyHooks` → o sidecar registra `hooks.PreToolUse`, emite `run.hook` e espera `hook.decide` (timeout 30 s → `ask`); Rust avalia `policy_rule` (deny > ask > allow > pass; sentinelas `@destructive-outside-project` e `@outside-project`; regras do projeto só deny/ask) e audita `policy.*`; aba Política com regras, interruptores e simulador.
- **03 — Sandbox e orçamentos**: migration 0008 (`sandbox_profile` com Estrito/Dev padrão/Somente leitura e `${PROJECT}`; `project.sandbox_profile_id`; `budget_policy` por projeto e membro com aviso, limite e turnos por run). `start_run` e o scheduler aplicam `options.sandbox` e o orçamento do mês (limite esgotado recusa o run e põe a task em Bloqueada; `maxBudgetUsd` é limitado ao restante). Seção Sandbox, aba Orçamentos e chips no cabeçalho do run.
- **04 — Keychain**: `SecretStore` (Keychain via `keyring`, memória em testes/`OCTOPUS_SECRETS=memory`); a chave entra só na cópia das opções enviada ao sidecar, nunca no run gravado, no export nem na auditoria (`secret.set` registra "valor não registrado"). Seção Autenticação do projeto. Correção de passagem: os comandos Tauri de configurações, time, orquestração e segurança não estavam registrados em `generate_handler!`.
- Fora: interrupção automática do run em andamento ao estourar o limite no meio (feita depois, em "Lacunas" 01), lista de MCP tools permitidas por regra, isolamento forte (Fase 6).

### Fase 4 — Memória e contexto (concluída em 16/10/2026 na branch `fase-4/memoria-contexto`)
- Pranchas no Design antes das telas: `Memoria.dc.html` (wiki, busca, observações) e `Contexto.dc.html` (medidor, brief, pins, compactações).
- **01 — Captura, wiki e FTS5**: `RunOptions.memory.capture` registra hooks `PostToolUse`, `Stop`, `SubagentStop`, `SessionEnd`, `PreCompact`, `PostCompact` (e `InstructionsLoaded`, na 04) que emitem `observation` e `compaction`; migration 0009 (`memory_observation`, `memory_page` + versões, FTS5 externo, `context_event`); sanitização de segredos antes de gravar; páginas são arquivos `.md` em `<dados>/projects/<id>/memory/wiki` (fonte da verdade, índice reconstruível); consolidação bruta ao fim do run no "Log de tarefas — mês"; tela Memória (Páginas, Observações).
- **02 — Recall e handoffs**: brief (handoff pendente da task, consumido uma vez, + páginas relevantes ao pedido, até 3.000 caracteres) injetado como `additionalContext` no primeiro `UserPromptSubmit` e registrado como `brief_injected`; tools MCP `memory_search`, `memory_write`, `memory_handoff` respondidas pelo core (`run.memory_call` → `memory.result`); handoff automático quando um run de task termina sem concluir; aba Handoffs e chip "Memória injetada" no sidebar.
- **03 — Consolidação com Haiku**: preferência `memory.consolidation` (`raw` | `haiku`); run de consolidação (`run.kind = consolidation`, `claude-haiku-5-5`, `dontAsk`, só `memory_write`/`memory_search`, demais ferramentas proibidas via `disallowedTools`, teto US$ 0,25) disparado ao fim de cada run de agente; `memory_write` com título existente atualiza a página; score decai com meia-vida de 30 dias.
- **04 — Contexto**: pins (arquivo do projeto, página, texto; sempre no brief), `settingSources` por projeto, alertas em 70%/90% com "Compactar agora" (`/compact` numa retomada, experimental), histórico de compactações e instruções carregadas (hook `InstructionsLoaded`), aba Contexto com o que entrou no último run.
- Fora: git interno da wiki (há versões no banco e os `.md` podem ir ao git do usuário), consolidação de contradições além da marcação textual pelo Haiku, memória entre projetos.

### Fase 5 — Skills, MCPs e harness (concluída em 16/10/2026 na branch `fase-5/skills-mcps-harness`)
- Pranchas no Design antes das telas: `Harness.dc.html` (MCPs e skills) e `HarnessPreview.dc.html` (perfil de execução, hooks ativos e preview do `options`).
- **01 — MCP servers**: `McpServerConfig` (stdio | sse | http) e `RunOptions.mcpServers` no protocolo; request `mcp.check` (o sidecar abre o servidor com `@modelcontextprotocol/sdk`, faz o handshake e lista as tools, timeout 15 s); migration 0013 (`mcp_server` global/projeto, `agent_profile.mcp_server_ids_json`); saúde da última checagem; export/import do backup sem valores de env/headers; nav Harness com a aba MCPs.
- **02 — Skills**: `RunOptions.plugins`; migration 0014 (`skill`, `agent_profile.skill_ids_json`); varredura de `.claude/skills` do projeto e `~/.claude/skills` (frontmatter), interruptores, editor e criação de `SKILL.md` confinada ao projeto; plugin local em `<dados>/projects/<id>/harness/plugin-<membro|project>` com as skills ativas que o Claude Code não carrega sozinho; ficha do membro escolhe MCP servers e skills.
- **03 — Perfil de execução**: defaults do projeto (`project.<id>.defaults`: modelo, turnos) aplicados em runs avulsos e no scheduler; `preview_run_options` monta o `RunOptions` final sem efeitos colaterais, com a origem de cada campo e os hooks declarativos ativos; aba "Perfil de execução".
- Fora: editor livre de hooks e `effort` por run (feitos depois, em "Lacunas" 03 e 02), marketplace/instalação de plugins remotos, tool policies por MCP server.

### Fase 6 — Isolamento forte (opcional)
- Runner em container (Apple `container` ou Docker) para tasks não confiáveis.

### Fase 7 — Polimento e distribuição (concluída em 16/10/2026 na branch `fase-7/polimento-distribuicao`)
- Prancha no Design antes das telas: `Distribuicao.dc.html` (menu bar, notificações, atualizações e atalhos).
- **01 — Menu bar e notificações**: ícone (feature `tray-icon`) com runs ativos, aprovações pendentes, tasks aguardando, Abrir, Pausar/Retomar scheduler e Sair, atualizado por evento e por tick; `tauri-plugin-notification` para aprovações, tasks (revisão/bloqueio) e fim de run conforme `notifications.*`, só com a janela fora de foco; fechar a janela esconde e o Dock reabre.
- **02 — Distribuição e updater**: `scripts/build-app.mjs` (assinatura ad-hoc por padrão, `APPLE_SIGNING_IDENTITY` e variáveis de notarização quando houver Developer ID), `createUpdaterArtifacts` com chave em `~/.tauri/octopus-updater.key` e pública no `tauri.conf.json`, `release/latest.json`; `tauri-plugin-updater` com endereço em `updates.endpoint` (sem endereço o app não procura); seção Atualizações.
- **03 — Atalhos**: ⌘1…⌘9, ⌘., ⌘N (e ⌘↵ no composer), com ajuda em Configurações.
- Fora: assinatura com Developer ID e notarização (exigem a conta Apple do usuário; o script já aceita as variáveis), binário único do sidecar (Node continua pré-requisito), servidor de releases, Windows/Linux. A Fase 6 fica opcional.

### Lacunas — orçamento no meio do run, esforço por run e hooks livres (concluídas em 19/10/2026 na branch `lacunas/orcamento-esforco-hooks`)
- Pranchas no Design antes das telas: `OrcamentoEsforco.dc.html` (run interrompido por orçamento, custo estimado, esforço no composer) e `HarnessHooks.dc.html` (editor de hooks livres).
- **01 — Orçamento no meio do run**: custo estimado por resposta (`store/pricing.rs`, preços públicos por MTok; modelo desconhecido usa o do Opus 5) somado em `run.est_cost_usd` uma vez por `messageId`, subagentes inclusos (migration 0015). O gasto do mês passa a ser custo final do SDK, ou a estimativa enquanto ele não chega. Depois de cada `usage` ou `result`, se o projeto ou o membro passou do hard, o core marca os runs ativos do escopo como interrompidos (`stop_cause = budget`) antes de pedir `run.interrupt`, bloqueia a task que cada um executava e audita `budget.hard_stop`; evento Tauri `budget:stopped` e notificação nativa. UI: chip "Interrompido · orçamento", banner com "Aumentar o limite", custo "≈" ao vivo no cabeçalho e no painel, parte "em andamento" na aba Orçamentos.
- **02 — Esforço por run**: `RunOptions.effort` vai direto para `options.effort` do SDK. Precedência composer (só aquele run) → membro (`agent_profile.effort`, migration 0016, entra no backup) → default do projeto (`project.<id>.defaults.effort`) → padrão do modelo; delegados levam o próprio esforço. O preview mostra a origem.
- **03 — Hooks livres**: tabela `custom_hook` (migration 0017, global ou do projeto, entra no backup), aba Harness → Hooks com lista, editor, filtro de ferramentas por regex validada e "Testar com exemplo" (`hooks.test`, mesmo código do run). O sidecar roda os comandos com a semântica dos command hooks do Claude Code e filtra a saída para só apertar. `hook_ran` aparece na transcrição; bloqueios vão para a auditoria; o preview lista os hooks livres.
- Fora: a estimativa ao vivo não conta tokens de ferramentas server-side nem a faixa de preço acima de 100k do Haiku 5.5 (o custo final do SDK corrige ao fechar); hooks livres rodam fora do sandbox do agente, com as permissões do usuário (dito na tela); o import em modo "substituir" não remove hooks ausentes do arquivo (como os MCP servers).

### Fase 8 — Time como empresa: entregas, confiança e delegação (23/10/2026, branch `fase-8/empresa-de-agentes`)
Motivo: na revisão da release o usuário criou um "Game Product Owner" e quis (a) que esse papel não dependesse dele para aprovar, (b) que o membro visse quem tem no time e as tasks para demandar, (c) ver o resultado das tasks com facilidade. Referências: Paperclip (agente com título, gerente, *trust preset* "pode atribuir tasks", aprovações subindo o organograma) e CrewAI (`allow_delegation`, tools "Delegate work to coworker", `expected_output`/`TaskOutput`). Decisões do usuário: aprovação de papel autônomo sobe para o **gerente no organograma**; delegação **só para quem reporta ao membro**; resultado visível **na task do Board, numa aba Entregas e no fim do transcript**.
- Pranchas no Design antes das telas: `Entregas.dc.html`, `Confianca.dc.html`, `Delegacao.dc.html`.
- **01 — Entregas**: `task_update` ganha `result` (markdown, até 20k); o core grava `task.result_md` na hora e, ao fim do run, completa com o texto final, os arquivos tocados (relativos ao worktree/projeto) e o run de origem (migration 0019). `claim_task` guarda o commit base; `store/task_diff.rs` monta o diff do worktree (ou do projeto, best-effort) contra a base (`git diff --name-status` + untracked, conteúdo confinado, 256 KB por arquivo); comando `task_diff`. UI: seção Resultado na task (markdown, Copiar), chips de arquivos e "Ver diff"; toggle **Kanban | Entregas** no Board; ícone de entrega no card; card **Resultado** no fim de todo transcript.
- **02 — Confiança e aprovação em cadeia** (migration 0020): `TrustPolicy` por cargo (default) e por membro (override): autonomia `supervised` (você aprova, padrão) · `managed` (sobe o organograma; no topo, você) · `autonomous` (sobe o organograma; no topo, auto-aprova e registra), "pode criar e atribuir tasks" e "aprova quem reporta a ele". Cargo seed **Gestor de produto** (autônomo, delega, aprova). `resolve_approver` sobe o `reports_to` até o primeiro chefe que aprova. Estágio gate ganha `approver: human | policy` (default `human`; toggle no chip). Gate por política e pedido de `review` do agente seguem a cadeia: `waiting_approval` (você), `review` (status com `approver_agent_id`) ou `auto_approved` (segue, ator "política"). **Runs de revisão** (`run.kind = review`): o scheduler roda o aprovador no worktree da task, modo padrão (em `plan` o agente se recusa a chamar `task_update`) com allowlist só de leitura (git status/diff/log…), sem Edit/Write, `board.reviewMaxTurns` (15), `task_update` só aceita `approved | returned` (`TaskContext.mode = review`). Aprovado avança com ator "agente <nome>"; devolvido reabre para quem fez e acima de `board.maxAgentReturns` (2) sobe para você; sem decisão duas vezes sobe para você; remover o revisor escala. Você aprova por cima a qualquer momento (interrompe o run de revisão). Badge do Board conta só o que espera você.
- **03 — Delegação** (migration 0021): tools MCP `team_list`, `task_list`, `task_create`, `task_assign` (`RunOptions.boardTools`, ligado por `agent_run_options` só para quem pode atribuir), round trip `run.board_call` → `board.result` espelhando o da memória; `store/board_calls.rs` valida tudo no core (confiança, responsável ∈ descendentes, dependências do projeto, estágio, `board.maxOpenTasksPerAgent` (10), 20 criações por run, recusa reatribuir task em run). Task guarda `created_by_agent_id`; evento `created_by_agent` e auditoria `board.task.created_by_agent`; o prompt da task só rotula "criada por um membro" (política e sandbox não mudam). A atribuição explícita passa a vencer o responsável do estágio no scheduler. UI: "criada por <nome>" no card e na task, transcript com chamadas legíveis, carga e "criou N" no Time.
- **04 — Governança e docs**: Configurações → "Board e delegação" (`board.maxAgentReturns`, `board.maxOpenTasksPerAgent`, `board.reviewMaxTurns`); auditoria `board.review.auto_approved` e `board.review.escalated`; consolidação inclui runs de revisão ("**Revisão:** aprovado/devolvido"); protocolo, README e esta seção.
- Testes reais (`--ignored`, com o Claude de verdade): entrega com worktree (`result_md`, `files_changed`, diff com `NOTAS.md`), cadeia de revisão (Ana entrega, Rui revisa e aprova sem clique) e delegação (Gabi lista o time e cria a task para a Dani; o próximo tick roda como a Dani).
- Fora: edição de cargos e de estágios na UI (confiança só por membro; `approver` só pelo chip); `review_parallel` próprio; metas e rotinas do Paperclip; delegação para quem não reporta ao membro. Achado para depois: o hook de confinamento de caminhos compara sem resolver links simbólicos (`/var` vs `/private/var` no macOS) — barra um caminho válido e, em tese, deixaria passar uma escrita por link; corrigir com `canonicalize` antes de comparar.

## Verificação

- **Fase 0**: `npm run tauri dev` abre o app; prompt "liste os arquivos" em uma pasta de teste produz streaming e um registro em `run` com `claude_session_id` e `cost_usd`; `sqlite3 octopus.db 'select * from run'` confirma.
- **Fase 1**: retomar a sessão e perguntar "o que fizemos antes?" responde com contexto; pedir uma escrita de arquivo gera aprovação na UI; negar impede a escrita.
- **Fase 2**: apagar o banco, abrir o app e concluir o onboarding (as 3 checagens verdes, projeto criado); exportar as configurações, apagar o banco de novo e restaurar o backup recria projetos, time e preferências; montar um time com 3 membros (Planejador → Implementador → Revisor) e ver o organograma com os três ligados ao gestor; abrir a ficha do Implementador e conferir que as responsabilidades do cargo entram no `system/init`; criar workflow de 3 estágios com 2 tasks dependentes; scheduler só inicia a segunda após a primeira ficar `done`; gate humano segura a task em `waiting_approval`; worktree criado em `.octopus/worktrees/<task>`.
- **Fase 3**: com perfil `estrito`, pedir `curl https://example.com` falha (host fora da allowlist) e `cat ~/.ssh/id_rsa` falha; pedir `rm -rf /tmp/x` fora do projeto é negado pelo motor Rust com motivo visível; alterar manualmente uma linha do audit log quebra a verificação de hash.
- **Fase 4**: após um run, páginas aparecem em `memory/wiki`; novo run na mesma task recebe o handoff; busca na UI encontra a decisão registrada; medidor de contexto sobe conforme o run avança e registra a compactação. Verificado com o Claude real (`cargo test real_sidecar -- --ignored`): o agente encontra no brief a palavra secreta gravada na memória e a devolve via `task_update`; com `memory.consolidation = haiku`, o run de consolidação grava páginas sem pedir permissão (US$ 0,01).
- **Fase 5**: adicionar um MCP server inválido mostra erro de health (coberto pelo mock e pelo fake sidecar; o teste real com um MCP de verdade fica para quando houver um servidor disponível); agente com skill vinculada a vê no `system/init` (o plugin local entra em `options.plugins`; verificado por teste unitário do plugin montado, não com o Claude real).
- **Verificação real de 20/10/2026** (`cargo test real_ -- --ignored --nocapture --test-threads=1`, com o login do Claude Code; ~US$ 1 no total): MCP server stdio local passa no `mcp.check`, conecta no run e a tool responde; skill do projeto aparece no `session_init` (campo `skills`); hook livre `PreToolUse` bloqueia o Bash e recebe `effort.level = low` na entrada; orçamento abaixo do custo da primeira resposta interrompe o run (`stop_cause = budget`); a estimativa ao vivo fica a menos de 5 % do custo final do SDK.
- **Uso real** (`real_dogfood_review_on_a_repo_copy`: o Revisor, em modo plan, revisa `customHooks.ts` numa cópia do repositório e um segundo run pergunta o que ele encontrou). Atritos achados e corrigidos: estimativa ao vivo ~⅓ abaixo do real (cache de 1 h a 2× e saída final do `message_delta`); 5 bugs reais no `customHooks.ts` (tempo limite sem matar filhos, UTF-8 partido entre pedaços, JSON grande truncado perdendo o bloqueio, `{` em texto de contexto virando erro, segredos do ambiente indo para o hook); o modo plan barrava o arquivo de plano em `~/.claude/plans/` pela política e o agente recusava `memory_write` (agora há aviso no system prompt e as tools internas do Octopus não pedem aprovação); o log de tarefas entrava cortado pelo começo no brief (agora pelo fim, com até 2.000 caracteres do resultado). Não testado ainda: a janela do app com o Claude real (a verificação passou pelo core e pelo sidecar).
- **Sidecar como binário único** (20/10/2026): `scripts/build-sidecar-binary.mjs` (esbuild → Node SEA → `postject`) com o Node 24 oficial de nodejs.org; o `.app` leva `agent-runtime` e o `claude` nativo em `Contents/MacOS` e não exige Node na máquina. Verificado de dentro do app assinado, sem Node no PATH: handshake, `mcp.check`, `hooks.test` e `run.start`.
- Testes automatizados: `cargo test` (policy engine, hash chain, scheduler/DAG, FTS), `vitest` no sidecar (parser de mensagens, protocolo), Playwright em 2 fluxos críticos (iniciar run, aprovar permissão).

## Riscos e mitigações

- **Agent SDK muda rápido (0.3.x)**: fixar versão no sidecar, encapsular tudo em `packages/agent-runtime`, testar upgrade por fase.
- **Bundle do sidecar**: `bun build --compile` exige `extractFromBunfs()`; alternativa Node SEA. Em dev, rodar via `node` direto.
- **Login claude.ai é só para uso pessoal**: já exposto na tela de auth; distribuição exige `api_key`.
- **Seatbelt é deprecado pela Apple** mas é o que o Claude Code usa hoje; a Fase 6 oferece isolamento por VM/container como alternativa.
- **Apple `container` exige macOS 26+ e está em versão 0.x**: tratar como opcional e detectar presença em runtime.
