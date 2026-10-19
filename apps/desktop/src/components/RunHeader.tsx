import { History, Lock, Square } from "lucide-react";
import type { BudgetStatus, Project, ProjectTotals, Run } from "../lib/types";
import type { RunViewState } from "../state/runReducer";
import { formatUsd } from "./RunSidebar";

type RunHeaderProps = {
  project: Project | null;
  run: Run | null;
  state: RunViewState;
  active: boolean;
  onInterrupt: () => void;
  interrupting: boolean;
  /** Retomar a sessão deste run (disponível quando o run terminou e tem sessão). */
  onContinue?: () => void;
  /** Custo acumulado do projeto (todos os runs). */
  totals?: ProjectTotals | null;
  /** Nome do perfil de sandbox do projeto. */
  sandboxName?: string | null;
  /** Orçamento do mês (aviso soft/hard). */
  budget?: BudgetStatus | null;
  /** Custo estimado do run ativo (tokens × tabela de preços), antes do custo final do SDK. */
  liveCostUsd?: number | null;
};

export function RunHeader({ project, run, state, active, onInterrupt, interrupting, onContinue, totals = null, sandboxName = null, budget = null, liveCostUsd = null }: RunHeaderProps) {
  const status = statusOf(run, state, active);
  const sessionId = state.sessionId ?? run?.claudeSessionId ?? null;
  const canContinue = Boolean(run && !active && sessionId && onContinue);
  return (
    <header className="flex flex-wrap items-center gap-4 border-b hairline bg-surface px-6 py-3.5">
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="eyebrow text-brand">{project ? project.name : "Sem projeto"}{run ? ` · Run ${run.id.slice(-6)}` : ""}</div>
        <h1 className="m-0 truncate font-display text-xl font-bold tracking-tight text-ink">{run ? run.prompt : "Run ao vivo"}</h1>
      </div>
      <div className="ml-auto flex flex-wrap items-center gap-2.5">
        <span data-testid="run-status" className={["inline-flex items-center gap-1.5 rounded-full px-2.5 py-1.5 text-xs font-semibold", status.className].join(" ")}>
          {status.dot && <span className={["size-1.5 rounded-full", status.dot].join(" ")} />}
          {status.label}
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-full border hairline-strong px-2.5 py-1.5 text-xs font-medium text-ink" data-testid="sandbox-chip">
          <Lock size={13} aria-hidden /> Sandbox {sandboxName ?? "Dev padrão"}
        </span>
        {budget && budget.project.level !== "ok" && (
          <span className={["inline-flex items-center gap-1.5 rounded-full px-2.5 py-1.5 text-xs font-semibold", budget.project.level === "hard" ? "bg-brand-soft text-brand-hover" : "bg-warning-soft text-warning-ink"].join(" ")} data-testid="budget-chip" data-level={budget.project.level}>
            <span className={["size-1.5 rounded-full", budget.project.level === "hard" ? "bg-brand" : "bg-warning"].join(" ")} />
            {budget.project.level === "hard" ? "Orçamento do mês esgotado" : "Passou do aviso de orçamento"} · {formatUsd(budget.project.spentUsd)}
            {budget.project.hardUsd != null ? ` / ${formatUsd(budget.project.hardUsd)}` : ""}
          </span>
        )}
        {state.model && <span className="rounded-full border hairline-strong px-2.5 py-1.5 font-mono text-xs text-ink">{state.model}</span>}
        {active && liveCostUsd != null && liveCostUsd > 0 && (
          <span data-testid="run-live-cost" title="Estimativa pelos tokens de cada resposta; o custo final vem do SDK quando o run fecha" className="rounded-full border hairline-strong px-2.5 py-1.5 font-mono text-xs text-ink">
            ≈ {formatUsd(liveCostUsd)}
          </span>
        )}
        {totals && totals.runs > 0 && (
          <span data-testid="project-cost" title="Custo acumulado de todos os runs deste projeto" className="rounded-full border hairline-strong px-2.5 py-1.5 font-mono text-xs text-ink">
            {`Projeto ${formatUsd(totals.costUsd)} em ${totals.runs} ${totals.runs === 1 ? "run" : "runs"}`}
          </span>
        )}
        {canContinue && (
          <button
            type="button"
            onClick={onContinue}
            className="inline-flex items-center gap-2 rounded-full border hairline-strong bg-surface px-3.5 py-2 text-[13px] font-semibold text-ink hover:border-ink"
          >
            <History size={13} aria-hidden /> Continuar sessão
          </button>
        )}
        {active && (
          <button
            type="button"
            onClick={onInterrupt}
            disabled={interrupting}
            className="inline-flex items-center gap-2 rounded-full border-[1.5px] border-brand bg-surface px-3.5 py-2 text-[13px] font-semibold text-brand hover:bg-brand-soft disabled:opacity-50"
          >
            <Square size={12} aria-hidden fill="currentColor" /> {interrupting ? "Interrompendo…" : "Interromper"}
          </button>
        )}
      </div>
    </header>
  );
}

function statusOf(run: Run | null, state: RunViewState, active: boolean): { label: string; className: string; dot?: string } {
  if (!run) return { label: "Pronto", className: "border hairline-strong text-ink" };
  if (state.pendingPermissions.length > 0) return { label: "Aguardando aprovação", className: "bg-warning-soft text-warning-ink", dot: "bg-warning" };
  if (active) return { label: "Executando", className: "bg-brand-soft text-brand-hover", dot: "bg-brand" };
  if (state.result?.isError || run.status === "failed") return { label: "Falhou", className: "bg-brand-soft text-brand-hover" };
  if (run.status === "interrupted" && run.stopCause === "budget") return { label: "Interrompido · orçamento", className: "bg-ink text-paper" };
  if (run.status === "interrupted") return { label: "Interrompido", className: "bg-warning-soft text-warning-ink" };
  return { label: "Concluído", className: "bg-success-soft text-success-ink", dot: "bg-success" };
}
