import { History, Lock, Square } from "lucide-react";
import type { Project, Run } from "../lib/types";
import type { RunViewState } from "../state/runReducer";

type RunHeaderProps = {
  project: Project | null;
  run: Run | null;
  state: RunViewState;
  active: boolean;
  onInterrupt: () => void;
  interrupting: boolean;
  /** Retomar a sessão deste run (disponível quando o run terminou e tem sessão). */
  onContinue?: () => void;
};

export function RunHeader({ project, run, state, active, onInterrupt, interrupting, onContinue }: RunHeaderProps) {
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
        <span className="inline-flex items-center gap-1.5 rounded-full border hairline-strong px-2.5 py-1.5 text-xs font-medium text-ink">
          <Lock size={13} aria-hidden /> Sandbox padrão
        </span>
        {state.model && <span className="rounded-full border hairline-strong px-2.5 py-1.5 font-mono text-xs text-ink">{state.model}</span>}
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
  if (run.status === "interrupted") return { label: "Interrompido", className: "bg-warning-soft text-warning-ink" };
  return { label: "Concluído", className: "bg-success-soft text-success-ink", dot: "bg-success" };
}
