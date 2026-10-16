import { BookOpen, CheckCircle2, ChevronDown, History, KanbanSquare, Lock, Play, Settings, Users } from "lucide-react";
import type { ReactNode } from "react";
import type { Project, Run } from "../lib/types";
import { THEME_LABELS, type ThemePreference } from "../lib/theme";

export type View = "run" | "sessions" | "approvals" | "agents" | "board" | "memory" | "security" | "settings";

type NavItem = { id: View; label: string; icon: ReactNode; badge?: number; live?: boolean; disabled?: boolean };

type ShellProps = {
  projects: Project[];
  selectedProject: Project | null;
  onSelectProject: (project: Project) => void;
  onAddProject: () => void;
  view: View;
  onChangeView: (view: View) => void;
  activeRuns: Run[];
  pendingApprovals: number;
  /** Tasks aguardando sua aprovação no board. */
  pendingGates?: number;
  theme: ThemePreference;
  onThemeChange: (theme: ThemePreference) => void;
  children: ReactNode;
};

const THEME_ORDER: ThemePreference[] = ["system", "light", "dark"];

export function Shell({ projects, selectedProject, onSelectProject, onAddProject, view, onChangeView, activeRuns, pendingApprovals, pendingGates = 0, theme, onThemeChange, children }: ShellProps) {
  const nav: NavItem[] = [
    { id: "run", label: "Run ao vivo", icon: <Play size={16} aria-hidden />, live: activeRuns.length > 0 },
    { id: "sessions", label: "Sessões", icon: <History size={16} aria-hidden /> },
    { id: "approvals", label: "Aprovações", icon: <CheckCircle2 size={16} aria-hidden />, badge: pendingApprovals },
    { id: "agents", label: "Time", icon: <Users size={16} aria-hidden /> },
    { id: "board", label: "Board", icon: <KanbanSquare size={16} aria-hidden />, badge: pendingGates },
    { id: "memory", label: "Memória", icon: <BookOpen size={16} aria-hidden />, disabled: true },
    { id: "security", label: "Segurança", icon: <Lock size={16} aria-hidden /> },
  ];

  return (
    <div className="flex h-full min-h-0 bg-paper">
      <nav aria-label="Navegação principal" className="flex w-60 shrink-0 flex-col gap-6 bg-sidebar p-4 text-sidebar-ink">
        <div className="flex items-center gap-2.5 px-2 py-1">
          <div className="flex size-7 items-center justify-center rounded-lg bg-brand">
            <OctopusMark />
          </div>
          <div className="font-display text-base font-bold tracking-tight">Octopus AI</div>
        </div>

        <div className="flex flex-col gap-1.5">
          <div className="eyebrow px-2 text-brand">Projeto</div>
          <label className="sr-only" htmlFor="project-select">
            Projeto selecionado
          </label>
          <div className="relative">
            <select
              id="project-select"
              value={selectedProject?.id ?? ""}
              onChange={(e) => {
                if (e.target.value === "__add__") {
                  onAddProject();
                  return;
                }
                const project = projects.find((p) => p.id === e.target.value);
                if (project) onSelectProject(project);
              }}
              className="w-full appearance-none rounded-md border hairline-dark bg-sidebar-line/50 px-3 py-2.5 pr-8 text-sm font-medium text-sidebar-ink"
            >
              {projects.length === 0 && <option value="">Nenhum projeto</option>}
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
              <option value="__add__">+ Adicionar projeto…</option>
            </select>
            <ChevronDown size={14} aria-hidden className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-sidebar-ink/70" />
          </div>
        </div>

        <ul className="flex flex-col gap-0.5">
          {nav.map((item) => {
            const current = item.id === view;
            return (
              <li key={item.id}>
                <button
                  type="button"
                  aria-current={current ? "page" : undefined}
                  disabled={item.disabled}
                  onClick={() => onChangeView(item.id)}
                  title={item.disabled ? "Disponível nas próximas fases" : undefined}
                  className={[
                    "flex w-full items-center gap-2.5 rounded-md px-3 py-2.5 text-left text-sm",
                    current ? "bg-brand/16 font-medium text-sidebar-ink" : "text-sidebar-ink/72 hover:bg-sidebar-ink/6 hover:text-sidebar-ink",
                    item.disabled ? "cursor-not-allowed opacity-40 hover:bg-transparent hover:text-sidebar-ink/72" : "",
                  ].join(" ")}
                >
                  {item.icon}
                  <span>{item.label}</span>
                  {item.live && <span aria-label="Run em andamento" className="ml-auto size-2 rounded-full bg-brand" />}
                  {item.badge ? (
                    <span className="ml-auto rounded-full bg-brand px-1.5 text-[11px] font-semibold text-white">{item.badge}</span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>

        <div className="mt-auto flex flex-col gap-3">
          <button
            type="button"
            aria-current={view === "settings" ? "page" : undefined}
            onClick={() => onChangeView("settings")}
            className={[
              "flex w-full items-center gap-2.5 rounded-md px-3 py-2.5 text-left text-sm",
              view === "settings" ? "bg-brand/16 font-medium text-sidebar-ink" : "text-sidebar-ink/72 hover:bg-sidebar-ink/6 hover:text-sidebar-ink",
            ].join(" ")}
          >
            <Settings size={16} aria-hidden />
            <span>Configurações</span>
          </button>
          <div className="flex flex-col gap-2.5 rounded-xl border hairline-dark p-3">
            <div className="eyebrow text-sidebar-ink/72">Runs ativos</div>
            {activeRuns.length === 0 && <div className="text-[13px] text-sidebar-ink/50">Nenhum run em andamento</div>}
            {activeRuns.slice(0, 3).map((run) => (
              <div key={run.id} className="flex items-center gap-2 text-[13px]">
                <span className={["size-2 rounded-full", run.status === "waiting_approval" ? "bg-warning" : "bg-brand"].join(" ")} />
                <span className="flex-1 truncate">{run.prompt}</span>
                <span className="font-mono text-xs text-sidebar-ink/72">{run.status === "waiting_approval" ? "aguardando" : "ativo"}</span>
              </div>
            ))}
          </div>

          <div role="radiogroup" aria-label="Tema" className="flex rounded-md border hairline-dark p-0.5 text-xs">
            {THEME_ORDER.map((option) => {
              const selected = option === theme;
              return (
                <button
                  key={option}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => onThemeChange(option)}
                  className={["flex-1 rounded-sm px-2 py-1.5 font-medium", selected ? "bg-sidebar-ink/12 text-sidebar-ink" : "text-sidebar-ink/60 hover:text-sidebar-ink"].join(" ")}
                >
                  {THEME_LABELS[option]}
                </button>
              );
            })}
          </div>
        </div>
      </nav>

      <main className="flex min-w-0 flex-1 flex-col">{children}</main>
    </div>
  );
}

function OctopusMark() {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="9" r="5" />
      <path d="M7 13c-1 3-3 5-4 6" />
      <path d="M17 13c1 3 3 5 4 6" />
      <path d="M10 14c-.5 3-1 5-1 6" />
      <path d="M14 14c.5 3 1 5 1 6" />
    </svg>
  );
}
