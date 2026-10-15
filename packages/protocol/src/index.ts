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

export const RunOptionsSchema = z.object({
  model: z.string().optional(),
  permissionMode: PermissionModeSchema.optional(),
  maxTurns: z.number().int().positive().optional(),
  maxBudgetUsd: z.number().positive().optional(),
  resumeSessionId: z.string().optional(),
  forkSession: z.boolean().optional(),
  systemPromptAppend: z.string().optional(),
  allowedTools: z.array(z.string()).optional(),
  settingSources: z.array(SettingSourceSchema).optional(),
  /** Variáveis adicionais para o processo do agente (ex.: ANTHROPIC_API_KEY em modo api_key). */
  env: z.record(z.string(), z.string()).optional(),
  includePartialMessages: z.boolean().optional(),
});
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

export const RequestMethodSchema = z.enum([
  "runtime.hello",
  "run.start",
  "run.interrupt",
  "permission.decide",
  "sessions.list",
]);
export type RequestMethod = z.infer<typeof RequestMethodSchema>;

export const REQUEST_SCHEMAS = {
  "runtime.hello": { params: HelloParamsSchema, result: HelloResultSchema },
  "run.start": { params: RunStartParamsSchema, result: RunStartResultSchema },
  "run.interrupt": { params: RunInterruptParamsSchema, result: RunInterruptResultSchema },
  "permission.decide": { params: PermissionDecideParamsSchema, result: PermissionDecideResultSchema },
  "sessions.list": { params: SessionsListParamsSchema, result: SessionsListResultSchema },
} as const;

// ---------------------------------------------------------------------------
// Eventos de run (sidecar -> Rust -> UI)
// ---------------------------------------------------------------------------

const parentToolUseId = z.string().nullable().default(null);

export const RunEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("session_init"),
    sessionId: z.string(),
    model: z.string(),
    tools: z.array(z.string()).default([]),
    mcpServers: z.array(z.object({ name: z.string(), status: z.string() })).default([]),
    permissionMode: z.string().nullable().default(null),
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
  z.object({
    type: z.literal("usage"),
    usage: UsageSchema,
    contextWindow: z.number().int().positive().nullable().default(null),
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

export const NotificationMethodSchema = z.enum(["run.event", "runtime.log"]);
export type NotificationMethod = z.infer<typeof NotificationMethodSchema>;

export const NOTIFICATION_SCHEMAS = {
  "run.event": RunEventNotificationSchema,
  "runtime.log": RuntimeLogSchema,
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
