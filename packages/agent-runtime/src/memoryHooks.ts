/**
 * Hooks de memória: transformam entradas dos hooks do SDK (PostToolUse, Stop, SubagentStop, SessionEnd,
 * PreCompact, PostCompact) em eventos `observation` / `compaction`. Puro, para ser testável sem o SDK.
 * O sidecar só trunca; a sanitização de segredos acontece no core antes de gravar.
 */
import type { RunEvent } from "@octopus/protocol";

export const MEMORY_HOOK_EVENTS = ["PostToolUse", "Stop", "SubagentStop", "SessionEnd", "PreCompact", "PostCompact"] as const;

/** Campos que os hooks de memória usam; os demais ficam como `unknown`. */
export type MemoryHookInputLike = {
  hook_event_name: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  tool_use_id?: string;
  parent_tool_use_id?: string | null;
  last_assistant_message?: string;
  agent_id?: string;
  agent_type?: string;
  reason?: string;
  trigger?: string;
  compact_summary?: string;
};

export const MAX_TOOL_BODY = 2_000;
export const MAX_TURN_BODY = 4_000;
export const MAX_SUMMARY_BODY = 8_000;

/** Ferramentas cujo retorno vale guardar; para leituras basta o título. */
const TOOLS_WITH_BODY = new Set(["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit", "WebFetch", "WebSearch"]);

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}… [truncado: ${text.length - max} caracteres]`;
}

export function summarizeToolInput(toolName: string, input: unknown): string {
  if (!input || typeof input !== "object") return typeof input === "string" ? input : toolName;
  const record = input as Record<string, unknown>;
  for (const key of ["command", "file_path", "path", "pattern", "query", "url", "prompt", "description"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim().split("\n")[0]!.slice(0, 200);
  }
  const entries = Object.entries(record).filter(([, v]) => typeof v === "string" || typeof v === "number");
  if (entries.length === 0) return toolName;
  return entries
    .slice(0, 3)
    .map(([k, v]) => `${k}=${String(v).slice(0, 60)}`)
    .join(" ");
}

export function stringifyResponse(response: unknown): string {
  if (response == null) return "";
  if (typeof response === "string") return response;
  if (Array.isArray(response)) {
    return response
      .map((part) => (part && typeof part === "object" && "text" in (part as object) ? String((part as { text: unknown }).text) : JSON.stringify(part)))
      .join("\n");
  }
  if (typeof response === "object") {
    const r = response as Record<string, unknown>;
    if (typeof r.stdout === "string" || typeof r.stderr === "string") {
      return [r.stdout, r.stderr].filter((s): s is string => typeof s === "string" && s.length > 0).join("\n");
    }
    if (typeof r.content === "string") return r.content;
    if (Array.isArray(r.content)) return stringifyResponse(r.content);
  }
  try {
    return JSON.stringify(response);
  } catch {
    return String(response);
  }
}

/** Converte a entrada de um hook em evento de run; `null` quando não há nada a registrar. */
export function eventFromMemoryHook(input: MemoryHookInputLike): RunEvent | null {
  const parent = input.parent_tool_use_id ?? null;
  switch (input.hook_event_name) {
    case "PostToolUse": {
      const toolName = input.tool_name ?? "ferramenta";
      const title = `${toolName} ${summarizeToolInput(toolName, input.tool_input)}`.trim();
      const body = TOOLS_WITH_BODY.has(toolName) || toolName.startsWith("mcp__") ? truncate(stringifyResponse(input.tool_response), MAX_TOOL_BODY) : "";
      return { type: "observation", kind: "tool_use", title, body, toolName, toolUseId: input.tool_use_id ?? null, parentToolUseId: parent, agentId: input.agent_id ?? null };
    }
    case "Stop": {
      const body = (input.last_assistant_message ?? "").trim();
      if (!body) return null;
      return { type: "observation", kind: "turn_end", title: "Fim do turno", body: truncate(body, MAX_TURN_BODY), toolName: null, toolUseId: null, parentToolUseId: parent, agentId: input.agent_id ?? null };
    }
    case "SubagentStop": {
      const body = (input.last_assistant_message ?? "").trim();
      return { type: "observation", kind: "subagent_end", title: `Subagente ${input.agent_type ?? input.agent_id ?? "desconhecido"}`, body: truncate(body, MAX_TURN_BODY), toolName: null, toolUseId: null, parentToolUseId: parent, agentId: input.agent_id ?? null };
    }
    case "SessionEnd":
      return { type: "observation", kind: "session_end", title: "Sessão encerrada", body: input.reason ?? "", toolName: null, toolUseId: null, parentToolUseId: null, agentId: null };
    case "PreCompact":
      return { type: "compaction", phase: "pre", trigger: input.trigger === "manual" ? "manual" : "auto", summary: null };
    case "PostCompact":
      return { type: "compaction", phase: "post", trigger: input.trigger === "manual" ? "manual" : "auto", summary: input.compact_summary ? truncate(input.compact_summary, MAX_SUMMARY_BODY) : null };
    default:
      return null;
  }
}
