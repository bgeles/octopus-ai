/**
 * Servidor JSON-RPC 2.0 sobre NDJSON para o sidecar.
 * Independente de I/O: recebe linhas, devolve linhas. O main.ts liga ao stdio.
 */
import {
  JsonRpcErrorCode,
  JsonRpcMessageSchema,
  NotificationMethodSchema,
  REQUEST_SCHEMAS,
  RequestMethodSchema,
  isRequest,
  type JsonRpcId,
  type JsonRpcResponse,
  type NotificationMethod,
  type RequestMethod,
} from "@octopus/protocol";
import { ZodError, type z } from "zod";

type RequestSchemas = typeof REQUEST_SCHEMAS;
export type RequestParams<M extends RequestMethod> = z.infer<RequestSchemas[M]["params"]>;
export type RequestResult<M extends RequestMethod> = z.infer<RequestSchemas[M]["result"]>;

export type Handler<M extends RequestMethod> = (params: RequestParams<M>) => Promise<RequestResult<M>>;

export class RpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

export type LineWriter = (line: string) => void;

export class RpcServer {
  private readonly handlers = new Map<RequestMethod, Handler<RequestMethod>>();

  constructor(private readonly write: LineWriter) {}

  register<M extends RequestMethod>(method: M, handler: Handler<M>): void {
    this.handlers.set(method, handler as unknown as Handler<RequestMethod>);
  }

  notify(method: NotificationMethod, params: unknown): void {
    this.write(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  /** Processa uma linha recebida. Sempre resolve; erros viram respostas JSON-RPC. */
  async handleLine(line: string): Promise<void> {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;

    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      this.respondError(null, JsonRpcErrorCode.ParseError, "JSON inválido");
      return;
    }

    const parsed = JsonRpcMessageSchema.safeParse(raw);
    if (!parsed.success) {
      const id = extractId(raw);
      if (hasUnknownMethod(raw)) {
        this.respondError(id, JsonRpcErrorCode.MethodNotFound, "Método desconhecido");
      } else {
        this.respondError(id, JsonRpcErrorCode.InvalidRequest, "Request inválido", flatten(parsed.error));
      }
      return;
    }

    const message = parsed.data;
    if (!isRequest(message)) {
      // O sidecar não recebe notificações nem respostas do Rust nesta versão do protocolo.
      return;
    }

    const handler = this.handlers.get(message.method);
    if (!handler) {
      this.respondError(message.id, JsonRpcErrorCode.MethodNotFound, `Sem handler para ${message.method}`);
      return;
    }

    const paramsResult = REQUEST_SCHEMAS[message.method].params.safeParse(message.params ?? {});
    if (!paramsResult.success) {
      this.respondError(message.id, JsonRpcErrorCode.InvalidParams, "Parâmetros inválidos", flatten(paramsResult.error));
      return;
    }

    try {
      const result = await handler(paramsResult.data as RequestParams<RequestMethod>);
      this.respond(message.id, result);
    } catch (error) {
      if (error instanceof RpcError) {
        this.respondError(message.id, error.code, error.message, error.data);
      } else {
        this.respondError(message.id, JsonRpcErrorCode.InternalError, error instanceof Error ? error.message : String(error));
      }
    }
  }

  private respond(id: JsonRpcId, result: unknown): void {
    const response: JsonRpcResponse = { jsonrpc: "2.0", id, result };
    this.write(JSON.stringify(response));
  }

  private respondError(id: JsonRpcId | null, code: number, message: string, data?: unknown): void {
    // JSON-RPC exige id null quando não foi possível identificar o request.
    const response = { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } };
    this.write(JSON.stringify(response));
  }
}

function extractId(raw: unknown): JsonRpcId | null {
  if (typeof raw === "object" && raw !== null && "id" in raw) {
    const id = (raw as { id: unknown }).id;
    if (typeof id === "string" || typeof id === "number") return id;
  }
  return null;
}

function hasUnknownMethod(raw: unknown): boolean {
  if (typeof raw !== "object" || raw === null || !("method" in raw)) return false;
  const method = (raw as { method: unknown }).method;
  if (typeof method !== "string") return false;
  return !RequestMethodSchema.safeParse(method).success && !NotificationMethodSchema.safeParse(method).success;
}

function flatten(error: ZodError): unknown {
  return error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
}
