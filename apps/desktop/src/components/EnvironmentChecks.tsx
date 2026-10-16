import { AlertTriangle, Check } from "lucide-react";
import type { EnvironmentCheck } from "../lib/types";

type EnvironmentChecksProps = {
  check: EnvironmentCheck | null;
  checking: boolean;
  onRecheck: () => void;
  compact?: boolean;
};

export function EnvironmentChecks({ check, checking, onRecheck, compact = false }: EnvironmentChecksProps) {
  const items = check
    ? [
        { key: "node", title: check.node.ok ? "Node.js encontrado" : "Node.js não encontrado", item: check.node },
        { key: "sidecar", title: check.sidecar.ok ? "Runtime do agente respondendo" : "Runtime do agente indisponível", item: check.sidecar },
        { key: "auth", title: check.claudeAuth.ok ? "Claude Code autenticado" : "Claude Code não autenticado", item: check.claudeAuth },
      ]
    : [];
  return (
    <div className="flex flex-col gap-2.5" data-testid="environment-checks">
      {!check && <p className="m-0 text-[13px] text-slate">{checking ? "Checando o ambiente…" : "Ambiente ainda não checado."}</p>}
      {items.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {items.map(({ key, title, item }) => (
            <li key={key} className={["flex items-center gap-3 rounded-md border hairline bg-surface px-3.5", compact ? "py-2" : "py-3"].join(" ")} data-testid={`check-${key}`} data-ok={item.ok}>
              <span aria-hidden className={["flex size-7 shrink-0 items-center justify-center rounded-full", item.ok ? "bg-success-soft text-success-ink" : "bg-warning-soft text-warning-ink"].join(" ")}>
                {item.ok ? <Check size={15} strokeWidth={2.5} /> : <AlertTriangle size={15} strokeWidth={2.5} />}
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="text-sm font-semibold">{title}</span>
                <span className="truncate font-mono text-xs text-slate" title={item.detail}>
                  {item.detail}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-3">
        <button type="button" onClick={onRecheck} disabled={checking} className="rounded-md border hairline-strong bg-surface px-3 py-1.5 text-[13px] font-medium disabled:opacity-50">
          {checking ? "Checando…" : "Checar de novo"}
        </button>
        {check && <span className="text-xs text-slate">última checagem {formatClock(check.checkedAt)}</span>}
      </div>
    </div>
  );
}

function formatClock(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : `às ${d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`;
}
