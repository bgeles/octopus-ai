import { PackageCheck, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { eventLabelFor } from "../lib/activity";
import { copyText, renderMarkdown } from "../lib/markdown";
import { firstLine } from "../lib/text";
import type { Project, Run, Stage, StageApprover, Task, TaskDiff, TaskEvent, TaskStatus, TeamMember, Workflow, WorkflowTemplate } from "../lib/types";
import { Avatar } from "./Avatar";
import { DiffView } from "./DiffView";
import { formatUsd } from "./RunSidebar";
import { formatRelative } from "./SessionsView";

type BoardViewProps = {
  project: Project | null;
  workflows: Workflow[] | null;
  templates: WorkflowTemplate[];
  tasks: Task[];
  team: TeamMember[];
  runs: Run[];
  selectedWorkflowId: string | null;
  onSelectWorkflow: (id: string) => void;
  onCreateFromTemplate: (templateId: string, useWorktrees: boolean) => Promise<void>;
  onNewTask: () => void;
  onOpenTask: (task: Task) => void;
  /** Diff do trabalho da task (worktree ou projeto) contra o commit base. */
  onLoadDiff: (task: Task) => Promise<TaskDiff>;
  /** Quem aprova num estágio gate: você ou a política de confiança do responsável. */
  onSetGateApprover: (workflow: Workflow, stage: Stage, approver: StageApprover) => Promise<void>;
  schedulerPaused: boolean;
  onTogglePaused: () => void;
  onTick: () => void;
  selectedTask: Task | null;
  taskEvents: TaskEvent[];
  onApprove: (task: Task, note: string | null) => Promise<void>;
  onReturn: (task: Task, stageId: string, note: string | null) => Promise<void>;
  onMove: (task: Task, stageId: string | null, status: TaskStatus, note: string | null) => Promise<void>;
  onOpenRun: (run: Run) => void;
  onCloseTask: () => void;
};

export const STATUS_LABELS: Record<TaskStatus, string> = {
  backlog: "backlog",
  ready: "pronta",
  running: "em run",
  waiting_approval: "aguardando você",
  review: "em revisão",
  done: "concluída",
  blocked: "bloqueada",
  failed: "falhou",
};

/** Rótulo do status; em revisão por agente, diz quem está revisando. */
export function statusLabel(task: Task, team: TeamMember[], stage?: Stage | null): string {
  if (task.status === "review" && task.approverAgentId) {
    const reviewer = team.find((m) => m.profile.id === task.approverAgentId);
    return `em revisão por ${reviewer?.profile.name ?? "um membro"}`;
  }
  if (task.status === "ready") {
    const effective = team.find((m) => m.profile.id === (task.assignedAgentId ?? stage?.agentProfileId ?? null));
    if (effective?.profile.pausedAt) return `pronta · ${effective.profile.name} pausado`;
  }
  return STATUS_LABELS[task.status];
}

export function BoardView(props: BoardViewProps) {
  const { project, workflows, templates, tasks, team, runs, selectedWorkflowId, onSelectWorkflow, onNewTask, onOpenTask, schedulerPaused, onTogglePaused, onTick, selectedTask } = props;
  const [useWorktrees, setUseWorktrees] = useState(false);
  const [creating, setCreating] = useState<string | null>(null);
  const [boardView, setBoardView] = useState<"kanban" | "deliveries">("kanban");
  const workflow = workflows?.find((w) => w.id === selectedWorkflowId) ?? workflows?.[0] ?? null;
  const wfTasks = workflow ? tasks.filter((t) => t.workflowId === workflow.id) : [];
  const deliveries = wfTasks.filter((t) => t.status === "done").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const memberOf = (id: string | null) => (id ? (team.find((m) => m.profile.id === id) ?? null) : null);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-6" data-testid="board-view">
      <div className="flex flex-wrap items-center gap-4">
        <div>
          <div className="eyebrow text-brand">{project?.name ?? ""} · Orquestração</div>
          <h1 className="m-0 font-display text-xl font-bold tracking-tight">{workflow ? `Workflow "${workflow.name}"` : "Board"}</h1>
        </div>
        {workflow && (
          <div role="radiogroup" aria-label="Vista" className="flex rounded-lg border hairline-strong p-0.5 text-[13px]">
            {(["kanban", "deliveries"] as const).map((v) => (
              <button key={v} type="button" role="radio" aria-checked={boardView === v} onClick={() => setBoardView(v)} className={["rounded-md px-3 py-1.5 font-medium", boardView === v ? "bg-ink text-paper" : "text-slate hover:text-ink"].join(" ")}>
                {v === "kanban" ? "Kanban" : `Entregas · ${deliveries.length}`}
              </button>
            ))}
          </div>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {workflows && workflows.length > 1 && (
            <select aria-label="Workflow" value={workflow?.id ?? ""} onChange={(e) => onSelectWorkflow(e.target.value)} className="rounded-sm border hairline-strong bg-surface px-2 py-1.5 text-[13px]">
              {workflows.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          )}
          <span className={["inline-flex items-center gap-1.5 rounded-full border hairline-strong px-2.5 py-1.5 text-xs font-medium", schedulerPaused ? "text-warning-ink" : ""].join(" ")} data-testid="scheduler-status">
            <span className={["size-1.5 rounded-full", schedulerPaused ? "bg-warning" : "bg-success"].join(" ")} />
            {schedulerPaused ? "Scheduler pausado" : `Scheduler ativo · ${workflow?.maxParallel ?? 1} run por vez`}
          </span>
          <button type="button" onClick={onTogglePaused} className="rounded-md border hairline-strong bg-surface px-3 py-1.5 text-[13px] font-medium hover:border-ink">
            {schedulerPaused ? "Retomar scheduler" : "Pausar scheduler"}
          </button>
          <button type="button" onClick={onTick} className="rounded-md border hairline-strong bg-surface px-3 py-1.5 text-[13px] font-medium hover:border-ink" title="Verificar agora se há tasks prontas">
            Rodar agora
          </button>
          {workflow && (
            <button type="button" onClick={onNewTask} className="inline-flex items-center gap-1.5 rounded-full bg-brand px-3.5 py-2 text-[13px] font-semibold text-white hover:bg-brand-hover">
              <Plus size={14} aria-hidden /> Nova task
            </button>
          )}
        </div>
      </div>

      {workflows && workflows.length === 0 && (
        <section aria-label="Começar um workflow" className="flex flex-col gap-4 rounded-xl border hairline bg-surface p-6">
          <div>
            <h2 className="m-0 font-display text-sm font-semibold">Escolha um modelo de workflow</h2>
            <p className="m-0 mt-1 text-[13px] text-slate">Cada estágio tem um responsável do time (pelo cargo) e o último pode ser um gate humano. Dá para editar depois.</p>
          </div>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(320px,100%),1fr))] gap-3">
            {templates.map((t) => (
              <article key={t.id} className="flex flex-col gap-3 rounded-xl border hairline p-4" data-testid="workflow-template">
                <h3 className="m-0 font-display text-[15px] font-bold">{t.name}</h3>
                <div className="flex flex-wrap items-center gap-1.5 text-xs">
                  {t.stages.map((s, i) => (
                    <span key={s.name} className="inline-flex items-center gap-1.5">
                      <span className={["rounded-full px-2 py-0.5", s.gate ? "bg-warning-soft text-warning-ink" : "border hairline-strong"].join(" ")}>
                        {s.name}
                        {s.roleTitle ? ` · ${s.roleTitle}` : s.gate ? " · você" : ""}
                      </span>
                      {i < t.stages.length - 1 && <span className="text-slate">→</span>}
                    </span>
                  ))}
                </div>
                <button
                  type="button"
                  disabled={creating !== null}
                  onClick={() => {
                    setCreating(t.id);
                    void props.onCreateFromTemplate(t.id, useWorktrees).finally(() => setCreating(null));
                  }}
                  className="self-start rounded-full bg-ink px-3.5 py-2 text-[13px] font-semibold text-paper disabled:opacity-50"
                >
                  {creating === t.id ? "Criando…" : "Usar este workflow"}
                </button>
              </article>
            ))}
          </div>
          <label className="flex items-center gap-2 text-[13px]">
            <input type="checkbox" checked={useWorktrees} onChange={(e) => setUseWorktrees(e.target.checked)} />
            Usar um worktree git por task (.octopus/worktrees/&lt;task&gt;)
          </label>
        </section>
      )}

      {workflow && (
        <>
          <section aria-label="Estágios do workflow" className="flex flex-wrap items-stretch gap-2.5 rounded-xl border hairline bg-surface p-4">
            {workflow.stages.map((stage, i) => {
              const inStage = wfTasks.filter((t) => t.stageId === stage.id);
              const running = inStage.some((t) => t.status === "running");
              const waiting = inStage.some((t) => t.status === "waiting_approval" || t.status === "review");
              const member = memberOf(stage.agentProfileId);
              return (
                <div key={stage.id} className="flex items-center gap-2.5">
                  <div className={["flex min-w-[180px] flex-col gap-1.5 rounded-lg border px-3.5 py-3", running ? "border-[1.5px] border-brand" : waiting ? "border-[1.5px] border-warning" : "hairline"].join(" ")} data-testid="stage-chip">
                    <div className="flex items-center gap-2">
                      <span className={["size-2 rounded-full", running ? "animate-pulse bg-brand" : waiting ? "bg-warning" : inStage.some((t) => t.status === "done") ? "bg-success" : "bg-mist"].join(" ")} />
                      <span className="font-display text-[13px] font-bold">{stage.name}</span>
                      {stage.gate && (
                        <button
                          type="button"
                          onClick={() => void props.onSetGateApprover(workflow, stage, (stage.approver ?? "human") === "human" ? "policy" : "human")}
                          title={(stage.approver ?? "human") === "human" ? "Gate humano: espera você. Clique para seguir a política de confiança do responsável." : "Gate por política: supervisionado → você; gerenciado → o gestor; autônomo → o gestor ou auto-aprova. Clique para voltar a esperar você."}
                          className={["rounded-full px-1.5 text-[10px] font-semibold", (stage.approver ?? "human") === "human" ? "bg-warning-soft text-warning-ink" : "bg-success-soft text-success-ink"].join(" ")}
                          data-testid="gate-approver"
                        >
                          {(stage.approver ?? "human") === "human" ? "gate: você" : "gate: por política"}
                        </button>
                      )}
                      <span className="ml-auto text-xs text-slate">{inStage.length}</span>
                    </div>
                    <div className="flex items-center gap-1.5 text-xs text-slate">
                      {stage.gate ? <Avatar initials="VC" size={20} manager /> : member ? <Avatar initials={member.profile.avatarSeed} size={20} active={running} /> : null}
                      <span>{stage.gate ? ((stage.approver ?? "human") === "human" ? "Você" : "você ou o gestor do responsável") : member ? `${member.profile.name} · ${member.role.title}` : "sem responsável (run avulso)"}</span>
                    </div>
                  </div>
                  {i < workflow.stages.length - 1 && <span className="text-slate">→</span>}
                </div>
              );
            })}
          </section>

          <div className="flex min-h-0 flex-wrap gap-5">
            {boardView === "deliveries" && (
              <section aria-label="Entregas" className="flex min-w-0 flex-1 basis-[480px] flex-col gap-2 rounded-xl border hairline bg-surface p-5" data-testid="deliveries">
                <div className="flex items-baseline gap-3">
                  <h2 className="m-0 font-display text-sm font-semibold">Entregas</h2>
                  <span className="text-xs text-slate">tasks concluídas, mais recentes primeiro · resultado deixado pelo agente</span>
                </div>
                {deliveries.length === 0 && <p className="m-0 text-[13px] text-slate">Nenhuma task concluída ainda. Quando um run terminar uma task, o resumo da entrega aparece aqui.</p>}
                <ul className="m-0 flex list-none flex-col p-0">
                  {deliveries.map((task) => {
                    const member = memberOf(task.assignedAgentId ?? runs.find((r) => r.id === task.resultRunId)?.agentProfileId ?? null);
                    const run = runs.find((r) => r.id === task.resultRunId) ?? null;
                    return (
                      <li key={task.id} className="border-b hairline last:border-b-0">
                        <button type="button" onClick={() => onOpenTask(task)} aria-current={selectedTask?.id === task.id ? "true" : undefined} className="grid w-full grid-cols-[64px_minmax(0,1fr)_140px] items-start gap-3.5 py-3 text-left text-[13px] hover:text-brand-hover" data-testid="delivery-row">
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
              </section>
            )}
            <section aria-label="Tasks por estágio" className={["grid min-w-0 flex-1 basis-[640px] grid-cols-[repeat(auto-fit,minmax(min(220px,100%),1fr))] gap-3", boardView === "deliveries" ? "hidden" : ""].join(" ")} data-testid="kanban" hidden={boardView === "deliveries"}>
              {workflow.stages.map((stage) => {
                const inStage = wfTasks.filter((t) => t.stageId === stage.id);
                return (
                  <div key={stage.id} className="flex min-w-0 flex-col gap-2" data-testid="kanban-column">
                    <div className="flex items-center gap-2 px-1">
                      <h2 className="m-0 font-display text-[13px] font-semibold">{stage.name}</h2>
                      <span className="text-xs text-slate">{inStage.length}</span>
                    </div>
                    {inStage.length === 0 && <div className="rounded-lg border border-dashed hairline p-3 text-center text-xs text-slate">vazio</div>}
                    {inStage.map((task) => (
                      <TaskCard key={task.id} task={task} stage={stage} member={memberOf(task.assignedAgentId ?? stage.agentProfileId)} team={team} run={runs.find((r) => r.id === task.lockRunId) ?? null} selected={selectedTask?.id === task.id} onOpen={() => onOpenTask(task)} />
                    ))}
                  </div>
                );
              })}
            </section>

            {selectedTask && workflow && (
              <TaskDetail task={selectedTask} workflow={workflow} team={team} runs={runs} events={props.taskEvents} tasks={tasks} onApprove={props.onApprove} onReturn={props.onReturn} onMove={props.onMove} onOpenRun={props.onOpenRun} onLoadDiff={props.onLoadDiff} onClose={props.onCloseTask} />
            )}
          </div>
        </>
      )}

      {workflows === null && <p className="m-0 text-[13px] text-slate">Carregando workflows…</p>}
    </div>
  );
}

function TaskCard({ task, stage, member, team, run, selected, onOpen }: { task: Task; stage?: Stage; member: TeamMember | null; team: TeamMember[]; run: Run | null; selected: boolean; onOpen: () => void }) {
  const border = task.status === "running" ? "border-[1.5px] border-brand" : task.status === "waiting_approval" || task.status === "review" ? "border-[1.5px] border-warning" : task.status === "failed" || task.status === "blocked" ? "border-[1.5px] border-brand/50" : selected ? "border-ink" : "hairline";
  return (
    <button type="button" onClick={onOpen} className={["flex flex-col gap-2 rounded-lg border bg-surface px-3.5 py-3 text-left hover:border-ink", border].join(" ")} data-testid="task-card" data-status={task.status} aria-current={selected ? "true" : undefined}>
      <div className="flex items-center gap-2">
        <StatusDot status={task.status} />
        <span className="text-[11px] font-semibold text-slate" data-testid={statusLabel(task, team, stage).includes("pausado") ? "paused-reason" : undefined}>{statusLabel(task, team, stage)}</span>
        {task.resultMd && <PackageCheck size={13} aria-label="com entrega" className="text-success-ink" />}
        <span className="ml-auto font-mono text-[11px] text-slate">{shortId(task.id)}</span>
      </div>
      <span className="text-[13px] font-semibold">{task.title}</span>
      <div className="flex items-center gap-2 text-xs text-slate">
        {member ? <Avatar initials={member.profile.avatarSeed} size={20} active={task.status === "running"} /> : <Avatar initials="VC" size={20} manager />}
        <span className="truncate">{member ? member.profile.name : "Você"}</span>
        {task.createdByAgentId && <span className="truncate text-[11px]" data-testid="created-by">· criada por {team.find((m) => m.profile.id === task.createdByAgentId)?.profile.name ?? "agente"}</span>}
        {run?.costUsd != null && <span className="ml-auto font-mono">{formatUsd(run.costUsd)}</span>}
        {task.dependsOn.length > 0 && <span className="ml-auto" title={`Depende de ${task.dependsOn.join(", ")}`}>↳ {task.dependsOn.length}</span>}
      </div>
    </button>
  );
}

export function StatusDot({ status }: { status: TaskStatus }) {
  const cls = status === "running" ? "animate-pulse bg-brand" : status === "waiting_approval" || status === "review" ? "bg-warning" : status === "done" ? "bg-success" : status === "failed" || status === "blocked" ? "bg-brand" : "bg-mist";
  return <span className={["size-2 shrink-0 rounded-full", cls].join(" ")} />;
}

export function shortId(id: string): string {
  return id.replace(/^task_/, "T-").slice(0, 10);
}

function TaskDetail({ task, workflow, team, runs, events, tasks, onApprove, onReturn, onMove, onOpenRun, onLoadDiff, onClose }: { task: Task; workflow: Workflow; team: TeamMember[]; runs: Run[]; events: TaskEvent[]; tasks: Task[]; onApprove: BoardViewProps["onApprove"]; onReturn: BoardViewProps["onReturn"]; onMove: BoardViewProps["onMove"]; onOpenRun: (run: Run) => void; onLoadDiff: BoardViewProps["onLoadDiff"]; onClose: () => void }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stage = workflow.stages.find((s) => s.id === task.stageId) ?? null;
  const stageIndex = workflow.stages.findIndex((s) => s.id === task.stageId);
  const member = team.find((m) => m.profile.id === (task.assignedAgentId ?? stage?.agentProfileId)) ?? null;
  const taskRuns = runs.filter((r) => r.taskId === task.id);
  const currentRun = taskRuns.find((r) => r.id === task.lockRunId) ?? null;
  const previous = workflow.stages.slice(0, Math.max(0, stageIndex)).reverse();
  const act = (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    fn()
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };
  const waiting = task.status === "waiting_approval" || task.status === "review";
  return (
    <aside aria-label={`Task: ${task.title}`} className={["flex w-full basis-[380px] flex-col gap-3.5 self-start rounded-xl border bg-surface p-5 lg:w-auto lg:flex-1", waiting ? "border-[1.5px] border-warning" : task.status === "running" ? "border-[1.5px] border-brand" : "hairline"].join(" ")} data-testid="task-detail">
      <div className="flex items-start gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="eyebrow text-slate">
            {shortId(task.id)} · {stage?.name ?? "?"} · {statusLabel(task, team, stage)}
          </span>
          <h2 className="m-0 font-display text-lg font-bold tracking-tight">{task.title}</h2>
        </div>
        <button type="button" onClick={onClose} className="ml-auto text-xs font-medium text-slate hover:text-ink">
          Fechar
        </button>
      </div>
      {task.descriptionMd && <p className="m-0 text-[13px] whitespace-pre-line">{task.descriptionMd}</p>}
      {task.acceptanceMd && (
        <div className="rounded-md bg-paper px-3.5 py-3 text-[13px]">
          <div className="mb-1 text-xs font-medium text-slate">Critérios de aceite</div>
          <p className="m-0 whitespace-pre-line">{task.acceptanceMd}</p>
        </div>
      )}
      {task.status === "review" && task.approverAgentId && (
        <div className="flex items-center gap-2.5 rounded-md bg-warning-soft px-3.5 py-2.5 text-[13px]" data-testid="task-review">
          {(() => {
            const reviewer = team.find((m) => m.profile.id === task.approverAgentId);
            return (
              <>
                <Avatar initials={reviewer?.profile.avatarSeed ?? "?"} size={24} active={Boolean(currentRun)} />
                <span>
                  <strong>{reviewer?.profile.name ?? "Um membro"}</strong> {currentRun ? "está revisando" : "vai revisar"} esta task (gestor de quem fez o trabalho).
                  {task.returnCount > 0 ? ` Devolvida ${task.returnCount}× por agentes.` : ""} Você pode aprovar por cima a qualquer momento.
                </span>
              </>
            );
          })()}
        </div>
      )}
      {(task.resultMd || task.filesChanged.length > 0 || task.baseCommit) && <Delivery task={task} runs={runs} team={team} onLoadDiff={onLoadDiff} />}
      {task.lastNote && (
        <div className="rounded-md border hairline px-3.5 py-2.5 text-[13px]" data-testid="task-note">
          <div className="mb-0.5 text-xs font-medium text-slate">Última nota</div>
          {task.lastNote}
        </div>
      )}
      <div className="flex flex-col text-[13px]">
        <Row label="Responsável" value={stage?.gate ? "Você (gate humano)" : member ? `${member.profile.name} · ${member.role.title}` : "run avulso"} />
        {task.createdByAgentId && <Row label="Criada por" value={(() => { const c = team.find((m) => m.profile.id === task.createdByAgentId); return c ? `${c.profile.name} · ${c.role.title} (pelo board)` : "um membro do time"; })()} />}
        {task.dependsOn.length > 0 && <Row label="Depende de" value={task.dependsOn.map((id) => tasks.find((t) => t.id === id)?.title ?? id).join(", ")} />}
        {currentRun && <Row label="Run atual" value={`${currentRun.id.slice(-6)} · ${currentRun.status}`} />}
        {task.worktreePath && <Row label="Worktree" value={task.worktreePath} />}
      </div>

      {(waiting || task.status === "blocked" || task.status === "failed" || task.status === "backlog") && (
        <div className="flex flex-col gap-2 border-t hairline pt-3">
          <label className="sr-only" htmlFor={`task-note-${task.id}`}>
            Observação
          </label>
          <input id={`task-note-${task.id}`} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Observação (fica no histórico da task)" className="rounded-sm border hairline-strong bg-surface px-2.5 py-1.5 text-[13px]" />
          <div className="flex flex-wrap gap-2">
            {waiting && (
              <button type="button" disabled={busy} onClick={() => act(() => onApprove(task, note.trim() || null))} className="rounded-full bg-brand px-3.5 py-2 text-[13px] font-semibold text-white hover:bg-brand-hover disabled:opacity-50">
                {task.status === "review" ? "Aprovar mesmo assim" : stageIndex === workflow.stages.length - 1 ? "Aprovar e concluir" : "Aprovar e seguir"}
              </button>
            )}
            {waiting && previous[0] && (
              <button type="button" disabled={busy} onClick={() => act(() => onReturn(task, previous[0]!.id, note.trim() || null))} className="rounded-md border hairline-strong bg-surface px-3.5 py-2 text-[13px] font-medium hover:border-ink disabled:opacity-50">
                Devolver para {previous[0].name}
              </button>
            )}
            {(task.status === "blocked" || task.status === "failed" || task.status === "backlog") && (
              <button type="button" disabled={busy} onClick={() => act(() => onMove(task, null, "ready", note.trim() || null))} className="rounded-full bg-ink px-3.5 py-2 text-[13px] font-semibold text-paper disabled:opacity-50">
                {task.status === "backlog" ? "Colocar na fila" : "Tentar de novo"}
              </button>
            )}
          </div>
        </div>
      )}
      {error && (
        <div role="alert" className="rounded-md bg-brand-soft px-3 py-2 text-[13px] text-brand-hover">
          {error}
        </div>
      )}

      {taskRuns.length > 0 && (
        <div className="flex flex-col gap-1 border-t hairline pt-3">
          <span className="text-xs font-medium text-slate">Runs</span>
          {taskRuns.map((r) => (
            <button key={r.id} type="button" onClick={() => onOpenRun(r)} className="flex items-center gap-2 text-left text-[13px] hover:text-brand-hover">
              <StatusDot status={r.status === "running" || r.status === "queued" ? "running" : r.status === "waiting_approval" ? "waiting_approval" : r.status === "completed" ? "done" : "failed"} />
              <span className="truncate">{r.id.slice(-6)}</span>
              {r.kind === "review" && <span className="rounded-full border hairline-strong px-1.5 text-[10px] text-slate">revisão</span>}
              <span className="ml-auto text-xs text-slate">{formatRelative(r.startedAt)}</span>
              {r.costUsd != null && <span className="font-mono text-xs">{formatUsd(r.costUsd)}</span>}
            </button>
          ))}
        </div>
      )}

      <div className="flex flex-col gap-1 border-t hairline pt-3" data-testid="task-history">
        <span className="text-xs font-medium text-slate">Movimentos</span>
        {events.length === 0 && <span className="text-xs text-slate">—</span>}
        {events
          .slice()
          .reverse()
          .map((e) => (
            <div key={e.id} className="flex items-baseline gap-2 text-xs">
              <span className="font-mono text-slate">{formatRelative(e.at)}</span>
              <span>
                <strong>{e.actor}</strong> · {eventLabel(e, workflow)}
                {e.note ? ` · ${e.note}` : ""}
              </span>
            </div>
          ))}
      </div>
    </aside>
  );
}

/** Entrega da task: resumo do agente, arquivos tocados e o diff contra o commit base. */
function Delivery({ task, runs, team, onLoadDiff }: { task: Task; runs: Run[]; team: TeamMember[]; onLoadDiff: BoardViewProps["onLoadDiff"] }) {
  const [copied, setCopied] = useState(false);
  const [diff, setDiff] = useState<TaskDiff | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setDiff(null);
    setOpen(false);
    setError(null);
  }, [task.id, task.resultRunId]);
  const run = runs.find((r) => r.id === task.resultRunId) ?? null;
  const who = team.find((m) => m.profile.id === run?.agentProfileId)?.profile.name ?? null;
  const toggleDiff = () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (diff) return;
    setLoading(true);
    setError(null);
    onLoadDiff(task)
      .then(setDiff)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  };
  const sign = (status: string) => (status === "added" ? "+" : status === "deleted" ? "−" : "~");
  return (
    <div className="flex flex-col gap-2.5" data-testid="task-delivery">
      {task.resultMd && (
        <section aria-label="Resultado" className="flex flex-col gap-2 rounded-lg border hairline bg-paper px-3.5 py-3" data-testid="task-result">
          <div className="flex items-center gap-2.5">
            <span className="eyebrow text-success-ink">Resultado</span>
            <span className="text-xs text-slate">
              {who ? `entregue por ${who}` : "entrega"}
              {run ? ` no run ${run.id.slice(-6)} · ${formatRelative(run.endedAt ?? run.startedAt)}` : ""}
            </span>
            <button type="button" onClick={() => void copyText(task.resultMd ?? "").then((ok) => ok && (setCopied(true), setTimeout(() => setCopied(false), 1500)))} className="ml-auto rounded-md border hairline-strong bg-surface px-2.5 py-1 text-xs font-medium hover:border-ink">
              {copied ? "Copiado" : "Copiar"}
            </button>
          </div>
          <div className="flex flex-col gap-1 text-[13px] leading-relaxed">{renderMarkdown(task.resultMd)}</div>
        </section>
      )}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2.5">
          <span className="text-xs font-medium text-slate">Arquivos alterados · {task.filesChanged.length}</span>
          {task.baseCommit && <span className="text-xs text-slate">{task.worktreePath ? "worktree" : "projeto"} vs {task.baseCommit.slice(0, 7)}</span>}
          {task.baseCommit && (
            <button type="button" onClick={toggleDiff} aria-expanded={open} className="ml-auto rounded-md border hairline-strong bg-surface px-2.5 py-1 text-xs font-medium hover:border-ink">
              {open ? "Ocultar diff" : "Ver diff"}
            </button>
          )}
        </div>
        {task.filesChanged.length > 0 && (
          <div className="flex flex-wrap gap-1.5 text-xs" data-testid="task-files">
            {task.filesChanged.map((f) => (
              <span key={f} className="rounded-full border hairline-strong px-2 py-0.5 font-mono" title={f}>
                {f.length > 48 ? `…${f.slice(-46)}` : f}
              </span>
            ))}
          </div>
        )}
        {open && loading && <span className="text-xs text-slate">Calculando diff…</span>}
        {open && error && (
          <div role="alert" className="rounded-md bg-brand-soft px-3 py-2 text-[13px] text-brand-hover">
            {error}
          </div>
        )}
        {open && diff && !diff.available && <p className="m-0 text-[13px] text-slate">{diff.reason ?? "Diff indisponível."}</p>}
        {open && diff?.available && diff.files.length === 0 && <p className="m-0 text-[13px] text-slate">Nada mudou em relação a {diff.base?.slice(0, 7) ?? "o commit base"}.</p>}
        {open && diff?.available && diff.files.length > 0 && (
          <div className="flex flex-col gap-2" data-testid="task-diff">
            {diff.scope === "project" && <p className="m-0 text-xs text-warning-ink">Diff da pasta do projeto (a task não tem worktree): pode incluir mudanças de fora dela.</p>}
            {diff.files.map((f) => (
              <details key={f.path} open={diff.files.length <= 3} className="flex flex-col gap-1">
                <summary className="cursor-pointer font-mono text-xs">
                  <span className={f.status === "added" ? "text-success-ink" : f.status === "deleted" ? "text-brand-hover" : "text-slate"}>{sign(f.status)}</span> {f.path}
                  {f.truncated ? " · truncado" : ""}
                </summary>
                <DiffView before={f.before} after={f.after} />
              </details>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3 border-b hairline py-1.5 last:border-b-0">
      <span className="text-slate">{label}</span>
      <span className="truncate text-right font-mono text-xs" title={value}>
        {value}
      </span>
    </div>
  );
}
function eventLabel(e: TaskEvent, workflow: Workflow): string {
  return eventLabelFor(e, (id) => workflow.stages.find((s) => s.id === id)?.name ?? id ?? "");
}
