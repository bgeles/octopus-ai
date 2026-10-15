/**
 * Gerencia runs do Agent SDK: inicia, interrompe, encaminha permissões e emite eventos.
 * O acesso ao SDK é injetado (QueryFn) para permitir testes sem rede nem binário do Claude.
 */
import type { PermissionDecision, RunEvent, RunStartParams } from "@octopus/protocol";
import { JsonRpcErrorCode } from "@octopus/protocol";
import { mapSdkMessage, type SdkMessageLike } from "./events.js";
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
  abortController: AbortController;
  canUseTool: CanUseToolLike;
};

export type QueryHandleLike = AsyncIterable<SdkMessageLike> & { interrupt?: () => Promise<void> };
export type QueryFn = (args: { prompt: string; options: QueryOptionsLike }) => QueryHandleLike;

export type EventSink = (runId: string, event: RunEvent) => void;

type PendingPermission = {
  resolve: (decision: PermissionDecision) => void;
};

type ActiveRun = {
  runId: string;
  abort: AbortController;
  handle: QueryHandleLike | null;
  pendingPermissions: Map<string, PendingPermission>;
  done: Promise<void>;
};

export class RunManager {
  private readonly runs = new Map<string, ActiveRun>();
  private permissionCounter = 0;

  constructor(
    private readonly queryFn: QueryFn,
    private readonly emit: EventSink,
    private readonly log: (level: "debug" | "info" | "warn" | "error", message: string) => void = () => {},
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
      done: Promise.resolve(),
    };
    this.runs.set(params.runId, run);

    const options = this.buildOptions(params, run);
    run.done = this.consume(run, params.prompt, options).finally(() => {
      for (const pending of run.pendingPermissions.values()) {
        pending.resolve({ behavior: "deny", message: "Run encerrado antes da decisão" });
      }
      run.pendingPermissions.clear();
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

  private requestPermission(
    run: ActiveRun,
    toolName: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<PermissionResultLike> {
    const requestId = `perm_${++this.permissionCounter}`;
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
      this.emit(run.runId, { type: "permission_request", requestId, toolName, input, reason: null });
    });
  }
}
