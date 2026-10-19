/**
 * Hooks livres (Harness → Hooks): comandos de shell do usuário que rodam em eventos do agente,
 * com a mesma semântica dos command hooks do Claude Code:
 *   - o JSON do evento vai no stdin; o comando roda com `/bin/sh -c` na pasta do projeto;
 *   - saída 0 segue (um JSON no stdout pode acrescentar contexto, bloquear ou parar);
 *   - saída 2 bloqueia, com o stderr como motivo (onde o evento permite bloquear);
 *   - outra saída, ou tempo esgotado, é erro sem bloquear.
 * O que volta para o SDK é filtrado: um hook livre só aperta. Num PreToolUse ele nega ou pede
 * aprovação, nunca libera (`allow`) nem reescreve a entrada (`updatedInput`).
 */
import { spawn } from "node:child_process";
import type { CustomHook, CustomHookEvent, HookRunResult } from "@octopus/protocol";

export type HookProcessResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
};

export type HookSpawn = (command: string, options: { cwd: string; env: Record<string, string>; stdin: string; timeoutMs: number }) => Promise<HookProcessResult>;

/** Limite do que guardamos de stdout/stderr (o resto é descartado). */
const OUTPUT_LIMIT = 8_000;
/** Contexto que um hook pode acrescentar ao agente por chamada. */
const CONTEXT_LIMIT = 10_000;

/** Eventos em que o Claude Code aceita bloquear (`decision: "block"` ou saída 2). */
const BLOCKABLE: ReadonlySet<CustomHookEvent> = new Set(["PreToolUse", "PostToolUse", "UserPromptSubmit", "Stop", "SubagentStop"]);
/** Eventos cujo stdout (texto) ou `additionalContext` entra no contexto do agente. */
const CONTEXT_EVENTS: ReadonlySet<CustomHookEvent> = new Set(["UserPromptSubmit", "SessionStart", "PostToolUse"]);
/** Eventos com nome de ferramenta, em que o `matcher` faz sentido. */
export const TOOL_EVENTS: ReadonlySet<CustomHookEvent> = new Set(["PreToolUse", "PostToolUse"]);

export const defaultHookSpawn: HookSpawn = (command, { cwd, env, stdin, timeoutMs }) =>
  new Promise((resolve) => {
    const started = Date.now();
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const child = spawn("/bin/sh", ["-c", command], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr, timedOut, durationMs: Date.now() - started });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < OUTPUT_LIMIT) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < OUTPUT_LIMIT) stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      stderr += String(error.message);
      finish(null);
    });
    child.on("close", (code) => finish(timedOut ? null : code));
    child.stdin.on("error", () => {
      // O comando pode sair sem ler o stdin (EPIPE): não é erro do hook.
    });
    child.stdin.end(stdin);
  });

/** Roda o hook e interpreta o resultado. Nunca lança: falhas viram `outcome: "error"`. */
export async function runCustomHook(hook: CustomHook, input: unknown, cwd: string, spawnFn: HookSpawn = defaultHookSpawn, extraEnv: Record<string, string> = {}): Promise<HookRunResult> {
  const env = Object.fromEntries(
    Object.entries({ ...process.env, CLAUDE_PROJECT_DIR: cwd, ...extraEnv }).filter((e): e is [string, string] => typeof e[1] === "string"),
  );
  let raw: HookProcessResult;
  try {
    raw = await spawnFn(hook.command, { cwd, env, stdin: safeJson(input), timeoutMs: hook.timeoutSec * 1000 });
  } catch (error) {
    raw = { exitCode: null, stdout: "", stderr: error instanceof Error ? error.message : String(error), timedOut: false, durationMs: 0 };
  }
  return interpretHookRun(hook, raw);
}

export function interpretHookRun(hook: CustomHook, raw: HookProcessResult): HookRunResult {
  const base = {
    exitCode: raw.exitCode,
    durationMs: Math.max(0, Math.round(raw.durationMs)),
    stdout: raw.stdout.slice(0, OUTPUT_LIMIT),
    stderr: raw.stderr.slice(0, OUTPUT_LIMIT),
  };
  if (raw.timedOut) {
    return { ...base, outcome: "timeout", message: `Tempo limite de ${hook.timeoutSec} s esgotado; o run seguiu`, output: {} };
  }
  if (raw.exitCode === 2) {
    const reason = raw.stderr.trim() || `Bloqueado pelo hook “${hook.name}”`;
    if (!BLOCKABLE.has(hook.event)) {
      return { ...base, outcome: "error", message: `${hook.event} não pode bloquear: ${reason}`, output: {} };
    }
    return { ...base, outcome: "blocked", message: reason, output: blockOutput(hook.event, reason) };
  }
  if (raw.exitCode !== 0) {
    const detail = raw.stderr.trim() || raw.stdout.trim();
    return { ...base, outcome: "error", message: `Saída ${raw.exitCode ?? "desconhecida"}${detail ? `: ${detail}` : ""}`, output: {} };
  }
  const text = raw.stdout.trim();
  if (text.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ...base, outcome: "error", message: "O stdout começa com { mas não é JSON válido", output: {} };
    }
    const output = sanitizeOutput(hook.event, parsed);
    const hso = output.hookSpecificOutput as { permissionDecision?: string; permissionDecisionReason?: string } | undefined;
    if (output.decision === "block" || hso?.permissionDecision === "deny" || output.continue === false) {
      const message = String(output.reason ?? hso?.permissionDecisionReason ?? output.stopReason ?? `Bloqueado pelo hook “${hook.name}”`);
      return { ...base, outcome: "blocked", message, output };
    }
    const message = hso?.permissionDecision === "ask" ? `Pediu aprovação${hso.permissionDecisionReason ? `: ${hso.permissionDecisionReason}` : ""}` : null;
    return { ...base, outcome: "ok", message, output };
  }
  if (text && CONTEXT_EVENTS.has(hook.event) && hook.event !== "PostToolUse") {
    return { ...base, outcome: "ok", message: null, output: { hookSpecificOutput: { hookEventName: hook.event, additionalContext: text.slice(0, CONTEXT_LIMIT) } } };
  }
  return { ...base, outcome: "ok", message: null, output: {} };
}

function blockOutput(event: CustomHookEvent, reason: string): Record<string, unknown> {
  if (event === "PreToolUse") {
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
  }
  return { decision: "block", reason };
}

/** Só passa o que aperta ou informa; descarta `allow`, `updatedInput` e chaves desconhecidas. */
export function sanitizeOutput(event: CustomHookEvent, value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const json = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (json.continue === false) {
    out.continue = false;
    if (typeof json.stopReason === "string") out.stopReason = json.stopReason;
  }
  if (typeof json.systemMessage === "string") out.systemMessage = json.systemMessage;
  if (json.decision === "block" && BLOCKABLE.has(event)) {
    out.decision = "block";
    out.reason = typeof json.reason === "string" ? json.reason : `Bloqueado pelo hook`;
  }
  const hso = json.hookSpecificOutput;
  if (hso && typeof hso === "object" && !Array.isArray(hso)) {
    const h = hso as Record<string, unknown>;
    const kept: Record<string, unknown> = { hookEventName: event };
    if (typeof h.additionalContext === "string" && CONTEXT_EVENTS.has(event)) kept.additionalContext = h.additionalContext.slice(0, CONTEXT_LIMIT);
    if (event === "PreToolUse" && (h.permissionDecision === "deny" || h.permissionDecision === "ask")) {
      kept.permissionDecision = h.permissionDecision;
      if (typeof h.permissionDecisionReason === "string") kept.permissionDecisionReason = h.permissionDecisionReason;
    }
    if (Object.keys(kept).length > 1) out.hookSpecificOutput = kept;
  }
  return out;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}
