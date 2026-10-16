import { useState } from "react";
import type { BudgetInput, BudgetLine, BudgetStatus } from "../lib/types";
import { formatUsd } from "./RunSidebar";

type BudgetTabProps = {
  status: BudgetStatus | null;
  onSave: (line: BudgetLine, input: BudgetInput) => Promise<void>;
};

export function BudgetTab({ status, onSave }: BudgetTabProps) {
  return (
    <section aria-label="Orçamentos" className="flex flex-col gap-3 rounded-xl border hairline bg-surface p-5" data-testid="budget-tab">
      <div className="flex items-baseline gap-3">
        <h2 className="m-0 font-display text-sm font-semibold">Orçamentos do mês{status ? ` · ${status.month}` : ""}</h2>
        <span className="text-xs text-slate">O aviso só avisa; o limite impede novos runs e limita o run em andamento ao que resta.</span>
      </div>
      {status === null && <p className="m-0 text-[13px] text-slate">Carregando…</p>}
      {status && (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(320px,100%),1fr))] gap-3">
          <BudgetCard line={status.project} onSave={onSave} />
          {status.agents.map((line) => (
            <BudgetCard key={line.scopeId} line={line} onSave={onSave} />
          ))}
        </div>
      )}
      {status && status.agents.length === 0 && <p className="m-0 text-xs text-slate">Membros do time aparecem aqui com o próprio limite assim que você os adicionar.</p>}
    </section>
  );
}

function BudgetCard({ line, onSave }: { line: BudgetLine; onSave: BudgetTabProps["onSave"] }) {
  const [editing, setEditing] = useState(false);
  const [soft, setSoft] = useState(line.softUsd?.toString() ?? "");
  const [hard, setHard] = useState(line.hardUsd?.toString() ?? "");
  const [turns, setTurns] = useState(line.maxTurns?.toString() ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const limit = line.hardUsd ?? line.softUsd ?? null;
  const pct = limit ? Math.min(100, Math.round((line.spentUsd / limit) * 100)) : 0;
  const border = line.level === "hard" ? "border-[1.5px] border-brand" : line.level === "soft" ? "border-[1.5px] border-warning" : "hairline";
  const hasLimits = line.softUsd != null || line.hardUsd != null || line.maxTurns != null;

  const parse = (v: string): number | null | "invalid" => {
    const t = v.trim().replace(",", ".");
    if (!t) return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : "invalid";
  };

  const save = async () => {
    setError(null);
    const s = parse(soft);
    const h = parse(hard);
    const t = parse(turns);
    if (s === "invalid" || h === "invalid" || t === "invalid") {
      setError("Use números.");
      return;
    }
    setSaving(true);
    try {
      await onSave(line, { softUsd: s, hardUsd: h, maxTurns: t === null ? null : Math.round(t) });
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <article aria-label={`Orçamento: ${line.label}`} className={["flex flex-col gap-2.5 rounded-xl border bg-surface p-4", border].join(" ")} data-testid="budget-card" data-level={line.level} data-scope={line.scope}>
      <div className="flex items-baseline justify-between gap-3 text-[13px]">
        <span className="font-semibold">{line.label}</span>
        <span className="font-mono text-xs">
          {formatUsd(line.spentUsd)}
          {line.softUsd != null || line.hardUsd != null
            ? ` / ${line.softUsd != null ? `soft ${line.softUsd}` : ""}${line.softUsd != null && line.hardUsd != null ? " · " : ""}${line.hardUsd != null ? `hard ${line.hardUsd}` : ""}`
            : " · sem limite"}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full border hairline bg-paper" role="progressbar" aria-label={`Gasto de ${line.label}`} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className={["h-full", line.level === "hard" ? "bg-brand" : line.level === "soft" ? "bg-warning" : "bg-ink"].join(" ")} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-slate">
        {line.runs} {line.runs === 1 ? "run" : "runs"} no mês
        {line.maxTurns ? ` · máx. ${line.maxTurns} turnos por run` : ""}
        {line.level === "hard" ? " · esgotado: novos runs bloqueados" : line.level === "soft" ? " · passou do aviso" : ""}
      </span>
      {!editing ? (
        <button type="button" onClick={() => setEditing(true)} className="self-start rounded-sm border hairline-strong bg-surface px-2.5 py-1 text-xs font-medium hover:border-ink">
          {hasLimits ? "Editar limites" : "Definir limite"}
        </button>
      ) : (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <label className="flex flex-col gap-0.5 text-[11px] font-medium text-slate">
            Aviso (US$)
            <input aria-label={`Aviso de ${line.label}`} value={soft} onChange={(e) => setSoft(e.target.value)} inputMode="decimal" className="w-20 rounded-sm border hairline-strong bg-surface px-2 py-1 text-xs" />
          </label>
          <label className="flex flex-col gap-0.5 text-[11px] font-medium text-slate">
            Limite (US$)
            <input aria-label={`Limite de ${line.label}`} value={hard} onChange={(e) => setHard(e.target.value)} inputMode="decimal" className="w-20 rounded-sm border hairline-strong bg-surface px-2 py-1 text-xs" />
          </label>
          <label className="flex flex-col gap-0.5 text-[11px] font-medium text-slate">
            Turnos/run
            <input aria-label={`Turnos de ${line.label}`} value={turns} onChange={(e) => setTurns(e.target.value)} inputMode="numeric" className="w-16 rounded-sm border hairline-strong bg-surface px-2 py-1 text-xs" />
          </label>
          <button type="submit" disabled={saving} className="rounded-full bg-ink px-3 py-1.5 text-xs font-semibold text-paper disabled:opacity-50">
            Salvar
          </button>
          <button type="button" onClick={() => setEditing(false)} className="rounded-sm border hairline-strong bg-surface px-2.5 py-1 text-xs font-medium">
            Cancelar
          </button>
          {error && (
            <span role="alert" className="basis-full text-xs text-brand-hover">
              {error}
            </span>
          )}
        </form>
      )}
    </article>
  );
}
