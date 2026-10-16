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

`options` (`RunOptions`): `model`, `permissionMode`, `maxTurns`, `maxBudgetUsd`, `resumeSessionId`, `forkSession`, `systemPromptAppend`, `allowedTools`, `settingSources`, `env`, `includePartialMessages`, `agents` (mapa nome → `{ description, prompt, tools?, model? }`, vira `options.agents` do SDK; o Octopus preenche com os membros do time que reportam ao agente do run), `taskContext` (`{ taskId, title, stage, allowedStatuses }`: o sidecar cria um MCP server in-process `octopus` com a tool `task_update(status, note)`, libera `mcp__octopus__task_update` em `allowedTools` e emite o evento `task_update`), `policyHooks` (registra um hook `PreToolUse` que emite `run.hook` e espera `hook.decide`; sem resposta em 30 s a decisão vira `ask`), `sandbox` (subconjunto do `SandboxSettings` do SDK: `enabled`, `failIfUnavailable`, `allowUnsandboxedCommands`, `network.allowedDomains/deniedDomains/strictAllowlist`, `filesystem.allowWrite/denyWrite/denyRead/allowRead`, `credentials.envVars`).

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
| `usage` | `usage{inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens}, contextWindow` | `message.usage` em `assistant` (só agente principal) |
| `permission_request` | `requestId, toolName, input, reason` | callback `canUseTool` |
| `result` | `sessionId, subtype, isError, costUsd, durationMs, numTurns, usage, stopReason, resultText` | `result` |
| `error` | `message, fatal` | exceções do sidecar |
| `task_update` | `taskId, status (done\|review\|blocked), note` | tool MCP in-process `task_update` chamada pelo agente (só em runs com `options.taskContext`) |

`parentToolUseId` não nulo indica mensagem de subagente (árvore reconstruível pelo id da tool call `Agent` que o iniciou).

Eventos terminais: `result` e `error` com `fatal: true`.

### `run.hook`

`{ runId, hookId, event: "PreToolUse", toolName, input, toolUseId, parentToolUseId }`. Bloqueante: o sidecar segura a ferramenta até o core responder com `hook.decide`. O core avalia as regras de política (nega vence, depois pergunta, senão permite) e registra a decisão na auditoria (`policy.allow|deny|ask`). `deny` chega ao agente com o motivo; `ask` vira um `permission_request` normal (com o motivo da regra em `reason`).

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
