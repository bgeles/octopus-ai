import { ChevronLeft } from "lucide-react";
import { firstLine } from "../lib/text";
import { AUTONOMY_LABELS, type ActivityItem, type AgentTotals, type Run, type Task, type TeamMember, type Workflow } from "../lib/types";
import { ActivityFeed } from "./ActivityFeed";
import { Avatar } from "./Avatar";
import { formatUsd } from "./RunSidebar";
import { formatRelative, labelFor } from "./SessionsView";
import { StatusBadge, taskLoad, type MemberStatus } from "./TeamView";

type MemberSheetProps = {
  member: TeamMember;
  team: TeamMember[];
  status: MemberStatus;
  totals: AgentTotals | null;
  runs: Run[];
  tasks?: Task[];
  /** Atividade recente deste membro (feed do projeto filtrado); null = carregando. */
  activity?: ActivityItem[] | null;
  workflows?: Workflow[];
  onOpenTask?: (taskId: string) => void;
  onOpenRunById?: (runId: string) => void;
  onPause?: (paused: boolean) => Promise<void>;
  onRunNow?: () => Promise<void>;
  onBack: () => void;
  onEdit: () => void;
  onRunAs: () => void;
  onOpenRun: (run: Run) => void;
};

const PERMISSION_LABELS: Record<string, string> = {
  default: "perguntar antes de agir",
  acceptEdits: "aceitar edições",
  plan: "somente planejar",
  dontAsk: "negar o que pediria aprovação",
  auto: "classificador automático",
};

export function MemberSheet({ member, team, status, totals, runs, tasks = [], activity = null, workflows = [], onOpenTask, onOpenRunById, onPause, onRunNow, onBack, onEdit, onRunAs, onOpenRun }: MemberSheetProps) {
  const load = taskLoad(tasks, member.profile.id);
  const boss = team.find((m) => m.profile.id === member.reportsToAgentId) ?? null;
  const delegates = team.filter((m) => m.reportsToAgentId === member.profile.id);
  const tools = member.profile.allowedTools ?? member.role.defaultTools ?? [];
  const permission = member.profile.permissionMode ?? member.role.defaultPermissionMode;
  const model = member.profile.model ?? member.role.defaultModel ?? "padrão do projeto";
  const memberRuns = runs.filter((r) => r.agentProfileId === member.profile.id);
  const cost = totals?.costUsd ?? 0;
  const budget = member.profile.maxBudgetUsd;
  const pct = budget ? Math.min(100, Math.round((cost / budget) * 100)) : 0;
  const responsibilities = member.role.responsibilitiesMd
    .split("\n")
    .map((l) => l.replace(/^-\s*/, "").trim())
    .filter(Boolean);

  return (
    <div className="flex flex-col gap-5 overflow-y-auto p-6" data-testid="member-sheet">
      <div className="flex flex-wrap items-center gap-4">
        <button type="button" onClick={onBack} className="inline-flex items-center gap-1 text-[13px] font-medium text-slate hover:text-ink">
          <ChevronLeft size={14} aria-hidden /> Time
        </button>
        <div className="flex items-center gap-3.5">
          <Avatar initials={member.profile.avatarSeed} size={56} active={status === "active"} />
          <div className="flex flex-col gap-0.5">
            <span className="eyebrow text-slate">{member.role.specialty}</span>
            <h1 className="m-0 font-display text-[22px] font-bold tracking-tight">{member.profile.name}</h1>
            <StatusBadge status={status} />
          </div>
        </div>
        <div className="ml-auto flex flex-wrap gap-2">
          <button type="button" onClick={onRunAs} className="rounded-full border-[1.5px] border-brand bg-surface px-3.5 py-2 text-[13px] font-semibold text-brand hover:bg-brand-soft">
            Dar uma tarefa
          </button>
          <button type="button" onClick={onEdit} className="rounded-md border hairline-strong bg-surface px-3.5 py-2 text-[13px] font-medium hover:border-ink">
            Editar membro
          </button>
          {onPause && (

            <button type="button" onClick={() => void onPause(status !== "paused")} className="rounded-md border hairline-strong bg-surface px-3.5 py-2 text-[13px] font-medium hover:border-ink" data-testid="member-pause">

              {status === "paused" ? "Retomar" : "Pausar"}

            </button>

          )}

          {onRunNow && (

            <button type="button" onClick={() => void onRunNow()} className="rounded-md border hairline-strong bg-surface px-3.5 py-2 text-[13px] font-medium hover:border-ink" data-testid="member-run-now">

              Rodar agora

            </button>

          )}
        </div>
      </div>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(320px,100%),1fr))] gap-4">
        <section aria-label="Responsabilidades" className="flex flex-col gap-2.5 rounded-xl border hairline bg-surface p-5">
          <h2 className="m-0 font-display text-sm font-semibold">
            Responsabilidades <span className="font-normal text-slate">· {member.role.title}</span>
          </h2>
          <ol className="m-0 flex flex-col gap-2 pl-4 text-[13px]">
            {responsibilities.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ol>
          {member.profile.instructionsMd && (
            <div className="rounded-md bg-paper px-3 py-2.5 text-[13px]">
              <div className="mb-1 text-xs font-medium text-slate">Instruções específicas</div>
              <p className="m-0 whitespace-pre-line">{member.profile.instructionsMd}</p>
            </div>
          )}
          <p className="m-0 text-xs text-slate">Estas frases entram no system prompt do agente (preset claude_code + append).</p>
        </section>

        <section aria-label="Como trabalha" className="flex flex-col gap-1 rounded-xl border hairline bg-surface p-5">
          <h2 className="m-0 mb-1.5 font-display text-sm font-semibold">Como trabalha</h2>
          <Row label="Modelo" value={model} />
          <Row label="Permissões" value={permission ? PERMISSION_LABELS[permission] ?? permission : "padrão do projeto"} />
          <Row label="Ferramentas" value={tools.length ? tools.join(" · ") : "todas"} />
          <Row label="Limites" value={[member.profile.maxTurns ? `${member.profile.maxTurns} turnos` : null, budget ? `${formatUsd(budget)} por run` : null].filter(Boolean).join(" · ") || "sem limites próprios"} />
          <Row label="Board" value={`${load.open} ${load.open === 1 ? "task aberta" : "tasks abertas"}${member.trust.canAssignTasks ? ` · criou ${load.created}` : ""}`} />
          <Row label="Confiança" value={[AUTONOMY_LABELS[member.trust.autonomy], member.trust.canAssignTasks ? "cria e atribui tasks" : null, member.trust.canApprove ? "aprova quem reporta a ele" : null].filter(Boolean).join(" · ")} />
        </section>

        <section aria-label="Delegação" className="flex flex-col gap-3 rounded-xl border hairline bg-surface p-5">
          <h2 className="m-0 font-display text-sm font-semibold">Delegação</h2>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs text-slate">Reporta a</span>
            <div className="flex items-center gap-2.5 text-[13px]">
              <Avatar initials={boss ? boss.profile.avatarSeed : "VC"} size={28} manager={!boss} />
              <span className="font-semibold">{boss ? boss.profile.name : "Você"}</span>
              <span className="text-xs text-slate">{boss ? boss.role.title : "gestor"}</span>
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs text-slate">Pode delegar para</span>
            {delegates.length === 0 && <span className="text-[13px] text-slate">ninguém ainda · edite outro membro para reportar a {member.profile.name}</span>}
            {delegates.map((d) => (
              <div key={d.id} className="flex items-center gap-2.5 text-[13px]" data-testid="delegate">
                <Avatar initials={d.profile.avatarSeed} size={28} />
                <span className="font-semibold">{d.profile.name}</span>
                <span className="text-xs text-slate">subagente · {d.role.specialty}</span>
              </div>
            ))}
          </div>
        </section>
      </div>

      <section aria-label={`Atividade de ${member.profile.name}`} className="flex flex-col gap-3 rounded-xl border hairline bg-surface p-5" data-testid="member-activity">
        <div className="flex flex-wrap items-baseline gap-3">
          <h2 className="m-0 font-display text-sm font-semibold">Atividade de {member.profile.name}</h2>
          <span className="text-xs text-slate">tasks, runs e decisões em que {member.profile.name} aparece</span>
        </div>
        <ActivityFeed items={activity} team={team} workflows={workflows} onOpenTask={onOpenTask} onOpenRun={onOpenRunById} emptyText={`Nada ainda: quando ${member.profile.name} rodar uma task, os movimentos aparecem aqui.`} />
      </section>

      <section aria-label="Runs deste membro" className="flex flex-col gap-3 rounded-xl border hairline bg-surface p-5">
        <div className="flex flex-wrap items-baseline gap-4">
          <h2 className="m-0 font-display text-sm font-semibold">Runs deste membro</h2>
          <span className="text-xs text-slate">{totals ? `${totals.runs} ${totals.runs === 1 ? "run" : "runs"} · ${totals.activeRuns} em andamento` : "nenhum run ainda"}</span>
          <span className="ml-auto font-mono text-xs">
            {formatUsd(cost)}
            {budget ? ` de ${formatUsd(budget)} por run` : ""}
          </span>
        </div>
        {budget ? (
          <div className="h-1 overflow-hidden rounded-full border hairline bg-paper">
            <div className={["h-full", pct >= 70 ? "bg-warning" : "bg-ink"].join(" ")} style={{ width: `${pct}%` }} />
          </div>
        ) : null}
        {memberRuns.length === 0 && <p className="m-0 text-[13px] text-slate">Dê uma tarefa a {member.profile.name}: o run aparece aqui e no histórico do projeto.</p>}
        <ul className="m-0 flex list-none flex-col p-0">
          {memberRuns.map((run) => (
            <li key={run.id}>
              <button type="button" onClick={() => onOpenRun(run)} className="flex w-full items-center gap-3 border-b hairline py-2.5 text-left text-[13px] last:border-b-0 hover:text-brand-hover">
                <span className={["size-2 shrink-0 rounded-full", run.status === "running" || run.status === "queued" ? "bg-brand" : run.status === "waiting_approval" ? "bg-warning" : run.status === "completed" ? "bg-success" : "bg-mist"].join(" ")} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-medium">{run.prompt}</span>
                  {firstLine(run.resultText ?? run.errorMessage) && <span className="truncate text-xs text-slate" data-testid="run-preview">{firstLine(run.resultText ?? run.errorMessage)}</span>}
                </span>
                {run.kind === "review" && <span className="rounded-full border hairline-strong px-1.5 text-[10px] text-slate">revisão</span>}
                <span className="text-xs text-slate">
                  {labelFor(run.status)} · {formatRelative(run.startedAt)}
                </span>
                <span className="font-mono text-xs">{run.costUsd === null ? "—" : formatUsd(run.costUsd)}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3 border-b hairline py-2 text-[13px] last:border-b-0">
      <span className="text-slate">{label}</span>
      <span className="text-right font-mono text-xs">{value}</span>
    </div>
  );
}
