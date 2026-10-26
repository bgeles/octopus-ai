import { RefreshCw } from "lucide-react";
import { MEMBER_STATUS_LABELS, type MemberStatus } from "../lib/memberState";
import type { ActivityItem, AgentTotals, Approval, BudgetStatus, GoalProgress, Project, Run, Task, TeamMember, Workflow, WorkflowReport } from "../lib/types";
import { goalPercent } from "./GoalsPanel";
import { MissionLine } from "./MissionLine";
import { WorkflowReportCard } from "./WorkflowReportCard";
import { ActivityFeed } from "./ActivityFeed";
import { Avatar } from "./Avatar";
import { DeliveriesList } from "./DeliveriesList";
import { formatUsd } from "./RunSidebar";
import { StatusBadge } from "./TeamView";

type HomeViewProps = {
  project: Project | null;
  team: TeamMember[] | null;
  totals: AgentTotals[];
  runs: Run[];
  tasks: Task[];
  workflows: Workflow[];
  approvals: Approval[] | null;
  budget: BudgetStatus | null;
  activity: ActivityItem[] | null;
  reports?: WorkflowReport[];
  /** Missão e objetivos ativos com progresso. */
  goals?: GoalProgress[];
  onEditMission?: () => void;
  onGenerateReport?: (workflow: Workflow) => Promise<void>;
  onExportReport?: (report: WorkflowReport, destination: string | null) => Promise<string>;
  statusOf: (agentProfileId: string) => MemberStatus;
  schedulerPaused: boolean;
  onOpenMember: (member: TeamMember) => void;
  onRunAs: (member: TeamMember) => void;
  onPause: (member: TeamMember, paused: boolean) => Promise<void>;
  onRunNow: (member: TeamMember) => Promise<void>;
  onOpenTask: (taskId: string) => void;
  onOpenRun: (runId: string) => void;
  onGo: (view: "approvals" | "board" | "agents") => void;
  onAddMember: () => void;
  onRefresh: () => void;
};

/** Início: o time atuando agora, o que espera você, gasto, atividade e entregas — como o Dashboard do Paperclip. */
export function HomeView({ project, team, totals, runs, tasks, workflows, approvals, budget, activity, reports = [], goals = [], onEditMission, onGenerateReport, onExportReport, statusOf, schedulerPaused, onOpenMember, onRunAs, onPause, onRunNow, onOpenTask, onOpenRun, onGo, onAddMember, onRefresh }: HomeViewProps) {
  const members = team ?? [];
  const states = new Map(members.map((m) => [m.profile.id, statusOf(m.profile.id)] as const));
  const activeMembers = members.filter((m) => states.get(m.profile.id) === "active").length;
  const pendingApprovals = approvals ? approvals.filter((a) => a.decision === null).length : 0;
  const waitingTasks = tasks.filter((t) => t.status === "waiting_approval").length;
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const deliveries = tasks.filter((t) => t.status === "done").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const deliveriesThisMonth = deliveries.filter((t) => new Date(t.updatedAt).getTime() >= monthStart.getTime()).length;
  const spent = (budget?.project.spentUsd ?? 0) + (budget?.project.liveUsd ?? 0);
  const limit = budget?.project.hardUsd ?? budget?.project.softUsd ?? null;
  const pct = limit ? Math.min(100, Math.round((spent / limit) * 100)) : 0;
  const hasWorkflow = workflows.length > 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-6" data-testid="home-view">
      <div className="flex flex-wrap items-center gap-4">
        <div>
          <div className="eyebrow text-brand">{project?.name ?? ""}</div>
          <h1 className="m-0 font-display text-xl font-bold tracking-tight">Início</h1>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <span className={["inline-flex items-center gap-1.5 rounded-full border hairline-strong px-2.5 py-1.5 text-xs font-medium", schedulerPaused ? "text-warning-ink" : ""].join(" ")}>
            <span className={["size-1.5 rounded-full", schedulerPaused ? "bg-warning" : "bg-success"].join(" ")} />
            {schedulerPaused ? "Scheduler pausado" : "Scheduler ativo"}
          </span>
          <button type="button" onClick={onRefresh} className="inline-flex items-center gap-1.5 rounded-md border hairline-strong bg-surface px-3 py-1.5 text-[13px] font-medium hover:border-ink">
            <RefreshCw size={13} aria-hidden /> Atualizar
          </button>
        </div>
      </div>

      {onEditMission && (
        <section aria-label="Missão e objetivos" className="flex flex-col gap-2 rounded-xl border hairline bg-surface px-5 py-3.5" data-testid="home-goals">
          <MissionLine project={project} onEdit={onEditMission} compact />
          {goals.filter((g) => g.status === "active").length > 0 && (
            <ul className="m-0 flex list-none flex-wrap gap-x-5 gap-y-1.5 p-0 text-xs text-slate">
              {goals.filter((g) => g.status === "active").map((g) => (
                <li key={g.id} className="flex items-center gap-2" data-testid="home-goal">
                  <span className="font-semibold text-ink">{g.title}</span>
                  <span className="h-1.5 w-24 overflow-hidden rounded-full bg-mist" aria-hidden>
                    <span className="block h-full rounded-full bg-brand" style={{ width: `${goalPercent(g)}%` }} />
                  </span>
                  <span>
                    {g.tasksDone} de {g.tasksTotal}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(200px,100%),1fr))] gap-3" data-testid="home-cards">
        <Card label="Membros em run" value={`${activeMembers}`} suffix={members.length ? `de ${members.length}` : ""} hint={members.length === 0 ? "nenhum membro ainda" : activeMembers === 0 ? "ninguém rodando agora" : members.filter((m) => states.get(m.profile.id) === "active").map((m) => m.profile.name).join(", ")} onClick={() => onGo("agents")} testId="card-active" />
        <Card label="Aguardando você" value={`${pendingApprovals + waitingTasks}`} hint={`${pendingApprovals} ${pendingApprovals === 1 ? "aprovação de ferramenta" : "aprovações de ferramenta"} · ${waitingTasks} ${waitingTasks === 1 ? "task em gate" : "tasks em gate"}`} tone={pendingApprovals + waitingTasks > 0 ? "warning" : undefined} onClick={() => {
            const firstWaiting = tasks.find((t) => t.status === "waiting_approval");
            if (pendingApprovals > 0 || !firstWaiting) onGo(pendingApprovals > 0 ? "approvals" : "board");
            else onOpenTask(firstWaiting.id);
          }} testId="card-waiting" />
        <Card label="Gasto do mês" value={formatUsd(spent)} hint={limit ? `de ${formatUsd(limit)} · ${pct}%` : "sem limite definido"} bar={limit ? pct : null} testId="card-spend" />
        <Card label="Entregas no mês" value={`${deliveriesThisMonth}`} hint={deliveries.length ? `última ${relative(deliveries[0]!.updatedAt)}` : "nenhuma ainda"} tone={deliveriesThisMonth > 0 ? "success" : undefined} onClick={() => onGo("board")} testId="card-deliveries" />
      </div>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(440px,100%),1fr))] gap-5">
        <section aria-label="Time agora" className="flex flex-col gap-2 rounded-xl border hairline bg-surface p-5" data-testid="home-team">
          <div className="flex flex-wrap items-baseline gap-3">
            <h2 className="m-0 font-display text-sm font-semibold">Time agora</h2>
            <span className="text-xs text-slate">estado de cada membro, o que faz e os controles</span>
            <button type="button" onClick={() => onGo("agents")} className="ml-auto text-xs font-semibold text-brand hover:text-brand-hover">
              Ver organograma
            </button>
          </div>
          {members.length === 0 && (
            <div className="flex flex-col items-start gap-2 rounded-lg border border-dashed hairline p-4 text-[13px] text-slate">
              <span>Ainda não há membros. Monte o time para ver quem está trabalhando aqui.</span>
              <button type="button" onClick={onAddMember} className="rounded-full bg-brand px-3.5 py-2 text-[13px] font-semibold text-white hover:bg-brand-hover">
                Adicionar membro
              </button>
            </div>
          )}
          <ul className="m-0 flex list-none flex-col p-0">
            {members.map((member) => {
              const status = states.get(member.profile.id) ?? "idle";
              const activeRun = runs.find((r) => r.agentProfileId === member.profile.id && (r.status === "running" || r.status === "queued" || r.status === "waiting_approval")) ?? null;
              const activeTask = activeRun?.taskId ? tasks.find((t) => t.id === activeRun.taskId) : null;
              const nextTask = tasks.find((t) => t.status === "ready" && t.assignedAgentId === member.profile.id) ?? null;
              const doing = activeRun
                ? activeTask
                  ? `${activeTask.title}${activeRun.kind === "review" ? " · revisão" : ""}`
                  : activeRun.prompt
                : status === "paused"
                  ? nextTask
                    ? `${nextTask.title} fica pronta esperando · pausado por você`
                    : "pausado por você"
                  : nextTask
                    ? `próxima: ${nextTask.title}`
                    : status === "error"
                      ? (totals.find((t) => t.agentProfileId === member.profile.id)?.lastRunId ? "último run falhou · veja a ficha" : "último run falhou")
                      : "sem task na fila";
              return (
                <li key={member.id} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b hairline py-2.5 last:border-b-0" data-testid="home-member" data-status={status}>
                  <Avatar initials={member.profile.avatarSeed} size={32} active={status === "active"} />
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate text-[13px] font-semibold">
                      {member.profile.name} <span className="font-normal text-slate">· {member.role.title}</span>
                    </span>
                    <span className="flex min-w-0 items-center gap-2 text-xs text-slate">
                      <StatusBadge status={status} />
                      <span className="truncate" title={doing}>
                        {doing}
                      </span>
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button type="button" onClick={() => void onPause(member, !member.profile.pausedAt)} className="rounded-md border hairline-strong bg-surface px-2.5 py-1 text-xs font-medium hover:border-ink" data-testid="home-pause">
                      {member.profile.pausedAt ? "Retomar" : "Pausar"}
                    </button>
                    {nextTask && (
                      <button type="button" onClick={() => void onRunNow(member)} className="rounded-md border hairline-strong bg-surface px-2.5 py-1 text-xs font-medium hover:border-ink" title={MEMBER_STATUS_LABELS[status]} data-testid="home-run-now">
                        Rodar agora
                      </button>
                    )}
                    <button type="button" onClick={() => onRunAs(member)} className="rounded-md border hairline-strong bg-surface px-2.5 py-1 text-xs font-medium hover:border-ink">
                      Dar uma tarefa
                    </button>
                    <button type="button" onClick={() => onOpenMember(member)} className="rounded-md border hairline-strong bg-surface px-2.5 py-1 text-xs font-medium hover:border-ink">
                      Ficha
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>

        <section aria-label="Atividade recente" className="flex flex-col gap-2 rounded-xl border hairline bg-surface p-5" data-testid="home-activity">
          <div className="flex items-baseline gap-3">
            <h2 className="m-0 font-display text-sm font-semibold">Atividade recente</h2>
            <span className="text-xs text-slate">quem fez o quê, ao vivo</span>
          </div>
          <ActivityFeed items={activity} team={members} workflows={workflows} onOpenTask={onOpenTask} onOpenRun={onOpenRun} emptyText="Nada aconteceu ainda. Dê uma tarefa a um membro ou crie uma task no Board." />
        </section>
      </div>

      {hasWorkflow && onGenerateReport && onExportReport && (
        <section aria-label="Resultado final" className="flex flex-col gap-3 rounded-xl border hairline bg-surface p-5" data-testid="home-reports">
          <div className="flex flex-wrap items-baseline gap-3">
            <h2 className="m-0 font-display text-sm font-semibold">Resultado final</h2>
            <span className="text-xs text-slate">relatório consolidado de cada workflow quando a última task conclui</span>
          </div>
          {workflows.map((wf) => (
            <WorkflowReportCard key={wf.id} report={reports.find((r) => r.workflowId === wf.id) ?? null} workflow={wf} team={members} tasksDone={tasks.filter((t) => t.workflowId === wf.id && t.status === "done").length} tasksTotal={tasks.filter((t) => t.workflowId === wf.id).length} onGenerate={() => onGenerateReport(wf)} onExport={onExportReport} onOpenTask={onOpenTask} compact />
          ))}
        </section>
      )}

      <section aria-label="Entregas recentes" className="flex flex-col gap-2 rounded-xl border hairline bg-surface p-5" data-testid="home-deliveries">
        <div className="flex flex-wrap items-baseline gap-3">
          <h2 className="m-0 font-display text-sm font-semibold">Entregas recentes</h2>
          <span className="text-xs text-slate">resultado deixado pelo agente em cada task concluída</span>
          <button type="button" onClick={() => onGo("board")} className="ml-auto text-xs font-semibold text-brand hover:text-brand-hover">
            {hasWorkflow ? "Ver todas as entregas" : "Criar um workflow"}
          </button>
        </div>
        <DeliveriesList tasks={deliveries} team={members} runs={runs} onOpenTask={(task) => onOpenTask(task.id)} limit={5} emptyText={hasWorkflow ? "Nenhuma task concluída ainda." : "Sem workflow ainda: crie um no Board para o time entregar por aqui."} />
      </section>
    </div>
  );
}

function Card({ label, value, suffix, hint, tone, bar = null, onClick, testId }: { label: string; value: string; suffix?: string; hint: string; tone?: "warning" | "success"; bar?: number | null; onClick?: () => void; testId: string }) {
  const color = tone === "warning" ? "text-warning-ink" : tone === "success" ? "text-success-ink" : "text-ink";
  const body = (
    <>
      <span className="eyebrow text-slate">{label}</span>
      <span className={["font-display text-2xl font-bold tracking-tight", color].join(" ")}>
        {value}
        {suffix ? <span className="ml-1 text-sm font-medium text-slate">{suffix}</span> : null}
      </span>
      <span className="truncate text-xs text-slate" title={hint}>
        {hint}
      </span>
      {bar !== null && (
        <div className="mt-1 h-1 overflow-hidden rounded-full border hairline bg-paper" role="progressbar" aria-label="Gasto sobre o orçamento" aria-valuenow={bar} aria-valuemin={0} aria-valuemax={100}>
          <div className={["h-full", bar >= 70 ? "bg-warning" : "bg-ink"].join(" ")} style={{ width: `${bar}%` }} />
        </div>
      )}
    </>
  );
  const cls = "flex flex-col gap-1 rounded-xl border hairline bg-surface px-4 py-3.5 text-left";
  return onClick ? (
    <button type="button" onClick={onClick} aria-label={label} className={`${cls} hover:border-ink`} data-testid={testId}>
      {body}
    </button>
  ) : (
    <div className={cls} data-testid={testId}>
      {body}
    </div>
  );
}

function relative(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "agora";
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `há ${hours} h`;
  return `há ${Math.round(hours / 24)} d`;
}
