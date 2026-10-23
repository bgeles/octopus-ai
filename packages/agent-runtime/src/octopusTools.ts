/**
 * MCP server in-process `octopus`: `task_update` (runs de task) e as tools de memória
 * (`memory_search`, `memory_write`, `memory_handoff`), respondidas pelo core via `run.memory_call`.
 * Separado do runner para ser testável sem o SDK.
 */
import type { BoardCallResult, BoardOp, MemoryCallResult, MemoryOp, TaskContext, TaskStatusUpdate } from "@octopus/protocol";
import { z } from "zod";
import { buildTaskUpdateHandler, TASK_UPDATE_SCHEMA_EXTRA, taskUpdateDescription, type TaskUpdateFn } from "./taskTools.js";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };
type ToolFn = (name: string, description: string, schema: Record<string, unknown>, handler: (args: never, extra: unknown) => Promise<ToolResult>) => unknown;
type CreateServerFn = (options: { name: string; version?: string; instructions?: string; tools: unknown[] }) => unknown;

export type MemoryCaller = (op: MemoryOp, args: Record<string, unknown>) => Promise<MemoryCallResult>;
export type BoardCaller = (op: BoardOp, args: Record<string, unknown>) => Promise<BoardCallResult>;
export type OctopusToolsOptions = {
  task?: { ctx: TaskContext; onUpdate: TaskUpdateFn };
  memory?: { call: MemoryCaller };
  /** Delegação: só para membros com "pode criar e atribuir tasks"; o core valida cada chamada. */
  board?: { call: BoardCaller };
};
export type OctopusToolsFactory = (opts: OctopusToolsOptions) => unknown;

export const MEMORY_TOOLS = ["mcp__octopus__memory_search", "mcp__octopus__memory_write", "mcp__octopus__memory_handoff"] as const;
export const MEMORY_WRITE_KINDS = ["decisions", "architecture", "pitfalls", "note"] as const;
export const BOARD_TOOLS = ["mcp__octopus__team_list", "mcp__octopus__task_list", "mcp__octopus__task_create", "mcp__octopus__task_assign"] as const;

export function buildBoardHandler(op: BoardOp, call: BoardCaller) {
  return async (args: Record<string, unknown>): Promise<ToolResult> => {
    const result = await call(op, args);
    return { content: [{ type: "text", text: result.content }], isError: result.ok ? undefined : true };
  };
}

export function buildMemoryHandler(op: MemoryOp, call: MemoryCaller) {
  return async (args: Record<string, unknown>): Promise<ToolResult> => {
    const result = await call(op, args);
    return { content: [{ type: "text", text: result.content }], isError: result.ok ? undefined : true };
  };
}

export function createOctopusToolsFactory(createServer: CreateServerFn, tool: ToolFn): OctopusToolsFactory {
  return (opts) => {
    const tools: unknown[] = [];
    if (opts.task) {
      const { ctx, onUpdate } = opts.task;
      tools.push(tool("task_update", taskUpdateDescription(ctx), { status: z.enum(ctx.allowedStatuses as [TaskStatusUpdate, ...TaskStatusUpdate[]]), note: z.string().optional(), ...TASK_UPDATE_SCHEMA_EXTRA }, buildTaskUpdateHandler(ctx, onUpdate) as never));
    }
    if (opts.memory) {
      const { call } = opts.memory;
      tools.push(
        tool("memory_search", "Busca na memória do projeto (wiki do Octopus: decisões, arquitetura, armadilhas, log de tarefas e handoffs). Use antes de decidir algo que pode já ter sido decidido ou quando precisar de contexto de runs anteriores.", { query: z.string().min(2) }, buildMemoryHandler("search", call) as never),
        tool("memory_write", "Registra na memória do projeto uma decisão, um fato de arquitetura, uma armadilha ou uma nota. Vira uma página da wiki com histórico. Nunca inclua segredos (chaves, senhas, tokens).", { kind: z.enum(MEMORY_WRITE_KINDS), title: z.string().min(3), body: z.string().min(3) }, buildMemoryHandler("write", call) as never),
        tool("memory_handoff", "Deixa uma nota de passagem para o próximo run desta task: onde parou, o que falhou e o que falta. Chame antes de encerrar quando o trabalho não terminou ou quando vai pedir revisão.", { body: z.string().min(3) }, buildMemoryHandler("handoff", call) as never),
      );
    }
    if (opts.board) {
      const { call } = opts.board;
      tools.push(
        tool("team_list", "Quem está no seu time: nome, cargo, especialidade, a quem reporta, carga atual (tasks abertas) e para quem você pode delegar. Chame antes de criar ou atribuir tasks.", {}, buildBoardHandler("team_list", call) as never),
        tool("task_list", "Tasks do board deste projeto (id, título, estágio, status, responsável, criador). Filtre por status: open (padrão: tudo que não está concluído), done, mine (criadas por você) ou all.", { status: z.enum(["open", "done", "mine", "all"]).optional() }, buildBoardHandler("task_list", call) as never),
        tool("task_create", "Cria uma task no board para alguém que reporta a você. Dê um título curto, uma descrição com o pedido completo e critérios de aceite verificáveis; o responsável (assignee) é o nome ou id de um membro do seu time. dependsOn recebe ids de tasks que precisam concluir antes. ready=false deixa no backlog.", { title: z.string().min(3), description: z.string().optional(), acceptance: z.string().optional(), assignee: z.string().min(1), dependsOn: z.array(z.string()).optional(), stage: z.string().optional(), ready: z.boolean().optional() }, buildBoardHandler("task_create", call) as never),
        tool("task_assign", "Atribui (ou reatribui) uma task existente a alguém que reporta a você. Não funciona em tasks em run.", { taskId: z.string().min(1), assignee: z.string().min(1) }, buildBoardHandler("task_assign", call) as never),
      );
    }
    return createServer({
      name: "octopus",
      version: "0.1.0",
      instructions: "Ferramentas do orquestrador Octopus: task_update informa o estado da task que você executa; memory_search, memory_write e memory_handoff acessam a memória do projeto; team_list, task_list, task_create e task_assign delegam trabalho para quem reporta a você.",
      tools,
    });
  };
}
