import { JsonRpcErrorCode } from "@octopus/protocol";
import { describe, expect, it } from "vitest";
import { RpcError, RpcServer } from "./rpc.js";

function makeServer() {
  const lines: string[] = [];
  const server = new RpcServer((line) => lines.push(line));
  const last = () => JSON.parse(lines[lines.length - 1]!);
  return { server, lines, last };
}

describe("RpcServer", () => {
  it("responde a runtime.hello com result", async () => {
    const { server, last } = makeServer();
    server.register("runtime.hello", async () => ({ protocolVersion: 1, runtimeVersion: "0.1.0", sdkVersion: "0.3.301" }));
    await server.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "runtime.hello", params: { protocolVersion: 1 } }));
    expect(last()).toEqual({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1, runtimeVersion: "0.1.0", sdkVersion: "0.3.301" } });
  });

  it("retorna ParseError para JSON inválido", async () => {
    const { server, last } = makeServer();
    await server.handleLine("{nope");
    expect(last().error.code).toBe(JsonRpcErrorCode.ParseError);
    expect(last().id).toBeNull();
  });

  it("retorna MethodNotFound para método desconhecido, preservando o id", async () => {
    const { server, last } = makeServer();
    await server.handleLine(JSON.stringify({ jsonrpc: "2.0", id: "abc", method: "nao.existe" }));
    expect(last().id).toBe("abc");
    expect(last().error.code).toBe(JsonRpcErrorCode.MethodNotFound);
  });

  it("retorna InvalidParams quando params não batem com o schema", async () => {
    const { server, last } = makeServer();
    server.register("run.start", async () => ({ accepted: true }));
    await server.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "run.start", params: { runId: "r1" } }));
    expect(last().error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(JSON.stringify(last().error.data)).toContain("cwd");
  });

  it("propaga RpcError do handler com código próprio", async () => {
    const { server, last } = makeServer();
    server.register("run.interrupt", async () => {
      throw new RpcError(JsonRpcErrorCode.RunNotFound, "sumiu");
    });
    await server.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "run.interrupt", params: { runId: "x" } }));
    expect(last().error).toEqual({ code: JsonRpcErrorCode.RunNotFound, message: "sumiu" });
  });

  it("converte exceções genéricas em InternalError", async () => {
    const { server, last } = makeServer();
    server.register("run.interrupt", async () => {
      throw new Error("boom");
    });
    await server.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 4, method: "run.interrupt", params: { runId: "x" } }));
    expect(last().error.code).toBe(JsonRpcErrorCode.InternalError);
    expect(last().error.message).toBe("boom");
  });

  it("ignora linhas vazias e respostas recebidas", async () => {
    const { server, lines } = makeServer();
    await server.handleLine("");
    await server.handleLine("   ");
    await server.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 9, result: {} }));
    expect(lines).toHaveLength(0);
  });

  it("emite notificações sem id", () => {
    const { server, last } = makeServer();
    server.notify("runtime.log", { level: "info", message: "oi" });
    expect(last()).toEqual({ jsonrpc: "2.0", method: "runtime.log", params: { level: "info", message: "oi" } });
  });
});
