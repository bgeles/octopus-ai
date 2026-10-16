import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PermissionMode } from "@octopus/protocol";
import { AddProjectDialog } from "./components/AddProjectDialog";
import { ApprovalsView } from "./components/ApprovalsView";
import { OnboardingView, type OnboardingResult } from "./components/OnboardingView";
import { SettingsView } from "./components/SettingsView";
import { Composer } from "./components/Composer";
import { RunHeader } from "./components/RunHeader";
import { RunSidebar } from "./components/RunSidebar";
import { SessionsView } from "./components/SessionsView";
import { Shell, type View } from "./components/Shell";
import { Transcript } from "./components/Transcript";
import { applyTheme, isThemePreference, readThemePreference, saveThemePreference, type ThemePreference } from "./lib/theme";
import type { Transport } from "./lib/transport";
import type { AppSettings, Approval, BackupSnapshot, EnvironmentCheck, FilePreview, HelloResult, PermissionDecision, Project, ProjectTotals, ResumeTarget, Run, RunEventNotification, SessionSummary } from "./lib/types";
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
  const [approvals, setApprovals] = useState<Approval[] | null>(null);
  const [totals, setTotals] = useState<ProjectTotals | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [theme, setThemeState] = useState<ThemePreference>(() => readThemePreference());
  const [environment, setEnvironment] = useState<EnvironmentCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [snapshots, setSnapshots] = useState<BackupSnapshot[] | null>(null);
  const [runtime, setRuntime] = useState<HelloResult | null>(null);
  const [busySessionId, setBusySessionId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // Mantém a referência ao run atual para o listener de eventos.
  const currentRunIdRef = useRef<string | null>(null);
  currentRunIdRef.current = currentRun?.id ?? null;

  const refreshRuns = useCallback(
    async (projectId: string) => {
      const [list, projectTotals] = await Promise.all([transport.invoke("list_runs", { projectId, limit: 20 }), transport.invoke("get_project_totals", { projectId })]);
      setRuns(list);
      setTotals(projectTotals);
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
      .invoke("get_settings", {})
      .then((loaded) => {
        if (cancelled) return;
        setSettings(loaded);
        if (isThemePreference(loaded.theme)) {
          setThemeState(loaded.theme);
          applyTheme(loaded.theme);
          saveThemePreference(loaded.theme);
        }
      })
      .catch((e) => setToast(`Falha ao carregar preferências: ${messageOf(e)}`));
    transport
      .invoke("runtime_info", {})
      .then((info) => {
        if (!cancelled) setRuntime(info);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [transport]);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

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

  const refreshApprovals = useCallback(
    async (projectId: string) => {
      try {
        setApprovals(await transport.invoke("list_approvals", { projectId, limit: 100 }));
      } catch (e) {
        setToast(`Falha ao listar aprovações: ${messageOf(e)}`);
      }
    },
    [transport],
  );

  useEffect(() => {
    if (!selectedProject) return;
    void refreshRuns(selectedProject.id);
    void refreshApprovals(selectedProject.id);
    setSessions(null);
  }, [selectedProject, refreshRuns, refreshApprovals]);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let disposed = false;
    transport
      .listen("run:event", (notification: RunEventNotification) => {
        if (notification.runId !== currentRunIdRef.current) return;
        setRunState((state) => applyRunEvent(state, notification));
        if (notification.event.type === "result" || (notification.event.type === "error" && notification.event.fatal) || notification.event.type === "permission_request") {
          const projectId = selectedProjectRef.current?.id;
          if (projectId) {
            void refreshRuns(projectId);
            void refreshApprovals(projectId);
          }
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
  }, [transport, refreshRuns, refreshApprovals]);

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

  const decide = async (runId: string, requestId: string, decision: PermissionDecision, note: string | null) => {
    setDeciding(requestId);
    try {
      await transport.invoke("decide_permission", { input: { runId, requestId, decision, note } });
      if (runId === currentRunIdRef.current) setRunState((state) => resolvePermission(state, requestId));
      const projectId = selectedProjectRef.current?.id;
      if (projectId) {
        await refreshRuns(projectId);
        await refreshApprovals(projectId);
      }
    } catch (e) {
      setToast(`Falha ao registrar decisão: ${messageOf(e)}`);
    } finally {
      setDeciding(null);
    }
  };

  const readProjectFile = useCallback(
    (path: string): Promise<FilePreview> => {
      const projectId = selectedProjectRef.current?.id;
      if (!projectId) return Promise.reject(new Error("Sem projeto selecionado"));
      return transport.invoke("read_project_file", { projectId, path });
    },
    [transport],
  );

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

  const setSetting = useCallback(
    async (key: string, value: unknown) => {
      await transport.invoke("set_setting", { key, value });
      setSettings((current) => {
        const next = { ...(current ?? {}) };
        if (value === null || value === undefined) delete next[key];
        else next[key] = value;
        return next;
      });
    },
    [transport],
  );

  const changeTheme = (next: ThemePreference) => {
    setThemeState(next);
    saveThemePreference(next);
    void setSetting("theme", next).catch((e) => setToast(`Falha ao salvar o tema: ${messageOf(e)}`));
  };

  const recheckEnvironment = useCallback(() => {
    setChecking(true);
    transport
      .invoke("check_environment", {})
      .then(setEnvironment)
      .catch((e) => setToast(`Falha ao checar o ambiente: ${messageOf(e)}`))
      .finally(() => setChecking(false));
  }, [transport]);

  const refreshSnapshots = useCallback(() => {
    transport
      .invoke("config_backups_list", {})
      .then(setSnapshots)
      .catch((e) => setToast(`Falha ao listar cópias: ${messageOf(e)}`));
  }, [transport]);

  const reloadProjects = useCallback(async () => {
    const list = await transport.invoke("list_projects", {});
    setProjects(list);
    setSelectedProject((current) => (current && list.some((p) => p.id === current.id) ? current : (list[0] ?? null)));
  }, [transport]);

  const afterConfigChange = async () => {
    await reloadProjects();
    setSettings(await transport.invoke("get_settings", {}));
    refreshSnapshots();
  };

  const finishOnboarding = async (result: OnboardingResult) => {
    if (result.project) await createProject(result.project);
    await setSetting("defaultAuthMode", result.defaultAuthMode);
    await setSetting("theme", result.theme);
    await setSetting("onboarding.completedAt", new Date().toISOString());
    setView("run");
  };

  const onboardingPending = settings !== null && settings["onboarding.completedAt"] === undefined;

  const activeRuns = runs.filter((r) => r.status === "running" || r.status === "waiting_approval" || r.status === "queued");
  const pendingApprovals = approvals ? approvals.filter((a) => a.decision === null).length : runState.pendingPermissions.length;

  if (onboardingPending) {
    return (
      <>
        <OnboardingView
          environment={environment}
          checking={checking}
          onRecheck={recheckEnvironment}
          theme={theme}
          onThemeChange={changeTheme}
          onPreviewImport={(path) => transport.invoke("config_import_preview", { path })}
          onImport={async (path, mode) => {
            await transport.invoke("config_import", { input: { path, mode } });
            await afterConfigChange();
          }}
          onFinish={finishOnboarding}
        />
        {toast && (
          <div role="status" className="fixed right-6 bottom-6 flex items-center gap-3 rounded-xl bg-ink px-4 py-3 text-[13px] text-paper shadow-md">
            <span>{toast}</span>
            <button type="button" onClick={() => setToast(null)} className="text-paper/70 hover:text-paper">
              Fechar
            </button>
          </div>
        )}
      </>
    );
  }

  return (
    <Shell
      projects={projects}
      selectedProject={selectedProject}
      onSelectProject={(p) => {
        setSelectedProject(p);
        setCurrentRun(null);
        setRunState(initialRunViewState());
        setResumeTarget(null);
        setTotals(null);
      }}
      onAddProject={() => setAddOpen(true)}
      view={view}
      onChangeView={setView}
      activeRuns={activeRuns}
      pendingApprovals={pendingApprovals}
      theme={theme}
      onThemeChange={changeTheme}
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
            totals={totals}
            onContinue={() => {
              const sessionId = runState.sessionId ?? currentRun?.claudeSessionId;
              if (sessionId) beginResume({ sessionId, title: currentRun?.prompt ?? null }, false);
            }}
          />
          <div className="flex min-h-0 flex-1">
            <section aria-label="Transcript do run" className="flex min-w-0 flex-1 flex-col overflow-y-auto">
              <Transcript runId={currentRun?.id ?? null} items={runState.items} pendingPermissions={runState.pendingPermissions} onDecide={(runId, id, d, note) => void decide(runId, id, d, note)} deciding={deciding} readFile={readProjectFile} />
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
        <ApprovalsView
          project={selectedProject}
          approvals={approvals}
          deciding={deciding}
          onDecide={(runId, id, d, note) => void decide(runId, id, d, note)}
          onRefresh={() => {
            if (selectedProject) void refreshApprovals(selectedProject.id);
          }}
          readFile={readProjectFile}
        />
      )}

      {view === "settings" && settings && (
        <SettingsView
          settings={settings}
          environment={environment}
          checking={checking}
          onRecheck={recheckEnvironment}
          theme={theme}
          onThemeChange={changeTheme}
          onSetSetting={setSetting}
          snapshots={snapshots}
          onRefreshSnapshots={refreshSnapshots}
          onExport={async (destination) => {
            await transport.invoke("config_export", { destination });
            refreshSnapshots();
          }}
          onPreviewFile={(path) => transport.invoke("config_import_preview", { path })}
          onImportFile={async (path, mode) => {
            await transport.invoke("config_import", { input: { path, mode } });
            await afterConfigChange();
          }}
          onPreviewSnapshot={(id) => transport.invoke("config_backup_preview", { id })}
          onRestoreSnapshot={async (id, mode) => {
            await transport.invoke("config_backup_restore", { input: { id, mode } });
            await afterConfigChange();
          }}
          onRevealSnapshot={(id) => transport.invoke("config_backup_reveal", { id }).then(() => undefined)}
          onRedoOnboarding={() => setSetting("onboarding.completedAt", null)}
          runtimeLabel={runtime ? `agent-runtime ${runtime.runtimeVersion} · SDK ${runtime.sdkVersion} · protocolo ${runtime.protocolVersion}` : "…"}
        />
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
