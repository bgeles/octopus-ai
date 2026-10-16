import { Plus } from "lucide-react";
import type { AgentTotals, Project, Role, TeamMember } from "../lib/types";
import { Avatar } from "./Avatar";
import { formatUsd } from "./RunSidebar";

export type MemberStatus = "active" | "waiting" | "idle";

type TeamViewProps = {
  project: Project | null;
  members: TeamMember[] | null;
  roles: Role[];
  totals: AgentTotals[];
  statusOf: (agentProfileId: string) => MemberStatus;
  monthlyCost: number;
  onAddMember: () => void;
  onOpenMember: (member: TeamMember) => void;
  onRunAs: (member: TeamMember) => void;
};

export function TeamView({ project, members, totals, statusOf, monthlyCost, onAddMember, onOpenMember, onRunAs }: TeamViewProps) {
  const list = members ?? [];
  const totalsById = new Map(totals.map((t) => [t.agentProfileId, t]));
  const active = list.filter((m) => statusOf(m.profile.id) === "active").length;
  const waiting = list.filter((m) => statusOf(m.profile.id) === "waiting").length;
  const budget = list.reduce((sum, m) => sum + (m.profile.maxBudgetUsd ?? 0), 0);
  const roots = list.filter((m) => !m.reportsToAgentId || !list.some((x) => x.profile.id === m.reportsToAgentId));
  const childrenOf = (id: string) => list.filter((m) => m.reportsToAgentId === id);

  return (
    <div className="flex flex-col gap-6 overflow-y-auto p-6" data-testid="team-view">
      <div className="flex flex-wrap items-center gap-4">
        <div>
          <div className="eyebrow text-brand">{project?.name ?? ""}</div>
          <h1 className="m-0 font-display text-xl font-bold tracking-tight">Time</h1>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <span className="rounded-full border hairline-strong px-2.5 py-1.5 text-xs font-medium" data-testid="team-summary">
            {list.length} {list.length === 1 ? "membro" : "membros"} · {active} em run · {waiting} aguardando você
          </span>
          <span className="rounded-full border hairline-strong px-2.5 py-1.5 font-mono text-xs">
            {formatUsd(monthlyCost)}
            {budget > 0 ? ` / ${formatUsd(budget)}` : ""} no mês
          </span>
          <button type="button" onClick={onAddMember} className="inline-flex items-center gap-1.5 rounded-full bg-brand px-3.5 py-2 text-[13px] font-semibold text-white hover:bg-brand-hover">
            <Plus size={14} aria-hidden /> Adicionar membro
          </button>
        </div>
      </div>

      <section aria-label="Organograma" className="flex flex-col gap-3 rounded-xl border hairline bg-surface p-6">
        <div className="flex items-baseline gap-3">
          <h2 className="m-0 font-display text-sm font-semibold">Organograma</h2>
          <span className="text-xs text-slate">Você no topo; cada membro reporta a você ou a outro membro. Linhas = delegação.</span>
        </div>
        <div className="flex flex-col items-center" data-testid="org-chart">
          <OrgNode initials="VC" title="Você" subtitle="Gestor · aprova e prioriza" manager />
          <span aria-hidden className="h-6 w-0.5 bg-mist" />
          {roots.length > 0 && <span aria-hidden className="h-0.5 bg-mist" style={{ width: `${Math.min(100, Math.max(roots.length, 1) * 220 - 20)}px`, maxWidth: "100%" }} />}
          <div className="flex flex-wrap justify-center gap-5">
            {roots.map((member) => (
              <OrgBranch key={member.id} member={member} childrenOf={childrenOf} statusOf={statusOf} onOpen={onOpenMember} depth={0} />
            ))}
            <div className="flex flex-col items-center">
              <span aria-hidden className="h-6 w-0.5 bg-mist" />
              <button type="button" onClick={onAddMember} className="flex w-[200px] items-center justify-center rounded-xl border border-dashed hairline-strong px-3 py-3.5 text-[13px] font-medium text-slate hover:border-ink hover:text-ink">
                + Novo membro
              </button>
            </div>
          </div>
        </div>
      </section>

      {members === null && <p className="m-0 text-[13px] text-slate">Carregando o time…</p>}
      {members && members.length === 0 && (
        <p className="m-0 rounded-xl border border-dashed hairline-strong p-5 text-[13px] text-slate">
          Ainda não há membros. Adicione um Implementador para começar: ele herda as responsabilidades do cargo e você pode delegar testes a um Testador que reporte a ele.
        </p>
      )}

      <section aria-label="Membros do time" className="grid grid-cols-[repeat(auto-fit,minmax(min(300px,100%),1fr))] gap-4">
        {list.map((member) => (
          <MemberCard key={member.id} member={member} status={statusOf(member.profile.id)} totals={totalsById.get(member.profile.id) ?? null} boss={list.find((m) => m.profile.id === member.reportsToAgentId) ?? null} onOpen={() => onOpenMember(member)} onRunAs={() => onRunAs(member)} />
        ))}
      </section>
    </div>
  );
}

function OrgBranch({ member, childrenOf, statusOf, onOpen, depth }: { member: TeamMember; childrenOf: (id: string) => TeamMember[]; statusOf: (id: string) => MemberStatus; onOpen: (m: TeamMember) => void; depth: number }) {
  const children = depth < 3 ? childrenOf(member.profile.id) : [];
  const status = statusOf(member.profile.id);
  return (
    <div className="flex flex-col items-center" data-testid="org-branch">
      <span aria-hidden className="h-6 w-0.5 bg-mist" />
      <OrgNode initials={member.profile.avatarSeed} title={member.profile.name} subtitle={statusLabel(status, member)} active={status === "active"} onClick={() => onOpen(member)} />
      {children.length > 0 && (
        <>
          <span aria-hidden className="h-6 w-0.5 bg-mist" />
          <div className="flex flex-wrap justify-center gap-4">
            {children.map((child) => (
              <OrgBranch key={child.id} member={child} childrenOf={childrenOf} statusOf={statusOf} onOpen={onOpen} depth={depth + 1} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function OrgNode({ initials, title, subtitle, manager = false, active = false, onClick }: { initials: string; title: string; subtitle: string; manager?: boolean; active?: boolean; onClick?: () => void }) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag
      type={onClick ? "button" : undefined}
      onClick={onClick}
      className={[
        "relative flex w-[200px] items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left",
        manager ? "border-sidebar bg-sidebar text-sidebar-ink" : active ? "border-[1.5px] border-brand bg-surface text-ink" : "hairline bg-surface text-ink",
        onClick ? "hover:border-ink" : "",
      ].join(" ")}
      data-testid="org-node"
    >
      {active && <span aria-hidden className="absolute top-2.5 right-2.5 size-2 animate-pulse rounded-full bg-brand" />}
      <Avatar initials={initials} size={32} manager={manager} active={active} />
      <span className="flex min-w-0 flex-col">
        <span className="truncate font-display text-[13px] font-bold">{title}</span>
        <span className={["truncate text-[11px]", manager ? "text-sidebar-ink/72" : "text-slate"].join(" ")}>{subtitle}</span>
      </span>
    </Tag>
  );
}

function MemberCard({ member, status, totals, boss, onOpen, onRunAs }: { member: TeamMember; status: MemberStatus; totals: AgentTotals | null; boss: TeamMember | null; onOpen: () => void; onRunAs: () => void }) {
  const budget = member.profile.maxBudgetUsd;
  const cost = totals?.costUsd ?? 0;
  const pct = budget ? Math.min(100, Math.round((cost / budget) * 100)) : 0;
  const tools = member.profile.allowedTools ?? member.role.defaultTools ?? [];
  return (
    <article aria-label={`Membro do time: ${member.profile.name}`} className={["flex flex-col gap-3 rounded-xl border bg-surface p-5", status === "active" ? "border-[1.5px] border-brand" : "hairline"].join(" ")} data-testid="member-card" data-status={status}>
      <div className="flex items-center gap-3">
        <Avatar initials={member.profile.avatarSeed} size={44} active={status === "active"} />
        <div className="flex min-w-0 flex-col">
          <span className="eyebrow text-slate">{member.role.specialty}</span>
          <h3 className="m-0 truncate font-display text-[17px] font-bold tracking-tight">{member.profile.name}</h3>
          <span className="text-xs text-slate">
            {member.role.title}
            {boss ? ` · reporta a ${boss.profile.name}` : " · reporta a você"}
          </span>
        </div>
      </div>
      <StatusBadge status={status} />
      <p className="m-0 line-clamp-3 text-[13px] whitespace-pre-line text-ink">{member.role.responsibilitiesMd.replace(/^- /gm, "")}</p>
      <div className="flex flex-wrap gap-1.5">
        {tools.map((t) => (
          <span key={t} className="rounded-full border hairline-strong px-2 py-0.5 font-mono text-[11px]">
            {t}
          </span>
        ))}
      </div>
      <div className="flex flex-col gap-1">
        <div className="flex justify-between text-xs text-slate">
          <span>Custo acumulado</span>
          <span className="font-mono text-ink">
            {formatUsd(cost)}
            {budget ? ` / ${formatUsd(budget)}` : ""}
            {totals ? ` · ${totals.runs} ${totals.runs === 1 ? "run" : "runs"}` : ""}
          </span>
        </div>
        {budget ? (
          <div className="h-1 overflow-hidden rounded-full border hairline bg-paper" role="progressbar" aria-label="Custo sobre o orçamento" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
            <div className={["h-full", pct >= 70 ? "bg-warning" : "bg-ink"].join(" ")} style={{ width: `${pct}%` }} />
          </div>
        ) : null}
      </div>
      <div className="flex gap-2 border-t hairline pt-3">
        <button type="button" onClick={onOpen} className="rounded-md border hairline-strong bg-surface px-3 py-1.5 text-[13px] font-medium hover:border-ink">
          Ver ficha
        </button>
        <button type="button" onClick={onRunAs} className="rounded-md border hairline-strong bg-surface px-3 py-1.5 text-[13px] font-medium hover:border-ink">
          Dar uma tarefa
        </button>
      </div>
    </article>
  );
}

export function StatusBadge({ status }: { status: MemberStatus }) {
  if (status === "active")
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-brand-hover">
        <span className="size-2 animate-pulse rounded-full bg-brand" /> Em run
      </span>
    );
  if (status === "waiting")
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-warning-ink">
        <span className="size-2 rounded-full bg-warning" /> Aguardando sua aprovação
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate">
      <span className="size-2 rounded-full bg-mist" /> Disponível
    </span>
  );
}

function statusLabel(status: MemberStatus, member: TeamMember): string {
  if (status === "active") return "Em run agora";
  if (status === "waiting") return "Aguardando aprovação";
  return member.role.specialty;
}
