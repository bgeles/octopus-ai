import { AlertTriangle, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { isTauri } from "../lib/transport";
import type { AuditEvent, AuditVerification, PolicyDecision, PolicyRule, PolicyRuleInput, Project } from "../lib/types";
import { PolicyTab } from "./PolicyTab";
import { formatRelative } from "./SessionsView";

export type SecurityTab = "policy" | "budgets" | "audit";

type SecurityViewProps = {
  project: Project | null;
  tab: SecurityTab;
  onChangeTab: (tab: SecurityTab) => void;
  audit: AuditEvent[] | null;
  verification: AuditVerification | null;
  onRefreshAudit: (kindPrefix: string | null) => void;
  onVerify: () => Promise<void>;
  onExport: (destination: string | null) => Promise<string>;
  /** Abas que ainda não existem ficam desabilitadas (chegam nas próximas iterações). */
  availableTabs?: SecurityTab[];
  rules: PolicyRule[] | null;
  policyEvents: AuditEvent[];
  onRefreshPolicy: () => void;
  onToggleRule: (rule: PolicyRule, enabled: boolean) => Promise<void>;
  onCreateRule: (scope: "global" | "project", input: PolicyRuleInput) => Promise<void>;
  onDeleteRule: (rule: PolicyRule) => Promise<void>;
  onSimulate: (toolName: string, input: unknown) => Promise<PolicyDecision>;
};

const FILTERS: { id: string | null; label: string }[] = [
  { id: null, label: "Todos" },
  { id: "policy.", label: "Política" },
  { id: "approval.", label: "Aprovações" },
  { id: "run.", label: "Runs" },
  { id: "board.", label: "Board" },
  { id: "config.", label: "Configuração" },
];

export function SecurityView({ project, tab, onChangeTab, audit, verification, onRefreshAudit, onVerify, onExport, availableTabs = ["policy", "audit"], rules, policyEvents, onRefreshPolicy, onToggleRule, onCreateRule, onDeleteRule, onSimulate }: SecurityViewProps) {
  const [filter, setFilter] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (tab === "audit") onRefreshAudit(filter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, filter]);

  useEffect(() => {
    if (tab === "audit" && verification === null) void onVerify();
    if (tab === "policy") onRefreshPolicy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const exportNow = async () => {
    setBusy(true);
    setNotice(null);
    try {
      let destination: string | null = null;
      if (isTauri()) {
        const { save } = await import("@tauri-apps/plugin-dialog");
        const chosen = await save({ title: "Exportar auditoria", defaultPath: `octopus-audit-${new Date().toISOString().slice(0, 10)}.jsonl`, filters: [{ name: "JSON Lines", extensions: ["jsonl"] }] });
        if (!chosen) return;
        destination = chosen;
      }
      const result = await onExport(destination);
      setNotice(destination ? `Auditoria exportada para ${result}` : `Auditoria exportada (${result.split("\n").filter(Boolean).length} eventos em JSONL)`);
    } finally {
      setBusy(false);
    }
  };

  const tabs: { id: SecurityTab; label: string }[] = [
    { id: "policy", label: "Política" },
    { id: "budgets", label: "Orçamentos" },
    { id: "audit", label: verification ? `Auditoria · ${verification.events} ${verification.ok ? "íntegros" : "eventos"}` : "Auditoria" },
  ];

  return (
    <div className="flex flex-col gap-5 overflow-y-auto p-6" data-testid="security-view">
      <div className="flex flex-wrap items-center gap-4">
        <div>
          <div className="eyebrow text-brand">{project?.name ?? ""}</div>
          <h1 className="m-0 font-display text-xl font-bold tracking-tight">Segurança</h1>
        </div>
        <div role="tablist" aria-label="Seções de segurança" className="ml-auto flex flex-wrap gap-2">
          {tabs.map((t) => {
            const available = availableTabs.includes(t.id);
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                disabled={!available}
                title={available ? undefined : "Chega nas próximas iterações da Fase 3"}
                onClick={() => onChangeTab(t.id)}
                className={["rounded-full px-3.5 py-1.5 text-[13px] font-medium", tab === t.id ? "border-[1.5px] border-ink bg-ink text-paper" : "border hairline-strong bg-surface text-ink", available ? "" : "cursor-not-allowed opacity-40"].join(" ")}
              >
                {t.label}
              </button>
            );
          })}
        </div>
      </div>

      {tab === "policy" && <PolicyTab project={project} rules={rules} lastBlocks={policyEvents} onToggle={onToggleRule} onCreate={onCreateRule} onDelete={onDeleteRule} onSimulate={onSimulate} />}

      {tab === "audit" && (
        <>
          <section
            aria-label="Integridade do log"
            className={["flex flex-wrap items-center gap-4 rounded-xl border bg-surface px-5 py-4", verification && !verification.ok ? "border-[1.5px] border-brand" : "hairline"].join(" ")}
            data-testid="audit-integrity"
            data-ok={verification?.ok ?? "unknown"}
          >
            <span className={["flex size-9 items-center justify-center rounded-full", verification && !verification.ok ? "bg-brand-soft text-brand-hover" : "bg-success-soft text-success-ink"].join(" ")} aria-hidden>
              {verification && !verification.ok ? <AlertTriangle size={18} strokeWidth={2.5} /> : <ShieldCheck size={18} strokeWidth={2.5} />}
            </span>
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="font-display text-base font-bold">
                {verification === null ? "Verificando a cadeia de hashes…" : verification.ok ? `Cadeia de hashes íntegra · ${verification.events} ${verification.events === 1 ? "evento" : "eventos"}` : `Cadeia de hashes quebrada no evento #${verification.firstBrokenSeq}`}
              </span>
              <span className="text-[13px] text-slate">
                {verification === null
                  ? "Recalculando SHA-256 de cada evento a partir do anterior."
                  : verification.ok
                    ? "Cada evento guarda o hash do anterior; nenhum foi alterado ou removido fora do app."
                    : `${verification.intactBefore} ${verification.intactBefore === 1 ? "evento íntegro" : "eventos íntegros"} antes dele. O payload gravado não bate com o hash encadeado: alguém editou o log fora do app. Os eventos seguintes ficam sob suspeita até revisão.`}
              </span>
            </div>
            <div className="ml-auto flex gap-2">
              <button type="button" disabled={busy} onClick={() => void onVerify()} className="rounded-full bg-ink px-3.5 py-2 text-[13px] font-semibold text-paper disabled:opacity-50">
                Verificar de novo
              </button>
              <button type="button" disabled={busy} onClick={() => void exportNow()} className="rounded-md border hairline-strong bg-surface px-3.5 py-2 text-[13px] font-medium disabled:opacity-50">
                Exportar JSONL
              </button>
            </div>
          </section>
          {notice && (
            <div role="status" className="rounded-md bg-success-soft px-3 py-2 text-[13px] text-success-ink">
              {notice}
            </div>
          )}

          <section aria-label="Eventos" className="flex flex-col gap-2.5 rounded-xl border hairline bg-surface p-5">
            <div className="flex flex-wrap items-center gap-2.5">
              <h2 className="m-0 font-display text-sm font-semibold">Eventos</h2>
              <span className="text-xs text-slate">append-only · SHA-256 de (hash anterior + ts + ator + tipo + payload)</span>
              <div className="ml-auto flex flex-wrap gap-1.5 text-xs" role="group" aria-label="Filtro de eventos">
                {FILTERS.map((f) => (
                  <button key={f.label} type="button" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)} className={["rounded-full px-2.5 py-1 font-medium", filter === f.id ? "bg-ink text-paper" : "border hairline-strong text-ink"].join(" ")}>
                    {f.label}
                  </button>
                ))}
              </div>
            </div>
            {audit === null && <p className="m-0 text-[13px] text-slate">Carregando…</p>}
            {audit && audit.length === 0 && <p className="m-0 text-[13px] text-slate">Nenhum evento ainda. Runs, aprovações, mudanças de time, board e configurações entram aqui.</p>}
            <ul className="m-0 flex list-none flex-col p-0">
              {(audit ?? []).map((e) => (
                <li key={e.seq} className={["grid grid-cols-[3.5rem_5rem_7.5rem_minmax(0,1fr)_9rem] items-baseline gap-3 border-b hairline py-2 text-[13px] last:border-b-0", verification?.firstBrokenSeq === e.seq ? "bg-brand-soft" : ""].join(" ")} data-testid="audit-row" data-kind={e.kind}>
                  <span className="font-mono text-xs text-slate">#{e.seq}</span>
                  <span className="font-mono text-xs text-slate" title={e.ts}>
                    {formatRelative(e.ts)}
                  </span>
                  <span className="truncate text-[11px] font-semibold tracking-wider text-slate uppercase" title={e.kind}>
                    {e.kind}
                  </span>
                  <span className="truncate" title={JSON.stringify(e.payload)}>
                    <strong>{e.actor}</strong> · {summarize(e)}
                  </span>
                  <span className={["truncate font-mono text-[11px]", verification && verification.firstBrokenSeq !== null && e.seq >= verification.firstBrokenSeq ? "text-brand-hover" : "text-success-ink"].join(" ")} title={e.hash}>
                    {e.hash.slice(0, 4)}…{e.hash.slice(-4)}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}

export function summarize(e: AuditEvent): string {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof p[k] === "string" ? (p[k] as string) : null);
  switch (e.kind) {
    case "run.requested":
      return `pediu o run ${String(p.runId ?? "").slice(-6)}${p.agentProfileId ? " como membro do time" : ""}`;
    case "run.started":
      return `run ${String(p.runId ?? "").slice(-6)} iniciado · ${str("model") ?? ""}`;
    case "run.finished":
      return `run ${String(p.runId ?? "").slice(-6)} ${str("status") ?? "terminou"}${typeof p.costUsd === "number" ? ` · US$ ${(p.costUsd as number).toFixed(2).replace(".", ",")}` : ""}`;
    case "run.failed":
      return `run ${String(p.runId ?? "").slice(-6)} falhou · ${str("message") ?? ""}`;
    case "run.interrupted":
      return `interrompeu o run ${String(p.runId ?? "").slice(-6)}`;
    case "approval.allow":
      return `permitiu ${str("tool") ?? "ferramenta"}${str("message") ? ` · motivo: ${str("message")}` : ""}`;
    case "approval.deny":
      return `negou ${str("tool") ?? "ferramenta"}${str("message") ? ` · ${str("message")}` : ""}`;
    case "config.setting":
      return `preferência ${str("key") ?? ""} = ${JSON.stringify(p.value)}`;
    case "config.project.created":
      return `criou o projeto ${str("name") ?? ""}`;
    case "team.member.added":
      return `adicionou ${str("name") ?? ""} (${str("role") ?? ""}) ao time`;
    case "board.task.created":
      return `criou a task ${str("title") ?? ""}`;
    case "board.task.approved":
      return `aprovou a task ${String(p.taskId ?? "")}${str("note") ? ` · ${str("note")}` : ""}`;
    default:
      return Object.entries(p)
        .slice(0, 3)
        .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
        .join(" · ");
  }
}
