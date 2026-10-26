import { Target } from "lucide-react";
import { useState } from "react";
import type { Goal, GoalInput, GoalProgress } from "../lib/types";

type GoalsPanelProps = {
  goals: GoalProgress[];
  onCreate: (input: GoalInput) => Promise<void>;
  onUpdate: (goal: Goal, input: GoalInput) => Promise<void>;
  onDelete: (goal: Goal) => Promise<void>;
};

export function goalPercent(goal: GoalProgress): number {
  return goal.tasksTotal === 0 ? 0 : Math.round((goal.tasksDone / goal.tasksTotal) * 100);
}

/** Objetivos do projeto: o porquê de cada task; progresso = tasks concluídas com esse objetivo. */
export function GoalsPanel({ goals, onCreate, onUpdate, onDelete }: GoalsPanelProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [parent, setParent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const titleOf = (id: string | null) => (id ? (goals.find((g) => g.id === id)?.title ?? null) : null);
  const act = (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    fn()
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };
  const asInput = (g: Goal): GoalInput => ({ title: g.title, descriptionMd: g.descriptionMd, parentGoalId: g.parentGoalId, status: g.status });

  return (
    <section aria-label="Objetivos" className="flex min-w-0 flex-1 basis-[480px] flex-col gap-3 rounded-xl border hairline bg-surface p-5" data-testid="goals-panel">
      <div className="flex items-baseline gap-3">
        <h2 className="m-0 font-display text-sm font-semibold">Objetivos</h2>
        <span className="text-xs text-slate">o porquê de cada task; progresso = tasks concluídas com esse objetivo</span>
      </div>
      {goals.length === 0 && <div className="rounded-lg border border-dashed hairline p-4 text-[13px] text-slate">Nenhum objetivo ainda. Crie um abaixo e ligue tasks e workflows a ele; o time vê os objetivos em team_list e pode usá-los ao delegar.</div>}
      <ul className="m-0 flex list-none flex-col p-0">
        {goals.map((g) => {
          const pct = goalPercent(g);
          const done = g.status === "done";
          return (
            <li key={g.id} className="flex flex-col gap-1.5 border-b hairline py-3 last:border-b-0" data-testid="goal-row" data-status={g.status}>
              <div className="flex flex-wrap items-center gap-2">
                <Target size={14} aria-hidden className={done ? "text-success-ink" : "text-brand"} />
                <span className={["text-[13px] font-semibold", done ? "line-through text-slate" : ""].join(" ")}>{g.title}</span>
                <span className="text-xs text-slate">{g.parentGoalId ? `↳ de ${titleOf(g.parentGoalId) ?? "objetivo removido"}` : "objetivo raiz"}</span>
                <span className={["ml-auto rounded-full px-2 py-0.5 text-[11px] font-semibold", done ? "bg-success-soft text-success-ink" : "border hairline-strong text-slate"].join(" ")}>{done ? "concluído" : "ativo"}</span>
                <button type="button" disabled={busy} onClick={() => act(() => onUpdate(g, { ...asInput(g), status: done ? "active" : "done" }))} className="rounded-md border hairline-strong bg-surface px-2.5 py-1 text-xs font-medium hover:border-ink disabled:opacity-50">
                  {done ? "Reabrir" : "Concluir"}
                </button>
                <button type="button" disabled={busy} onClick={() => act(() => onDelete(g))} className="rounded-md border hairline-strong bg-surface px-2.5 py-1 text-xs font-medium text-slate hover:border-brand hover:text-brand disabled:opacity-50">
                  Excluir
                </button>
              </div>
              {g.descriptionMd && <p className="m-0 text-[13px] text-slate">{g.descriptionMd}</p>}
              <div className="flex items-center gap-2 text-xs text-slate">
                <div className="h-1.5 w-40 overflow-hidden rounded-full bg-mist" aria-hidden>
                  <div className={["h-full rounded-full", done ? "bg-success" : "bg-brand"].join(" ")} style={{ width: `${pct}%` }} />
                </div>
                <span data-testid="goal-progress">
                  {g.tasksDone} de {g.tasksTotal} tasks · {pct}%
                </span>
                {g.workflows > 0 && <span>· {g.workflows === 1 ? "1 workflow" : `${g.workflows} workflows`}</span>}
              </div>
            </li>
          );
        })}
      </ul>
      <form
        className="flex flex-col gap-2 border-t hairline pt-3"
        data-testid="goal-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!title.trim()) {
            setError("Informe o título do objetivo.");
            return;
          }
          act(async () => {
            await onCreate({ title: title.trim(), descriptionMd: description.trim(), parentGoalId: parent || null });
            setTitle("");
            setDescription("");
            setParent("");
          });
        }}
      >
        <div className="text-xs font-medium text-slate">Novo objetivo</div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex min-w-[220px] flex-1 flex-col gap-1 text-[13px] font-medium text-slate">
            Título do objetivo
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Triagem 30% mais rápida" className="rounded-sm border hairline-strong bg-surface px-3 py-2 text-sm text-ink" />
          </label>
          <label className="flex min-w-[180px] flex-col gap-1 text-[13px] font-medium text-slate">
            Pai
            <select aria-label="Pai" value={parent} onChange={(e) => setParent(e.target.value)} className="rounded-sm border hairline-strong bg-surface px-3 py-2 text-sm text-ink">
              <option value="">Nenhum</option>
              {goals.filter((g) => g.status === "active").map((g) => (
                <option key={g.id} value={g.id}>
                  {g.title}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" disabled={busy} className="rounded-full bg-ink px-3.5 py-2 text-[13px] font-semibold text-paper disabled:opacity-50">
            Criar
          </button>
        </div>
        <label className="flex flex-col gap-1 text-[13px] font-medium text-slate">
          Descrição (opcional; vai junto no prompt)
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="para onde cada lead vai" className="rounded-sm border hairline-strong bg-surface px-3 py-2 text-sm text-ink" />
        </label>
        {error && (
          <div role="alert" className="rounded-md bg-brand-soft px-3 py-2 text-[13px] text-brand-hover">
            {error}
          </div>
        )}
      </form>
    </section>
  );
}
