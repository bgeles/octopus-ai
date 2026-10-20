import { Plus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { Transport } from "../lib/transport";
import type { CustomHookEvent, CustomHookInput, CustomHookRecord, HookRunResult, Project } from "../lib/types";

/** Eventos aceitos, na ordem do editor, com o que cada um significa. */
export const HOOK_EVENTS: { id: CustomHookEvent; label: string }[] = [
  { id: "PreToolUse", label: "PreToolUse · antes da ferramenta" },
  { id: "PostToolUse", label: "PostToolUse · depois da ferramenta" },
  { id: "UserPromptSubmit", label: "UserPromptSubmit · ao enviar instrução" },
  { id: "Stop", label: "Stop · fim do turno" },
  { id: "SubagentStop", label: "SubagentStop · fim de subagente" },
  { id: "SessionStart", label: "SessionStart · início da sessão" },
  { id: "SessionEnd", label: "SessionEnd · fim da sessão" },
  { id: "Notification", label: "Notification · aviso do agente" },
  { id: "PreCompact", label: "PreCompact · antes de compactar" },
];

const TOOL_EVENTS: CustomHookEvent[] = ["PreToolUse", "PostToolUse"];

type Draft = { id: string | null; name: string; event: CustomHookEvent; matcher: string; command: string; timeoutSec: string; scope: "project" | "global"; enabled: boolean };

const EMPTY: Draft = { id: null, name: "", event: "PreToolUse", matcher: "", command: "", timeoutSec: "30", scope: "project", enabled: true };

function toDraft(h: CustomHookRecord): Draft {
  return { id: h.id, name: h.name, event: h.event, matcher: h.matcher ?? "", command: h.command, timeoutSec: String(h.timeoutSec), scope: h.projectId ? "project" : "global", enabled: h.enabled };
}

type HooksTabProps = {
  project: Project | null;
  transport: Transport;
  onCount?: (count: number) => void;
};

export function HooksTab({ project, transport, onCount }: HooksTabProps) {
  const [hooks, setHooks] = useState<CustomHookRecord[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<HookRunResult | null>(null);
  const projectId = project?.id ?? null;

  const reload = useCallback(async () => {
    const list = await transport.invoke("list_custom_hooks", { projectId });
    setHooks(list);
    onCount?.(list.length);
  }, [transport, projectId, onCount]);

  useEffect(() => {
    setDraft(null);
    setTest(null);
    void reload().catch((e) => setError(String(e)));
  }, [reload]);

  const toInput = (d: Draft): CustomHookInput => ({
    id: d.id,
    projectId: d.scope === "project" ? projectId : null,
    name: d.name,
    event: d.event,
    matcher: TOOL_EVENTS.includes(d.event) ? d.matcher.trim() || null : null,
    command: d.command,
    timeoutSec: Number(d.timeoutSec) || 30,
    enabled: d.enabled,
  });

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const save = () =>
    act(async () => {
      if (!draft) return;
      await transport.invoke("save_custom_hook", { input: toInput(draft) });
      setDraft(null);
      setTest(null);
      await reload();
    });

  const runTest = () =>
    act(async () => {
      if (!draft || !projectId) return;
      setTest(null);
      setTest(await transport.invoke("test_custom_hook", { input: { projectId, hook: toInput(draft) } }));
    });

  const isTool = draft ? TOOL_EVENTS.includes(draft.event) : false;

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col gap-5">
        <section aria-label="Hooks livres" className="flex flex-col gap-3 rounded-xl border hairline bg-surface p-5" data-testid="custom-hooks">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex flex-col gap-0.5">
              <h2 className="m-0 font-display text-sm font-semibold">Seus hooks</h2>
              <span className="text-xs text-slate">comandos de shell que o Octopus roda em eventos do agente, além dos hooks declarativos</span>
            </div>
            <button type="button" onClick={() => { setDraft({ ...EMPTY }); setTest(null); }} disabled={!project} className="ml-auto inline-flex items-center gap-1.5 rounded-full bg-ink px-3.5 py-2 text-[13px] font-semibold text-paper disabled:opacity-40">
              <Plus size={14} aria-hidden /> Novo hook
            </button>
          </div>
          {error && (
            <div role="alert" className="rounded-md border border-brand bg-brand-soft px-3 py-2 text-[13px] text-brand-hover">
              {error}
            </div>
          )}
          {hooks && hooks.length === 0 && <p className="m-0 text-[13px] text-slate">Nenhum hook ainda. Use um para formatar código depois de editar, bloquear comandos que a política não cobre ou avisar quando o agente terminar.</p>}
          <ul className="m-0 flex list-none flex-col p-0">
            {hooks?.map((h) => (
              <li key={h.id} data-testid="hook-row" data-hook={h.name} className={["grid grid-cols-[120px_minmax(0,1fr)_80px_auto] items-center gap-3 border-b hairline py-2.5 text-[13px]", draft?.id === h.id ? "bg-paper" : ""].join(" ")}>
                <span className="flex flex-col">
                  <code className="font-mono text-xs">{h.event}</code>
                  <span className="text-[11px] text-slate">{TOOL_EVENTS.includes(h.event) ? (h.matcher ?? "todas") : "—"}</span>
                </span>
                <button type="button" onClick={() => { setDraft(toDraft(h)); setTest(null); }} className="flex min-w-0 flex-col text-left">
                  <span className="font-medium">{h.name}</span>
                  <code className="truncate font-mono text-[11px] text-slate">{h.command}</code>
                </button>
                <span className="eyebrow text-slate">{h.projectId ? "projeto" : "global"}</span>
                <input
                  type="checkbox"
                  aria-label={`Ativar ${h.name}`}
                  checked={h.enabled}
                  onChange={(e) => void act(async () => { await transport.invoke("set_custom_hook_enabled", { hookId: h.id, enabled: e.target.checked }); await reload(); })}
                  className="size-[18px] accent-ink"
                />
              </li>
            ))}
          </ul>
        </section>

        {draft && (
          <form
            aria-label={draft.id ? `Editar ${draft.name}` : "Novo hook"}
            className="flex flex-col gap-3 rounded-xl border-[1.5px] border-ink bg-surface p-5"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <label className="flex flex-col gap-1 text-xs font-medium text-slate">
              Nome
              <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Ex.: Formatar Java depois de editar" className="rounded-sm border hairline-strong bg-surface px-2.5 py-1.5 text-[13px] text-ink" />
            </label>
            <div className="grid grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_96px] gap-3">
              <label className="flex flex-col gap-1 text-xs font-medium text-slate">
                Evento
                <select value={draft.event} onChange={(e) => setDraft({ ...draft, event: e.target.value as CustomHookEvent })} className="rounded-sm border hairline-strong bg-surface px-2.5 py-1.5 text-[13px] text-ink">
                  {HOOK_EVENTS.map((ev) => (
                    <option key={ev.id} value={ev.id}>
                      {ev.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium text-slate">
                Ferramentas (regex)
                <input value={isTool ? draft.matcher : ""} disabled={!isTool} onChange={(e) => setDraft({ ...draft, matcher: e.target.value })} placeholder={isTool ? "todas" : "só para eventos de ferramenta"} className="rounded-sm border hairline-strong bg-surface px-2.5 py-1.5 font-mono text-[13px] text-ink disabled:bg-paper" />
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium text-slate">
                Tempo limite (s)
                <input value={draft.timeoutSec} inputMode="numeric" onChange={(e) => setDraft({ ...draft, timeoutSec: e.target.value })} className="rounded-sm border hairline-strong bg-surface px-2.5 py-1.5 text-[13px] text-ink" />
              </label>
            </div>
            <label className="flex flex-col gap-1 text-xs font-medium text-slate">
              Comando (roda com /bin/sh na pasta do projeto)
              <textarea value={draft.command} rows={3} onChange={(e) => setDraft({ ...draft, command: e.target.value })} placeholder="./mvnw -q spotless:apply" className="resize-y rounded-sm border hairline-strong bg-surface px-2.5 py-2 font-mono text-xs text-ink" />
            </label>
            <div className="flex flex-wrap items-center gap-3">
              <fieldset className="m-0 flex gap-3 border-0 p-0 text-[13px]">
                <legend className="sr-only">Escopo</legend>
                <label className="flex items-center gap-1.5">
                  <input type="radio" name="hook-scope" checked={draft.scope === "project"} onChange={() => setDraft({ ...draft, scope: "project" })} className="accent-ink" />
                  Este projeto
                </label>
                <label className="flex items-center gap-1.5">
                  <input type="radio" name="hook-scope" checked={draft.scope === "global"} onChange={() => setDraft({ ...draft, scope: "global" })} className="accent-ink" />
                  Todos os projetos
                </label>
              </fieldset>
              <div className="ml-auto flex flex-wrap gap-2">
                {draft.id && (
                  <button type="button" disabled={busy} onClick={() => void act(async () => { await transport.invoke("delete_custom_hook", { hookId: draft.id! }); setDraft(null); setTest(null); await reload(); })} className="rounded-full border border-brand bg-surface px-3.5 py-2 text-[13px] font-semibold text-brand hover:bg-brand-soft disabled:opacity-50">
                    Remover
                  </button>
                )}
                <button type="button" onClick={() => setDraft(null)} className="rounded-full border hairline-strong bg-surface px-3.5 py-2 text-[13px] font-medium">
                  Cancelar
                </button>
                <button type="button" disabled={busy || !draft.command.trim() || !draft.name.trim()} onClick={() => void runTest()} className="rounded-full border hairline-strong bg-surface px-3.5 py-2 text-[13px] font-medium disabled:opacity-50">
                  Testar com exemplo
                </button>
                <button type="submit" disabled={busy} className="rounded-full bg-ink px-3.5 py-2 text-[13px] font-semibold text-paper disabled:opacity-50">
                  Salvar
                </button>
              </div>
            </div>
            {test && (
              <div data-testid="hook-test" data-outcome={test.outcome} className={["flex flex-col gap-1 rounded-lg border bg-paper p-3 font-mono text-[11px] leading-relaxed text-ink", test.outcome === "ok" ? "hairline" : "border-brand"].join(" ")}>
                <span>
                  saída {test.exitCode ?? "—"} em {test.durationMs} ms → {test.outcome === "blocked" ? (draft.event === "PreToolUse" ? "nega" : "bloqueia") : test.outcome === "ok" ? "segue" : test.outcome === "timeout" ? "tempo esgotado" : "erro"}
                  {test.message ? `: ${test.message}` : ""}
                </span>
                {test.stdout.trim() && <span className="whitespace-pre-wrap opacity-70">stdout: {test.stdout.trim()}</span>}
              </div>
            )}
          </form>
        )}
      </div>

      <div className="flex min-w-0 flex-col gap-5">
        <section aria-label="Como o Octopus roda um hook" className="flex flex-col gap-2 rounded-xl border hairline bg-surface p-5">
          <h2 className="m-0 font-display text-sm font-semibold">Como o Octopus roda um hook</h2>
          <dl className="m-0 grid grid-cols-[110px_minmax(0,1fr)] gap-x-3 text-[13px]">
            <dt className="border-b hairline py-2 text-slate">Entrada</dt>
            <dd className="m-0 border-b hairline py-2">o JSON do evento chega no stdin, igual ao Claude Code</dd>
            <dt className="border-b hairline py-2 text-slate">Saída 0</dt>
            <dd className="m-0 border-b hairline py-2">segue; um JSON no stdout pode acrescentar contexto ao agente</dd>
            <dt className="border-b hairline py-2 text-slate">Saída 2</dt>
            <dd className="m-0 border-b hairline py-2">bloqueia; o stderr vira o motivo que o agente lê</dd>
            <dt className="border-b hairline py-2 text-slate">Outra saída</dt>
            <dd className="m-0 border-b hairline py-2">erro sem bloquear; aparece na transcrição</dd>
            <dt className="py-2 text-slate">Tempo limite</dt>
            <dd className="m-0 py-2">o processo é encerrado e o run segue</dd>
          </dl>
        </section>
        <section aria-label="O que um hook livre não faz" className="flex flex-col gap-2 rounded-xl border hairline bg-surface p-5">
          <h2 className="m-0 font-display text-sm font-semibold">O que um hook livre não faz</h2>
          <p className="m-0 text-[13px]">
            Num PreToolUse ele só pode <strong>negar</strong> ou <strong>pedir aprovação</strong>. Ele não libera o que a política bloqueia nem reescreve a entrada da ferramenta.
          </p>
          <p className="m-0 text-xs text-slate">O comando roda com as suas permissões, fora do sandbox do agente. Cada criação, alteração e bloqueio fica na auditoria.</p>
        </section>
      </div>
    </div>
  );
}
