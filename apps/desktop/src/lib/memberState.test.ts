import { describe, expect, it } from "vitest";
import { memberState } from "./memberState";
import { createMockTransport } from "./mockTransport";
import type { Run, TeamMember } from "./types";

async function member(): Promise<TeamMember> {
  const t = createMockTransport();
  return t.invoke("add_team_member", { projectId: "proj_demo", input: { name: "Ana", roleId: "role_implementador" } });
}
const run = (over: Partial<Run>): Run => ({ id: "r", projectId: "proj_demo", prompt: "x", options: {}, agentProfileId: "a", kind: "agent", taskId: null, status: "completed", claudeSessionId: null, model: null, startedAt: "2026-10-26T10:00:00Z", endedAt: null, costUsd: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, numTurns: null, stopReason: null, resultText: null, errorMessage: null, ...over });

describe("memberState", () => {
  it("prioriza run ativo, depois aguardando, pausado, erro e disponível", async () => {
    const m = await member();
    const id = m.profile.id;
    expect(memberState(m, null, [])).toBe("idle");
    expect(memberState(m, null, [run({ agentProfileId: id, status: "failed" })])).toBe("error");
    expect(memberState(m, { agentProfileId: id, runs: 1, activeRuns: 0, costUsd: 0, lastRunAt: null, lastRunStatus: "failed" }, [])).toBe("error");
    const paused = { ...m, profile: { ...m.profile, pausedAt: "2026-10-26T09:00:00Z" } };
    expect(memberState(paused, null, [run({ agentProfileId: id, status: "failed" })])).toBe("paused");
    expect(memberState(paused, null, [run({ agentProfileId: id, status: "running" })])).toBe("active");
    expect(memberState(m, null, [run({ agentProfileId: id, status: "running" }), run({ id: "w", agentProfileId: id, status: "waiting_approval" })])).toBe("waiting");
    // Um run mais novo bem-sucedido limpa o erro; consolidações não contam.
    expect(memberState(m, null, [run({ agentProfileId: id, status: "failed" }), run({ id: "n", agentProfileId: id, status: "completed", startedAt: "2026-10-26T11:00:00Z" })])).toBe("idle");
    expect(memberState(m, null, [run({ agentProfileId: id, status: "failed", kind: "consolidation" })])).toBe("idle");
  });
});
