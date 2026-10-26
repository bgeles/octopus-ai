import { firstLine } from "../lib/text";
import type { Run, Task, TeamMember } from "../lib/types";
import { shortId } from "./BoardView";
import { formatUsd } from "./RunSidebar";
import { formatRelative } from "./SessionsView";

type DeliveriesListProps = {
  /** Tasks concluídas (já filtradas), mais recentes primeiro. */
  tasks: Task[];
  team: TeamMember[];
  runs: Run[];
  selectedTaskId?: string | null;
  onOpenTask: (task: Task) => void;
  limit?: number;
  emptyText?: string;
};

/** Lista de entregas: id, título, resumo deixado pelo agente, arquivos, custo, quem e quando. */
export function DeliveriesList({ tasks, team, runs, selectedTaskId = null, onOpenTask, limit, emptyText = "Nenhuma task concluída ainda. Quando um run terminar uma task, o resumo da entrega aparece aqui." }: DeliveriesListProps) {
  const shown = limit ? tasks.slice(0, limit) : tasks;
  if (shown.length === 0) return <p className="m-0 text-[13px] text-slate">{emptyText}</p>;
  return (
    <ul className="m-0 flex list-none flex-col p-0">
      {shown.map((task) => {
        const run = runs.find((r) => r.id === task.resultRunId) ?? null;
        const member = team.find((m) => m.profile.id === (task.assignedAgentId ?? run?.agentProfileId ?? null)) ?? null;
        return (
          <li key={task.id} className="border-b hairline last:border-b-0">
            <button type="button" onClick={() => onOpenTask(task)} aria-current={selectedTaskId === task.id ? "true" : undefined} className="grid w-full grid-cols-[64px_minmax(0,1fr)_140px] items-start gap-3.5 py-3 text-left text-[13px] hover:text-brand-hover" data-testid="delivery-row">
              <span className="font-mono text-xs text-slate">{shortId(task.id)}</span>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="font-semibold text-ink">{task.title}</span>
                <span className="truncate text-slate">{firstLine(task.resultMd) ?? task.lastNote ?? "sem resumo da entrega"}</span>
                <span className="text-xs text-slate">
                  {task.filesChanged.length} {task.filesChanged.length === 1 ? "arquivo" : "arquivos"}
                  {run?.costUsd != null ? ` · ${formatUsd(run.costUsd)}` : ""}
                </span>
              </span>
              <span className="flex flex-col gap-0.5 text-right text-xs text-slate">
                <span className="font-semibold text-ink">{member ? member.profile.name : "run avulso"}</span>
                <span>{formatRelative(task.updatedAt)}</span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
