import { useState } from "react";
import { copyText, renderMarkdown } from "../lib/markdown";
import { isTauri } from "../lib/transport";
import type { TeamMember, Workflow, WorkflowReport } from "../lib/types";
import { Avatar } from "./Avatar";
import { formatUsd } from "./RunSidebar";
import { formatRelative } from "./SessionsView";

type WorkflowReportCardProps = {
  report: WorkflowReport | null;
  workflow: Workflow;
  team: TeamMember[];
  tasksDone: number;
  tasksTotal: number;
  onGenerate: () => Promise<void>;
  onExport: (report: WorkflowReport, destination: string | null) => Promise<string>;
  onOpenTask: (taskId: string) => void;
  /** Versão compacta (Início). */
  compact?: boolean;
};

/** O "resultado final" de um workflow: resumo executivo, entregas por task, custo, membros e exportação. */
export function WorkflowReportCard({ report, workflow, team, tasksDone, tasksTotal, onGenerate, onExport, onOpenTask, compact = false }: WorkflowReportCardProps) {
  const [busy, setBusy] = useState<"generate" | "export" | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = (kind: "generate" | "export", fn: () => Promise<unknown>) => {
    setBusy(kind);
    setError(null);
    fn()
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(null));
  };
  const exportMd = async (r: WorkflowReport) => {
    if (isTauri()) {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const chosen = await save({ title: "Exportar relatório", defaultPath: `relatorio-${workflow.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-${new Date().toISOString().slice(0, 10)}.md`, filters: [{ name: "Markdown", extensions: ["md"] }] });
      if (!chosen) return;
      await onExport(r, chosen);
    } else {
      // Fora do Tauri (mock/navegador): copia o markdown.
      const md = await onExport(r, null);
      await copyText(md);
    }
  };

  if (!report) {
    return (
      <section aria-label="Relatório final" className="flex flex-col gap-2 rounded-xl border border-dashed hairline bg-surface px-5 py-4" data-testid="workflow-report">
        <div className="flex flex-wrap items-center gap-3">
          <span className="eyebrow text-slate">Relatório final</span>
          <span className="text-[13px] text-slate">
            {tasksTotal === 0 ? "Sem tasks ainda." : `${tasksDone} de ${tasksTotal} ${tasksTotal === 1 ? "task concluída" : "tasks concluídas"}.`} Quando a última concluir, o relatório aparece aqui.
          </span>
          <button type="button" disabled={busy !== null || tasksTotal === 0} onClick={() => run("generate", onGenerate)} className="ml-auto rounded-md border hairline-strong bg-surface px-3 py-1.5 text-[13px] font-medium hover:border-ink disabled:opacity-50" data-testid="report-generate">
            {busy === "generate" ? "Gerando…" : "Gerar relatório agora"}
          </button>
        </div>
        {error && (
          <div role="alert" className="rounded-md bg-brand-soft px-3 py-2 text-[13px] text-brand-hover">
            {error}
          </div>
        )}
      </section>
    );
  }

  const members = report.members.map((m) => ({ ...m, member: team.find((t) => t.profile.id === m.agentProfileId) ?? null }));
  const duration = report.startedAt && report.finishedAt ? durationLabel(report.startedAt, report.finishedAt) : null;
  const summary = report.summaryMd?.trim() ?? "";
  const complete = report.tasksDone === report.tasksTotal;
  return (
    <section aria-label="Relatório final" className={["flex flex-col gap-3 rounded-xl border bg-surface px-5 py-4", complete ? "border-[1.5px] border-success" : "hairline"].join(" ")} data-testid="workflow-report">
      <div className="flex flex-wrap items-center gap-2.5">
        <span className={["eyebrow", complete ? "text-success-ink" : "text-slate"].join(" ")}>
          Relatório final · geração {report.generation} · {formatRelative(report.createdAt)}
        </span>
        <span className="text-xs text-slate">{report.trigger === "auto" ? "gerado quando a última task concluiu" : "gerado por você"}</span>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <button type="button" onClick={() => void copyText(report.summaryMd ? `${report.bodyMd}\n\n## Resumo executivo\n\n${report.summaryMd}` : report.bodyMd).then((ok) => ok && (setCopied(true), setTimeout(() => setCopied(false), 1500)))} className="rounded-md border hairline-strong bg-surface px-2.5 py-1 text-xs font-medium hover:border-ink">
            {copied ? "Copiado" : "Copiar"}
          </button>
          <button type="button" disabled={busy !== null} onClick={() => run("export", () => exportMd(report))} className="rounded-md border hairline-strong bg-surface px-2.5 py-1 text-xs font-medium hover:border-ink disabled:opacity-50" data-testid="report-export">
            {busy === "export" ? "Exportando…" : "Exportar .md"}
          </button>
          <button type="button" disabled={busy !== null} onClick={() => run("generate", onGenerate)} className="rounded-full bg-ink px-3 py-1 text-xs font-semibold text-paper disabled:opacity-50" data-testid="report-generate">
            {busy === "generate" ? "Gerando…" : "Atualizar relatório"}
          </button>
        </div>
      </div>
      {!compact && <h3 className="m-0 font-display text-base font-bold tracking-tight">{workflow.name}</h3>}
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <span className="rounded-full border hairline-strong px-2 py-0.5" data-testid="report-progress">
          {report.tasksDone} de {report.tasksTotal} {report.tasksTotal === 1 ? "task" : "tasks"}
        </span>
        <span className="rounded-full border hairline-strong px-2 py-0.5 font-mono">{formatUsd(report.costUsd)}</span>
        {duration && <span className="rounded-full border hairline-strong px-2 py-0.5">{duration}</span>}
        {members.length > 0 && (
          <span className="ml-1 inline-flex items-center gap-1">
            {members.map((m) => (
              <Avatar key={m.agentProfileId} initials={m.member?.profile.avatarSeed ?? m.name.slice(0, 2).toUpperCase()} size={20} label={m.name} />
            ))}
            <span className="ml-1 text-slate">{members.map((m) => m.name).join(", ")}</span>
          </span>
        )}
      </div>
      {(report.summaryStatus !== "none" || summary) && (
        <div className="flex flex-col gap-1.5 rounded-lg border-l-[3px] border-success bg-paper px-3.5 py-3" data-testid="report-summary" data-status={report.summaryStatus}>
          <span className="eyebrow text-slate">Resumo executivo · Haiku</span>
          {summary ? (
            <div className="flex flex-col gap-1 text-[14px] leading-relaxed">{renderMarkdown(summary)}</div>
          ) : report.summaryStatus === "failed" ? (
            <p className="m-0 text-[13px] text-slate">Resumo indisponível (o run do Haiku falhou). O relatório completo está abaixo.</p>
          ) : (
            <p className="m-0 text-[13px] text-slate">Resumo em preparação com o Haiku…</p>
          )}
        </div>
      )}
      <details open={!compact && !summary} className="text-[13px]">
        <summary className="cursor-pointer text-slate">
          Relatório completo · {report.tasks.filter((t) => t.done).length} {report.tasks.filter((t) => t.done).length === 1 ? "entrega" : "entregas"}
        </summary>
        <div className="mt-2 flex flex-col gap-2">
          {report.tasks.length > 0 && (
            <ul className="m-0 flex list-none flex-col gap-1 p-0" data-testid="report-tasks">
              {report.tasks.map((t) => (
                <li key={t.taskId} className="flex items-center gap-2 text-xs">
                  <span className={["size-1.5 rounded-full", t.done ? "bg-success" : "bg-mist"].join(" ")} />
                  <button type="button" onClick={() => onOpenTask(t.taskId)} className="font-medium text-ink underline-offset-2 hover:text-brand-hover hover:underline">
                    {t.title}
                  </button>
                  <span className="text-slate">
                    {t.memberName ?? "run avulso"} · {formatUsd(t.costUsd)} · {t.filesChanged.length} {t.filesChanged.length === 1 ? "arquivo" : "arquivos"}
                    {t.done ? "" : ` · ${t.status}`}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-col gap-1 rounded-md bg-paper px-3.5 py-3 text-[13px] leading-relaxed" data-testid="report-body">
            {renderMarkdown(report.bodyMd)}
          </div>
        </div>
      </details>
      {error && (
        <div role="alert" className="rounded-md bg-brand-soft px-3 py-2 text-[13px] text-brand-hover">
          {error}
        </div>
      )}
    </section>
  );
}

function durationLabel(start: string, end: string): string {
  const mins = Math.max(0, Math.round((new Date(end).getTime() - new Date(start).getTime()) / 60_000));
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)} h ${mins % 60} min`;
}
