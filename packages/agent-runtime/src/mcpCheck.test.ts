import { describe, expect, it } from "vitest";
import { checkMcpServer, type McpCheckDeps } from "./mcpCheck.js";

function deps(overrides: Partial<McpCheckDeps> & { tools?: Array<{ name: string; description?: string }>; failConnect?: string; hang?: boolean }): McpCheckDeps & { state: { closed: number } } {
  const state = { closed: 0 };
  const base: McpCheckDeps = {
    createTransport: async (config) => ({ config }),
    createClient: () => ({
      async connect() {
        if (overrides.failConnect) throw new Error(overrides.failConnect);
        if (overrides.hang) await new Promise(() => {});
      },
      async listTools() {
        return { tools: overrides.tools ?? [] };
      },
      getServerVersion: () => ({ name: "fake", version: "1.0" }),
      async close() {
        state.closed += 1;
      },
    }),
    timeoutMs: overrides.timeoutMs,
  };
  return { ...base, ...overrides, state };
}

describe("mcp.check", () => {
  it("conecta, lista tools e fecha", async () => {
    const d = deps({ tools: [{ name: "read_file", description: "Lê" }, { name: "list_dir" }] });
    const r = await checkMcpServer({ type: "stdio", command: "npx", args: ["x"] }, d);
    expect(r.ok).toBe(true);
    expect(r.tools).toEqual([
      { name: "read_file", description: "Lê" },
      { name: "list_dir", description: null },
    ]);
    expect(r.serverVersion).toBe("fake 1.0");
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
    expect(d.state.closed).toBe(1);
  });

  it("falha de conexão vira erro legível, sem lançar", async () => {
    const d = deps({ failConnect: "401 Unauthorized" });
    const r = await checkMcpServer({ type: "http", url: "https://mcp.example.com/jira" }, d);
    expect(r).toMatchObject({ ok: false, tools: [], error: "401 Unauthorized" });
    expect(d.state.closed).toBe(1);
  });

  it("respeita o timeout", async () => {
    const d = deps({ hang: true, timeoutMs: 30 });
    const r = await checkMcpServer({ type: "sse", url: "https://mcp.example.com/sse" }, d);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("Sem resposta");
  });

  it("erro ao criar o transporte também é capturado", async () => {
    const d = deps({ createTransport: async () => { throw new Error("comando não encontrado"); } });
    const r = await checkMcpServer({ type: "stdio", command: "nope" }, d);
    expect(r).toMatchObject({ ok: false, error: "comando não encontrado" });
  });
});
