import { describe, expect, it } from "vitest";
import { BOARD_TOOLS, MEMORY_TOOLS, buildBoardHandler, buildMemoryHandler, createOctopusToolsFactory } from "./octopusTools.js";

describe("octopus tools", () => {
  it("monta só as tools pedidas e repassa chamadas de memória ao core", async () => {
    const created: { name: string; description: string }[] = [];
    const factory = createOctopusToolsFactory(
      (opts) => ({ server: opts.name, tools: opts.tools }),
      (name, description) => {
        created.push({ name, description });
        return name;
      },
    );
    const onlyTask = factory({ task: { ctx: { taskId: "t", title: "T", stage: "Implementar", allowedStatuses: ["done"] }, onUpdate: () => {} } }) as { tools: unknown[] };
    expect(onlyTask.tools).toEqual(["task_update"]);
    created.length = 0;
    const both = factory({ task: { ctx: { taskId: "t", title: "T", stage: "Implementar", allowedStatuses: ["done"] }, onUpdate: () => {} }, memory: { call: async () => ({ ok: true, content: "" }) } }) as { tools: unknown[] };
    expect(both.tools).toEqual(["task_update", "memory_search", "memory_write", "memory_handoff"]);
    expect(created.find((t) => t.name === "memory_write")?.description).toContain("Nunca inclua segredos");
    expect(MEMORY_TOOLS).toHaveLength(3);
  });

  it("as tools de delegação só entram quando `board` é passado e repassam ao core", async () => {
    const created: { name: string; description: string }[] = [];
    const factory = createOctopusToolsFactory(
      (opts) => ({ server: opts.name, tools: opts.tools }),
      (name, description) => {
        created.push({ name, description });
        return name;
      },
    );
    const calls: unknown[] = [];
    const withBoard = factory({ board: { call: async (op, args) => (calls.push([op, args]), { ok: true, content: "Task task_24 criada" }) } }) as { tools: unknown[] };
    expect(withBoard.tools).toEqual(["team_list", "task_list", "task_create", "task_assign"]);
    expect(created.find((t) => t.name === "task_create")?.description).toContain("reporta a você");
    expect(BOARD_TOOLS).toEqual(["mcp__octopus__team_list", "mcp__octopus__task_list", "mcp__octopus__task_create", "mcp__octopus__task_assign"]);
    const handler = buildBoardHandler("task_create", async (op, args) => (calls.push([op, args]), { ok: false, content: "Responsável inválido" }));
    expect(await handler({ title: "X", assignee: "Leo" })).toEqual({ content: [{ type: "text", text: "Responsável inválido" }], isError: true });
    expect(calls.at(-1)).toEqual(["task_create", { title: "X", assignee: "Leo" }]);
  });

  it("buildMemoryHandler traduz ok/erro para o formato de tool", async () => {
    const calls: unknown[] = [];
    const ok = buildMemoryHandler("search", async (op, args) => {
      calls.push([op, args]);
      return { ok: true, content: "1 página" };
    });
    expect(await ok({ query: "x" })).toEqual({ content: [{ type: "text", text: "1 página" }], isError: undefined });
    expect(calls).toEqual([["search", { query: "x" }]]);
    const fail = buildMemoryHandler("write", async () => ({ ok: false, content: "Tipo inválido" }));
    expect(await fail({})).toEqual({ content: [{ type: "text", text: "Tipo inválido" }], isError: true });
  });
});
