import { Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AuditEvent, PolicyDecision, PolicyRule, PolicyRuleInput, Project, RuleAction, RuleKind } from "../lib/types";
import { formatRelative } from "./SessionsView";

type PolicyTabProps = {
  project: Project | null;
  rules: PolicyRule[] | null;
  lastBlocks: AuditEvent[];
  onToggle: (rule: PolicyRule, enabled: boolean) => Promise<void>;
  onCreate: (scope: "global" | "project", input: PolicyRuleInput) => Promise<void>;
  onDelete: (rule: PolicyRule) => Promise<void>;
  onSimulate: (toolName: string, input: unknown) => Promise<PolicyDecision>;
};

export const KIND_LABELS: Record<RuleKind, string> = { command: "comando", write: "escrita", tool: "ferramenta", mcp: "mcp" };
export const ACTION_LABELS: Record<RuleAction, string> = { allow: "permite", deny: "nega", ask: "pergunta" };

export function PolicyTab({ project, rules, lastBlocks, onToggle, onCreate, onDelete, onSimulate }: PolicyTabProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [simCommand, setSimCommand] = useState("rm -rf /tmp/x");
  const [simResult, setSimResult] = useState<PolicyDecision | null>(null);

  const toggle = async (rule: PolicyRule) => {
    setBusyId(rule.id);
    setError(null);
    try {
      await onToggle(rule, !rule.enabled);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const simulate = async () => {
    setError(null);
    try {
      setSimResult(await onSimulate("Bash", { command: simCommand }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="flex flex-col gap-5" data-testid="policy-tab">
      <section aria-label="Regras de política" className="flex flex-col gap-3 rounded-xl border hairline bg-surface p-5">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex flex-col gap-0.5">
            <h2 className="m-0 font-display text-sm font-semibold">Regras de política (PreToolUse)</h2>
            <span className="text-xs text-slate">Avaliadas em Rust antes de cada ferramenta: nega vence, depois pergunta, senão permite. Regras do projeto só apertam; afrouxar só no escopo global.</span>
          </div>
          <button type="button" onClick={() => setDialogOpen(true)} className="ml-auto inline-flex items-center gap-1.5 rounded-full bg-brand px-3.5 py-2 text-[13px] font-semibold text-white hover:bg-brand-hover">
            <Plus size={14} aria-hidden /> Nova regra
          </button>
        </div>
        {error && (
          <div role="alert" className="rounded-md bg-brand-soft px-3 py-2 text-[13px] text-brand-hover">
            {error}
          </div>
        )}
        {rules === null && <p className="m-0 text-[13px] text-slate">Carregando…</p>}
        <ul className="m-0 flex list-none flex-col p-0">
          {(rules ?? []).map((rule) => (
            <li key={rule.id} className="grid grid-cols-[2.25rem_6.5rem_minmax(0,1fr)_5rem_5rem_auto] items-center gap-3 border-b hairline py-2.5 text-[13px] last:border-b-0" data-testid="policy-rule" data-rule-id={rule.id} data-enabled={rule.enabled}>
              <button
                type="button"
                role="switch"
                aria-checked={rule.enabled}
                aria-label={`Regra ${rule.reason || rule.pattern} ativa`}
                disabled={busyId === rule.id}
                onClick={() => void toggle(rule)}
                className={["relative h-[18px] w-[30px] rounded-full transition-colors", rule.enabled ? "bg-ink" : "bg-mist"].join(" ")}
              >
                <span className={["absolute top-0.5 size-3.5 rounded-full bg-surface transition-[left]", rule.enabled ? "left-[14px]" : "left-0.5"].join(" ")} />
              </button>
              <span className="text-[11px] font-semibold tracking-wider text-slate uppercase">{KIND_LABELS[rule.kind]}</span>
              <span className="flex min-w-0 flex-col gap-0.5">
                <code className="truncate font-mono text-xs" title={rule.pattern}>
                  {describePattern(rule.pattern)}
                </code>
                <span className="truncate text-xs text-slate">{rule.reason}</span>
              </span>
              <span className={["justify-self-start rounded-full px-2 py-0.5 text-[11px] font-semibold", rule.action === "deny" ? "bg-brand-soft text-brand-hover" : rule.action === "ask" ? "bg-warning-soft text-warning-ink" : "bg-success-soft text-success-ink"].join(" ")}>
                {ACTION_LABELS[rule.action]}
              </span>
              <span className="text-[11px] text-slate">{rule.scope === "global" ? "global" : (project?.name ?? "projeto")}</span>
              {rule.builtin ? (
                <span className="text-[11px] text-slate">catálogo</span>
              ) : (
                <button type="button" onClick={() => void onDelete(rule).catch((e) => setError(e instanceof Error ? e.message : String(e)))} className="text-xs font-medium text-brand-hover hover:underline">
                  Remover
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(380px,100%),1fr))] gap-5">
        <section aria-label="Testar a política" className="flex flex-col gap-2.5 rounded-xl border hairline bg-surface p-5">
          <h2 className="m-0 font-display text-sm font-semibold">Testar a política</h2>
          <span className="text-xs text-slate">Simula o que o motor faria com um comando Bash neste projeto, sem executar nada.</span>
          <div className="flex gap-2">
            <label className="sr-only" htmlFor="policy-sim">
              Comando para simular
            </label>
            <input id="policy-sim" value={simCommand} onChange={(e) => setSimCommand(e.target.value)} className="min-w-0 flex-1 rounded-sm border hairline-strong bg-surface px-2.5 py-1.5 font-mono text-xs" />
            <button type="button" onClick={() => void simulate()} className="rounded-md border hairline-strong bg-surface px-3 py-1.5 text-[13px] font-medium hover:border-ink">
              Simular
            </button>
          </div>
          {simResult && (
            <div className={["rounded-md px-3 py-2 text-[13px]", simResult.behavior === "deny" ? "bg-brand-soft text-brand-hover" : simResult.behavior === "ask" ? "bg-warning-soft text-warning-ink" : "bg-success-soft text-success-ink"].join(" ")} data-testid="policy-sim-result" data-behavior={simResult.behavior}>
              <strong>{simResult.behavior === "pass" ? "passa" : ACTION_LABELS[simResult.behavior]}</strong>
              {simResult.reason ? ` · ${simResult.reason}` : " · nenhuma regra opinou; vale o modo de permissão do run"}
            </div>
          )}
        </section>

        <section aria-label="Últimas decisões da política" className="flex flex-col gap-2 rounded-xl border hairline bg-surface p-5">
          <h2 className="m-0 font-display text-sm font-semibold">Últimas decisões da política</h2>
          {lastBlocks.length === 0 && <p className="m-0 text-[13px] text-slate">Nenhum bloqueio ou pergunta ainda. Aparecem aqui e na auditoria quando o agente tenta algo coberto por uma regra.</p>}
          <ul className="m-0 flex list-none flex-col p-0">
            {lastBlocks.slice(0, 6).map((e) => {
              const p = (e.payload ?? {}) as Record<string, unknown>;
              const input = (p.input ?? {}) as Record<string, unknown>;
              const summary = typeof input.command === "string" ? input.command : typeof input.file_path === "string" ? input.file_path : "";
              const kind = e.kind.replace("policy.", "");
              return (
                <li key={e.seq} className="flex items-baseline gap-2.5 border-b hairline py-2 text-[13px] last:border-b-0" data-testid="policy-event" data-kind={e.kind}>
                  <span className={["rounded-full px-2 py-0.5 text-[11px] font-semibold", kind === "deny" ? "bg-brand-soft text-brand-hover" : kind === "ask" ? "bg-warning-soft text-warning-ink" : "bg-success-soft text-success-ink"].join(" ")}>{kind === "deny" ? "negou" : kind === "ask" ? "perguntou" : "permitiu"}</span>
                  <span className="min-w-0 flex-1 truncate">
                    <code className="font-mono text-xs">{String(p.tool ?? "")}</code> {summary && <code className="font-mono text-xs text-slate">{summary}</code>}
                    {typeof p.reason === "string" && <span className="text-slate"> · {p.reason}</span>}
                  </span>
                  <span className="text-xs text-slate">{formatRelative(e.ts)}</span>
                </li>
              );
            })}
          </ul>
        </section>
      </div>

      <RuleDialog open={dialogOpen} project={project} onClose={() => setDialogOpen(false)} onCreate={onCreate} />
    </div>
  );
}

export function describePattern(pattern: string): string {
  if (pattern === "@destructive-outside-project") return "rm -rf / rmdir / shred fora da pasta do projeto";
  if (pattern === "@outside-project") return "qualquer caminho fora da pasta do projeto";
  return pattern;
}

function RuleDialog({ open, project, onClose, onCreate }: { open: boolean; project: Project | null; onClose: () => void; onCreate: PolicyTabProps["onCreate"] }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [kind, setKind] = useState<RuleKind>("command");
  const [pattern, setPattern] = useState("");
  const [action, setAction] = useState<RuleAction>("deny");
  const [reason, setReason] = useState("");
  const [scope, setScope] = useState<"global" | "project">("project");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setKind("command");
    setPattern("");
    setAction("deny");
    setReason("");
    setScope(project ? "project" : "global");
    setError(null);
  }, [open, project]);

  const submit = async () => {
    setError(null);
    if (!pattern.trim()) {
      setError("Informe o padrão.");
      return;
    }
    setSaving(true);
    try {
      await onCreate(scope, { kind, pattern: pattern.trim(), action, reason: reason.trim(), enabled: true });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <dialog ref={dialogRef} onClose={onClose} aria-labelledby="rule-dialog-title" className="m-auto w-[520px] max-w-[calc(100vw-32px)] rounded-xl border hairline bg-surface p-0 text-ink shadow-md backdrop:bg-black/40">
      <form
        method="dialog"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="flex flex-col gap-4 p-6"
      >
        <div className="flex flex-col gap-1">
          <div className="eyebrow text-brand">Política</div>
          <h2 id="rule-dialog-title" className="m-0 font-display text-lg font-bold tracking-tight">
            Nova regra
          </h2>
          <p className="m-0 text-[13px] text-slate">Comandos usam expressão regular; escrita, ferramenta e MCP usam globs separados por |.</p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1 text-[13px] font-medium text-slate">
            Tipo
            <select aria-label="Tipo" value={kind} onChange={(e) => setKind(e.target.value as RuleKind)} className="rounded-sm border hairline-strong bg-surface px-3 py-2 text-sm text-ink">
              {(Object.keys(KIND_LABELS) as RuleKind[]).map((k) => (
                <option key={k} value={k}>
                  {KIND_LABELS[k]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[13px] font-medium text-slate">
            Ação
            <select aria-label="Ação" value={action} onChange={(e) => setAction(e.target.value as RuleAction)} className="rounded-sm border hairline-strong bg-surface px-3 py-2 text-sm text-ink">
              <option value="deny">nega</option>
              <option value="ask">pergunta</option>
              <option value="allow" disabled={scope === "project"}>
                permite (só global)
              </option>
            </select>
          </label>
        </div>
        <label className="flex flex-col gap-1 text-[13px] font-medium text-slate">
          Padrão
          <input value={pattern} onChange={(e) => setPattern(e.target.value)} placeholder={kind === "command" ? "\\bdocker\\s+system\\s+prune\\b" : kind === "write" ? "**/migrations/V1*.sql" : "WebFetch|WebSearch"} className="rounded-sm border hairline-strong bg-surface px-3 py-2 font-mono text-[13px] text-ink" />
        </label>
        <label className="flex flex-col gap-1 text-[13px] font-medium text-slate">
          Motivo (o agente recebe este texto)
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ex.: migrações antigas são imutáveis" className="rounded-sm border hairline-strong bg-surface px-3 py-2 text-sm text-ink" />
        </label>
        <div role="radiogroup" aria-label="Escopo" className="flex rounded-md border hairline-strong p-0.5 text-[13px]">
          {(["project", "global"] as const).map((s) => (
            <button key={s} type="button" role="radio" aria-checked={scope === s} disabled={s === "project" && !project} onClick={() => { setScope(s); if (s === "project" && action === "allow") setAction("deny"); }} className={["flex-1 rounded-sm px-3 py-2 font-medium disabled:opacity-40", scope === s ? "bg-ink text-paper" : "text-slate hover:text-ink"].join(" ")}>
              {s === "project" ? `Só ${project?.name ?? "este projeto"}` : "Global (todos os projetos)"}
            </button>
          ))}
        </div>
        {error && (
          <div role="alert" className="rounded-md bg-brand-soft px-3 py-2 text-[13px] text-brand-hover">
            {error}
          </div>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="rounded-md border hairline-strong px-3.5 py-2 text-[13px] font-medium text-ink">
            Cancelar
          </button>
          <button type="submit" disabled={saving} className="rounded-full bg-brand px-4 py-2 text-[13px] font-semibold text-white hover:bg-brand-hover disabled:opacity-50">
            {saving ? "Salvando…" : "Criar regra"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
