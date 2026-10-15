/**
 * Transporte de mock: simula o core Rust + sidecar no navegador.
 * Reproduz as fixtures compartilhadas do protocolo para que a UI possa ser desenvolvida e testada
 * sem Tauri, sem Claude e sem rede. Também é o backend dos testes Playwright.
 */
import fixtureEvents from "@octopus/protocol/fixtures/run-events.notifications.json";
import type { PermissionDecision, RunEventNotification } from "@octopus/protocol";
import type { Transport, Unlisten } from "./transport";
import type { CommandName, Commands, EventName, Events, Project, Run, StoredRunEvent } from "./types";

type FixtureNotification = { params: RunEventNotification };

export type MockOptions = {
  /** Intervalo entre eventos reproduzidos, em ms. */
  tickMs?: number;
  /** Eventos a reproduzir em cada run. Padrão: fixture compartilhada do protocolo. */
  events?: RunEventNotification[];
  /** Projetos iniciais. */
  projects?: Project[];
};

export function fixtureRunEvents(): RunEventNotification[] {
  return (fixtureEvents as FixtureNotification[]).map((n) => n.params);
}

export function createMockTransport(options: MockOptions = {}): Transport & { emit: <E extends EventName>(e: E, p: Events[E]) => void } {
  const tickMs = options.tickMs ?? 120;
  const script = options.events ?? fixtureRunEvents();
  const listeners = new Map<EventName, Set<(payload: never) => void>>();
  const projects: Project[] = options.projects ?? [
    { id: "proj_demo", name: "chat-core", path: "/Users/dev/projetos/chat-core", authMode: "subscription", createdAt: new Date().toISOString() },
  ];
  const runs = new Map<string, Run>();
  const events = new Map<string, StoredRunEvent[]>();
  const pendingTimers = new Map<string, ReturnType<typeof setTimeout>[]>();
  const pausedAt = new Map<string, number>();
  const seqByRun = new Map<string, number>();
  let runCounter = 0;

  const emit = <E extends EventName>(event: E, payload: Events[E]) => {
    for (const handler of listeners.get(event) ?? []) (handler as (p: Events[E]) => void)(payload);
  };

  const nextSeq = (runId: string) => {
    const seq = seqByRun.get(runId) ?? 0;
    seqByRun.set(runId, seq + 1);
    return seq;
  };

  /** Emite um evento avulso (fora do roteiro) com seq próprio e o persiste. */
  const emitEvent = (runId: string, event: RunEventNotification["event"]) => {
    const notification: RunEventNotification = { runId, seq: nextSeq(runId), at: new Date().toISOString(), event };
    if (event.type !== "assistant_text_delta") {
      events.get(runId)?.push({ runId, seq: notification.seq, at: notification.at, kind: event.type, event });
    }
    emit("run:event", notification);
  };

  const deliver = (runId: string, index: number) => {
    const run = runs.get(runId);
    if (!run || index >= script.length) return;
    const template = script[index]!;
    const notification: RunEventNotification = { ...template, runId, seq: nextSeq(runId), at: new Date().toISOString() };
    const ev = notification.event;
    if (ev.type !== "assistant_text_delta") {
      events.get(runId)!.push({ runId, seq: notification.seq, at: notification.at, kind: ev.type, event: ev });
    }
    if (ev.type === "session_init") {
      run.status = "running";
      run.claudeSessionId = ev.sessionId;
      run.model = ev.model;
    } else if (ev.type === "usage") {
      run.inputTokens = ev.usage.inputTokens;
      run.outputTokens = ev.usage.outputTokens;
      run.cacheReadTokens = ev.usage.cacheReadTokens;
    } else if (ev.type === "result") {
      run.status = ev.isError ? "failed" : "completed";
      run.costUsd = ev.costUsd;
      run.numTurns = ev.numTurns;
      run.resultText = ev.resultText;
      run.endedAt = notification.at;
    } else if (ev.type === "permission_request") {
      run.status = "waiting_approval";
    }
    emit("run:event", notification);
    if (ev.type === "permission_request") {
      // Pausa até decide_permission.
      pausedAt.set(runId, index + 1);
      return;
    }
    schedule(runId, index + 1);
  };

  const schedule = (runId: string, index: number) => {
    if (index >= script.length) return;
    const timer = setTimeout(() => deliver(runId, index), tickMs);
    pendingTimers.set(runId, [...(pendingTimers.get(runId) ?? []), timer]);
  };

  const handlers: { [C in CommandName]: (args: Commands[C]["args"]) => Promise<Commands[C]["result"]> } = {
    runtime_info: async () => ({ protocolVersion: 1, runtimeVersion: "mock", sdkVersion: "mock" }),
    list_projects: async () => [...projects],
    create_project: async ({ input }) => {
      const project: Project = {
        id: `proj_${projects.length + 1}`,
        name: input.name,
        path: input.path,
        authMode: "subscription",
        createdAt: new Date().toISOString(),
      };
      projects.unshift(project);
      return project;
    },
    delete_project: async ({ projectId }) => {
      const index = projects.findIndex((p) => p.id === projectId);
      if (index === -1) return false;
      projects.splice(index, 1);
      return true;
    },
    list_runs: async ({ projectId, limit }) =>
      [...runs.values()]
        .filter((r) => r.projectId === projectId)
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        .slice(0, limit ?? 50),
    get_run: async ({ runId }) => runs.get(runId) ?? null,
    list_run_events: async ({ runId }) => [...(events.get(runId) ?? [])],
    start_run: async ({ input }) => {
      const project = projects.find((p) => p.id === input.projectId);
      if (!project) throw new Error(`Projeto ${input.projectId} não encontrado`);
      if (!input.prompt.trim()) throw new Error("O prompt não pode ser vazio");
      const run: Run = {
        id: `run_mock_${++runCounter}`,
        projectId: project.id,
        prompt: input.prompt,
        options: input.options ?? {},
        status: "running",
        claudeSessionId: null,
        model: input.options?.model ?? null,
        startedAt: new Date().toISOString(),
        endedAt: null,
        costUsd: null,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        numTurns: null,
        stopReason: null,
        resultText: null,
        errorMessage: null,
      };
      runs.set(run.id, run);
      events.set(run.id, []);
      schedule(run.id, 0);
      return { ...run };
    },
    interrupt_run: async ({ runId }) => {
      const run = runs.get(runId);
      if (!run || !["running", "waiting_approval", "queued"].includes(run.status)) return false;
      for (const t of pendingTimers.get(runId) ?? []) clearTimeout(t);
      pendingTimers.delete(runId);
      pausedAt.delete(runId);
      run.status = "interrupted";
      run.endedAt = new Date().toISOString();
      emitEvent(runId, { type: "error", message: "Run interrompido pelo usuário", fatal: true });
      return true;
    },
    decide_permission: async ({ input }) => {
      const resume = pausedAt.get(input.runId);
      if (resume === undefined) return false;
      pausedAt.delete(input.runId);
      const run = runs.get(input.runId)!;
      run.status = "running";
      const decision: PermissionDecision = input.decision;
      const pending = events.get(input.runId)?.findLast((e) => e.event.type === "permission_request");
      const toolName = pending?.event.type === "permission_request" ? pending.event.toolName : "Bash";
      const toolInput = pending?.event.type === "permission_request" ? pending.event.input : {};
      // Como no SDK: a ferramenta aprovada ou negada aparece como tool_use seguido do seu tool_result.
      emitEvent(input.runId, { type: "tool_use", toolUseId: "toolu_perm", name: toolName, input: toolInput, parentToolUseId: null });
      if (decision.behavior === "deny") {
        emitEvent(input.runId, { type: "tool_result", toolUseId: "toolu_perm", content: `Negado: ${decision.message}`, isError: true, parentToolUseId: null });
      } else {
        emitEvent(input.runId, { type: "tool_result", toolUseId: "toolu_perm", content: "Tests run: 12, Failures: 0", isError: false, parentToolUseId: null });
      }
      schedule(input.runId, resume);
      return true;
    },
    list_sessions: async () => [
      {
        sessionId: "5b3f2c1a-8d4e-4f6b-9a7c-2e1d0f9b8a6c",
        cwd: projects[0]?.path ?? "/",
        title: "Criar migração Flyway V12 para tabela leads",
        tags: ["migração"],
        createdAt: new Date(Date.now() - 3_600_000).toISOString(),
        lastUsedAt: new Date().toISOString(),
      },
    ],
  };

  return {
    emit,
    invoke: async (command, args) => handlers[command](args as never) as never,
    listen: async (event, handler) => {
      const set = listeners.get(event) ?? new Set();
      set.add(handler as (payload: never) => void);
      listeners.set(event, set);
      const unlisten: Unlisten = () => set.delete(handler as (payload: never) => void);
      return unlisten;
    },
  };
}
