import { describe, expect, it } from "vitest";
import { activityActor, activityLabel, taskEventLabel } from "./activity";
import type { ActivityItem } from "./types";

const base: ActivityItem = { id: "x", at: "2026-10-26T10:00:00Z", source: "task", kind: "advanced", actor: "scheduler", taskId: "task_1", taskTitle: "Mapear", runId: "run_1", agentProfileId: "agent_1", agentName: "Ana", costUsd: 0.25, note: null, fromStage: "stage_1", toStage: "stage_2", payload: null };
const name = (id: string | null) => (id === "stage_1" ? "Pesquisar" : id === "stage_2" ? "Sintetizar" : (id ?? ""));

describe("rótulos do feed de atividade", () => {
  it("fala pelo membro quando o scheduler agiu por ele", () => {
    expect(activityActor(base)).toBe("Ana");
    expect(activityActor({ ...base, actor: "você" })).toBe("você");
    expect(activityActor({ ...base, actor: "agente Rui" })).toBe("agente Rui");
    expect(activityActor({ ...base, source: "run", actor: "sistema" })).toBe("Ana");
  });

  it("descreve movimentos de task, runs avulsos e decisões suas", () => {
    expect(activityLabel(base, name)).toBe("Pesquisar → Sintetizar");
    expect(activityLabel({ ...base, kind: "review_requested" }, name)).toBe("encaminhou para revisão");
    expect(activityLabel({ ...base, source: "run", kind: "run_finished" }, name)).toBe("concluiu o run");
    expect(activityLabel({ ...base, source: "run", kind: "run_interrupted" }, name)).toBe("interrompeu o run");
    expect(activityLabel({ ...base, source: "audit", kind: "approval.deny", payload: { tool: "Bash" } }, name)).toBe("negou Bash");
    expect(activityLabel({ ...base, source: "audit", kind: "budget.hard_stop", payload: {} }, name)).toBe("parou o run por orçamento");
    expect(activityLabel({ ...base, source: "audit", kind: "team.member.added", payload: { name: "Dani" } }, name)).toBe("adicionou Dani ao time");
    expect(activityLabel({ ...base, source: "audit", kind: "x.y" }, name)).toBe("x.y");
  });

  it("taskEventLabel cobre os kinds do board", () => {
    expect(taskEventLabel("created", null, "stage_1", name)).toBe("criou em Pesquisar");
    expect(taskEventLabel("auto_approved", null, null, name)).toBe("auto-aprovou por política");
    expect(taskEventLabel("comment", null, null, name)).toBe("comentou");
  });
});
