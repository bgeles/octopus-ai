import { AlertCircle } from "lucide-react";
import type { Run } from "../lib/types";
import { formatUsd } from "./RunSidebar";

type BudgetStopBannerProps = {
  run: Run;
  onRaiseLimit: () => void;
};

/** Run parado pelo Octopus porque o orçamento mensal estourou enquanto ele rodava. */
export function BudgetStopBanner({ run, onRaiseLimit }: BudgetStopBannerProps) {
  return (
    <div role="alert" data-testid="budget-stop-banner" className="mx-6 mt-6 flex max-w-[920px] flex-col gap-2.5 rounded-xl border-[1.5px] border-brand bg-surface px-4 py-3.5">
      <div className="flex items-center gap-2">
        <AlertCircle size={16} aria-hidden className="text-brand" />
        <h2 className="m-0 font-display text-[15px] font-bold">Orçamento mensal esgotado no meio do run</h2>
      </div>
      <p className="m-0 text-[13px]">{run.errorMessage ?? "O Octopus interrompeu este run porque o limite do mês foi atingido."}</p>
      <p className="m-0 text-xs text-slate">
        Este run gastou ≈ {formatUsd(run.costUsd ?? run.estCostUsd ?? 0)} (estimativa pelos tokens de cada resposta).
        {run.taskId ? " A task que ele executava foi para Bloqueada." : ""}
      </p>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={onRaiseLimit} className="rounded-full bg-brand px-3.5 py-2 text-[13px] font-semibold text-white hover:bg-brand-hover">
          Aumentar o limite
        </button>
      </div>
    </div>
  );
}
