/**
 * Converte mensagens do Claude Agent SDK em eventos do protocolo Octopus.
 * Função pura: não depende do SDK em tempo de execução, só do formato das mensagens,
 * o que permite testar com fixtures e isolar o resto do sidecar de mudanças no SDK.
 */
import type { RunEvent, Usage } from "@octopus/protocol";

/** Forma mínima das mensagens do SDK que o mapeador entende. */
export type SdkMessageLike = {
  type: string;
  subtype?: string;
  session_id?: string;
  parent_tool_use_id?: string | null;
  // system/init
  model?: string;
  tools?: string[];
  mcp_servers?: Array<{ name: string; status: string }>;
  skills?: string[];
  permissionMode?: string;
  // assistant/user
  message?: {
    id?: string;
    content?: unknown;
    usage?: SdkUsageLike;
  };
  // stream_event
  event?: { type?: string; delta?: { type?: string; text?: string }; message?: { id?: string; usage?: SdkUsageLike }; usage?: SdkUsageLike };
  // result
  is_error?: boolean;
  duration_ms?: number;
  num_turns?: number;
  total_cost_usd?: number;
  usage?: SdkUsageLike;
  stop_reason?: string | null;
  result?: string;
  modelUsage?: Record<string, { contextWindow?: number }>;
};

type SdkUsageLike = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
};

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content?: unknown; is_error?: boolean }
  | { type: string; [key: string]: unknown };

export function mapSdkMessage(message: SdkMessageLike): RunEvent[] {
  switch (message.type) {
    case "system":
      return mapSystem(message);
    case "assistant":
      return mapAssistant(message);
    case "user":
      return mapUser(message);
    case "stream_event":
      return mapStreamEvent(message);
    case "result":
      return [mapResult(message)];
    default:
      return [];
  }
}

function mapSystem(message: SdkMessageLike): RunEvent[] {
  if (message.subtype !== "init" || !message.session_id) return [];
  return [
    {
      type: "session_init",
      sessionId: message.session_id,
      model: message.model ?? "desconhecido",
      tools: message.tools ?? [],
      mcpServers: (message.mcp_servers ?? []).map((s) => ({ name: s.name, status: s.status })),
      permissionMode: message.permissionMode ?? null,
      skills: message.skills ?? [],
    },
  ];
}

function mapAssistant(message: SdkMessageLike): RunEvent[] {
  const events: RunEvent[] = [];
  const parentToolUseId = message.parent_tool_use_id ?? null;
  const blocks = asBlocks(message.message?.content);

  for (const block of blocks) {
    if (block.type === "text" && typeof block.text === "string") {
      events.push({ type: "assistant_text", messageId: message.message?.id ?? null, text: block.text, parentToolUseId });
    } else if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
      events.push({ type: "tool_use", toolUseId: block.id, name: block.name, input: block.input, parentToolUseId });
    }
  }

  const usage = toUsage(message.message?.usage);
  if (usage) {
    events.push({
      type: "usage",
      usage,
      contextWindow: parentToolUseId === null ? contextWindowOf(message) : null,
      messageId: message.message?.id ?? null,
      parentToolUseId,
    });
  }
  return events;
}

function mapUser(message: SdkMessageLike): RunEvent[] {
  const parentToolUseId = message.parent_tool_use_id ?? null;
  const events: RunEvent[] = [];
  for (const block of asBlocks(message.message?.content)) {
    if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
      events.push({
        type: "tool_result",
        toolUseId: block.tool_use_id,
        content: stringifyToolResult(block.content),
        isError: block.is_error === true,
        parentToolUseId,
      });
    }
  }
  return events;
}

function mapStreamEvent(message: SdkMessageLike): RunEvent[] {
  const delta = message.event?.delta;
  if (message.event?.type === "content_block_delta" && delta?.type === "text_delta" && typeof delta.text === "string") {
    return [{ type: "assistant_text_delta", text: delta.text, parentToolUseId: message.parent_tool_use_id ?? null }];
  }
  return [];
}

/**
 * Uso final de cada mensagem pelo streaming. O SDK manda a mensagem `assistant` antes de ela
 * terminar, com a saída ainda parcial; o total de saída só chega no `message_delta`. Guarda o
 * uso do `message_start` por fio (agente principal ou subagente) e, no `message_delta`, emite um
 * `usage` com o mesmo `messageId`: o core soma só a diferença para o que já tinha contado.
 */
export class StreamUsageTracker {
  private readonly open = new Map<string, { id: string; usage: SdkUsageLike }>();

  observe(message: SdkMessageLike): RunEvent[] {
    if (message.type !== "stream_event" || !message.event) return [];
    const thread = message.parent_tool_use_id ?? "";
    const ev = message.event;
    if (ev.type === "message_start" && ev.message?.id) {
      this.open.set(thread, { id: ev.message.id, usage: { ...(ev.message.usage ?? {}) } });
      return [];
    }
    if (ev.type === "message_delta" && ev.usage) {
      const current = this.open.get(thread);
      if (!current) return [];
      const merged: SdkUsageLike = { ...current.usage };
      for (const [k, v] of Object.entries(ev.usage) as Array<[keyof SdkUsageLike, number | null | undefined]>) {
        if (typeof v === "number") merged[k] = v;
      }
      current.usage = merged;
      const usage = toUsage(merged);
      if (!usage) return [];
      return [{ type: "usage", usage, contextWindow: null, messageId: current.id, parentToolUseId: message.parent_tool_use_id ?? null }];
    }
    return [];
  }
}

function mapResult(message: SdkMessageLike): RunEvent {
  return {
    type: "result",
    sessionId: message.session_id ?? "",
    subtype: message.subtype ?? "unknown",
    isError: message.is_error === true || (message.subtype ?? "").startsWith("error"),
    costUsd: typeof message.total_cost_usd === "number" ? message.total_cost_usd : null,
    durationMs: typeof message.duration_ms === "number" ? Math.round(message.duration_ms) : null,
    numTurns: typeof message.num_turns === "number" ? message.num_turns : null,
    usage: toUsage(message.usage),
    stopReason: message.stop_reason ?? null,
    resultText: typeof message.result === "string" ? message.result : null,
  };
}

function asBlocks(content: unknown): ContentBlock[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  return content.filter((b): b is ContentBlock => typeof b === "object" && b !== null && typeof (b as { type?: unknown }).type === "string");
}

export function stringifyToolResult(content: unknown): string {
  if (content === undefined || content === null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text") {
          return String((part as { text?: unknown }).text ?? "");
        }
        return JSON.stringify(part);
      })
      .join("\n");
  }
  return JSON.stringify(content);
}

function toUsage(usage: SdkUsageLike | undefined): Usage | null {
  if (!usage) return null;
  if (typeof usage.input_tokens !== "number" && typeof usage.output_tokens !== "number") return null;
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
  };
}

function contextWindowOf(message: SdkMessageLike): number | null {
  const entries = Object.values(message.modelUsage ?? {});
  for (const entry of entries) {
    if (typeof entry.contextWindow === "number") return entry.contextWindow;
  }
  return null;
}
