import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { memberState } from "./lib/memberState";
import type { EffortLevel, PermissionMode } from "@octopus/protocol";
import { AddProjectDialog } from "./components/AddProjectDialog";
import { ApprovalsView } from "./components/ApprovalsView";
import { BoardView } from "./components/BoardView";
import { HarnessView } from "./components/HarnessView";
import { MemoryView } from "./components/MemoryView";
import { SecurityView, type SecurityTab } from "./components/SecurityView";
import { TaskDialog } from "./components/TaskDialog";
import { MemberDialog } from "./components/MemberDialog";
import { MemberSheet } from "./components/MemberSheet";
import { TeamView, type MemberStatus } from "./components/TeamView";
import { OnboardingView, type OnboardingResult } from "./components/OnboardingView";
import { SettingsView } from "./components/SettingsView";
import { Composer } from "./components/Composer";
import { RunHeader } from "./components/RunHeader";
import { BudgetStopBanner } from "./components/BudgetStopBanner";
import { RunSidebar } from "./components/RunSidebar";
import { SessionsView } from "./components/SessionsView";
import { Shell, type View } from "./components/Shell";
import { shortcutFor } from "./lib/shortcuts";
import { Transcript } from "./components/Transcript";
import { applyTheme, isThemePreference, readThemePreference, saveThemePreference, type ThemePreference } from "./lib/theme";
import type { Transport } from "./lib/transport";
import type { ActivityItem, AgentTotals, Approval, AppSettings, AuditEvent, AuditVerification, BackupSnapshot, BudgetStatus, EnvironmentCheck, FilePreview, HelloResult, McpServer, PermissionDecision, PolicyRule, Project, ProjectDefaults, ProjectTotals, ResumeTarget, Role, Run, RunEventNotification, SandboxProfile, SessionSummary, Skill, Task, TaskEvent, TaskInput, TeamMember, TeamMemberInput, Workflow, WorkflowTemplate } from "./lib/types";
import { projectDefaultsKey } from "./lib/types";
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
  const [team, setTeam] = useState<TeamMember[] | null>(null);
  const [roles, setRoles] = useState<Role[]>([]);
  const [teamTotals, setTeamTotals] = useState<AgentTotals[]>([]);
  const [openMemberId, setOpenMemberId] = useState<string | null>(null);
  /** Feed de atividade do membro aberto na ficha (null = carregando). */
  const [memberActivity, setMemberActivity] = useState<ActivityItem[] | null>(null);
  const [memberDialog, setMemberDialog] = useState<{ open: boolean; member: TeamMember | null }>({ open: false, member: null });
  const [runAs, setRunAs] = useState<TeamMember | null>(null);
  const [workflows, setWorkflows] = useState<Workflow[] | null>(null);
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [taskEvents, setTaskEvents] = useState<TaskEvent[]>([]);
  const [taskDialogOpen, setTaskDialogOpen] = useState(false);
  const [securityTab, setSecurityTab] = useState<SecurityTab>("policy");
  const [rules, setRules] = useState<PolicyRule[] | null>(null);
  const [policyEvents, setPolicyEvents] = useState<AuditEvent[]>([]);
  const [sandboxProfiles, setSandboxProfiles] = useState<SandboxProfile[]>([]);
  const [budget, setBudget] = useState<BudgetStatus | null>(null);
  const [hasApiKey, setHasApiKey] = useState<boolean | null>(null);
  const [harnessLists, setHarnessLists] = useState<{ mcpServers: McpServer[]; skills: Skill[] }>({ mcpServers: [], skills: [] });
  const [audit, setAudit] = useState<AuditEvent[] | null>(null);
  const [auditVerification, setAuditVerification] = useState<AuditVerification | null>(null);
  const [busySessionId, setBusySessionId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // Mantém a referência ao run atual para o listener de eventos.
  const currentRunIdRef = useRef<string | null>(null);
  currentRunIdRef.current = currentRun?.id ?? null;

  const refreshRuns = useCallback(
    async (projectId: string) => {
      const [list, projectTotals, agentTotals] = await Promise.all([
        transport.invoke("list_runs", { projectId, limit: 20 }),
        transport.invoke("get_project_totals", { projectId }),
        transport.invoke("team_totals", { projectId }),
      ]);
      setRuns(list);
      setTotals(projectTotals);
      setTeamTotals(agentTotals);
      transport
        .invoke("get_budget_status", { projectId })
        .then(setBudget)
        .catch(() => {});
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

  const refreshTeam = useCallback(
    async (projectId: string) => {
      try {
        const [members, roleList] = await Promise.all([transport.invoke("list_team", { projectId }), transport.invoke("list_roles", { projectId })]);
        setTeam(members);
        setRoles(roleList);
        setRunAs((current) => (current ? (members.find((m) => m.profile.id === current.profile.id) ?? null) : null));
      } catch (e) {
        setToast(`Falha ao carregar o time: ${messageOf(e)}`);
      }
    },
    [transport],
  );

  const refreshBoard = useCallback(
    async (projectId: string) => {
      try {
        const [wfs, taskList] = await Promise.all([transport.invoke("list_workflows", { projectId }), transport.invoke("list_tasks", { projectId })]);
        setWorkflows(wfs);
        setTasks(taskList);
        setSelectedWorkflowId((current) => (current && wfs.some((w) => w.id === current) ? current : (wfs[0]?.id ?? null)));
      } catch (e) {
        setToast(`Falha ao carregar o board: ${messageOf(e)}`);
      }
    },
    [transport],
  );

  useEffect(() => {
    transport
      .invoke("list_workflow_templates", {})
      .then(setTemplates)
      .catch(() => {});
    transport
      .invoke("list_sandbox_profiles", {})
      .then(setSandboxProfiles)
      .catch(() => {});
  }, [transport]);

  const refreshAuth = useCallback(() => {
    const projectId = selectedProjectRef.current?.id;
    if (!projectId) return;
    transport
      .invoke("has_project_api_key", { projectId })
      .then(setHasApiKey)
      .catch(() => setHasApiKey(null));
  }, [transport]);

  // Listas do Harness para a ficha do membro (MCP servers e skills do projeto).
  useEffect(() => {
    const projectId = selectedProject?.id;
    if (!memberDialog.open || !projectId) return;
    Promise.all([transport.invoke("list_mcp_servers", { projectId }), transport.invoke("list_skills", { projectId })])
      .then(([mcpServers, skills]) => setHarnessLists({ mcpServers, skills }))
      .catch(() => setHarnessLists({ mcpServers: [], skills: [] }));
  }, [transport, memberDialog.open, selectedProject?.id]);

  const refreshBudget = useCallback(() => {
    const projectId = selectedProjectRef.current?.id;
    if (!projectId) return;
    transport
      .invoke("get_budget_status", { projectId })
      .then(setBudget)
      .catch(() => {});
  }, [transport]);

  // Menu bar: abrir uma tela ou um run ativo.
  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    let disposed = false;
    const keep = (fn: () => void) => (disposed ? fn() : unlisteners.push(fn));
    transport
      .listen("app:navigate", (target) => {
        if (["run", "sessions", "approvals", "agents", "board", "memory", "harness", "security", "settings"].includes(target)) setView(target as View);
      })
      .then(keep)
      .catch(() => {});
    transport
      .listen("app:open-run", (runId) => {
        void transport.invoke("get_run", { runId }).then((run) => {
          if (run) void openRunRef.current?.(run);
        });
      })
      .then(keep)
      .catch(() => {});
    return () => {
      disposed = true;
      unlisteners.forEach((fn) => fn());
    };
  }, [transport]);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let disposed = false;
    transport
      .listen("board:changed", () => {
        const projectId = selectedProjectRef.current?.id;
        if (projectId) {
          void refreshBoard(projectId);
          void refreshRuns(projectId);
        }
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [transport, refreshBoard, refreshRuns]);

  useEffect(() => {
    if (!selectedTaskId) {
      setTaskEvents([]);
      return;
    }
    transport
      .invoke("list_task_events", { taskId: selectedTaskId })
      .then(setTaskEvents)
      .catch(() => setTaskEvents([]));
  }, [transport, selectedTaskId, tasks]);

  useEffect(() => {
    if (!selectedProject) return;
    void refreshRuns(selectedProject.id);
    void refreshApprovals(selectedProject.id);
    void refreshTeam(selectedProject.id);
    void refreshBoard(selectedProject.id);
    setSessions(null);
    setTeam(null);
    setOpenMemberId(null);
    setSelectedTaskId(null);
  }, [selectedProject, refreshRuns, refreshApprovals, refreshTeam, refreshBoard]);

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
            void refreshBoard(projectId);
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
  }, [transport, refreshRuns, refreshApprovals, refreshBoard]);

  const selectedProjectRef = useRef<Project | null>(null);
  selectedProjectRef.current = selectedProject;

  useEffect(() => {
    transport.listen("runtime:exited", (code) => setToast(`O runtime do agente encerrou (código ${code ?? "desconhecido"}). Reinicie o app.`)).catch(() => {});
  }, [transport]);

  // Custo estimado ao vivo do run aberto e runs parados por orçamento.
  const [liveCost, setLiveCost] = useState<{ runId: string; usd: number } | null>(null);
  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    let disposed = false;
    const keep = (fn: () => void) => (disposed ? fn() : unlisteners.push(fn));
    transport
      .listen("run:cost", ({ runId, estCostUsd }) => {
        if (runId === currentRunIdRef.current) setLiveCost({ runId, usd: estCostUsd });
      })
      .then(keep)
      .catch(() => {});
    transport
      .listen("budget:stopped", ({ reason }) => {
        setToast(reason);
        const projectId = selectedProjectRef.current?.id;
        if (projectId) {
          void refreshRuns(projectId);
          void refreshBoard(projectId);
          void refreshApprovals(projectId);
        }
      })
      .then(keep)
      .catch(() => {});
    return () => {
      disposed = true;
      for (const fn of unlisteners) fn();
    };
  }, [transport, refreshRuns, refreshBoard, refreshApprovals]);

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

  const startRun = async (prompt: string, options: { permissionMode: PermissionMode; maxTurns: number; effort?: EffortLevel | null }) => {
    if (!selectedProject) return;
    setStarting(true);
    setToast(null);
    try {
      const run = await transport.invoke("start_run", {
        input: {
          projectId: selectedProject.id,
          prompt,
          agentProfileId: runAs?.profile.id ?? null,
          options: {
            permissionMode: options.permissionMode,
            maxTurns: options.maxTurns,
            ...(options.effort ? { effort: options.effort } : {}),
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

  const openRunRef = useRef<((run: Run) => Promise<void>) | null>(null);
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
    // Board e Time recarregam ao entrar: o scheduler e outras janelas podem ter mudado o estado.
    if ((view === "board" || view === "agents") && selectedProject) {
      void refreshBoard(selectedProject.id);
      void refreshTeam(selectedProject.id);
      transport
        .invoke("get_settings", {})
        .then(setSettings)
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, selectedProject]);

  openRunRef.current = openRun;

  // Atalhos de teclado (⌘1…⌘9, ⌘., ⌘N).
  const shortcutState = useRef({ active: false, interrupt: async () => {} });
  shortcutState.current = { active, interrupt };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = shortcutFor(e);
      if (!action) return;
      e.preventDefault();
      if (action.kind === "view") setView(action.view);
      else if (action.kind === "interrupt") {
        if (shortcutState.current.active) void shortcutState.current.interrupt();
      } else {
        setView("run");
        setTimeout(() => document.getElementById("prompt")?.focus(), 0);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /** Retoma a sessão com `/compact`: o Claude Code compacta o contexto e devolve o resumo (experimental). */
  const compactSession = async (sessionId: string) => {
    if (!selectedProject) return;
    setStarting(true);
    setToast(null);
    try {
      const run = await transport.invoke("start_run", {
        input: { projectId: selectedProject.id, prompt: "/compact", options: { permissionMode: "default", maxTurns: 1, includePartialMessages: true, resumeSessionId: sessionId } },
      });
      currentRunIdRef.current = run.id;
      setCurrentRun(run);
      setRunState(withUserPrompt(initialRunViewState(run.id), "/compact", run.startedAt));
      setView("run");
      await refreshRuns(selectedProject.id);
    } catch (e) {
      setToast(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  };

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

  const memberStatus = (agentProfileId: string): MemberStatus => {
    const member = team?.find((m) => m.profile.id === agentProfileId);
    if (!member) return "idle";
    return memberState(member, teamTotals.find((t) => t.agentProfileId === agentProfileId) ?? null, runs);
  };
  const pauseMember = async (member: TeamMember, paused: boolean) => {
    try {
      await transport.invoke("set_member_paused", { agentProfileId: member.profile.id, paused });
      setToast(paused ? `${member.profile.name} pausado: não recebe tasks novas até retomar.` : `${member.profile.name} retomado.`);
      if (selectedProject) {
        await refreshTeam(selectedProject.id);
        await refreshBoard(selectedProject.id);
        await refreshRuns(selectedProject.id);
      }
    } catch (e) {
      setToast(`Falha ao ${paused ? "pausar" : "retomar"}: ${messageOf(e)}`);
    }
  };
  const runMemberNow = async (member: TeamMember) => {
    try {
      const report = await transport.invoke("run_member_now", { agentProfileId: member.profile.id });
      if (report.started.length === 0) setToast(report.failed[0] ? `Não deu para iniciar: ${report.failed[0][1]}` : `Nenhuma task pronta para ${member.profile.name}.`);
      if (selectedProject) {
        await refreshBoard(selectedProject.id);
        await refreshRuns(selectedProject.id);
      }
    } catch (e) {
      setToast(`Falha ao rodar agora: ${messageOf(e)}`);
    }
  };

  const saveMember = async (input: TeamMemberInput) => {
    if (!selectedProject) return;
    if (memberDialog.member) await transport.invoke("update_team_member", { agentProfileId: memberDialog.member.profile.id, input });
    else await transport.invoke("add_team_member", { projectId: selectedProject.id, input });
    await refreshTeam(selectedProject.id);
  };

  const removeMember = async () => {
    if (!selectedProject || !memberDialog.member) return;
    await transport.invoke("remove_team_member", { agentProfileId: memberDialog.member.profile.id });
    setOpenMemberId(null);
    await refreshTeam(selectedProject.id);
  };

  const runAsMember = (member: TeamMember) => {
    setRunAs(member);
    setView("run");
  };

  const openMember = team?.find((m) => m.profile.id === openMemberId) ?? null;
  const refreshMemberActivity = useCallback(
    (projectId: string, agentProfileId: string) => {
      transport
        .invoke("list_project_activity", { projectId, agentProfileId, limit: 50 })
        .then(setMemberActivity)
        .catch(() => setMemberActivity([]));
    },
    [transport],
  );
  useEffect(() => {
    if (!openMemberId || !selectedProject) {
      setMemberActivity(null);
      return;
    }
    // Recarrega quando o board/os runs mudam (board:changed, fim de run).
    refreshMemberActivity(selectedProject.id, openMemberId);
  }, [openMemberId, selectedProject, refreshMemberActivity, tasks, runs]);
  /** Abre uma task no Board (seleciona o workflow dela). */
  const openTask = (taskId: string) => {
    const task = tasks.find((t) => t.id === taskId);
    if (task) setSelectedWorkflowId(task.workflowId);
    setSelectedTaskId(taskId);
    setView("board");
  };
  const openRunById = async (runId: string) => {
    const run = runs.find((r) => r.id === runId) ?? (await transport.invoke("get_run", { runId }).catch(() => null));
    if (run) await openRun(run);
  };
  const monthlyTeamCost = teamTotals.reduce((sum, t) => sum + t.costUsd, 0);

  // Defaults do projeto (esforço) podem ter mudado no Harness: relê as preferências ao voltar ao run.
  useEffect(() => {
    if (view !== "run") return;
    transport
      .invoke("get_settings", {})
      .then(setSettings)
      .catch(() => {});
  }, [view, transport]);

  const schedulerPaused = settings?.["scheduler.paused"] === true;
  const selectedWorkflow = workflows?.find((w) => w.id === selectedWorkflowId) ?? workflows?.[0] ?? null;
  const selectedTask = tasks.find((t) => t.id === selectedTaskId) ?? null;
  // Só o que espera você: revisões por agentes não contam.
  const pendingGates = tasks.filter((t) => t.status === "waiting_approval").length;

  const tick = async () => {
    try {
      await transport.invoke("scheduler_tick", {});
      if (selectedProject) {
        await refreshBoard(selectedProject.id);
        await refreshRuns(selectedProject.id);
      }
    } catch (e) {
      setToast(`Falha ao rodar o scheduler: ${messageOf(e)}`);
    }
  };

  const createTask = async (input: TaskInput) => {
    if (!selectedProject || !selectedWorkflow) return;
    const task = await transport.invoke("create_task", { projectId: selectedProject.id, workflowId: selectedWorkflow.id, input });
    await refreshBoard(selectedProject.id);
    setSelectedTaskId(task.id);
    void tick();
  };

  const afterTaskChange = async () => {
    if (!selectedProject) return;
    await refreshBoard(selectedProject.id);
    void tick();
  };

  const refreshAudit = useCallback(
    (kindPrefix: string | null) => {
      transport
        .invoke("list_audit_events", { projectId: selectedProjectRef.current?.id ?? null, kindPrefix, limit: 200 })
        .then(setAudit)
        .catch((e) => setToast(`Falha ao carregar a auditoria: ${messageOf(e)}`));
    },
    [transport],
  );

  const refreshPolicy = useCallback(() => {
    const projectId = selectedProjectRef.current?.id ?? null;
    transport
      .invoke("list_policy_rules", { projectId })
      .then(setRules)
      .catch((e) => setToast(`Falha ao carregar as regras: ${messageOf(e)}`));
    transport
      .invoke("list_audit_events", { projectId, kindPrefix: "policy.", limit: 20 })
      .then(setPolicyEvents)
      .catch(() => {});
  }, [transport]);

  const verifyAudit = useCallback(async () => {
    try {
      setAuditVerification(await transport.invoke("verify_audit", {}));
    } catch (e) {
      setToast(`Falha ao verificar a auditoria: ${messageOf(e)}`);
    }
  }, [transport]);

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
        setRunAs(null);
      }}
      onAddProject={() => setAddOpen(true)}
      view={view}
      onChangeView={setView}
      activeRuns={activeRuns}
      pendingApprovals={pendingApprovals}
      pendingGates={pendingGates}
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
            sandboxName={sandboxProfiles.find((p) => p.id === (selectedProject?.sandboxProfileId ?? "sandbox_dev"))?.name ?? null}
            budget={budget}
            liveCostUsd={liveCost && liveCost.runId === currentRun?.id ? liveCost.usd : null}
            onContinue={() => {
              const sessionId = runState.sessionId ?? currentRun?.claudeSessionId;
              if (sessionId) beginResume({ sessionId, title: currentRun?.prompt ?? null }, false);
            }}
          />
          <div className="flex min-h-0 flex-1">
            <section aria-label="Transcript do run" className="flex min-w-0 flex-1 flex-col overflow-y-auto">
              {currentRun?.stopCause === "budget" && (
                <BudgetStopBanner
                  run={currentRun}
                  onRaiseLimit={() => {
                    setSecurityTab("budgets");
                    setView("security");
                  }}
                />
              )}
              <Transcript runId={currentRun?.id ?? null} items={runState.items} pendingPermissions={runState.pendingPermissions} onDecide={(runId, id, d, note) => void decide(runId, id, d, note)} deciding={deciding} readFile={readProjectFile} result={runState.result} />
            </section>
            <RunSidebar
              state={runState}
              run={currentRun}
              elapsedMs={elapsedMs}
              onCompact={
                !active && (runState.sessionId ?? currentRun?.claudeSessionId)
                  ? () => {
                      const sessionId = runState.sessionId ?? currentRun?.claudeSessionId;
                      if (sessionId) void compactSession(sessionId);
                    }
                  : null
              }
            />
          </div>
          <Composer
            disabled={!selectedProject}
            busy={starting || active}
            resumeTarget={resumeTarget}
            onCancelResume={() => setResumeTarget(null)}
            team={team ?? []}
            runAs={runAs}
            onRunAsChange={setRunAs}
            onSubmit={(prompt, options) => void startRun(prompt, options)}
            defaultEffort={runAs?.profile.effort ?? (selectedProject ? ((settings?.[projectDefaultsKey(selectedProject.id)] as ProjectDefaults | undefined)?.effort ?? null) : null)}
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

      {view === "agents" && openMember && (
        <MemberSheet
          member={openMember}
          team={team ?? []}
          status={memberStatus(openMember.profile.id)}
          totals={teamTotals.find((t) => t.agentProfileId === openMember.profile.id) ?? null}
          tasks={tasks}
          runs={runs}
          activity={memberActivity}
          workflows={workflows ?? []}
          onOpenTask={openTask}
          onOpenRunById={(id) => void openRunById(id)}
          onPause={(paused) => pauseMember(openMember, paused)}
          onRunNow={tasks.some((t) => t.status === "ready" && t.assignedAgentId === openMember.profile.id) ? () => runMemberNow(openMember) : undefined}
          onBack={() => setOpenMemberId(null)}
          onEdit={() => setMemberDialog({ open: true, member: openMember })}
          onRunAs={() => runAsMember(openMember)}
          onOpenRun={(run) => void openRun(run)}
        />
      )}
      {view === "agents" && !openMember && (
        <TeamView
          project={selectedProject}
          members={team}
          roles={roles}
          totals={teamTotals}
          tasks={tasks}
          statusOf={memberStatus}
          monthlyCost={monthlyTeamCost}
          onAddMember={() => setMemberDialog({ open: true, member: null })}
          onOpenMember={(member) => setOpenMemberId(member.profile.id)}
          onRunAs={runAsMember}
          onPause={pauseMember}
          onRunNow={runMemberNow}
        />
      )}

      {view === "board" && (
        <BoardView
          project={selectedProject}
          workflows={workflows}
          templates={templates}
          tasks={tasks}
          team={team ?? []}
          runs={runs}
          selectedWorkflowId={selectedWorkflow?.id ?? null}
          onSelectWorkflow={setSelectedWorkflowId}
          onCreateFromTemplate={async (templateId, useWorktrees) => {
            if (!selectedProject) return;
            try {
              const wf = await transport.invoke("create_workflow_from_template", { input: { projectId: selectedProject.id, templateId, useWorktrees } });
              await refreshBoard(selectedProject.id);
              setSelectedWorkflowId(wf.id);
            } catch (e) {
              setToast(`Falha ao criar o workflow: ${messageOf(e)}`);
            }
          }}
          onNewTask={() => setTaskDialogOpen(true)}
          onOpenTask={(task) => setSelectedTaskId(task.id)}
          onLoadDiff={(task) => transport.invoke("task_diff", { taskId: task.id })}
          onSetGateApprover={async (workflow, stage, approver) => {
            try {
              await transport.invoke("update_workflow", { workflowId: workflow.id, input: { name: workflow.name, stages: workflow.stages.map((s) => (s.id === stage.id ? { ...s, approver } : s)), useWorktrees: workflow.useWorktrees, maxParallel: workflow.maxParallel } });
              await afterTaskChange();
            } catch (e) {
              setToast(`Falha ao mudar o gate: ${messageOf(e)}`);
            }
          }}
          schedulerPaused={schedulerPaused}
          onTogglePaused={() => void setSetting("scheduler.paused", schedulerPaused ? null : true).catch((e) => setToast(messageOf(e)))}
          onTick={() => void tick()}
          selectedTask={selectedTask}
          taskEvents={taskEvents}
          onApprove={async (task, note) => {
            await transport.invoke("approve_task", { taskId: task.id, note });
            await afterTaskChange();
          }}
          onReturn={async (task, stageId, note) => {
            await transport.invoke("return_task", { taskId: task.id, stageId, note });
            await afterTaskChange();
          }}
          onMove={async (task, stageId, status, note) => {
            await transport.invoke("move_task", { input: { taskId: task.id, stageId, status, note } });
            await afterTaskChange();
          }}
          onOpenRun={(run) => void openRun(run)}
          onCloseTask={() => setSelectedTaskId(null)}
        />
      )}

      {view === "memory" && <MemoryView project={selectedProject} transport={transport} />}
      {view === "harness" && <HarnessView project={selectedProject} transport={transport} />}
      {view === "security" && (
        <SecurityView
          project={selectedProject}
          tab={securityTab}
          onChangeTab={setSecurityTab}
          audit={audit}
          verification={auditVerification}
          onRefreshAudit={refreshAudit}
          onVerify={verifyAudit}
          onExport={(destination) => transport.invoke("export_audit", { destination })}
          rules={rules}
          policyEvents={policyEvents}
          onRefreshPolicy={refreshPolicy}
          onToggleRule={async (rule, enabled) => {
            await transport.invoke("set_policy_rule_enabled", { ruleId: rule.id, enabled });
            refreshPolicy();
          }}
          onCreateRule={async (scope, input) => {
            await transport.invoke("create_policy_rule", { input: { projectId: scope === "project" ? (selectedProject?.id ?? null) : null, input } });
            refreshPolicy();
          }}
          onDeleteRule={async (rule) => {
            await transport.invoke("delete_policy_rule", { ruleId: rule.id });
            refreshPolicy();
          }}
          onSimulate={async (toolName, input) => {
            if (!selectedProject) throw new Error("Sem projeto selecionado");
            const decision = await transport.invoke("evaluate_policy", { projectId: selectedProject.id, toolName, input });
            refreshPolicy();
            return decision;
          }}
          sandboxProfiles={sandboxProfiles}
          onSelectSandbox={async (profileId) => {
            if (!selectedProject) return;
            const updated = await transport.invoke("set_project_sandbox", { projectId: selectedProject.id, profileId });
            setProjects((list) => list.map((p) => (p.id === updated.id ? updated : p)));
            setSelectedProject(updated);
          }}
          budget={budget}
          onRefreshBudget={refreshBudget}
          onSaveBudget={async (line, input) => {
            await transport.invoke("set_budget_policy", { input: { scope: line.scope, scopeId: line.scopeId, input } });
            refreshBudget();
          }}
          hasApiKey={hasApiKey}
          onRefreshAuth={refreshAuth}
          onChangeAuthMode={async (authMode) => {
            if (!selectedProject) return;
            const updated = await transport.invoke("update_project_auth", { projectId: selectedProject.id, authMode });
            setProjects((list) => list.map((p) => (p.id === updated.id ? updated : p)));
            setSelectedProject(updated);
            refreshAuth();
          }}
          onSaveApiKey={async (apiKey) => {
            if (!selectedProject) return;
            await transport.invoke("set_project_api_key", { projectId: selectedProject.id, apiKey });
            refreshAuth();
          }}
          onClearApiKey={async () => {
            if (!selectedProject) return;
            await transport.invoke("clear_project_api_key", { projectId: selectedProject.id });
            refreshAuth();
          }}
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
          onCheckUpdate={() => transport.invoke("check_update", {})}
          onInstallUpdate={async () => {
            await transport.invoke("install_update", {});
          }}
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
      <TaskDialog open={taskDialogOpen} workflow={selectedWorkflow} tasks={tasks.filter((t) => t.workflowId === selectedWorkflow?.id)} team={team ?? []} onClose={() => setTaskDialogOpen(false)} onCreate={createTask} />
      <MemberDialog
        open={memberDialog.open}
        roles={roles}
        team={team ?? []}
        mcpServers={harnessLists.mcpServers}
        skills={harnessLists.skills}
        member={memberDialog.member}
        onClose={() => setMemberDialog((d) => ({ ...d, open: false }))}
        onSave={saveMember}
        onRemove={memberDialog.member ? removeMember : undefined}
      />
    </Shell>
  );
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
