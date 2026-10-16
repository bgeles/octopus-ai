import { GitFork, Play } from "lucide-react";
import { useState } from "react";
import type { Run, SessionSummary } from "../lib/types";

type SessionsViewProps = {
  runs: Run[];
  sessions: SessionSummary[] | null;
  busySessionId: string | null;
  onOpenRun: (run: Run) => void;
  onRefresh: () => void;
  onResume: (session: SessionSummary, fork: boolean) => void;
  onRename: (sessionId: string, title: string) => Promise<void>;
  onTag: (sessionId: string, tag: string | null) => Promise<void>;
};

export function SessionsView({ runs, sessions, busySessionId, onOpenRun, onRefresh, onResume, onRename, onTag }: SessionsViewProps) {
  return (
    <div className="flex flex-col gap-6 overflow-y-auto p-6">
      <div className="flex items-center gap-4">
        <div>
          <div className="eyebrow text-brand">Histórico</div>
          <h1 className="m-0 font-display text-xl font-bold tracking-tight">Sessões</h1>
        </div>
        <button type="button" onClick={onRefresh} className="ml-auto rounded-md border hairline-strong bg-surface px-3 py-1.5 text-[13px] font-medium">
          Atualizar
        </button>
      </div>

      <section className="flex flex-col gap-2" aria-label="Sessões do Claude nesta pasta">
        <h2 className="m-0 font-display text-sm font-semibold text-slate">Sessões do Claude nesta pasta</h2>
        {sessions === null && <p className="m-0 text-[13px] text-slate">Carregando…</p>}
        {sessions && sessions.length === 0 && <p className="m-0 text-[13px] text-slate">Nenhuma sessão encontrada para esta pasta.</p>}
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {(sessions ?? []).map((s) => (
            <SessionRow key={s.sessionId} session={s} busy={busySessionId === s.sessionId} onResume={onResume} onRename={onRename} onTag={onTag} />
          ))}
        </ul>
        <p className="m-0 text-xs text-slate">Retomar continua a mesma sessão com todo o contexto; bifurcar cria uma sessão nova a partir dela, preservando a original.</p>
      </section>

      <section className="flex flex-col gap-2" aria-label="Runs deste projeto">
        <h2 className="m-0 font-display text-sm font-semibold text-slate">Runs deste projeto</h2>
        {runs.length === 0 && <p className="m-0 text-[13px] text-slate">Nenhum run ainda.</p>}
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {runs.map((run) => (
            <li key={run.id}>
              <button type="button" onClick={() => onOpenRun(run)} className="flex w-full items-center gap-3 rounded-xl border hairline bg-surface px-4 py-3 text-left hover:border-ink/30">
                <span className={["size-2 shrink-0 rounded-full", dotFor(run.status)].join(" ")} />
                <span className="min-w-0 flex-1 truncate font-medium">{run.prompt}</span>
                {run.options.resumeSessionId && (
                  <span className="rounded-full border hairline-strong px-2 text-[11px] text-slate">{run.options.forkSession ? "bifurcado" : "retomado"}</span>
                )}
                <span className="text-xs text-slate">{labelFor(run.status)}</span>
                <span className="font-mono text-xs text-slate">{run.costUsd === null ? "—" : `US$ ${run.costUsd.toFixed(2).replace(".", ",")}`}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

type RowMode = "view" | "rename" | "tag";

function SessionRow({
  session,
  busy,
  onResume,
  onRename,
  onTag,
}: {
  session: SessionSummary;
  busy: boolean;
  onResume: SessionsViewProps["onResume"];
  onRename: SessionsViewProps["onRename"];
  onTag: SessionsViewProps["onTag"];
}) {
  const [mode, setMode] = useState<RowMode>("view");
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const title = session.title ?? "(sem título)";

  const begin = (next: RowMode) => {
    setDraft(next === "rename" ? (session.title ?? "") : (session.tags[0] ?? ""));
    setMode(next);
  };

  const save = async () => {
    setSaving(true);
    try {
      if (mode === "rename") {
        const value = draft.trim();
        if (!value) return;
        await onRename(session.sessionId, value);
      } else if (mode === "tag") {
        await onTag(session.sessionId, draft.trim() || null);
      }
      setMode("view");
    } finally {
      setSaving(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void save();
    } else if (e.key === "Escape") {
      e.preventDefault();
      setMode("view");
    }
  };

  const buttonClass = "rounded-md border hairline-strong bg-surface px-3 py-1.5 text-[13px] font-medium text-ink hover:border-ink disabled:opacity-50";

  return (
    <li className={["flex flex-col gap-2.5 rounded-xl border bg-surface px-4 py-3", mode === "view" ? "hairline" : "border-ink"].join(" ")} data-testid="session-row">
      <div className="flex flex-wrap items-center gap-3">
        <span className="min-w-0 flex-1 basis-60 truncate font-medium" data-testid="session-title">
          {title}
        </span>
        {session.tags.map((t) => (
          <span key={t} className="rounded-full border hairline-strong px-2 text-xs text-ink" data-testid="session-tag">
            {t}
          </span>
        ))}
        <span className="font-mono text-[11px] text-slate">{session.sessionId.slice(0, 8)}…</span>
        {session.lastUsedAt && <span className="text-xs text-slate">{formatRelative(session.lastUsedAt)}</span>}
      </div>

      {mode === "view" && (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => onResume(session, false)}
            className="inline-flex items-center gap-1.5 rounded-full bg-brand px-3 py-1.5 text-[13px] font-semibold text-white hover:bg-brand-hover disabled:opacity-50"
          >
            <Play size={13} aria-hidden fill="currentColor" /> Retomar
          </button>
          <button type="button" disabled={busy} onClick={() => onResume(session, true)} className={["inline-flex items-center gap-1.5", buttonClass].join(" ")}>
            <GitFork size={13} aria-hidden /> Bifurcar
          </button>
          <button type="button" disabled={busy} onClick={() => begin("rename")} className={buttonClass}>
            Renomear
          </button>
          <button type="button" disabled={busy} onClick={() => begin("tag")} className={buttonClass}>
            Tag
          </button>
        </div>
      )}

      {mode !== "view" && (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <label htmlFor={`${mode}-${session.sessionId}`} className="text-xs font-medium text-slate">
            {mode === "rename" ? "Novo título" : "Tag"}
          </label>
          <input
            id={`${mode}-${session.sessionId}`}
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={mode === "rename" ? "Título da sessão" : "vazio remove a tag"}
            className={["min-w-0 rounded-sm border hairline-strong bg-surface px-2.5 py-1.5 text-[13px] text-ink", mode === "rename" ? "flex-1 basis-72" : "w-52"].join(" ")}
          />
          <button type="submit" disabled={saving || (mode === "rename" && draft.trim().length === 0)} className="rounded-full bg-ink px-3 py-1.5 text-[13px] font-semibold text-paper disabled:opacity-50">
            {saving ? "Salvando…" : "Salvar"}
          </button>
          <button type="button" onClick={() => setMode("view")} className={buttonClass}>
            Cancelar
          </button>
          <span className="text-xs text-slate">Enter salva · Esc cancela</span>
        </form>
      )}
    </li>
  );
}

function dotFor(status: Run["status"]): string {
  switch (status) {
    case "running":
    case "queued":
      return "bg-brand";
    case "waiting_approval":
      return "bg-warning";
    case "completed":
      return "bg-success";
    default:
      return "bg-mist";
  }
}

export function labelFor(status: Run["status"]): string {
  switch (status) {
    case "queued":
      return "na fila";
    case "running":
      return "executando";
    case "waiting_approval":
      return "aguardando aprovação";
    case "completed":
      return "concluído";
    case "failed":
      return "falhou";
    case "interrupted":
      return "interrompido";
  }
}

export function formatRelative(iso: string, now = Date.now()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const minutes = Math.round((now - then) / 60_000);
  if (minutes < 1) return "agora";
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `há ${hours} h`;
  const days = Math.round(hours / 24);
  return days === 1 ? "ontem" : `há ${days} dias`;
}
