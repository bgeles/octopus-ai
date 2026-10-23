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
  if (ctx.mode === "review") {
    return `Você está revisando o trabalho de outro membro na task "${ctx.title}" (estágio ${ctx.stage}) do board do Octopus. Inspecione a entrega sem editar nada e chame esta tool uma vez ao decidir: status "approved" quando a entrega cumpre o pedido e os critérios de aceite, "returned" quando falta algo ou está errado. Em "note", diga objetivamente o motivo (o autor vai ler).`;
  }
  return `Atualiza o estado da task "${ctx.title}" (estágio ${ctx.stage}) no board do Octopus. Chame ao terminar o trabalho: status "done" quando concluiu tudo, "review" quando precisa de revisão humana ou de outro membro, "blocked" quando não consegue prosseguir. Inclua uma nota curta com o que foi feito ou o que bloqueia e, em "result", o resumo da entrega em markdown: o que mudou, em quais arquivos, e como verificar.`;
}

export const MAX_RESULT_CHARS = 20_000;

export type TaskUpdateFn = (status: TaskStatusUpdate, note: string | null, result: string | null) => void;

export function buildTaskUpdateHandler(ctx: TaskContext, onUpdate: TaskUpdateFn) {
  return async (args: { status: string; note?: string; result?: string }): Promise<ToolResult> => {
    const status = args.status as TaskStatusUpdate;
    if (!ctx.allowedStatuses.includes(status)) {
      return { content: [{ type: "text", text: `Status "${args.status}" não permitido para esta task. Use: ${ctx.allowedStatuses.join(", ")}.` }], isError: true };
    }
    const note = args.note?.trim() ? args.note.trim() : null;
    const raw = args.result?.trim() ?? "";
    const result = raw ? (raw.length > MAX_RESULT_CHARS ? `${raw.slice(0, MAX_RESULT_CHARS)}\n\n… [resumo truncado em ${MAX_RESULT_CHARS} caracteres]` : raw) : null;
    onUpdate(status, note, result);
    return { content: [{ type: "text", text: `Task ${ctx.taskId} marcada como ${status}${result ? " com o resumo da entrega" : ""}.` }] };
  };
}

export const TASK_UPDATE_SCHEMA_EXTRA = { result: z.string().optional() };

export function createTaskToolsFactory(createServer: CreateServerFn, tool: ToolFn) {
  return (ctx: TaskContext, onUpdate: TaskUpdateFn): unknown =>
    createServer({
      name: "octopus",
      version: "0.1.0",
      instructions: "Ferramentas do orquestrador Octopus. Use task_update para informar o estado da task que você executa.",
      tools: [
        tool(
          "task_update",
          taskUpdateDescription(ctx),
          { status: z.enum(ctx.allowedStatuses as [TaskStatusUpdate, ...TaskStatusUpdate[]]), note: z.string().optional(), ...TASK_UPDATE_SCHEMA_EXTRA },
          buildTaskUpdateHandler(ctx, onUpdate) as never,
        ),
      ],
    });
}
