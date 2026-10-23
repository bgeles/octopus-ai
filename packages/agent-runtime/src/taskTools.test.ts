import { describe, expect, it, vi } from "vitest";
import { buildTaskUpdateHandler, createTaskToolsFactory, MAX_RESULT_CHARS, taskUpdateDescription } from "./taskTools.js";

const ctx = { taskId: "task_1", title: "Criar migração", stage: "Implementar", allowedStatuses: ["done", "review", "blocked"] as const };

describe("task_update", () => {
  it("emite a atualização e responde ao agente", async () => {
    const onUpdate = vi.fn();
    const handler = buildTaskUpdateHandler({ ...ctx, allowedStatuses: [...ctx.allowedStatuses] }, onUpdate);
    const result = await handler({ status: "review", note: "  pronto para revisar " });
    expect(onUpdate).toHaveBeenCalledWith("review", "pronto para revisar", null);
    expect(result.content[0]?.text).toContain("marcada como review");
    expect(result.isError).toBeUndefined();
  });

  it("repassa o resumo da entrega e trunca resumos enormes", async () => {
    const onUpdate = vi.fn();
    const handler = buildTaskUpdateHandler({ ...ctx, allowedStatuses: [...ctx.allowedStatuses] }, onUpdate);
    const ok = await handler({ status: "done", result: "## Entrega\n- V12 criada" });
    expect(onUpdate).toHaveBeenCalledWith("done", null, "## Entrega\n- V12 criada");
    expect(ok.content[0]?.text).toContain("com o resumo da entrega");
    await handler({ status: "done", result: "x".repeat(MAX_RESULT_CHARS + 50) });
    const long = onUpdate.mock.calls[1]?.[2] as string;
    expect(long.length).toBeLessThan(MAX_RESULT_CHARS + 100);
    expect(long).toContain("[resumo truncado");
  });

  it("no modo revisão a descrição fala em aprovar/devolver e só aceita esses status", async () => {
    const review = { ...ctx, allowedStatuses: ["approved", "returned"] as ("approved" | "returned")[], mode: "review" as const };
    expect(taskUpdateDescription(review)).toContain("revisando o trabalho de outro membro");
    expect(taskUpdateDescription(review)).toContain('"returned"');
    expect(taskUpdateDescription({ ...ctx, allowedStatuses: [...ctx.allowedStatuses], mode: "work" })).toContain("Atualiza o estado da task");
    const onUpdate = vi.fn();
    const handler = buildTaskUpdateHandler(review, onUpdate);
    const ok = await handler({ status: "returned", note: "falta o teste" });
    expect(onUpdate).toHaveBeenCalledWith("returned", "falta o teste", null);
    expect(ok.isError).toBeUndefined();
    const no = await handler({ status: "done" });
    expect(no.isError).toBe(true);
  });

  it("recusa status fora da lista permitida", async () => {
    const onUpdate = vi.fn();
    const handler = buildTaskUpdateHandler({ ...ctx, allowedStatuses: ["review"] }, onUpdate);
    const result = await handler({ status: "done" });
    expect(result.isError).toBe(true);
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("monta o server com a tool task_update via as fábricas do SDK", () => {
    const tool = vi.fn((name: string) => ({ name }));
    const createServer = vi.fn((options: { name: string; tools: unknown[] }) => options);
    const factory = createTaskToolsFactory(createServer as never, tool as never);
    const server = factory({ ...ctx, allowedStatuses: [...ctx.allowedStatuses] }, () => {}) as { name: string; tools: unknown[] };
    expect(server.name).toBe("octopus");
    expect(server.tools).toHaveLength(1);
    expect(tool.mock.calls[0]?.[0]).toBe("task_update");
    expect(tool.mock.calls[0]?.[1]).toBe(taskUpdateDescription({ ...ctx, allowedStatuses: [...ctx.allowedStatuses] }));
  });
});
