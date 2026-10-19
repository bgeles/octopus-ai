# Protocolo Rust ⇄ sidecar ⇄ UI

Fonte da verdade: `packages/protocol/src/index.ts` (schemas Zod). O lado Rust espelha os tipos em `apps/desktop/src-tauri/src/protocol.rs`. Os dois lados são verificados contra as fixtures em `packages/protocol/fixtures/`, que também alimentam o transporte de mock da UI e o sidecar falso dos testes Rust.

## Transporte

JSON-RPC 2.0 em NDJSON (uma mensagem JSON por linha) pelo stdio do sidecar.

- Rust → sidecar: **requests** (com `id`). O sidecar responde `result` ou `error`.
- sidecar → Rust: **notificações** (sem `id`).
- stderr do sidecar é só log.

## Requests

| Método | Params | Result |
|---|---|---|
| `runtime.hello` | `{ protocolVersion }` | `{ protocolVersion, runtimeVersion, sdkVersion }` |
| `run.start` | `{ runId, cwd, prompt, options }` | `{ accepted: true }` |
| `run.interrupt` | `{ runId }` | `{ interrupted }` |
| `permission.decide` | `{ runId, requestId, decision }` | `{ applied }` |
| `sessions.list` | `{ cwd }` | `{ sessions: SessionSummary[] }` |
| `sessions.rename` | `{ sessionId, cwd, title }` | `{ ok: true }` |
| `sessions.tag` | `{ sessionId, cwd, tag: string \| null }` | `{ ok: true }` (`null` remove a tag) |
| `hook.decide` | `{ runId, hookId, decision: { behavior: allow\|deny\|ask, reason?, updatedInput? } }` | `{ applied }` (resposta do core a um `run.hook`) |
| `mcp.check` | `{ name, config: { type: stdio\|sse\|http, command/args/env \| url/headers } }` | `{ ok, tools: [{ name, description }], error, latencyMs, serverVersion }` (abre o servidor com o cliente MCP oficial, faz o handshake e lista as tools; timeout de 15 s) |
| `memory.result` | `{ runId, callId, result: { ok, content } }` | `{ applied }` (resposta do core a um `run.memory_call`; `content` vira o texto devolvido à tool) |
| `hooks.test` | `{ hook: CustomHook, cwd, input }` | `{ outcome (ok\|blocked\|error\|timeout), exitCode, durationMs, stdout, stderr, message, output }` (roda um hook livre com uma entrada de exemplo pelo mesmo código dos runs; `output` é o que voltaria ao SDK, já filtrado) |

`options` (`RunOptions`): `model`, `effort` (`low\|medium\|high\|xhigh\|max`, vira `options.effort` do SDK; ausente = padrão do modelo; também aceito em cada `agents[nome]`), `permissionMode`, `maxTurns`, `maxBudgetUsd`, `resumeSessionId`, `forkSession`, `systemPromptAppend`, `allowedTools`, `disallowedTools` (ferramentas proibidas no run; usado nos runs de consolidação da memória), `settingSources`, `env`, `includePartialMessages`, `agents` (mapa nome → `{ description, prompt, tools?, model? }`, vira `options.agents` do SDK; o Octopus preenche com os membros do time que reportam ao agente do run), `taskContext` (`{ taskId, title, stage, allowedStatuses }`: o sidecar cria um MCP server in-process `octopus` com a tool `task_update(status, note)`, libera `mcp__octopus__task_update` em `allowedTools` e emite o evento `task_update`), `policyHooks` (registra um hook `PreToolUse` que emite `run.hook` e espera `hook.decide`; sem resposta em 30 s a decisão vira `ask`), `mcpServers` (mapa nome → `{ type: stdio, command, args?, env? }` \| `{ type: sse\|http, url, headers? }`, vira `options.mcpServers` do SDK junto com o `octopus` in-process), `plugins` (lista de `{ type: local, path, skipMcpDiscovery? }`; o Octopus monta um plugin local com as skills ativas do membro ou do projeto), `sandbox` (subconjunto do `SandboxSettings` do SDK: `enabled`, `failIfUnavailable`, `allowUnsandboxedCommands`, `network.allowedDomains/deniedDomains/strictAllowlist`, `filesystem.allowWrite/denyWrite/denyRead/allowRead`, `credentials.envVars`), `memory` (`{ capture, brief?, briefItems?, tools? }`: `capture` registra hooks `PostToolUse`, `Stop`, `SubagentStop`, `SessionEnd`, `PreCompact`, `PostCompact` e `InstructionsLoaded` que emitem `observation` e `compaction`, sanitizados pelo core; `brief` é injetado como `additionalContext` no primeiro `UserPromptSubmit` e gera `brief_injected`; `tools` expõe as tools MCP `memory_search(query)`, `memory_write(kind, title, body)` e `memory_handoff(body)`, respondidas pelo core via `run.memory_call` → `memory.result`), `customHooks` (lista de `{ id, name, event, matcher?, command, timeoutSec }`, com `event` em `PreToolUse\|PostToolUse\|UserPromptSubmit\|Stop\|SubagentStop\|SessionStart\|SessionEnd\|Notification\|PreCompact`: o sidecar registra um matcher por hook (o `matcher` só vale nos eventos de ferramenta), roda `command` com `/bin/sh -c` na pasta do projeto com o JSON do evento no stdin e `CLAUDE_PROJECT_DIR`/`OCTOPUS_RUN_ID` no ambiente, e interpreta como o Claude Code: saída 0 segue (JSON no stdout pode trazer `decision: block`, `continue: false`, `systemMessage` ou `hookSpecificOutput.additionalContext`/`permissionDecision`), saída 2 bloqueia com o stderr como motivo, outra saída ou tempo esgotado é erro sem bloquear. A saída é filtrada: `permissionDecision: allow` e `updatedInput` são descartados, então um hook livre só nega ou pede aprovação. Cada execução emite `hook_ran`).

Retomar e bifurcar não têm método próprio: são um `run.start` com `options.resumeSessionId` (e `forkSession: true` para bifurcar); o SDK recebe `resume`/`forkSession`. O `session_init` do novo run traz o `sessionId` resultante (o mesmo, ao retomar; um novo, ao bifurcar).

`decision`: `{ behavior: "allow", updatedInput? }` ou `{ behavior: "deny", message }`.

## Notificações

### `run.event`

`{ runId, seq, at, event }`. `seq` é crescente por run; `at` é RFC 3339. `event.type`:

| Tipo | Campos | Origem no SDK |
|---|---|---|
| `session_init` | `sessionId, model, tools, mcpServers, permissionMode` | `system/init` |
| `assistant_text_delta` | `text, parentToolUseId` | `stream_event` com `text_delta` (não persistido) |
| `assistant_text` | `messageId, text, parentToolUseId` | bloco `text` em `assistant` |
| `tool_use` | `toolUseId, name, input, parentToolUseId` | bloco `tool_use` em `assistant` |
| `tool_result` | `toolUseId, content, isError, parentToolUseId` | bloco `tool_result` em `user` |
| `usage` | `usage{inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens}, contextWindow, messageId, parentToolUseId` | `message.usage` em `assistant`. O SDK repete o mesmo uso em cada bloco da mensagem: o core soma o custo estimado uma vez por `messageId`. Mensagens de subagente (`parentToolUseId` não nulo) contam no custo, mas não no medidor de contexto (`contextWindow` vem nulo) |
| `permission_request` | `requestId, toolName, input, reason` | callback `canUseTool` |
| `result` | `sessionId, subtype, isError, costUsd, durationMs, numTurns, usage, stopReason, resultText` | `result` |
| `error` | `message, fatal` | exceções do sidecar |
| `task_update` | `taskId, status (done\|review\|blocked), note` | tool MCP in-process `task_update` chamada pelo agente (só em runs com `options.taskContext`) |
| `observation` | `kind (tool_use\|turn_end\|subagent_end\|session_end), title, body, toolName, toolUseId, parentToolUseId, agentId` | capturada pelos hooks de memória (só em runs com `options.memory.capture`); o corpo é truncado no sidecar e sanitizado no core |
| `compaction` | `phase (pre\|post), trigger (manual\|auto), summary` | hooks `PreCompact`/`PostCompact`; o resumo só vem no `post` |
| `brief_injected` | `chars, items[]` | o brief de memória entrou como `additionalContext` (uma vez por run) |
| `hook_ran` | `hookId, name, event, toolName, outcome (ok\|blocked\|error\|timeout), exitCode, durationMs, message` | um hook livre (`options.customHooks`) rodou; o core audita os bloqueios como `hook.blocked` |
| `instructions_loaded` | `filePath, memoryType (User\|Project\|Local\|Managed), loadReason` | hook `InstructionsLoaded`: um evento por arquivo de instruções (CLAUDE.md, rules) que o Claude Code carregou |

`parentToolUseId` não nulo indica mensagem de subagente (árvore reconstruível pelo id da tool call `Agent` que o iniciou).

Eventos terminais: `result` e `error` com `fatal: true`.

### `run.hook`

`{ runId, hookId, event: "PreToolUse", toolName, input, toolUseId, parentToolUseId }`. Bloqueante: o sidecar segura a ferramenta até o core responder com `hook.decide`. O core avalia as regras de política (nega vence, depois pergunta, senão permite) e registra a decisão na auditoria (`policy.allow|deny|ask`). `deny` chega ao agente com o motivo; `ask` vira um `permission_request` normal (com o motivo da regra em `reason`).

### `run.memory_call`

`{ runId, callId, op: search|write|handoff, args }`. O agente chamou uma tool MCP de memória; o sidecar segura a resposta da tool até o core responder `memory.result` (timeout de 30 s devolve um erro textual ao agente).

### `runtime.log`

`{ level, message }`.

## Códigos de erro

| Código | Significado |
|---|---|
| -32700 | JSON inválido |
| -32600 | Request inválido |
| -32601 | Método desconhecido |
| -32602 | Parâmetros inválidos |
| -32603 | Erro interno |
| -32001 | Run não encontrado |
| -32002 | Run já existe |
| -32003 | Pedido de permissão não encontrado |
| -32004 | Hook não encontrado (já decidido ou run encerrado) |

## Evolução

Mudanças incompatíveis incrementam `PROTOCOL_VERSION`; o handshake `runtime.hello` falha se os lados divergirem. Toda mudança deve atualizar os schemas, as fixtures e o espelho Rust no mesmo commit.
