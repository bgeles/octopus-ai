import type { Approval, Project } from "../lib/types";
import { ApprovalCard, summarizeInput, type DecideFn, type ReadFileFn } from "./ApprovalCard";
import { formatTime } from "./Transcript";

type ApprovalsViewProps = {
  project: Project | null;
  approvals: Approval[] | null;
  deciding: string | null;
  onDecide: DecideFn;
  onRefresh: () => void;
  readFile: ReadFileFn;
};

export function ApprovalsView({ project, approvals, deciding, onDecide, onRefresh, readFile }: ApprovalsViewProps) {
  const pending = (approvals ?? []).filter((a) => a.decision === null);
  const decided = (approvals ?? []).filter((a) => a.decision !== null);
  return (
    <div className="flex flex-col gap-6 overflow-y-auto p-6">
      <div className="flex items-center gap-4">
        <div>
          <div className="eyebrow text-brand">{project?.name ?? ""}</div>
          <h1 className="m-0 font-display text-xl font-bold tracking-tight">Aprovações</h1>
        </div>
        {pending.length > 0 && (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-warning-soft px-2.5 py-1 text-xs font-semibold text-warning-ink">
            <span className="size-1.5 rounded-full bg-warning" />
            {pending.length} {pending.length === 1 ? "pendente" : "pendentes"}
          </span>
        )}
        <button type="button" onClick={onRefresh} className="ml-auto rounded-md border hairline-strong bg-surface px-3 py-1.5 text-[13px] font-medium">
          Atualizar
        </button>
      </div>

      <section className="flex flex-col gap-3" aria-label="Pendentes">
        <h2 className="m-0 font-display text-sm font-semibold text-slate">Pendentes</h2>
        {approvals === null && <p className="m-0 text-[13px] text-slate">Carregando…</p>}
        {approvals && pending.length === 0 && <p className="m-0 text-[13px] text-slate">Nenhuma aprovação pendente. Pedidos de permissão dos runs aparecem aqui e no transcript.</p>}
        {pending.map((a) => (
          <ApprovalCard
            key={a.id}
            request={{ runId: a.runId, requestId: a.requestId, toolName: a.toolName, input: a.toolInput, reason: a.reason, at: a.requestedAt, runPrompt: a.runPrompt }}
            onDecide={onDecide}
            busy={deciding === a.requestId}
            readFile={readFile}
          />
        ))}
      </section>

      <section className="flex flex-col gap-2" aria-label="Decididas">
        <div className="flex items-baseline gap-3">
          <h2 className="m-0 font-display text-sm font-semibold text-slate">Decididas</h2>
          <span className="text-xs text-slate">decisão e motivo ficam gravados no run</span>
        </div>
        {approvals && decided.length === 0 && <p className="m-0 text-[13px] text-slate">Nenhuma decisão registrada ainda.</p>}
        <ul className="m-0 flex list-none flex-col rounded-xl border hairline bg-surface p-0">
          {decided.map((a) => (
            <li key={a.id} className="grid grid-cols-[3rem_6rem_minmax(0,1fr)_6rem] items-baseline gap-3 border-b hairline px-4 py-2.5 text-[13px] last:border-b-0" data-testid="decided-approval">
              <span className="font-mono text-xs text-slate">{a.decidedAt ? formatTime(a.decidedAt) : ""}</span>
              <span className="font-semibold text-ink">{a.toolName}</span>
              <span className="flex min-w-0 flex-col gap-0.5">
                <code className="truncate font-mono text-xs text-ink">{summarizeInput(a.toolName, a.toolInput)}</code>
                <span className="truncate text-xs text-slate">{a.decisionMessage ? `Motivo: ${a.decisionMessage}` : `Run: ${a.runPrompt}`}</span>
              </span>
              <span className={["text-right font-semibold", a.decision === "allow" ? "text-success-ink" : "text-brand-hover"].join(" ")}>{a.decision === "allow" ? "permitido" : "negado"}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
