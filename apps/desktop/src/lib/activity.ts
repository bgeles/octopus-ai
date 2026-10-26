import type { ActivityItem, TaskEvent } from "./types";

/** Rótulo de um movimento de task (Board e feed). */
export function taskEventLabel(kind: string, fromStage: string | null, toStage: string | null, name: (id: string | null) => string): string {
  switch (kind) {
    case "created":
      return `criou em ${name(toStage)}`;
    case "created_by_agent":
      return `criou em ${name(toStage)} pelo board`;
    case "assigned":
      return "reatribuiu";
    case "run_started":
      return `iniciou run em ${name(toStage)}`;
    case "agent_update":
      return "agente atualizou";
    case "advanced":
      return `${name(fromStage)} → ${name(toStage)}`;
    case "completed":
      return "concluiu";
    case "approved":
      return `aprovou ${name(fromStage)} → ${name(toStage)}`;
    case "returned":
      return `devolveu para ${name(toStage)}`;
    case "moved":
      return `moveu para ${name(toStage)}`;
    case "blocked":
      return "bloqueou";
    case "run_finished":
      return "run terminou";
    case "run_failed":
    case "failed":
      return "falhou";
    case "review_requested":
      return "encaminhou para revisão";
    case "review_started":
      return "iniciou run de revisão";
    case "review_failed":
      return "revisão não concluiu";
    case "auto_approved":
      return "auto-aprovou por política";
    case "escalated":
      return "escalou para você";
    case "comment":
      return "comentou";
    default:
      return kind;
  }
}

export function eventLabelFor(e: TaskEvent, name: (id: string | null) => string): string {
  return taskEventLabel(e.kind, e.fromStage, e.toStage, name);
}

/** Quem aparece como autor da linha: o membro quando o scheduler agiu por ele. */
export function activityActor(item: ActivityItem): string {
  if (item.actor === "scheduler" && item.agentName) return item.agentName;
  if (item.actor === "sistema" && item.source === "run" && item.agentName) return item.agentName;
  return item.actor;
}

/** Frase da linha do feed (sem o ator). */
export function activityLabel(item: ActivityItem, name: (id: string | null) => string): string {
  const str = (k: string) => {
    const p = item.payload;
    return p && typeof p === "object" && typeof (p as Record<string, unknown>)[k] === "string" ? ((p as Record<string, unknown>)[k] as string) : null;
  };
  switch (item.source) {
    case "task":
      return taskEventLabel(item.kind, item.fromStage, item.toStage, name);
    case "run":
      switch (item.kind) {
        case "run_started":
          return "iniciou um run";
        case "run_finished":
          return "concluiu o run";
        case "run_interrupted":
          return "interrompeu o run";
        default:
          return "run falhou";
      }
    default:
      switch (item.kind) {
        case "approval.allow":
          return `permitiu ${str("tool") ?? "a ferramenta"}`;
        case "approval.deny":
          return `negou ${str("tool") ?? "a ferramenta"}`;
        case "budget.hard_stop":
          return "parou o run por orçamento";
        case "team.member.added":
          return `adicionou ${str("name") ?? "um membro"} ao time`;
        case "team.member.removed":
          return `removeu ${str("name") ?? "um membro"} do time`;
        case "team.member.paused":
          return `pausou ${str("name") ?? "um membro"}`;
        case "team.member.resumed":
          return `retomou ${str("name") ?? "um membro"}`;
        case "team.member.run_now":
          return `mandou ${str("name") ?? "um membro"} rodar agora`;
        default:
          return item.kind;
      }
  }
}
