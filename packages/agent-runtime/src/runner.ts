/**
 * Gerencia runs do Agent SDK: inicia, interrompe, encaminha permissões e emite eventos.
 * O acesso ao SDK é injetado (QueryFn) para permitir testes sem rede nem binário do Claude.
 */
import type { HookDecision, PermissionDecision, RunEvent, RunHookNotification, RunStartParams, TaskContext, TaskStatusUpdate } from "@octopus/protocol";
import { JsonRpcErrorCode } from "@octopus/protocol";
import { mapSdkMessage, type SdkMessageLike } from "./events.js";
import { MEMORY_HOOK_EVENTS, eventFromMemoryHook, type MemoryHookInputLike } from "./memoryHooks.js";
import { RpcError } from "./rpc.js";

export type PermissionResultLike =
  | { behavior: "allow"; updatedInput: Record<string, unknown> }
  | { behavior: "deny"; message: string; interrupt?: boolean };

export type CanUseToolLike = (
  toolName: string,
  input: Record<string, unknown>,
  options: { signal: AbortSignal },
) => Promise<PermissionResultLike>;

/** Subconjunto das opções do SDK que o runner produz. Mantido estrutural para não acoplar aos tipos do SDK. */
export type QueryOptionsLike = {
  cwd: string;
  model?: string;
  permissionMode?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  resume?: string;
  forkSession?: boolean;
  systemPrompt?: { type: "preset"; preset: "claude_code"; append?: string };
  allowedTools?: string[];
  settingSources?: Array<"user" | "project" | "local">;
  env?: Record<string, string | undefined>;
  includePartialMessages?: boolean;
  agents?: Record<string, { description: string; prompt: string; tools?: string[]; model?: string }>;
  /** MCP servers in-process (instâncias do SDK); o runner só repassa. */
  mcpServers?: Record<string, unknown>;
  /** Hooks do SDK (PreToolUse etc.), estruturalmente iguais ao `HookCallbackMatcher`. */
  hooks?: Record<string, Array<{ matcher?: string; hooks: HookCallbackLike[]; timeout?: number }>>;
  /** `SandboxSettings` do SDK; o runner só repassa. */
  sandbox?: unknown;
  abortController: AbortController;
  canUseTool: CanUseToolLike;
};

export type QueryHandleLike = AsyncIterable<SdkMessageLike> & { interrupt?: () => Promise<void> };
export type QueryFn = (args: { prompt: string; options: QueryOptionsLike }) => QueryHandleLike;

export type EventSink = (runId: string, event: RunEvent) => void;

/** Entrada mínima do hook PreToolUse do SDK. */
export type PreToolUseInputLike = { hook_event_name: string; tool_name: string; tool_input: unknown; tool_use_id?: string; parent_tool_use_id?: string | null };
export type HookCallbackLike = (input: PreToolUseInputLike & MemoryHookInputLike, toolUseId: string | undefined, options: { signal: AbortSignal }) => Promise<unknown>;

/** Notifica o core de um hook bloqueante (`run.hook`); a resposta chega por `decideHook`. */
export type HookSink = (notification: RunHookNotification) => void;

/** Quanto tempo esperar pelo core antes de cair em `ask`. */
export const HOOK_TIMEOUT_MS = 30_000;

/** Fábrica do MCP server `octopus` (createSdkMcpServer + tool do SDK), injetada para testes. */
export type TaskToolsFactory = (ctx: TaskContext, onUpdate: (status: TaskStatusUpdate, note: string | null) => void) => unknown;

export const TASK_UPDATE_TOOL = "mcp__octopus__task_update";

type PendingPermission = {
  resolve: (decision: PermissionDecision) => void;
};

type PendingHook = {
  resolve: (decision: HookDecision) => void;
};

type ActiveRun = {
  runId: string;
  abort: AbortController;
  handle: QueryHandleLike | null;
  pendingPermissions: Map<string, PendingPermission>;
  pendingHooks: Map<string, PendingHook>;
  /** Motivo de um `ask` da política, para o `permission_request` seguinte da mesma ferramenta. */
  askReasons: Map<string, string>;
  done: Promise<void>;
};

export class RunManager {
  private readonly runs = new Map<string, ActiveRun>();
  private permissionCounter = 0;
  private hookCounter = 0;

  constructor(
    private readonly queryFn: QueryFn,
    private readonly emit: EventSink,
    private readonly log: (level: "debug" | "info" | "warn" | "error", message: string) => void = () => {},
    private readonly taskTools: TaskToolsFactory | null = null,
    private readonly emitHook: HookSink | null = null,
    private readonly hookTimeoutMs: number = HOOK_TIMEOUT_MS,
  ) {}

  get activeRunIds(): string[] {
    return [...this.runs.keys()];
  }

  start(params: RunStartParams): void {
    if (this.runs.has(params.runId)) {
      throw new RpcError(JsonRpcErrorCode.RunAlreadyExists, `Run ${params.runId} já está ativo`);
    }

    const abort = new AbortController();
    const run: ActiveRun = {
      runId: params.runId,
      abort,
      handle: null,
      pendingPermissions: new Map(),
      pendingHooks: new Map(),
      askReasons: new Map(),
      done: Promise.resolve(),
    };
    this.runs.set(params.runId, run);

    const options = this.buildOptions(params, run);
    run.done = this.consume(run, params.prompt, options).finally(() => {
      for (const pending of run.pendingPermissions.values()) {
        pending.resolve({ behavior: "deny", message: "Run encerrado antes da decisão" });
      }
      run.pendingPermissions.clear();
      for (const pending of run.pendingHooks.values()) pending.resolve({ behavior: "deny", reason: "Run encerrado antes da decisão" });
      run.pendingHooks.clear();
      this.runs.delete(params.runId);
    });
  }

  async interrupt(runId: string): Promise<boolean> {
    const run = this.runs.get(runId);
    if (!run) return false;
    try {
      if (run.handle?.interrupt) await run.handle.interrupt();
    } catch (error) {
      this.log("warn", `interrupt() falhou para ${runId}: ${String(error)}`);
    }
    run.abort.abort();
    return true;
  }

  decidePermission(runId: string, requestId: string, decision: PermissionDecision): boolean {
    const run = this.runs.get(runId);
    if (!run) throw new RpcError(JsonRpcErrorCode.RunNotFound, `Run ${runId} não encontrado`);
    const pending = run.pendingPermissions.get(requestId);
    if (!pending) throw new RpcError(JsonRpcErrorCode.PermissionRequestNotFound, `Pedido ${requestId} não encontrado`);
    run.pendingPermissions.delete(requestId);
    pending.resolve(decision);
    return true;
  }

  decideHook(runId: string, hookId: string, decision: HookDecision): boolean {
    const run = this.runs.get(runId);
    if (!run) throw new RpcError(JsonRpcErrorCode.RunNotFound, `Run ${runId} não encontrado`);
    const pending = run.pendingHooks.get(hookId);
    if (!pending) throw new RpcError(JsonRpcErrorCode.HookNotFound, `Hook ${hookId} não encontrado`);
    run.pendingHooks.delete(hookId);
    pending.resolve(decision);
    return true;
  }

  /** Aguarda todos os runs ativos terminarem (usado em testes e no shutdown). */
  async drain(): Promise<void> {
    await Promise.all([...this.runs.values()].map((run) => run.done));
  }

  private buildOptions(params: RunStartParams, run: ActiveRun): QueryOptionsLike {
    const o = params.options;
    const options: QueryOptionsLike = {
      cwd: params.cwd,
      abortController: run.abort,
      includePartialMessages: o.includePartialMessages ?? true,
      canUseTool: (toolName, input, { signal }) => this.requestPermission(run, toolName, input, signal),
    };
    if (o.model) options.model = o.model;
    if (o.permissionMode) options.permissionMode = o.permissionMode;
    if (o.maxTurns) options.maxTurns = o.maxTurns;
    if (o.maxBudgetUsd) options.maxBudgetUsd = o.maxBudgetUsd;
    if (o.resumeSessionId) {
      options.resume = o.resumeSessionId;
      if (o.forkSession) options.forkSession = true;
    }
    if (o.systemPromptAppend) {
      options.systemPrompt = { type: "preset", preset: "claude_code", append: o.systemPromptAppend };
    }
    if (o.allowedTools) options.allowedTools = o.allowedTools;
    if (o.settingSources) options.settingSources = o.settingSources;
    if (o.env) options.env = { ...process.env, ...o.env };
    if (o.agents && Object.keys(o.agents).length > 0) options.agents = o.agents;
    if (o.sandbox) options.sandbox = o.sandbox;
    if (o.policyHooks && this.emitHook) {
      options.hooks = { PreToolUse: [{ hooks: [(input, toolUseId) => this.preToolUse(run, input, toolUseId)] }] };
    }
    if (o.memory && o.memory.capture !== false) {
      const hooks = options.hooks ?? {};
      for (const eventName of MEMORY_HOOK_EVENTS) {
        hooks[eventName] = [...(hooks[eventName] ?? []), { hooks: [async (input) => this.memoryHook(run, input)] }];
      }
      options.hooks = hooks;
    }
    if (o.taskContext && this.taskTools) {
      const ctx = o.taskContext;
      const server = this.taskTools(ctx, (status, note) => {
        this.emit(run.runId, { type: "task_update", taskId: ctx.taskId, status, note });
      });
      options.mcpServers = { octopus: server as never };
      if (options.allowedTools && !options.allowedTools.includes(TASK_UPDATE_TOOL)) {
        options.allowedTools = [...options.allowedTools, TASK_UPDATE_TOOL];
      }
    }
    return options;
  }

  private async consume(run: ActiveRun, prompt: string, options: QueryOptionsLike): Promise<void> {
    let sawResult = false;
    try {
      const handle = this.queryFn({ prompt, options });
      run.handle = handle;
      for await (const message of handle) {
        for (const event of mapSdkMessage(message)) {
          if (event.type === "result") sawResult = true;
          this.emit(run.runId, event);
        }
      }
      if (!sawResult) {
        this.emit(run.runId, { type: "error", message: "O run terminou sem mensagem de resultado", fatal: true });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (run.abort.signal.aborted) {
        this.emit(run.runId, { type: "error", message: `Run interrompido: ${message}`, fatal: true });
      } else {
        this.emit(run.runId, { type: "error", message, fatal: true });
      }
    }
  }

  /** Hooks de memória: emitem `observation`/`compaction` e nunca interferem no fluxo do agente. */
  private memoryHook(run: ActiveRun, input: MemoryHookInputLike): unknown {
    try {
      const event = eventFromMemoryHook(input);
      if (event) this.emit(run.runId, event);
    } catch (error) {
      this.log("warn", `hook de memória falhou: ${String(error)}`);
    }
    return {};
  }

  /** Hook PreToolUse: pergunta ao core e traduz a decisão para o formato do SDK. */
  private async preToolUse(run: ActiveRun, input: PreToolUseInputLike, toolUseId: string | undefined): Promise<unknown> {
    if (input.hook_event_name !== "PreToolUse") return {};
    const hookId = `hook_${++this.hookCounter}`;
    const decision = await new Promise<HookDecision>((resolve) => {
      const timer = setTimeout(() => {
        if (run.pendingHooks.delete(hookId)) {
          this.log("warn", `hook ${hookId} sem resposta do core em ${this.hookTimeoutMs} ms; pedindo aprovação`);
          resolve({ behavior: "ask", reason: "Política sem resposta a tempo; confirme manualmente" });
        }
      }, this.hookTimeoutMs);
      run.pendingHooks.set(hookId, {
        resolve: (d) => {
          clearTimeout(timer);
          resolve(d);
        },
      });
      this.emitHook!({
        runId: run.runId,
        hookId,
        event: "PreToolUse",
        toolName: input.tool_name,
        input: input.tool_input,
        toolUseId: toolUseId ?? input.tool_use_id ?? null,
        parentToolUseId: input.parent_tool_use_id ?? null,
      });
    });
    if (decision.behavior === "pass") return {};
    if (decision.behavior === "ask" && decision.reason) run.askReasons.set(askKey(input.tool_name, input.tool_input), decision.reason);
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: decision.behavior,
        permissionDecisionReason: decision.reason,
        ...(decision.updatedInput ? { updatedInput: decision.updatedInput } : {}),
      },
    };
  }

  private requestPermission(
    run: ActiveRun,
    toolName: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<PermissionResultLike> {
    const requestId = `perm_${++this.permissionCounter}`;
    const key = askKey(toolName, input);
    const reason = run.askReasons.get(key) ?? null;
    run.askReasons.delete(key);
    return new Promise<PermissionResultLike>((resolve) => {
      const finish = (decision: PermissionDecision) => {
        signal.removeEventListener("abort", onAbort);
        if (decision.behavior === "allow") {
          resolve({ behavior: "allow", updatedInput: decision.updatedInput ?? input });
        } else {
          resolve({ behavior: "deny", message: decision.message });
        }
      };
      const onAbort = () => {
        run.pendingPermissions.delete(requestId);
        finish({ behavior: "deny", message: "Pedido de permissão cancelado" });
      };
      signal.addEventListener("abort", onAbort, { once: true });
      run.pendingPermissions.set(requestId, { resolve: finish });
      this.emit(run.runId, { type: "permission_request", requestId, toolName, input, reason });
    });
  }
}

function askKey(toolName: string, input: unknown): string {
  let serialized = "";
  try {
    serialized = JSON.stringify(input) ?? "";
  } catch {
    serialized = String(input);
  }
  return `${toolName}:${serialized}`;
}
