/**
 * Teste de conexão de um MCP server (`mcp.check`): abre o transporte, faz o handshake com o
 * cliente MCP oficial e lista as tools. As dependências são injetáveis para testar sem rede.
 */
import type { McpCheckResult, McpServerConfig } from "@octopus/protocol";

export const MCP_CHECK_TIMEOUT_MS = 15_000;

export type McpClientLike = {
  connect(transport: unknown): Promise<void>;
  listTools(): Promise<{ tools: Array<{ name: string; description?: string }> }>;
  getServerVersion?(): { name?: string; version?: string } | undefined;
  close(): Promise<void>;
};

export type McpCheckDeps = {
  createClient: () => McpClientLike;
  createTransport: (config: McpServerConfig) => Promise<unknown>;
  timeoutMs?: number;
};

export async function defaultMcpDeps(): Promise<McpCheckDeps> {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  return {
    createClient: () => new Client({ name: "octopus-desktop", version: "0.1.0" }) as unknown as McpClientLike,
    createTransport: async (config) => {
      if (config.type === "stdio") {
        const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
        const env = Object.fromEntries(Object.entries({ ...process.env, ...(config.env ?? {}) }).filter((e): e is [string, string] => typeof e[1] === "string"));
        return new StdioClientTransport({ command: config.command, args: config.args ?? [], env, stderr: "ignore" });
      }
      const headers = config.headers ?? {};
      if (config.type === "sse") {
        const { SSEClientTransport } = await import("@modelcontextprotocol/sdk/client/sse.js");
        return new SSEClientTransport(new URL(config.url), { requestInit: { headers } });
      }
      const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
      return new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers } });
    },
  };
}

export async function checkMcpServer(config: McpServerConfig, deps: McpCheckDeps): Promise<McpCheckResult> {
  const started = Date.now();
  const timeoutMs = deps.timeoutMs ?? MCP_CHECK_TIMEOUT_MS;
  let client: McpClientLike | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const transport = await deps.createTransport(config);
    client = deps.createClient();
    const work = (async () => {
      await client!.connect(transport);
      const listed = await client!.listTools();
      return listed.tools.map((t) => ({ name: t.name, description: t.description ?? null }));
    })();
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Sem resposta em ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
    });
    const tools = await Promise.race([work, timeout]);
    const version = client.getServerVersion?.();
    return { ok: true, tools, error: null, latencyMs: Date.now() - started, serverVersion: version?.version ? `${version.name ?? ""} ${version.version}`.trim() : null };
  } catch (error) {
    return { ok: false, tools: [], error: error instanceof Error ? error.message : String(error), latencyMs: Date.now() - started, serverVersion: null };
  } finally {
    if (timer) clearTimeout(timer);
    if (client) await client.close().catch(() => {});
  }
}
