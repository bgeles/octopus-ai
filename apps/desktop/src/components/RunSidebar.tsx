import type { Run } from "../lib/types";
import { contextUsage, subagentTree, type RunViewState, type SubagentNode } from "../state/runReducer";

type RunSidebarProps = {
  state: RunViewState;
  run: Run | null;
  elapsedMs: number;
  /** Retoma a sessão com `/compact` (experimental). */
  onCompact?: (() => void) | null;
};

export function RunSidebar({ state, run, elapsedMs, onCompact = null }: RunSidebarProps) {
  const ctx = contextUsage(state);
  const percent = Math.round(ctx.fraction * 100);
  const level = ctx.fraction >= 0.9 ? "critical" : ctx.fraction >= 0.7 ? "warning" : "ok";
  const cost = state.result?.costUsd ?? run?.costUsd ?? null;
  const turns = state.result?.numTurns ?? run?.numTurns ?? null;
  const maxTurns = run?.options.maxTurns ?? null;
  const budget = run?.options.maxBudgetUsd ?? null;
  const subagents = subagentTree(state.items);

  return (
    <aside aria-label="Estado do run" className="flex w-[340px] shrink-0 flex-col gap-4 border-l hairline bg-surface p-5">
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
        {level !== "ok" && (
          <div role="alert" className={["flex flex-col gap-1.5 rounded-md px-2.5 py-2 text-xs", level === "critical" ? "bg-brand-soft text-brand-hover" : "bg-warning-soft text-warning-ink"].join(" ")} data-testid="context-alert" data-level={level}>
            <span className="font-semibold">{level === "critical" ? "Contexto crítico: acima de 90% da janela." : "Contexto alto: acima de 70% da janela."}</span>
            <span>{level === "critical" ? "O Claude Code vai compactar sozinho em breve; compacte agora para escolher o momento, ou bifurque a sessão para começar limpo." : "Considere compactar ao fechar esta etapa."}</span>
            {onCompact && (
              <button type="button" onClick={onCompact} className="self-start rounded-full bg-ink px-2.5 py-1 text-[11px] font-semibold text-paper" title="Retoma a sessão enviando /compact (experimental)">
                Compactar agora
              </button>
            )}
          </div>
        )}
        {state.compactions.length > 0 && (
          <div className="flex flex-col gap-0.5 text-xs text-slate" data-testid="compaction-history">
            <span className="font-semibold text-ink">
              {state.compactions.length} {state.compactions.length === 1 ? "compactação" : "compactações"} neste run
            </span>
            {state.compactions.map((c, i) => (
              <span key={i} className="truncate" title={c.summary ?? undefined}>
                {c.trigger === "manual" ? "manual" : "automática"}
                {c.summary ? ` · ${c.summary}` : ""}
              </span>
            ))}
          </div>
        )}
        {state.instructions.length > 0 && (
          <div className="flex flex-col gap-0.5 text-xs text-slate" data-testid="instructions-loaded">
            <span className="font-semibold text-ink">Instruções carregadas</span>
            {state.instructions.map((i) => (
              <span key={i.filePath} className="truncate font-mono" title={`${i.filePath} · ${i.loadReason}`}>
                {i.filePath.split("/").slice(-2).join("/")} · {i.memoryType === "User" ? "usuário" : i.memoryType === "Project" ? "projeto" : i.memoryType.toLowerCase()}
              </span>
            ))}
          </div>
        )}
        {state.brief && (
          <div className="flex flex-col gap-0.5 rounded-md border hairline bg-paper px-2.5 py-2 text-xs" data-testid="brief-chip">
            <span className="font-semibold text-ink">Memória injetada · {state.brief.chars.toLocaleString("pt-BR")} caracteres</span>
            {state.brief.items.length > 0 && <span className="text-slate">{state.brief.items.join(" · ")}</span>}
          </div>
        )}
      </section>

      <section className="flex flex-col gap-2.5 border-t hairline pt-4">
        <h2 className="m-0 font-display text-sm font-semibold">Custo</h2>
        <div className="grid grid-cols-2 gap-3">
          <Stat label="Este run" value={cost !== null ? formatUsd(cost) : run?.estCostUsd ? `≈ ${formatUsd(run.estCostUsd)}` : "—"} />
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
        {subagents.length > 0 && (
          <ul className="m-0 flex list-none flex-col gap-1 p-0" aria-label="Subagentes">
            {subagents.map((node) => (
              <SubagentRow key={node.toolUseId} node={node} />
            ))}
          </ul>
        )}
        <div className="flex flex-wrap gap-1.5 pt-1">
          {Object.entries(state.toolCounts).length === 0 && <span className="text-xs text-slate">Nenhuma ferramenta chamada</span>}
          {Object.entries(state.toolCounts)
            .sort((a, b) => b[1] - a[1])
            .map(([name, count]) => (
              <span key={name} className="rounded-full border hairline-strong px-2 py-0.5 text-xs text-ink">
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

function SubagentRow({ node }: { node: SubagentNode }) {
  const dot = node.status === "running" ? "bg-brand animate-pulse" : node.status === "error" ? "bg-brand" : "bg-success";
  return (
    <li className="flex items-center gap-2 border-l-2 border-mist py-1 pl-4 text-[13px] text-ink" data-testid="subagent-node" data-status={node.status}>
      <span aria-label={node.status === "running" ? "em execução" : node.status === "error" ? "falhou" : "concluído"} className={["size-2 shrink-0 rounded-full", dot].join(" ")} />
      <span className="min-w-0 flex-1 truncate">{node.name}</span>
      <span className="shrink-0 text-xs text-slate">{subagentCounters(node)}</span>
    </li>
  );
}

export function subagentCounters(node: Pick<SubagentNode, "toolCalls" | "messages" | "errors">): string {
  const parts = [`${node.toolCalls} ${node.toolCalls === 1 ? "ferramenta" : "ferramentas"}`, `${node.messages} ${node.messages === 1 ? "mensagem" : "mensagens"}`];
  if (node.errors > 0) parts.push(`${node.errors} ${node.errors === 1 ? "erro" : "erros"}`);
  return parts.join(" · ");
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
