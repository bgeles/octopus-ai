/**
 * Transporte de mock: simula o core Rust + sidecar no navegador.
 * Reproduz as fixtures compartilhadas do protocolo para que a UI possa ser desenvolvida e testada
 * sem Tauri, sem Claude e sem rede. Também é o backend dos testes Playwright.
 */
import editApprovalEvents from "@octopus/protocol/fixtures/run-events-edit-approval.notifications.json";
import subagentEvents from "@octopus/protocol/fixtures/run-events-subagent.notifications.json";
import fixtureEvents from "@octopus/protocol/fixtures/run-events.notifications.json";
import type { PermissionDecision, RunEventNotification } from "@octopus/protocol";
import type { Transport, Unlisten } from "./transport";
import type { Approval, AppSettings, BackupSnapshot, CommandName, Commands, ConfigExport, EventName, Events, ImportMode, ImportPreview, ImportResult, Project, Run, SessionSummary, StoredRunEvent } from "./types";

type FixtureNotification = { params: RunEventNotification };

export type MockOptions = {
  /** Intervalo entre eventos reproduzidos, em ms. */
  tickMs?: number;
  /** Eventos a reproduzir em cada run. Padrão: fixture compartilhada do protocolo. */
  events?: RunEventNotification[];
  /** Projetos iniciais. */
  projects?: Project[];
  /** Instalação nova: sem projetos, sem preferências, onboarding pendente. */
  freshInstall?: boolean;
  /** Resultado das checagens de ambiente (padrão: tudo ok). */
  environment?: Partial<{ node: boolean; claudeAuth: boolean }>;
};

/** Export de demonstração que o mock "lê" de qualquer caminho terminado em `.json`. */
export function demoConfigExport(): ConfigExport {
  return {
    schemaVersion: 1,
    exportedAt: "2026-10-16T12:00:00.000Z",
    appVersion: "0.1.0",
    settings: { theme: "dark", defaultAuthMode: "subscription", "onboarding.completedAt": "2026-10-16T11:00:00.000Z" },
    projects: [
      { id: "proj_demo", name: "chat-core", path: "/Users/dev/projetos/chat-core", authMode: "subscription", createdAt: "2026-10-15T10:00:00.000Z" },
      { id: "proj_frontend", name: "frontend-chat", path: "/Users/dev/projetos/frontend-chat", authMode: "subscription", createdAt: "2026-10-15T11:00:00.000Z" },
    ],
  };
}

export function fixtureRunEvents(): RunEventNotification[] {
  return (fixtureEvents as FixtureNotification[]).map((n) => n.params);
}

/** Roteiro alternativo: aprovações de Edit e Write (preview com diff). */
export function editApprovalRunEvents(): RunEventNotification[] {
  return (editApprovalEvents as FixtureNotification[]).map((n) => n.params);
}

/** Roteiro alternativo: agente principal delega a um subagente (parentToolUseId). */
export function subagentRunEvents(): RunEventNotification[] {
  return (subagentEvents as FixtureNotification[]).map((n) => n.params);
}

/** Conteúdo "atual" de arquivos do projeto de demonstração, para o diff de Write. */
const MOCK_FILES: Record<string, string> = {
  "README.md": "# chat-core\n\nServiço de leads.\n",
  "src/main/java/com/acme/leads/LeadRepository.java": [
    "package com.acme.leads;",
    "",
    "import java.util.List;",
    "import org.springframework.data.jpa.repository.JpaRepository;",
    "",
    "public interface LeadRepository extends JpaRepository<Lead, Long> {",
    "    List<Lead> findByStatus(LeadStatus status);",
    "",
    "    List<Lead> findAll();",
    "}",
    "",
  ].join("\n"),
};

export function createMockTransport(options: MockOptions = {}): Transport & { emit: <E extends EventName>(e: E, p: Events[E]) => void } {
  const tickMs = options.tickMs ?? 120;
  const script = options.events ?? fixtureRunEvents();
  const listeners = new Map<EventName, Set<(payload: never) => void>>();
  const fresh = options.freshInstall ?? false;
  const projects: Project[] = options.projects ?? (fresh ? [] : [
    { id: "proj_demo", name: "chat-core", path: "/Users/dev/projetos/chat-core", authMode: "subscription", createdAt: new Date().toISOString() },
  ]);
  const settings: AppSettings = fresh ? {} : { "onboarding.completedAt": "2026-10-15T10:00:00.000Z", defaultAuthMode: "subscription" };
  const snapshots: BackupSnapshot[] = [];
  const snapshotFiles = new Map<string, ConfigExport>();
  let snapshotCounter = 0;
  const exportConfig = (): ConfigExport => ({
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    appVersion: "0.1.0-mock",
    settings: { ...settings },
    projects: projects.map((p) => ({ ...p })),
  });
  const writeSnapshot = (reason: BackupSnapshot["reason"]): BackupSnapshot => {
    const config = exportConfig();
    const snapshot: BackupSnapshot = {
      id: `bkp_${++snapshotCounter}`,
      createdAt: config.exportedAt,
      path: `/mock/backups/octopus-config-${snapshotCounter}-${reason}.json`,
      schemaVersion: 1,
      reason,
      sizeBytes: JSON.stringify(config).length,
    };
    snapshots.unshift(snapshot);
    snapshotFiles.set(snapshot.id, config);
    const autos = snapshots.filter((s) => s.reason === "auto");
    for (const old of autos.slice(20)) {
      snapshots.splice(snapshots.indexOf(old), 1);
      snapshotFiles.delete(old.id);
    }
    return snapshot;
  };
  const sameProject = (a: Project, b: Project) => a.id === b.id && a.name === b.name && a.path === b.path && a.authMode === b.authMode;
  const previewImport = (config: ConfigExport): ImportPreview => {
    const preview: ImportPreview = { schemaVersion: config.schemaVersion, exportedAt: config.exportedAt, projectsNew: [], projectsSame: [], projectsConflict: [], projectsRemoved: [], settings: Object.keys(config.settings).length };
    for (const incoming of config.projects) {
      const existing = projects.find((p) => p.id === incoming.id || p.path === incoming.path);
      if (!existing) preview.projectsNew.push(incoming.name);
      else if (sameProject(existing, incoming)) preview.projectsSame.push(incoming.name);
      else preview.projectsConflict.push(`${incoming.name} ↔ ${existing.name}`);
    }
    for (const existing of projects) {
      if (!config.projects.some((p) => p.id === existing.id || p.path === existing.path)) preview.projectsRemoved.push(existing.name);
    }
    return preview;
  };
  const importConfig = (config: ConfigExport, mode: ImportMode): ImportResult => {
    const result: ImportResult = { projectsAdded: 0, projectsUpdated: 0, projectsRemoved: 0, settingsApplied: 0 };
    for (const incoming of config.projects) {
      const existing = projects.find((p) => p.id === incoming.id || p.path === incoming.path);
      if (!existing) {
        projects.push({ ...incoming });
        result.projectsAdded++;
      } else if (mode === "replace" && !sameProject(existing, incoming)) {
        Object.assign(existing, { name: incoming.name, path: incoming.path, authMode: incoming.authMode });
        result.projectsUpdated++;
      }
    }
    if (mode === "replace") {
      for (const existing of [...projects]) {
        if (!config.projects.some((p) => p.id === existing.id || p.path === existing.path)) {
          projects.splice(projects.indexOf(existing), 1);
          result.projectsRemoved++;
        }
      }
      for (const key of Object.keys(settings)) delete settings[key];
    }
    for (const [key, value] of Object.entries(config.settings)) {
      settings[key] = value;
      result.settingsApplied++;
    }
    return result;
  };
  const readExport = (path: string): ConfigExport => {
    if (!path.endsWith(".json")) throw new Error(`${path} não é um export válido`);
    const bySnapshot = snapshots.find((s) => s.path === path);
    return bySnapshot ? snapshotFiles.get(bySnapshot.id)! : demoConfigExport();
  };
  const runs = new Map<string, Run>();
  const events = new Map<string, StoredRunEvent[]>();
  const sessions: SessionSummary[] = [
    {
      sessionId: "5b3f2c1a-8d4e-4f6b-9a7c-2e1d0f9b8a6c",
      cwd: projects[0]?.path ?? "/",
      title: "Criar migração Flyway V12 para tabela leads",
      tags: ["migração"],
      createdAt: new Date(Date.now() - 3_600_000).toISOString(),
      lastUsedAt: new Date().toISOString(),
    },
  ];
  let forkCounter = 0;
  const approvals = new Map<string, Approval>();
  const approvalKey = (runId: string, requestId: string) => `${runId}:${requestId}`;
  const recordApproval = (run: Run, at: string, ev: Extract<RunEventNotification["event"], { type: "permission_request" }>) => {
    const key = approvalKey(run.id, ev.requestId);
    if (approvals.has(key)) return;
    approvals.set(key, {
      id: `appr_${approvals.size + 1}`,
      runId: run.id,
      projectId: run.projectId,
      runPrompt: run.prompt,
      requestId: ev.requestId,
      toolName: ev.toolName,
      toolInput: ev.input,
      reason: ev.reason,
      decision: null,
      decisionMessage: null,
      requestedAt: at,
      decidedAt: null,
    });
  };
  const closePendingApprovals = (runId: string) => {
    for (const approval of approvals.values()) {
      if (approval.runId === runId && approval.decision === null) {
        approval.decision = "deny";
        approval.decisionMessage = "Run encerrado antes da decisão";
        approval.decidedAt = new Date().toISOString();
      }
    }
  };
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
    let event = template.event;
    // Retomar mantém o id da sessão; bifurcar nasce com um id novo (como o SDK faz).
    if (event.type === "session_init" && run.options.resumeSessionId) {
      const sessionId = run.options.forkSession ? `fork-${++forkCounter}-${run.options.resumeSessionId.slice(0, 8)}` : run.options.resumeSessionId;
      event = { ...event, sessionId };
    }
    const notification: RunEventNotification = { ...template, event, runId, seq: nextSeq(runId), at: new Date().toISOString() };
    const ev = notification.event;
    if (ev.type !== "assistant_text_delta") {
      events.get(runId)!.push({ runId, seq: notification.seq, at: notification.at, kind: ev.type, event: ev });
    }
    if (ev.type === "session_init") {
      run.status = "running";
      run.claudeSessionId = ev.sessionId;
      run.model = ev.model;
      if (!sessions.some((s) => s.sessionId === ev.sessionId)) {
        const project = projects.find((p) => p.id === run.projectId);
        sessions.unshift({ sessionId: ev.sessionId, cwd: project?.path ?? "/", title: run.prompt, tags: [], createdAt: notification.at, lastUsedAt: notification.at });
      }
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
      closePendingApprovals(run.id);
    } else if (ev.type === "permission_request") {
      run.status = "waiting_approval";
      recordApproval(run, notification.at, ev);
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
      writeSnapshot("auto");
      return project;
    },
    delete_project: async ({ projectId }) => {
      const index = projects.findIndex((p) => p.id === projectId);
      if (index === -1) return false;
      projects.splice(index, 1);
      writeSnapshot("auto");
      return true;
    },
    list_runs: async ({ projectId, limit }) =>
      [...runs.values()]
        .filter((r) => r.projectId === projectId)
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        .slice(0, limit ?? 50),
    get_run: async ({ runId }) => runs.get(runId) ?? null,
    get_project_totals: async ({ projectId }) => {
      const list = [...runs.values()].filter((r) => r.projectId === projectId);
      return {
        projectId,
        runs: list.length,
        costUsd: list.reduce((sum, r) => sum + (r.costUsd ?? 0), 0),
        inputTokens: list.reduce((sum, r) => sum + r.inputTokens, 0),
        outputTokens: list.reduce((sum, r) => sum + r.outputTokens, 0),
        cacheReadTokens: list.reduce((sum, r) => sum + r.cacheReadTokens, 0),
      };
    },
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
      closePendingApprovals(runId);
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
      const pending = events.get(input.runId)?.findLast((e) => e.event.type === "permission_request" && e.event.requestId === input.requestId);
      const toolName = pending?.event.type === "permission_request" ? pending.event.toolName : "Bash";
      const toolInput = pending?.event.type === "permission_request" ? pending.event.input : {};
      const approval = approvals.get(approvalKey(input.runId, input.requestId));
      if (approval && approval.decision === null) {
        approval.decision = decision.behavior;
        approval.decisionMessage = decision.behavior === "deny" ? decision.message : (input.note?.trim() || null);
        approval.decidedAt = new Date().toISOString();
      }
      // Como no SDK: a ferramenta aprovada ou negada aparece como tool_use seguido do seu tool_result.
      const toolUseId = `toolu_${input.requestId}`;
      emitEvent(input.runId, { type: "tool_use", toolUseId, name: toolName, input: toolInput, parentToolUseId: null });
      if (decision.behavior === "deny") {
        emitEvent(input.runId, { type: "tool_result", toolUseId, content: `Negado: ${decision.message}`, isError: true, parentToolUseId: null });
      } else {
        emitEvent(input.runId, { type: "tool_result", toolUseId, content: toolName === "Bash" ? "Tests run: 12, Failures: 0" : "OK", isError: false, parentToolUseId: null });
      }
      schedule(input.runId, resume);
      return true;
    },
    list_approvals: async ({ projectId, limit }) =>
      [...approvals.values()]
        .filter((a) => a.projectId === projectId)
        .sort((a, b) => Number(a.decision !== null) - Number(b.decision !== null) || b.requestedAt.localeCompare(a.requestedAt))
        .slice(0, limit ?? 100)
        .map((a) => ({ ...a })),
    read_project_file: async ({ path, maxBytes }) => {
      const key = path.replace(/^\/Users\/dev\/projetos\/chat-core\//, "");
      const content = MOCK_FILES[key];
      if (content === undefined) return { path, exists: false, content: "", truncated: false };
      const limit = maxBytes ?? 256 * 1024;
      return { path, exists: true, content: content.slice(0, limit), truncated: content.length > limit };
    },
    get_settings: async () => ({ ...settings }),
    set_setting: async ({ key, value }) => {
      if (value === null || value === undefined) delete settings[key];
      else settings[key] = value;
      writeSnapshot("auto");
      return null;
    },
    check_environment: async () => {
      const env = { node: true, claudeAuth: true, ...options.environment };
      return {
        node: env.node ? { ok: true, detail: "/opt/homebrew/bin/node · v23.1.0" } : { ok: false, detail: "Node.js não encontrado no PATH nem nos caminhos usuais. Instale o Node ou aponte OCTOPUS_NODE." },
        sidecar: { ok: true, detail: "agent-runtime mock · Claude Agent SDK mock" },
        claudeAuth: env.claudeAuth ? { ok: true, detail: "credencial do Claude Code no Keychain · login pessoal" } : { ok: false, detail: "nenhuma credencial do Claude Code no Keychain nem ANTHROPIC_API_KEY. Rode `claude` no Terminal e faça login." },
        authMethod: env.claudeAuth ? "keychain" : null,
        checkedAt: new Date().toISOString(),
      };
    },
    config_export: async ({ destination }) => ({ snapshot: writeSnapshot("manual"), copiedTo: destination ?? null }),
    config_export_json: async () => exportConfig(),
    config_import_preview: async ({ path }) => previewImport(readExport(path)),
    config_import: async ({ input }) => {
      const config = readExport(input.path);
      writeSnapshot("pre-restore");
      const result = importConfig(config, input.mode);
      writeSnapshot("auto");
      return result;
    },
    config_backups_list: async () => snapshots.map((s) => ({ ...s })),
    config_backup_preview: async ({ id }) => {
      const config = snapshotFiles.get(id);
      if (!config) throw new Error(`Cópia ${id} não encontrada`);
      return previewImport(config);
    },
    config_backup_restore: async ({ input }) => {
      const config = snapshotFiles.get(input.id);
      if (!config) throw new Error(`Cópia ${input.id} não encontrada`);
      writeSnapshot("pre-restore");
      const result = importConfig(config, input.mode);
      writeSnapshot("auto");
      return result;
    },
    config_backup_reveal: async () => null,
    list_sessions: async () => sessions.map((s) => ({ ...s, tags: [...s.tags] })),
    rename_session: async ({ input }) => {
      const session = sessions.find((s) => s.sessionId === input.sessionId);
      if (!session) throw new Error(`Sessão ${input.sessionId} não encontrada`);
      if (!input.title.trim()) throw new Error("Informe um título para a sessão");
      session.title = input.title.trim();
      return true;
    },
    tag_session: async ({ input }) => {
      const session = sessions.find((s) => s.sessionId === input.sessionId);
      if (!session) throw new Error(`Sessão ${input.sessionId} não encontrada`);
      const tag = input.tag?.trim();
      session.tags = tag ? [tag] : [];
      return true;
    },
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
