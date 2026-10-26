import { activityActor, activityLabel } from "../lib/activity";
import { truncate } from "../lib/text";
import type { ActivityItem, TeamMember, Workflow } from "../lib/types";
import { Avatar } from "./Avatar";
import { formatUsd } from "./RunSidebar";
import { formatRelative } from "./SessionsView";

type ActivityFeedProps = {
  items: ActivityItem[] | null;
  team: TeamMember[];
  workflows: Workflow[];
  onOpenTask?: (taskId: string) => void;
  onOpenRun?: (runId: string) => void;
  emptyText?: string;
  compact?: boolean;
};

/** Linha do tempo do projeto: quem fez o quê, em qual task, com custo e links. */
export function ActivityFeed({ items, team, workflows, onOpenTask, onOpenRun, emptyText = "Nada aconteceu ainda.", compact = false }: ActivityFeedProps) {
  const stageName = (id: string | null) => workflows.flatMap((w) => w.stages).find((s) => s.id === id)?.name ?? id ?? "";
  if (items === null) return <p className="m-0 text-[13px] text-slate">Carregando atividade…</p>;
  if (items.length === 0) return <p className="m-0 text-[13px] text-slate">{emptyText}</p>;
  return (
    <ul className="m-0 flex list-none flex-col p-0" data-testid="activity-feed">
      {items.map((item) => {
        const member = team.find((m) => m.profile.id === item.agentProfileId) ?? null;
        const actor = activityActor(item);
        const isHuman = actor === "você";
        const note = item.source === "run" ? item.note : item.kind === "approval.deny" || item.kind === "approval.allow" ? null : item.note;
        return (
          <li key={item.id} className={["flex items-start gap-2.5 border-b hairline last:border-b-0", compact ? "py-1.5" : "py-2.5"].join(" ")} data-testid="activity-row" data-kind={item.kind}>
            {isHuman ? <Avatar initials="VC" size={compact ? 20 : 24} manager /> : <Avatar initials={member?.profile.avatarSeed ?? (item.agentName ? item.agentName.slice(0, 2).toUpperCase() : "··")} size={compact ? 20 : 24} />}
            <div className="flex min-w-0 flex-1 flex-col gap-0.5 text-[13px]">
              <span className="min-w-0">
                <strong>{actor}</strong> · {activityLabel(item, stageName)}
                {item.taskTitle && item.taskId && (
                  <>
                    {" · "}
                    {onOpenTask ? (
                      <button type="button" onClick={() => onOpenTask(item.taskId!)} className="font-medium text-ink underline-offset-2 hover:text-brand-hover hover:underline">
                        {item.taskTitle}
                      </button>
                    ) : (
                      <span className="font-medium">{item.taskTitle}</span>
                    )}
                  </>
                )}
              </span>
              {note && !compact && <span className="truncate text-xs text-slate">{truncate(note.replace(/\s+/g, " ").trim(), 140)}</span>}
            </div>
            <span className="flex shrink-0 items-center gap-2 text-xs text-slate">
              {item.costUsd != null && <span className="font-mono">{formatUsd(item.costUsd)}</span>}
              {item.runId && onOpenRun && (
                <button type="button" onClick={() => onOpenRun(item.runId!)} className="rounded-md border hairline-strong px-1.5 py-0.5 text-[11px] hover:border-ink hover:text-ink">
                  abrir run
                </button>
              )}
              <span title={item.at}>{formatRelative(item.at)}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
