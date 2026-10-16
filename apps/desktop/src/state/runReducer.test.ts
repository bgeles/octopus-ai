import { describe, expect, it } from "vitest";
import { fixtureRunEvents, subagentRunEvents } from "../lib/mockTransport";
import { applyRunEvent, contextUsage, initialRunViewState, isRunActive, resolvePermission, subagentTree, topLevelItems, withUserPrompt } from "./runReducer";

const events = fixtureRunEvents();

function reduceAll(list = events) {
  return list.reduce((state, n) => applyRunEvent(state, n), initialRunViewState());
}

describe("applyRunEvent", () => {
  it("reproduz a fixture compartilhada até um estado final coerente", () => {
    const state = reduceAll();
    expect(state.runId).toBe("run_01HZX9R2Y3");
    expect(state.sessionId).toBe("5b3f2c1a-8d4e-4f6b-9a7c-2e1d0f9b8a6c");
    expect(state.model).toBe("claude-opus-5-5");
    expect(state.result).toMatchObject({ subtype: "success", isError: false, costUsd: 0.0421, numTurns: 3 });
    expect(state.pendingPermissions).toEqual([]); // o result limpa pendências
    expect(isRunActive(state)).toBe(false);
  });

  it("acumula deltas de texto em um único bloco em streaming", () => {
    let state = initialRunViewState("r");
    state = applyRunEvent(state, { runId: "r", seq: 0, at: "t", event: { type: "assistant_text_delta", text: "Olá", parentToolUseId: null } });
    state = applyRunEvent(state, { runId: "r", seq: 1, at: "t", event: { type: "assistant_text_delta", text: " mundo", parentToolUseId: null } });
    expect(state.items).toEqual([{ kind: "assistant", id: "assistant_0", text: "Olá mundo", streaming: true, parentToolUseId: null, at: "t" }]);

    state = applyRunEvent(state, { runId: "r", seq: 2, at: "t", event: { type: "assistant_text", messageId: "m", text: "Olá mundo!", parentToolUseId: null } });
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({ text: "Olá mundo!", streaming: false });
  });

  it("casa tool_result com o tool_use correspondente e conta ferramentas", () => {
    const state = reduceAll();
    const tool = state.items.find((i) => i.kind === "tool");
    expect(tool).toMatchObject({ kind: "tool", name: "Glob", result: "V11__add_lead_status.sql\nV10__create_leads.sql", isError: false });
    expect(state.toolCounts).toEqual({ Glob: 1 });
  });

  it("registra pedidos de permissão e permite resolvê-los", () => {
    const upToPermission = events.slice(0, 5);
    let state = reduceAll(upToPermission);
    expect(state.pendingPermissions).toHaveLength(1);
    expect(state.pendingPermissions[0]).toMatchObject({ requestId: "perm_01", toolName: "Bash" });
    expect(isRunActive(state)).toBe(true);
    state = resolvePermission(state, "perm_01");
    expect(state.pendingPermissions).toEqual([]);
  });

  it("ignora eventos de outro run e eventos repetidos", () => {
    let state = initialRunViewState("r1");
    const other = { ...events[0]!, runId: "r2" };
    expect(applyRunEvent(state, other)).toBe(state);
    state = applyRunEvent(state, { ...events[2]!, runId: "r1", seq: 5 });
    const again = applyRunEvent(state, { ...events[2]!, runId: "r1", seq: 5 });
    expect(again).toBe(state);
    expect(state.items).toHaveLength(1);
  });

  it("marca subagentes a partir de tool_use Agent", () => {
    const state = applyRunEvent(initialRunViewState("r"), {
      runId: "r",
      seq: 0,
      at: "t",
      event: { type: "tool_use", toolUseId: "toolu_sub", name: "Agent", input: {}, parentToolUseId: null },
    });
    expect(state.subagentIds).toEqual(["toolu_sub"]);
  });

  it("erro fatal encerra o run e limpa pendências", () => {
    let state = reduceAll(events.slice(0, 5));
    state = applyRunEvent(state, { runId: state.runId!, seq: 99, at: "t", event: { type: "error", message: "boom", fatal: true } });
    expect(isRunActive(state)).toBe(false);
    expect(state.pendingPermissions).toEqual([]);
    expect(state.items.at(-1)).toMatchObject({ kind: "error", message: "boom", fatal: true });
  });

  it("withUserPrompt adiciona o prompt do usuário ao transcript", () => {
    const state = withUserPrompt(initialRunViewState("r"), "faça X", "t");
    expect(state.items).toEqual([{ kind: "user", id: "user_0", text: "faça X", at: "t" }]);
  });
});

describe("contextUsage", () => {
  it("usa a janela informada e soma entrada + cache", () => {
    const state = reduceAll();
    const usage = contextUsage(state);
    expect(usage.window).toBe(1_000_000);
    expect(usage.used).toBe(1200 + 88000);
    expect(usage.fraction).toBeCloseTo(0.0892, 3);
  });

  it("cai para a janela padrão sem informação", () => {
    expect(contextUsage(initialRunViewState())).toEqual({ used: 0, window: 200_000, fraction: 0 });
  });
});

describe("subagentTree", () => {
  const subagentEvents = subagentRunEvents();

  it("agrupa itens pelo parentToolUseId com nome, contadores e status", () => {
    const running = reduceAll(subagentEvents.slice(0, 6));
    let tree = subagentTree(running.items);
    expect(tree).toHaveLength(1);
    expect(tree[0]).toMatchObject({ toolUseId: "toolu_agent_1", name: "Mapear migrações Flyway", subagentType: "Explore", status: "running", toolCalls: 1, messages: 1, errors: 0 });
    expect(tree[0]!.children.map((c) => c.kind)).toEqual(["assistant", "tool"]);

    const done = reduceAll(subagentEvents);
    tree = subagentTree(done.items);
    expect(tree[0]!.status).toBe("done");
    expect(done.toolCounts).toEqual({ Agent: 1, Grep: 1 });
  });

  it("topLevelItems esconde os filhos de subagentes conhecidos e mantém órfãos", () => {
    const state = reduceAll(subagentEvents);
    const top = topLevelItems(state.items);
    expect(top.map((i) => (i.kind === "tool" ? `tool:${i.name}` : i.kind))).toEqual(["assistant", "tool:Agent", "assistant"]);

    const orphan = applyRunEvent(initialRunViewState("r"), { runId: "r", seq: 0, at: "t", event: { type: "assistant_text", messageId: null, text: "solto", parentToolUseId: "toolu_desconhecido" } });
    expect(topLevelItems(orphan.items)).toHaveLength(1);
  });

  it("marca erro quando o subagente falha", () => {
    let state = initialRunViewState("r");
    state = applyRunEvent(state, { runId: "r", seq: 0, at: "t", event: { type: "tool_use", toolUseId: "a1", name: "Task", input: { subagent_type: "Plan" }, parentToolUseId: null } });
    state = applyRunEvent(state, { runId: "r", seq: 1, at: "t", event: { type: "tool_result", toolUseId: "a1", content: "falhou", isError: true, parentToolUseId: null } });
    expect(subagentTree(state.items)[0]).toMatchObject({ name: "Plan", status: "error" });
  });
});
