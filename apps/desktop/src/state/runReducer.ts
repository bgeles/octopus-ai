/**
 * Reduz eventos de run em um estado de transcript para a UI. Função pura, sem React.
 */
import type { RunEvent, RunEventNotification, Usage } from "@octopus/protocol";

export type TranscriptItem =
  | { kind: "user"; id: string; text: string; at: string }
  | { kind: "assistant"; id: string; text: string; streaming: boolean; parentToolUseId: string | null; at: string }
  | {
      kind: "tool";
      id: string;
      toolUseId: string;
      name: string;
      input: unknown;
      result: string | null;
      isError: boolean;
      parentToolUseId: string | null;
      at: string;
    }
  | { kind: "error"; id: string; message: string; fatal: boolean; at: string };

export type PendingPermission = {
  requestId: string;
  toolName: string;
  input: unknown;
  reason: string | null;
  at: string;
};

export type RunResultSummary = {
  subtype: string;
  isError: boolean;
  costUsd: number | null;
  durationMs: number | null;
  numTurns: number | null;
  stopReason: string | null;
  resultText: string | null;
};

export type RunViewState = {
  runId: string | null;
  sessionId: string | null;
  model: string | null;
  tools: string[];
  permissionMode: string | null;
  items: TranscriptItem[];
  pendingPermissions: PendingPermission[];
  usage: Usage | null;
  contextWindow: number | null;
  result: RunResultSummary | null;
  lastSeq: number;
  toolCounts: Record<string, number>;
  subagentIds: string[];
  /** Brief de memória injetado no início do run (o que entrou no contexto). */
  brief: { chars: number; items: string[] } | null;
  /** Arquivos de instruções carregados pelo Claude Code (CLAUDE.md, rules). */
  instructions: { filePath: string; memoryType: string; loadReason: string }[];
  /** Compactações do contexto neste run (só as concluídas, com resumo). */
  compactions: { trigger: string; summary: string | null; at: string }[];
};

export const DEFAULT_CONTEXT_WINDOW = 200_000;

export function initialRunViewState(runId: string | null = null): RunViewState {
  return {
    runId,
    sessionId: null,
    model: null,
    tools: [],
    permissionMode: null,
    items: [],
    pendingPermissions: [],
    usage: null,
    contextWindow: null,
    result: null,
    lastSeq: -1,
    toolCounts: {},
    subagentIds: [],
    brief: null,
    instructions: [],
    compactions: []
  };
}

export function withUserPrompt(state: RunViewState, text: string, at = new Date().toISOString()): RunViewState {
  return { ...state, items: [...state.items, { kind: "user", id: `user_${state.items.length}`, text, at }] };
}

export function applyRunEvent(state: RunViewState, notification: RunEventNotification): RunViewState {
  if (state.runId !== null && notification.runId !== state.runId) return state;
  // Eventos fora de ordem ou repetidos são ignorados, exceto deltas (sem seq confiável no mock).
  if (notification.seq <= state.lastSeq && notification.event.type !== "assistant_text_delta") return state;
  const next = applyEvent({ ...state, runId: state.runId ?? notification.runId, lastSeq: Math.max(state.lastSeq, notification.seq) }, notification.event, notification.at);
  return next;
}

function applyEvent(state: RunViewState, event: RunEvent, at: string): RunViewState {
  switch (event.type) {
    case "session_init":
      return { ...state, sessionId: event.sessionId, model: event.model, tools: event.tools, permissionMode: event.permissionMode };

    case "assistant_text_delta": {
      const items = [...state.items];
      const last = items[items.length - 1];
      if (last && last.kind === "assistant" && last.streaming && last.parentToolUseId === event.parentToolUseId) {
        items[items.length - 1] = { ...last, text: last.text + event.text };
      } else {
        items.push({ kind: "assistant", id: `assistant_${items.length}`, text: event.text, streaming: true, parentToolUseId: event.parentToolUseId, at });
      }
      return { ...state, items };
    }

    case "assistant_text": {
      const items = [...state.items];
      const last = items[items.length - 1];
      // O texto completo substitui o bloco em streaming correspondente.
      if (last && last.kind === "assistant" && last.streaming && last.parentToolUseId === event.parentToolUseId) {
        items[items.length - 1] = { ...last, text: event.text, streaming: false };
      } else {
        items.push({ kind: "assistant", id: `assistant_${items.length}`, text: event.text, streaming: false, parentToolUseId: event.parentToolUseId, at });
      }
      return { ...state, items };
    }

    case "tool_use": {
      const items = finishStreaming(state.items);
      items.push({
        kind: "tool",
        id: `tool_${event.toolUseId}`,
        toolUseId: event.toolUseId,
        name: event.name,
        input: event.input,
        result: null,
        isError: false,
        parentToolUseId: event.parentToolUseId,
        at,
      });
      const toolCounts = { ...state.toolCounts, [event.name]: (state.toolCounts[event.name] ?? 0) + 1 };
      const subagentIds = isSubagentTool(event.name) ? [...state.subagentIds, event.toolUseId] : state.subagentIds;
      return { ...state, items, toolCounts, subagentIds };
    }

    case "tool_result": {
      let found = false;
      const items = state.items.map((item) => {
        if (item.kind === "tool" && item.toolUseId === event.toolUseId) {
          found = true;
          return { ...item, result: event.content, isError: event.isError };
        }
        return item;
      });
      if (!found) {
        items.push({
          kind: "tool",
          id: `tool_${event.toolUseId}`,
          toolUseId: event.toolUseId,
          name: "desconhecida",
          input: null,
          result: event.content,
          isError: event.isError,
          parentToolUseId: event.parentToolUseId,
          at,
        });
      }
      return { ...state, items };
    }

    case "usage":
      return { ...state, usage: event.usage, contextWindow: event.contextWindow ?? state.contextWindow };

    case "permission_request":
      return {
        ...state,
        pendingPermissions: [
          ...state.pendingPermissions,
          { requestId: event.requestId, toolName: event.toolName, input: event.input, reason: event.reason, at },
        ],
      };

    case "result":
      return {
        ...state,
        items: finishStreaming(state.items),
        usage: event.usage ?? state.usage,
        sessionId: event.sessionId || state.sessionId,
        result: {
          subtype: event.subtype,
          isError: event.isError,
          costUsd: event.costUsd,
          durationMs: event.durationMs,
          numTurns: event.numTurns,
          stopReason: event.stopReason,
          resultText: event.resultText,
        },
        pendingPermissions: [],
      };

    case "error":
      return {
        ...state,
        items: [...finishStreaming(state.items), { kind: "error", id: `error_${state.items.length}`, message: event.message, fatal: event.fatal, at }],
        pendingPermissions: event.fatal ? [] : state.pendingPermissions,
      };

    case "task_update":
      // O board reage a este evento; no transcript a chamada da tool task_update já aparece como tool_use.
      return state;

    case "brief_injected":
      return { ...state, brief: { chars: event.chars, items: event.items } };

    case "instructions_loaded":
      return state.instructions.some((i) => i.filePath === event.filePath) ? state : { ...state, instructions: [...state.instructions, { filePath: event.filePath, memoryType: event.memoryType, loadReason: event.loadReason }] };

    case "compaction":
      return event.phase === "post" ? { ...state, compactions: [...state.compactions, { trigger: event.trigger, summary: event.summary, at }] } : state;

    case "observation":
      // Vão para a memória/contexto no core; o transcript não muda (a compactação ganha vista na Fase 4, iteração 04).
      return state;
  }
}

export function resolvePermission(state: RunViewState, requestId: string): RunViewState {
  return { ...state, pendingPermissions: state.pendingPermissions.filter((p) => p.requestId !== requestId) };
}

function finishStreaming(items: TranscriptItem[]): TranscriptItem[] {
  return items.map((item) => (item.kind === "assistant" && item.streaming ? { ...item, streaming: false } : item));
}

/** Fração do contexto ocupada (0..1) e tokens usados. */
export function contextUsage(state: RunViewState): { used: number; window: number; fraction: number } {
  const window = state.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const used = state.usage ? state.usage.inputTokens + state.usage.cacheReadTokens + state.usage.cacheCreationTokens : 0;
  return { used, window, fraction: Math.min(1, used / window) };
}

export function isRunActive(state: RunViewState): boolean {
  if (state.runId === null) return false;
  if (state.result) return false;
  return !state.items.some((i) => i.kind === "error" && i.fatal);
}

// ---------------------------------------------------------------------------
// Árvore de subagentes (por parentToolUseId)
// ---------------------------------------------------------------------------

export type SubagentNode = {
  toolUseId: string;
  /** Descrição dada pelo agente principal ao delegar (ou o tipo do subagente). */
  name: string;
  subagentType: string | null;
  status: "running" | "done" | "error";
  toolCalls: number;
  messages: number;
  errors: number;
  children: TranscriptItem[];
  at: string;
};

const SUBAGENT_TOOLS = new Set(["Agent", "Task"]);

export function isSubagentTool(name: string): boolean {
  return SUBAGENT_TOOLS.has(name);
}

/** Agrupa os itens do transcript sob a chamada `Agent`/`Task` que os originou. */
export function subagentTree(items: TranscriptItem[]): SubagentNode[] {
  const nodes = new Map<string, SubagentNode>();
  for (const item of items) {
    if (item.kind === "tool" && isSubagentTool(item.name)) {
      const input = typeof item.input === "object" && item.input !== null ? (item.input as Record<string, unknown>) : {};
      const description = typeof input.description === "string" ? input.description : null;
      const subagentType = typeof input.subagent_type === "string" ? input.subagent_type : null;
      nodes.set(item.toolUseId, {
        toolUseId: item.toolUseId,
        name: description ?? subagentType ?? "Subagente",
        subagentType,
        status: item.result === null ? "running" : item.isError ? "error" : "done",
        toolCalls: 0,
        messages: 0,
        errors: 0,
        children: [],
        at: item.at,
      });
    }
  }
  for (const item of items) {
    if (item.kind !== "assistant" && item.kind !== "tool") continue;
    if (!item.parentToolUseId) continue;
    const node = nodes.get(item.parentToolUseId);
    if (!node) continue;
    node.children.push(item);
    if (item.kind === "tool") {
      node.toolCalls++;
      if (item.isError) node.errors++;
    } else {
      node.messages++;
    }
  }
  return [...nodes.values()];
}

/** Itens de nível superior: tudo que não pertence a um subagente conhecido. */
export function topLevelItems(items: TranscriptItem[], tree = subagentTree(items)): TranscriptItem[] {
  const known = new Set(tree.map((n) => n.toolUseId));
  return items.filter((item) => !((item.kind === "assistant" || item.kind === "tool") && item.parentToolUseId && known.has(item.parentToolUseId)));
}
