/**
 * MCP server in-process `octopus` com a tool `task_update`, que deixa o agente mover a própria task.
 * Fica separado do runner para ser testável sem o SDK (a fábrica recebe createSdkMcpServer e tool).
 */
import type { TaskContext, TaskStatusUpdate } from "@octopus/protocol";
import { z } from "zod";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };
type ToolFn = (name: string, description: string, schema: Record<string, unknown>, handler: (args: never, extra: unknown) => Promise<ToolResult>) => unknown;
type CreateServerFn = (options: { name: string; version?: string; instructions?: string; tools: unknown[] }) => unknown;

export function taskUpdateDescription(ctx: TaskContext): string {
  return `Atualiza o estado da task "${ctx.title}" (estágio ${ctx.stage}) no board do Octopus. Chame ao terminar o trabalho: status "done" quando concluiu tudo, "review" quando precisa de revisão humana ou de outro membro, "blocked" quando não consegue prosseguir. Inclua uma nota curta com o que foi feito ou o que bloqueia.`;
}

export function buildTaskUpdateHandler(ctx: TaskContext, onUpdate: (status: TaskStatusUpdate, note: string | null) => void) {
  return async (args: { status: string; note?: string }): Promise<ToolResult> => {
    const status = args.status as TaskStatusUpdate;
    if (!ctx.allowedStatuses.includes(status)) {
      return { content: [{ type: "text", text: `Status "${args.status}" não permitido para esta task. Use: ${ctx.allowedStatuses.join(", ")}.` }], isError: true };
    }
    const note = args.note?.trim() ? args.note.trim() : null;
    onUpdate(status, note);
    return { content: [{ type: "text", text: `Task ${ctx.taskId} marcada como ${status}.` }] };
  };
}

export function createTaskToolsFactory(createServer: CreateServerFn, tool: ToolFn) {
  return (ctx: TaskContext, onUpdate: (status: TaskStatusUpdate, note: string | null) => void): unknown =>
    createServer({
      name: "octopus",
      version: "0.1.0",
      instructions: "Ferramentas do orquestrador Octopus. Use task_update para informar o estado da task que você executa.",
      tools: [
        tool(
          "task_update",
          taskUpdateDescription(ctx),
          { status: z.enum(ctx.allowedStatuses as [TaskStatusUpdate, ...TaskStatusUpdate[]]), note: z.string().optional() },
          buildTaskUpdateHandler(ctx, onUpdate) as never,
        ),
      ],
    });
}
