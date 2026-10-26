import type { AgentTotals, Run, TeamMember } from "./types";

/** Estado de um membro para a UI (como no Paperclip: ativo, em run, pausado, erro). */
export type MemberStatus = "active" | "waiting" | "paused" | "error" | "idle";

export const MEMBER_STATUS_LABELS: Record<MemberStatus, string> = {
  active: "Em run",
  waiting: "Aguardando sua aprovação",
  paused: "Pausado",
  error: "Último run falhou",
  idle: "Disponível",
};

/**
 * Deriva o estado: run ativo vence tudo (um membro pausado termina o que está fazendo);
 * depois aguardando aprovação; depois pausado; depois o último run falhado; senão disponível.
 */
export function memberState(member: TeamMember, totals: AgentTotals | null, runs: Run[]): MemberStatus {
  const mine = runs.filter((r) => r.agentProfileId === member.profile.id && r.kind !== "consolidation");
  if (mine.some((r) => r.status === "waiting_approval")) return "waiting";
  if (mine.some((r) => r.status === "running" || r.status === "queued") || (totals?.activeRuns ?? 0) > 0) return "active";
  if (member.profile.pausedAt) return "paused";
  const last = mine.slice().sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  const lastStatus = last?.status ?? totals?.lastRunStatus ?? null;
  if (lastStatus === "failed") return "error";
  return "idle";
}
