import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PermissionMode } from "@octopus/protocol";
import { AddProjectDialog } from "./components/AddProjectDialog";
import { Composer } from "./components/Composer";
import { RunHeader } from "./components/RunHeader";
import { RunSidebar } from "./components/RunSidebar";
import { SessionsView } from "./components/SessionsView";
import { Shell, type View } from "./components/Shell";
import { Transcript } from "./components/Transcript";
import type { Transport } from "./lib/transport";
import type { PermissionDecision, Project, ResumeTarget, Run, RunEventNotification, SessionSummary } from "./lib/types";
import { applyRunEvent, initialRunViewState, isRunActive, resolvePermission, withUserPrompt, type RunViewState } from "./state/runReducer";

type AppProps = { transport: Transport };

export function App({ transport }: AppProps) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [view, setView] = useState<View>("run");
  const [addOpen, setAddOpen] = useState(false);
  const [runs, setRuns] = useState<Run[]>([]);
  const [currentRun, setCurrentRun] = useState<Run | null>(null);
  const [runState, setRunState] = useState<RunViewState>(initialRunViewState());
  const [starting, setStarting] = useState(false);
  const [interrupting, setInterrupting] = useState(false);
  const [deciding, setDeciding] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [resumeTarget, setResumeTarget] = useState<ResumeTarget | null>(null);
  const [busySessionId, setBusySessionId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // Mantém a referência ao run atual para o listener de eventos.
  const currentRunIdRef = useRef<string | null>(null);
  currentRunIdRef.current = currentRun?.id ?? null;

  const refreshRuns = useCallback(
    async (projectId: string) => {
      const list = await transport.invoke("list_runs", { projectId, limit: 20 });
      setRuns(list);
      const currentId = currentRunIdRef.current;
      if (currentId) {
        const fresh = list.find((r) => r.id === currentId) ?? (await transport.invoke("get_run", { runId: currentId }));
        if (fresh) setCurrentRun((current) => (current && current.id === fresh.id ? fresh : current));
      }
    },
    [transport],
  );

  useEffect(() => {
    let cancelled = false;
    transport
      .invoke("list_projects", {})
      .then((list) => {
        if (cancelled) return;
        setProjects(list);
        setSelectedProject((current) => current ?? list[0] ?? null);
      })
      .catch((e) => setToast(`Falha ao carregar projetos: ${messageOf(e)}`));
    return () => {
      cancelled = true;
    };
  }, [transport]);

  useEffect(() => {
    if (!selectedProject) return;
    void refreshRuns(selectedProject.id);
    setSessions(null);
  }, [selectedProject, refreshRuns]);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let disposed = false;
    transport
      .listen("run:event", (notification: RunEventNotification) => {
        if (notification.runId !== currentRunIdRef.current) return;
        setRunState((state) => applyRunEvent(state, notification));
        if (notification.event.type === "result" || (notification.event.type === "error" && notification.event.fatal) || notification.event.type === "permission_request") {
          const projectId = selectedProjectRef.current?.id;
          if (projectId) void refreshRuns(projectId);
        }
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [transport, refreshRuns]);

  const selectedProjectRef = useRef<Project | null>(null);
  selectedProjectRef.current = selectedProject;

  useEffect(() => {
    transport.listen("runtime:exited", (code) => setToast(`O runtime do agente encerrou (código ${code ?? "desconhecido"}). Reinicie o app.`)).catch(() => {});
  }, [transport]);

  const active = isRunActive(runState);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);

  const elapsedMs = useMemo(() => {
    if (!currentRun) return 0;
    const start = new Date(currentRun.startedAt).getTime();
    const end = runState.result || !active ? (currentRun.endedAt ? new Date(currentRun.endedAt).getTime() : now) : now;
    return Math.max(0, end - start);
  }, [currentRun, runState.result, active, now]);

  const startRun = async (prompt: string, options: { permissionMode: PermissionMode; maxTurns: number }) => {
    if (!selectedProject) return;
    setStarting(true);
    setToast(null);
    try {
      const run = await transport.invoke("start_run", {
        input: {
          projectId: selectedProject.id,
          prompt,
          options: {
            permissionMode: options.permissionMode,
            maxTurns: options.maxTurns,
            includePartialMessages: true,
            ...(resumeTarget ? { resumeSessionId: resumeTarget.sessionId, ...(resumeTarget.fork ? { forkSession: true } : {}) } : {}),
          },
        },
      });
      setResumeTarget(null);
      currentRunIdRef.current = run.id;
      setCurrentRun(run);
      setRunState(withUserPrompt(initialRunViewState(run.id), prompt, run.startedAt));
      setView("run");
      await refreshRuns(selectedProject.id);
    } catch (e) {
      setToast(`Não foi possível iniciar o run: ${messageOf(e)}`);
    } finally {
      setStarting(false);
    }
  };

  const interrupt = async () => {
    if (!currentRun) return;
    setInterrupting(true);
    try {
      await transport.invoke("interrupt_run", { runId: currentRun.id });
      await refreshRuns(currentRun.projectId);
    } catch (e) {
      setToast(`Falha ao interromper: ${messageOf(e)}`);
    } finally {
      setInterrupting(false);
    }
  };

  const decide = async (requestId: string, decision: PermissionDecision) => {
    if (!currentRun) return;
    setDeciding(requestId);
    try {
      await transport.invoke("decide_permission", { input: { runId: currentRun.id, requestId, decision } });
      setRunState((state) => resolvePermission(state, requestId));
      await refreshRuns(currentRun.projectId);
    } catch (e) {
      setToast(`Falha ao registrar decisão: ${messageOf(e)}`);
    } finally {
      setDeciding(null);
    }
  };

  const openRun = async (run: Run) => {
    const events = await transport.invoke("list_run_events", { runId: run.id });
    let state = withUserPrompt(initialRunViewState(run.id), run.prompt, run.startedAt);
    for (const stored of events) state = applyRunEvent(state, { runId: stored.runId, seq: stored.seq, at: stored.at, event: stored.event });
    currentRunIdRef.current = run.id;
    setCurrentRun(run);
    setRunState(state);
    setView("run");
  };

  const createProject = async (input: { name: string; path: string }) => {
    const project = await transport.invoke("create_project", { input });
    setProjects((list) => [project, ...list]);
    setSelectedProject(project);
  };

  const loadSessions = async () => {
    if (!selectedProject) return;
    try {
      setSessions(await transport.invoke("list_sessions", { projectId: selectedProject.id }));
    } catch (e) {
      setToast(`Falha ao listar sessões: ${messageOf(e)}`);
      setSessions([]);
    }
  };

  useEffect(() => {
    if (view === "sessions" && sessions === null) void loadSessions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, selectedProject]);

  const beginResume = (session: { sessionId: string; title: string | null }, fork: boolean) => {
    setResumeTarget({ sessionId: session.sessionId, title: session.title, fork });
    setView("run");
  };

  const renameSession = async (sessionId: string, title: string) => {
    if (!selectedProject) return;
    setBusySessionId(sessionId);
    try {
      await transport.invoke("rename_session", { input: { projectId: selectedProject.id, sessionId, title } });
      await loadSessions();
    } catch (e) {
      setToast(`Falha ao renomear a sessão: ${messageOf(e)}`);
    } finally {
      setBusySessionId(null);
    }
  };

  const tagSession = async (sessionId: string, tag: string | null) => {
    if (!selectedProject) return;
    setBusySessionId(sessionId);
    try {
      await transport.invoke("tag_session", { input: { projectId: selectedProject.id, sessionId, tag } });
      await loadSessions();
    } catch (e) {
      setToast(`Falha ao taguear a sessão: ${messageOf(e)}`);
    } finally {
      setBusySessionId(null);
    }
  };

  const activeRuns = runs.filter((r) => r.status === "running" || r.status === "waiting_approval" || r.status === "queued");

  return (
    <Shell
      projects={projects}
      selectedProject={selectedProject}
      onSelectProject={(p) => {
        setSelectedProject(p);
        setCurrentRun(null);
        setRunState(initialRunViewState());
        setResumeTarget(null);
      }}
      onAddProject={() => setAddOpen(true)}
      view={view}
      onChangeView={setView}
      activeRuns={activeRuns}
      pendingApprovals={runState.pendingPermissions.length}
    >
      {view === "run" && (
        <>
          <RunHeader
            project={selectedProject}
            run={currentRun}
            state={runState}
            active={active}
            onInterrupt={() => void interrupt()}
            interrupting={interrupting}
            onContinue={() => {
              const sessionId = runState.sessionId ?? currentRun?.claudeSessionId;
              if (sessionId) beginResume({ sessionId, title: currentRun?.prompt ?? null }, false);
            }}
          />
          <div className="flex min-h-0 flex-1">
            <section aria-label="Transcript do run" className="flex min-w-0 flex-1 flex-col overflow-y-auto">
              <Transcript items={runState.items} pendingPermissions={runState.pendingPermissions} onDecide={(id, d) => void decide(id, d)} deciding={deciding} />
            </section>
            <RunSidebar state={runState} run={currentRun} elapsedMs={elapsedMs} />
          </div>
          <Composer
            disabled={!selectedProject}
            busy={starting || active}
            resumeTarget={resumeTarget}
            onCancelResume={() => setResumeTarget(null)}
            onSubmit={(prompt, options) => void startRun(prompt, options)}
          />
        </>
      )}

      {view === "sessions" && (
        <SessionsView
          runs={runs}
          sessions={sessions}
          busySessionId={busySessionId}
          onOpenRun={(run) => void openRun(run)}
          onRefresh={() => void loadSessions()}
          onResume={beginResume}
          onRename={renameSession}
          onTag={tagSession}
        />
      )}

      {view === "approvals" && (
        <div className="flex flex-col gap-4 p-6">
          <div className="eyebrow text-brand">{selectedProject?.name ?? ""}</div>
          <h1 className="m-0 font-display text-xl font-bold tracking-tight">Aprovações</h1>
          {runState.pendingPermissions.length === 0 ? (
            <p className="text-slate">Nenhuma aprovação pendente. Pedidos de permissão do run atual aparecem aqui e no transcript.</p>
          ) : (
            <Transcript items={[]} pendingPermissions={runState.pendingPermissions} onDecide={(id, d) => void decide(id, d)} deciding={deciding} />
          )}
        </div>
      )}

      {toast && (
        <div role="status" className="fixed right-6 bottom-6 flex items-center gap-3 rounded-xl bg-ink px-4 py-3 text-[13px] text-paper shadow-md">
          <span>{toast}</span>
          <button type="button" onClick={() => setToast(null)} className="text-paper/70 hover:text-paper">
            Fechar
          </button>
        </div>
      )}

      <AddProjectDialog open={addOpen} onClose={() => setAddOpen(false)} onCreate={createProject} />
    </Shell>
  );
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
