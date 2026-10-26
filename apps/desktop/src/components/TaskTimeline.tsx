import { useState } from "react";
import { eventLabelFor } from "../lib/activity";
import { renderMarkdown } from "../lib/markdown";
import { firstLine } from "../lib/text";
import type { Run, Task, TaskEvent, TeamMember, Workflow } from "../lib/types";
import { Avatar } from "./Avatar";
import { StatusDot } from "./BoardView";
import { formatUsd } from "./RunSidebar";
import { formatRelative } from "./SessionsView";

type TaskTimelineProps = {
  task: Task;
  workflow: Workflow;
  team: TeamMember[];
  /** Runs desta task. */
  runs: Run[];
  events: TaskEvent[];
  onOpenRun: (run: Run) => void;
  onComment?: (body: string) => Promise<void>;
};

type Item = { at: string; key: string } & ({ kind: "event"; event: TaskEvent } | { kind: "run"; run: Run; events: TaskEvent[] } | { kind: "comment"; event: TaskEvent });

/** Thread da task (como a issue do Paperclip): movimentos, runs recolhíveis e seus comentários, em ordem. */
export function TaskTimeline({ task, workflow, team, runs, events, onOpenRun, onComment }: TaskTimelineProps) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stageName = (id: string | null) => workflow.stages.find((s) => s.id === id)?.name ?? id ?? "";
  const runIds = new Set(runs.map((r) => r.id));
  const items: Item[] = [];
  for (const e of events) {
    if (e.kind === "comment") items.push({ at: e.at, key: e.id, kind: "comment", event: e });
    else if (e.runId && runIds.has(e.runId) && e.kind !== "run_started" && e.kind !== "review_started") continue; // agrupado no card do run
    else if (e.kind === "run_started" || e.kind === "review_started") continue; // o card do run marca o início
    else items.push({ at: e.at, key: e.id, kind: "event", event: e });
  }
  for (const run of runs) items.push({ at: run.startedAt, key: run.id, kind: "run", run, events: events.filter((e) => e.runId === run.id && e.kind !== "comment") });
  items.sort((a, b) => a.at.localeCompare(b.at) || a.key.localeCompare(b.key));

  const submit = async () => {
    if (!onComment) return;
    const body = draft.trim();
    if (!body) return;
    setBusy(true);
    setError(null);
    try {
      await onComment(body);
      setDraft("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-1.5 border-t hairline pt-3" data-testid="task-history">
      <div className="flex items-baseline gap-2">
        <span className="text-xs font-medium text-slate">Linha do tempo</span>
        <span className="text-[11px] text-slate">movimentos, runs e seus comentários</span>
      </div>
      {items.length === 0 && <span className="text-xs text-slate">—</span>}
      {items.map((item) => {
        if (item.kind === "comment") {
          return (
            <div key={item.key} className="flex gap-2.5 rounded-md border-l-[3px] border-brand bg-paper px-3 py-2" data-testid="task-comment">
              <Avatar initials="VC" size={22} manager />
              <div className="flex min-w-0 flex-col gap-0.5 text-[13px]">
                <span className="text-[11px] text-slate">
                  <strong className="text-ink">você</strong> comentou · {formatRelative(item.at)} · entra no prompt do próximo run
                </span>
                <div className="flex flex-col gap-0.5">{renderMarkdown(item.event.note ?? "")}</div>
              </div>
            </div>
          );
        }
        if (item.kind === "run") {
          const run = item.run;
          const member = team.find((m) => m.profile.id === run.agentProfileId) ?? null;
          const stage = workflow.stages.find((s) => s.id === (item.events.find((e) => e.toStage)?.toStage ?? task.stageId));
          const preview = firstLine(run.resultText ?? run.errorMessage);
          const open = run.id === task.lockRunId || run.status === "running" || run.status === "waiting_approval";
          return (
            <details key={item.key} open={open} className="rounded-md border hairline bg-surface" data-testid="task-run">
              <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-[13px]">
                <StatusDot status={run.status === "running" || run.status === "queued" ? "running" : run.status === "waiting_approval" ? "waiting_approval" : run.status === "completed" ? "done" : "failed"} />
                {member ? <Avatar initials={member.profile.avatarSeed} size={20} active={run.status === "running"} /> : <Avatar initials="VC" size={20} manager />}
                <span className="font-semibold">{member ? member.profile.name : "Você"}</span>
                <span className="truncate text-slate">
                  · {run.kind === "review" ? "revisão" : run.kind === "report" ? "relatório" : `run${stage ? ` em ${stage.name}` : ""}`}
                </span>
                <span className="ml-auto flex shrink-0 items-center gap-2 text-xs text-slate">
                  {run.costUsd != null && <span className="font-mono">{formatUsd(run.costUsd)}</span>}
                  <span>{formatRelative(run.startedAt)}</span>
                </span>
              </summary>
              <div className="flex flex-col gap-1.5 border-t hairline px-3 py-2 text-xs">
                {preview && <p className="m-0 text-[13px] text-ink">{preview}</p>}
                {item.events.map((e) => (
                  <div key={e.id} className="flex items-baseline gap-2 text-slate">
                    <span className="font-mono">{formatRelative(e.at)}</span>
                    <span>
                      <strong className="text-ink">{e.actor}</strong> · {eventLabelFor(e, stageName)}
                      {e.note ? ` · ${e.note}` : ""}
                    </span>
                  </div>
                ))}
                <button type="button" onClick={() => onOpenRun(run)} className="self-start rounded-md border hairline-strong bg-surface px-2 py-0.5 text-[11px] font-medium hover:border-ink">
                  Abrir run
                </button>
              </div>
            </details>
          );
        }
        const e = item.event;
        return (
          <div key={item.key} className="flex items-baseline gap-2 text-xs">
            <span className="font-mono text-slate">{formatRelative(e.at)}</span>
            <span>
              <strong>{e.actor}</strong> · {eventLabelFor(e, stageName)}
              {e.note ? ` · ${e.note}` : ""}
            </span>
          </div>
        );
      })}
      {onComment && (
        <div className="mt-1 flex flex-col gap-1.5">
          <textarea aria-label="Comentário" value={draft} onChange={(e) => setDraft(e.target.value)} rows={2} placeholder="Comentar para o agente (entra no prompt do próximo run desta task)…" className="resize-y rounded-sm border hairline-strong bg-surface px-2.5 py-1.5 text-[13px]" data-testid="task-comment-input" />
          <div className="flex items-center gap-2">
            <button type="button" disabled={busy || !draft.trim()} onClick={() => void submit()} className="rounded-full bg-ink px-3 py-1 text-xs font-semibold text-paper disabled:opacity-50">
              {busy ? "Enviando…" : "Comentar"}
            </button>
            <span className="text-[11px] text-slate">Só contexto: não muda política, sandbox nem permissões.</span>
          </div>
          {error && (
            <div role="alert" className="rounded-md bg-brand-soft px-3 py-2 text-[13px] text-brand-hover">
              {error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
