import type { Run } from "../lib/types";
import { contextUsage, type RunViewState } from "../state/runReducer";

type RunSidebarProps = {
  state: RunViewState;
  run: Run | null;
  elapsedMs: number;
};

export function RunSidebar({ state, run, elapsedMs }: RunSidebarProps) {
  const ctx = contextUsage(state);
  const percent = Math.round(ctx.fraction * 100);
  const level = ctx.fraction >= 0.9 ? "critical" : ctx.fraction >= 0.7 ? "warning" : "ok";
  const cost = state.result?.costUsd ?? run?.costUsd ?? null;
  const turns = state.result?.numTurns ?? run?.numTurns ?? null;
  const maxTurns = run?.options.maxTurns ?? null;
  const budget = run?.options.maxBudgetUsd ?? null;

  return (
    <aside aria-label="Estado do run" className="flex w-[340px] shrink-0 flex-col gap-4 border-l hairline bg-white p-5">
      <section className="flex flex-col gap-2.5">
        <h2 className="m-0 font-display text-sm font-semibold">Contexto</h2>
        <div className="flex items-baseline gap-1.5">
          <span className="font-display text-[28px] leading-none font-bold tracking-tight">{percent}%</span>
          <span className="text-xs text-slate">de {formatTokens(ctx.window)} tokens</span>
        </div>
        <div role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} aria-label="Uso do contexto" className="h-1.5 overflow-hidden rounded-full bg-paper">
          <div
            className={["h-full rounded-full transition-[width] duration-300", level === "ok" ? "bg-ink" : level === "warning" ? "bg-warning" : "bg-brand"].join(" ")}
            style={{ width: `${Math.max(percent, ctx.used > 0 ? 1 : 0)}%` }}
          />
        </div>
        <div className="flex justify-between text-xs text-slate">
          <span>Cache lido: {formatTokens(state.usage?.cacheReadTokens ?? 0)}</span>
          <span>Saída: {formatTokens(state.usage?.outputTokens ?? 0)}</span>
        </div>
      </section>

      <section className="flex flex-col gap-2.5 border-t hairline pt-4">
        <h2 className="m-0 font-display text-sm font-semibold">Custo</h2>
        <div className="grid grid-cols-2 gap-3">
          <Stat label="Este run" value={cost === null ? "—" : formatUsd(cost)} />
          <Stat label="Orçamento" value={budget === null ? "sem limite" : formatUsd(budget)} />
        </div>
        <div className="flex justify-between text-xs text-slate">
          <span>
            Turnos: {turns ?? "—"}
            {maxTurns ? ` de ${maxTurns}` : ""}
          </span>
          <span>Duração: {formatDuration(elapsedMs)}</span>
        </div>
      </section>

      <section className="flex flex-col gap-2 border-t hairline pt-4">
        <h2 className="m-0 font-display text-sm font-semibold">Agentes e ferramentas</h2>
        <div className="flex items-center gap-2 rounded-md bg-paper px-2 py-1.5 text-[13px]">
          <span className={["size-2 rounded-full", state.result ? "bg-success" : state.runId ? "bg-brand" : "bg-mist"].join(" ")} />
          <span className="font-semibold">Principal</span>
          <span className="ml-auto text-xs text-slate">{state.model ?? "modelo padrão"}</span>
        </div>
        {state.subagentIds.map((id) => (
          <div key={id} className="flex items-center gap-2 py-1 pl-6 text-[13px] text-graphite">
            <span className="size-2 rounded-full bg-success" />
            <span>Subagente</span>
            <span className="ml-auto font-mono text-xs text-slate">{id.slice(0, 12)}</span>
          </div>
        ))}
        <div className="flex flex-wrap gap-1.5 pt-1">
          {Object.entries(state.toolCounts).length === 0 && <span className="text-xs text-fog">Nenhuma ferramenta chamada</span>}
          {Object.entries(state.toolCounts)
            .sort((a, b) => b[1] - a[1])
            .map(([name, count]) => (
              <span key={name} className="rounded-full border hairline-strong px-2 py-0.5 text-xs text-graphite">
                {name} {count}
              </span>
            ))}
        </div>
      </section>

      <section className="flex flex-col gap-2 border-t hairline pt-4">
        <h2 className="m-0 font-display text-sm font-semibold">Sessão</h2>
        <div className="font-mono text-xs break-all text-slate">{state.sessionId ?? "aguardando início"}</div>
        {state.permissionMode && <div className="text-xs text-slate">Permissões: {state.permissionMode}</div>}
      </section>
    </aside>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-slate">{label}</span>
      <span className="font-mono text-[15px] font-medium">{value}</span>
    </div>
  );
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

export function formatUsd(n: number): string {
  return `US$ ${n.toFixed(2).replace(".", ",")}`;
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
