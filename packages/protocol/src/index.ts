/**
 * Protocolo Octopus AI: contrato entre o core Rust, o sidecar Node (Agent SDK) e a UI.
 *
 * Transporte Rust <-> sidecar: JSON-RPC 2.0 em NDJSON (uma mensagem JSON por linha) via stdio.
 *   - Rust -> sidecar: requests (`id` presente). O sidecar responde com `result` ou `error`.
 *   - sidecar -> Rust: notificações (`id` ausente), principalmente `run.event`.
 *
 * Este arquivo é a fonte da verdade. O lado Rust espelha estes tipos em `src-tauri/src/protocol.rs`
 * e os dois lados são verificados contra as fixtures em `fixtures/` (ver tests).
 */
import { z } from "zod";

export const PROTOCOL_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Primitivos
// ---------------------------------------------------------------------------

export const PermissionModeSchema = z.enum([
  "default",
  "acceptEdits",
  "plan",
  "dontAsk",
  "auto",
]);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;

/** Esforço de raciocínio do modelo (`options.effort` do SDK); ausente = padrão do modelo. */
export const EffortLevelSchema = z.enum(["low", "medium", "high", "xhigh", "max"]);
export type EffortLevel = z.infer<typeof EffortLevelSchema>;

export const SettingSourceSchema = z.enum(["user", "project", "local"]);
export type SettingSource = z.infer<typeof SettingSourceSchema>;

export const UsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative().default(0),
  cacheCreationTokens: z.number().int().nonnegative().default(0),
});
export type Usage = z.infer<typeof UsageSchema>;

// ---------------------------------------------------------------------------
// Opções de um run (subconjunto do Agent SDK que o orquestrador controla)
// ---------------------------------------------------------------------------

/** Subagente programático (`options.agents` do SDK): o Octopus usa para os membros delegados do time. */
export const AgentDefinitionSchema = z.object({
  description: z.string(),
  prompt: z.string(),
  tools: z.array(z.string()).optional(),
  model: z.string().optional(),
  effort: EffortLevelSchema.optional(),
});
export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;

/** `approved`/`returned` só valem em runs de revisão (`TaskContext.mode = "review"`). */
export const TaskStatusUpdateSchema = z.enum(["done", "review", "blocked", "approved", "returned"]);
export const TaskModeSchema = z.enum(["work", "review"]);
export type TaskMode = z.infer<typeof TaskModeSchema>;
export type TaskStatusUpdate = z.infer<typeof TaskStatusUpdateSchema>;

export const TaskContextSchema = z.object({
  taskId: z.string(),
  title: z.string(),
  stage: z.string(),
  /** Estados que o agente pode pedir via `task_update`. */
  allowedStatuses: z.array(TaskStatusUpdateSchema).default(["done", "review", "blocked"]),
  /** Trabalho na task (padrão) ou revisão do trabalho de outro membro. */
  mode: TaskModeSchema.default("work"),
});
export type TaskContext = z.infer<typeof TaskContextSchema>;

/** Subconjunto do `SandboxSettings` do SDK que o Octopus controla (perfis de sandbox). */
export const SandboxSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  failIfUnavailable: z.boolean().optional(),
  allowUnsandboxedCommands: z.boolean().optional(),
  autoAllowBashIfSandboxed: z.boolean().optional(),
  network: z
    .object({
      allowedDomains: z.array(z.string()).optional(),
      deniedDomains: z.array(z.string()).optional(),
      strictAllowlist: z.boolean().optional(),
    })
    .optional(),
  filesystem: z
    .object({
      allowWrite: z.array(z.string()).optional(),
      denyWrite: z.array(z.string()).optional(),
      denyRead: z.array(z.string()).optional(),
      allowRead: z.array(z.string()).optional(),
    })
    .optional(),
  credentials: z
    .object({
      envVars: z.array(z.object({ name: z.string(), mode: z.enum(["deny", "mask"]), injectHosts: z.array(z.string()).optional() })).optional(),
    })
    .optional(),
});
export type SandboxSettings = z.infer<typeof SandboxSettingsSchema>;

/** MCP server externo (stdio, SSE ou HTTP), como o `McpServerConfig` do SDK sem a variante in-process. */
export const McpServerConfigSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("stdio"), command: z.string().min(1), args: z.array(z.string()).optional(), env: z.record(z.string(), z.string()).optional() }),
  z.object({ type: z.literal("sse"), url: z.string().url(), headers: z.record(z.string(), z.string()).optional() }),
  z.object({ type: z.literal("http"), url: z.string().url(), headers: z.record(z.string(), z.string()).optional() }),
]);
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

/** Memória do projeto: captura observações por hooks (PostToolUse, Stop, SubagentStop, SessionEnd, Pre/PostCompact). */
export const MemoryOptionsSchema = z.object({
  capture: z.boolean().default(true),
  /** Brief de memória (markdown) injetado como `additionalContext` no primeiro `UserPromptSubmit`. */
  brief: z.string().optional(),
  /** Rótulos do que entrou no brief (páginas, handoff), para o evento `brief_injected`. */
  briefItems: z.array(z.string()).optional(),
  /** Expõe as tools MCP `memory_search`, `memory_write` e `memory_handoff` (respondidas pelo core via `run.memory_call`/`memory.result`). */
  tools: z.boolean().optional(),
});
export type MemoryOptions = z.infer<typeof MemoryOptionsSchema>;

/** Eventos do SDK em que um hook livre (comando de shell do usuário) pode rodar. */
export const CustomHookEventSchema = z.enum([
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "Stop",
  "SubagentStop",
  "SessionStart",
  "SessionEnd",
  "Notification",
  "PreCompact",
]);
export type CustomHookEvent = z.infer<typeof CustomHookEventSchema>;

/**
 * Hook livre: o sidecar roda `command` com `/bin/sh -c` na pasta do projeto, com o JSON do evento
 * no stdin (como os command hooks do Claude Code). Saída 0 segue (JSON no stdout pode acrescentar
 * contexto); saída 2 bloqueia com o stderr como motivo; outra saída é erro sem bloquear.
 * Num PreToolUse ele só nega ou pede aprovação: nunca libera nem reescreve a entrada.
 */
export const CustomHookSchema = z.object({
  id: z.string(),
  name: z.string(),
  event: CustomHookEventSchema,
  /** Regex sobre o nome da ferramenta (só eventos de ferramenta); ausente = todas. */
  matcher: z.string().optional(),
  command: z.string().min(1),
  timeoutSec: z.number().int().positive().max(600).default(30),
});
export type CustomHook = z.infer<typeof CustomHookSchema>;

/** Como o Octopus interpretou uma execução de hook livre. */
export const HookOutcomeSchema = z.enum(["ok", "blocked", "error", "timeout"]);
export type HookOutcome = z.infer<typeof HookOutcomeSchema>;

export const RunOptionsSchema = z.object({
  model: z.string().optional(),
  effort: EffortLevelSchema.optional(),
  permissionMode: PermissionModeSchema.optional(),
  maxTurns: z.number().int().positive().optional(),
  maxBudgetUsd: z.number().positive().optional(),
  resumeSessionId: z.string().optional(),
  forkSession: z.boolean().optional(),
  systemPromptAppend: z.string().optional(),
  allowedTools: z.array(z.string()).optional(),
  /** Ferramentas que o agente não pode usar neste run (vira `disallowedTools` do SDK). */
  disallowedTools: z.array(z.string()).optional(),
  settingSources: z.array(SettingSourceSchema).optional(),
  /** Variáveis adicionais para o processo do agente (ex.: ANTHROPIC_API_KEY em modo api_key). */
  env: z.record(z.string(), z.string()).optional(),
  includePartialMessages: z.boolean().optional(),
  /** Subagentes disponíveis ao agente principal, por nome. */
  agents: z.record(z.string(), AgentDefinitionSchema).optional(),
  /** Run que executa uma task do board: o sidecar expõe a tool MCP `task_update` ao agente. */
  taskContext: TaskContextSchema.optional(),
  /** Encaminha PreToolUse ao core (`run.hook` → `hook.decide`) para o motor de política em Rust. */
  policyHooks: z.boolean().optional(),
  /** Perfil de sandbox traduzido para `options.sandbox` do SDK. */
  sandbox: SandboxSettingsSchema.optional(),
  /** Captura de memória por hooks; o core sanitiza e guarda as observações. */
  memory: MemoryOptionsSchema.optional(),
  /** MCP servers externos por nome (o sidecar acrescenta o `octopus` in-process). */
  mcpServers: z.record(z.string(), McpServerConfigSchema).optional(),
  /** Plugins locais do Claude Code (o Octopus monta um com as skills ativas do membro/projeto). */
  plugins: z.array(z.object({ type: z.literal("local"), path: z.string().min(1), skipMcpDiscovery: z.boolean().optional() })).optional(),
  /** Hooks livres do usuário (Harness → Hooks), registrados ao lado dos declarativos. */
  customHooks: z.array(CustomHookSchema).optional(),
});
export type SdkPlugin = NonNullable<RunOptions["plugins"]>[number];
export type RunOptions = z.infer<typeof RunOptionsSchema>;

// ---------------------------------------------------------------------------
// Requests Rust -> sidecar
// ---------------------------------------------------------------------------

export const HelloParamsSchema = z.object({ protocolVersion: z.literal(PROTOCOL_VERSION) });
export const HelloResultSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  runtimeVersion: z.string(),
  sdkVersion: z.string(),
});
export type HelloResult = z.infer<typeof HelloResultSchema>;

export const RunStartParamsSchema = z.object({
  runId: z.string(),
  cwd: z.string(),
  prompt: z.string(),
  options: RunOptionsSchema.default({}),
});
export type RunStartParams = z.infer<typeof RunStartParamsSchema>;
export const RunStartResultSchema = z.object({ accepted: z.literal(true) });

export const RunInterruptParamsSchema = z.object({ runId: z.string() });
export const RunInterruptResultSchema = z.object({ interrupted: z.boolean() });

export const PermissionDecisionSchema = z.discriminatedUnion("behavior", [
  z.object({ behavior: z.literal("allow"), updatedInput: z.record(z.string(), z.unknown()).optional() }),
  z.object({ behavior: z.literal("deny"), message: z.string() }),
]);
export type PermissionDecision = z.infer<typeof PermissionDecisionSchema>;

export const PermissionDecideParamsSchema = z.object({
  runId: z.string(),
  requestId: z.string(),
  decision: PermissionDecisionSchema,
});
export type PermissionDecideParams = z.infer<typeof PermissionDecideParamsSchema>;
export const PermissionDecideResultSchema = z.object({ applied: z.boolean() });

export const SessionsListParamsSchema = z.object({ cwd: z.string() });
export const SessionSummarySchema = z.object({
  sessionId: z.string(),
  cwd: z.string(),
  title: z.string().nullable(),
  tags: z.array(z.string()).default([]),
  createdAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
});
export type SessionSummary = z.infer<typeof SessionSummarySchema>;
export const SessionsListResultSchema = z.object({ sessions: z.array(SessionSummarySchema) });

/** Renomeia uma sessão (SDK `renameSession`). `cwd` localiza o arquivo da sessão. */
export const SessionsRenameParamsSchema = z.object({
  sessionId: z.string(),
  cwd: z.string(),
  title: z.string().min(1),
});
export type SessionsRenameParams = z.infer<typeof SessionsRenameParamsSchema>;

/** Define ou remove (`null`) a tag de uma sessão (SDK `tagSession`). */
export const SessionsTagParamsSchema = z.object({
  sessionId: z.string(),
  cwd: z.string(),
  tag: z.string().min(1).nullable(),
});
export type SessionsTagParams = z.infer<typeof SessionsTagParamsSchema>;

export const SessionMutationResultSchema = z.object({ ok: z.literal(true) });

/** Decisão do core para um hook PreToolUse (vira `hookSpecificOutput.permissionDecision` no SDK). */
export const HookDecisionSchema = z.object({
  /** `pass` = nenhuma regra opinou: segue o fluxo normal de permissões do SDK. */
  behavior: z.enum(["allow", "deny", "ask", "pass"]),
  reason: z.string().optional(),
  updatedInput: z.record(z.string(), z.unknown()).optional(),
});
export type HookDecision = z.infer<typeof HookDecisionSchema>;

export const HookDecideParamsSchema = z.object({
  runId: z.string(),
  hookId: z.string(),
  decision: HookDecisionSchema,
});
export type HookDecideParams = z.infer<typeof HookDecideParamsSchema>;
export const HookDecideResultSchema = z.object({ applied: z.boolean() });

/** Chamada de tool de memória feita pelo agente; o core responde com `memory.result`. */
export const MemoryOpSchema = z.enum(["search", "write", "handoff"]);
export type MemoryOp = z.infer<typeof MemoryOpSchema>;
export const RunMemoryCallNotificationSchema = z.object({
  runId: z.string(),
  callId: z.string(),
  op: MemoryOpSchema,
  args: z.record(z.string(), z.unknown()),
});
export type RunMemoryCallNotification = z.infer<typeof RunMemoryCallNotificationSchema>;
export const MemoryCallResultSchema = z.object({ ok: z.boolean(), content: z.string() });
export type MemoryCallResult = z.infer<typeof MemoryCallResultSchema>;
export const MemoryResultParamsSchema = z.object({
  runId: z.string(),
  callId: z.string(),
  result: MemoryCallResultSchema,
});
export type MemoryResultParams = z.infer<typeof MemoryResultParamsSchema>;
export const MemoryResultResultSchema = z.object({ applied: z.boolean() });

/** Teste de conexão de um MCP server: handshake + lista de tools. */
export const McpCheckParamsSchema = z.object({ name: z.string(), config: McpServerConfigSchema });
export type McpCheckParams = z.infer<typeof McpCheckParamsSchema>;
export const McpToolInfoSchema = z.object({ name: z.string(), description: z.string().nullable().default(null) });
export type McpToolInfo = z.infer<typeof McpToolInfoSchema>;
export const McpCheckResultSchema = z.object({
  ok: z.boolean(),
  tools: z.array(McpToolInfoSchema).default([]),
  error: z.string().nullable().default(null),
  latencyMs: z.number().int().nonnegative().nullable().default(null),
  serverVersion: z.string().nullable().default(null),
});
export type McpCheckResult = z.infer<typeof McpCheckResultSchema>;

/** Testa um hook livre com uma entrada de exemplo, pelo mesmo código que roda nos runs. */
export const HooksTestParamsSchema = z.object({
  hook: CustomHookSchema,
  cwd: z.string(),
  input: z.record(z.string(), z.unknown()),
});
export type HooksTestParams = z.infer<typeof HooksTestParamsSchema>;
export const HookRunResultSchema = z.object({
  outcome: HookOutcomeSchema,
  exitCode: z.number().int().nullable(),
  durationMs: z.number().int().nonnegative(),
  stdout: z.string(),
  stderr: z.string(),
  /** Motivo de bloqueio (stderr na saída 2, ou `reason` do JSON) ou mensagem de erro. */
  message: z.string().nullable(),
  /** O que voltaria para o SDK (já filtrado: sem `allow` nem `updatedInput`). */
  output: z.record(z.string(), z.unknown()),
});
export type HookRunResult = z.infer<typeof HookRunResultSchema>;

export const RequestMethodSchema = z.enum([
  "runtime.hello",
  "run.start",
  "run.interrupt",
  "permission.decide",
  "sessions.list",
  "sessions.rename",
  "sessions.tag",
  "hook.decide",
  "memory.result",
  "mcp.check",
  "hooks.test",
]);
export type RequestMethod = z.infer<typeof RequestMethodSchema>;

export const REQUEST_SCHEMAS = {
  "runtime.hello": { params: HelloParamsSchema, result: HelloResultSchema },
  "run.start": { params: RunStartParamsSchema, result: RunStartResultSchema },
  "run.interrupt": { params: RunInterruptParamsSchema, result: RunInterruptResultSchema },
  "permission.decide": { params: PermissionDecideParamsSchema, result: PermissionDecideResultSchema },
  "sessions.list": { params: SessionsListParamsSchema, result: SessionsListResultSchema },
  "sessions.rename": { params: SessionsRenameParamsSchema, result: SessionMutationResultSchema },
  "sessions.tag": { params: SessionsTagParamsSchema, result: SessionMutationResultSchema },
  "hook.decide": { params: HookDecideParamsSchema, result: HookDecideResultSchema },
  "memory.result": { params: MemoryResultParamsSchema, result: MemoryResultResultSchema },
  "mcp.check": { params: McpCheckParamsSchema, result: McpCheckResultSchema },
  "hooks.test": { params: HooksTestParamsSchema, result: HookRunResultSchema },
} as const;

// ---------------------------------------------------------------------------
// Eventos de run (sidecar -> Rust -> UI)
// ---------------------------------------------------------------------------

const parentToolUseId = z.string().nullable().default(null);

export const ObservationKindSchema = z.enum(["tool_use", "turn_end", "subagent_end", "session_end"]);
export type ObservationKind = z.infer<typeof ObservationKindSchema>;

export const RunEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("session_init"),
    sessionId: z.string(),
    model: z.string(),
    tools: z.array(z.string()).default([]),
    mcpServers: z.array(z.object({ name: z.string(), status: z.string() })).default([]),
    permissionMode: z.string().nullable().default(null),
    /** Skills que o Claude Code carregou (do usuário, do projeto e dos plugins). */
    skills: z.array(z.string()).default([]),
  }),
  z.object({
    type: z.literal("assistant_text"),
    messageId: z.string().nullable().default(null),
    text: z.string(),
    parentToolUseId,
  }),
  z.object({
    type: z.literal("assistant_text_delta"),
    text: z.string(),
    parentToolUseId,
  }),
  z.object({
    type: z.literal("tool_use"),
    toolUseId: z.string(),
    name: z.string(),
    input: z.unknown(),
    parentToolUseId,
  }),
  z.object({
    type: z.literal("tool_result"),
    toolUseId: z.string(),
    content: z.string(),
    isError: z.boolean().default(false),
    parentToolUseId,
  }),
  /**
   * Uso de tokens de uma resposta do modelo. O SDK repete o mesmo uso em cada bloco da mesma
   * mensagem: `messageId` permite contar uma vez só. Respostas de subagentes vêm com `parentToolUseId`
   * (entram na estimativa de custo, mas não no medidor de contexto do agente principal).
   */
  z.object({
    type: z.literal("usage"),
    usage: UsageSchema,
    contextWindow: z.number().int().positive().nullable().default(null),
    messageId: z.string().nullable().default(null),
    parentToolUseId,
  }),
  z.object({
    type: z.literal("permission_request"),
    requestId: z.string(),
    toolName: z.string(),
    input: z.unknown(),
    reason: z.string().nullable().default(null),
  }),
  z.object({
    type: z.literal("result"),
    sessionId: z.string(),
    subtype: z.string(),
    isError: z.boolean(),
    costUsd: z.number().nullable().default(null),
    durationMs: z.number().int().nonnegative().nullable().default(null),
    numTurns: z.number().int().nonnegative().nullable().default(null),
    usage: UsageSchema.nullable().default(null),
    stopReason: z.string().nullable().default(null),
    resultText: z.string().nullable().default(null),
  }),
  z.object({
    type: z.literal("error"),
    message: z.string(),
    fatal: z.boolean().default(false),
  }),
  z.object({
    type: z.literal("task_update"),
    taskId: z.string(),
    status: TaskStatusUpdateSchema,
    note: z.string().nullable().default(null),
    /** Resumo da entrega em markdown (o que mudou, onde, como verificar). */
    result: z.string().nullable().default(null),
  }),
  /** Observação capturada por hook para a memória do projeto (sanitizada pelo core antes de gravar). */
  z.object({
    type: z.literal("observation"),
    kind: ObservationKindSchema,
    title: z.string(),
    body: z.string(),
    toolName: z.string().nullable().default(null),
    toolUseId: z.string().nullable().default(null),
    parentToolUseId,
    agentId: z.string().nullable().default(null),
  }),
  /** O brief de memória entrou no contexto do agente (via UserPromptSubmit). */
  z.object({
    type: z.literal("brief_injected"),
    chars: z.number().int().nonnegative(),
    items: z.array(z.string()).default([]),
  }),
  /** Arquivo de instruções (CLAUDE.md, rules) carregado pelo Claude Code (hook InstructionsLoaded). */
  z.object({
    type: z.literal("instructions_loaded"),
    filePath: z.string(),
    memoryType: z.enum(["User", "Project", "Local", "Managed"]),
    loadReason: z.string(),
  }),
  /** Um hook livre rodou (o comando do usuário), com o resultado interpretado. */
  z.object({
    type: z.literal("hook_ran"),
    hookId: z.string(),
    name: z.string(),
    event: CustomHookEventSchema,
    toolName: z.string().nullable().default(null),
    outcome: HookOutcomeSchema,
    exitCode: z.number().int().nullable().default(null),
    durationMs: z.number().int().nonnegative(),
    message: z.string().nullable().default(null),
  }),
  /** Compactação do contexto pelo Claude Code (PreCompact sem resumo; PostCompact com o resumo gerado). */
  z.object({
    type: z.literal("compaction"),
    phase: z.enum(["pre", "post"]),
    trigger: z.enum(["manual", "auto"]),
    summary: z.string().nullable().default(null),
  }),
]);
export type RunEvent = z.infer<typeof RunEventSchema>;
export type RunEventType = RunEvent["type"];

export const RunEventNotificationSchema = z.object({
  runId: z.string(),
  seq: z.number().int().nonnegative(),
  at: z.string(),
  event: RunEventSchema,
});
export type RunEventNotification = z.infer<typeof RunEventNotificationSchema>;

export const RuntimeLogSchema = z.object({
  level: z.enum(["debug", "info", "warn", "error"]),
  message: z.string(),
});

/** Hook PreToolUse bloqueante: o sidecar espera `hook.decide` do core (com timeout → `ask`). */
export const RunHookNotificationSchema = z.object({
  runId: z.string(),
  hookId: z.string(),
  event: z.literal("PreToolUse"),
  toolName: z.string(),
  input: z.unknown(),
  toolUseId: z.string().nullable().default(null),
  /** Mensagens de subagente trazem o id da chamada Agent pai. */
  parentToolUseId: z.string().nullable().default(null),
});
export type RunHookNotification = z.infer<typeof RunHookNotificationSchema>;

export const NotificationMethodSchema = z.enum(["run.event", "runtime.log", "run.hook", "run.memory_call"]);
export type NotificationMethod = z.infer<typeof NotificationMethodSchema>;

export const NOTIFICATION_SCHEMAS = {
  "run.event": RunEventNotificationSchema,
  "runtime.log": RuntimeLogSchema,
  "run.hook": RunHookNotificationSchema,
  "run.memory_call": RunMemoryCallNotificationSchema,
} as const;

// ---------------------------------------------------------------------------
// Envelopes JSON-RPC 2.0
// ---------------------------------------------------------------------------

export const JsonRpcIdSchema = z.union([z.string(), z.number().int()]);
export type JsonRpcId = z.infer<typeof JsonRpcIdSchema>;

export const JsonRpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: JsonRpcIdSchema,
  method: RequestMethodSchema,
  params: z.unknown().optional(),
});
export type JsonRpcRequest = z.infer<typeof JsonRpcRequestSchema>;

export const JsonRpcNotificationSchema = z.object({
  jsonrpc: z.literal("2.0"),
  method: NotificationMethodSchema,
  params: z.unknown().optional(),
});
export type JsonRpcNotification = z.infer<typeof JsonRpcNotificationSchema>;

export const JsonRpcErrorSchema = z.object({
  code: z.number().int(),
  message: z.string(),
  data: z.unknown().optional(),
});
export type JsonRpcError = z.infer<typeof JsonRpcErrorSchema>;

// `strict` impede que um request com método desconhecido (que ainda tem `id`) seja aceito como resposta.
export const JsonRpcResponseSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: JsonRpcIdSchema,
    result: z.unknown().optional(),
    error: JsonRpcErrorSchema.optional(),
  })
  .strict();
export type JsonRpcResponse = z.infer<typeof JsonRpcResponseSchema>;

/** Qualquer linha válida do canal NDJSON. */
export const JsonRpcMessageSchema = z.union([
  JsonRpcRequestSchema,
  JsonRpcNotificationSchema,
  JsonRpcResponseSchema,
]);
export type JsonRpcMessage = z.infer<typeof JsonRpcMessageSchema>;

/** Códigos de erro JSON-RPC usados pelo sidecar. */
export const JsonRpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  /** Específicos do Octopus (faixa -32000..-32099 é reservada ao servidor). */
  RunNotFound: -32001,
  RunAlreadyExists: -32002,
  PermissionRequestNotFound: -32003,
  HookNotFound: -32004,
  MemoryCallNotFound: -32005,
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function parseJsonRpcLine(line: string): JsonRpcMessage {
  return JsonRpcMessageSchema.parse(JSON.parse(line));
}

export function isRequest(message: JsonRpcMessage): message is JsonRpcRequest {
  return "id" in message && "method" in message;
}

export function isNotification(message: JsonRpcMessage): message is JsonRpcNotification {
  return !("id" in message) && "method" in message;
}

export function isResponse(message: JsonRpcMessage): message is JsonRpcResponse {
  return "id" in message && !("method" in message);
}
