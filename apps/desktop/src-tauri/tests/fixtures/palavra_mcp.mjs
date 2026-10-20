// MCP server stdio mínimo para o teste real do harness: uma tool `palavra` que devolve uma
// palavra fixa. Usa o SDK MCP oficial já instalado no repositório (nada é baixado).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({ name: "palavra-teste", version: "1.0.0" });
server.registerTool("palavra", { description: "Devolve a palavra do dia do projeto." }, async () => ({
  content: [{ type: "text", text: "abacaxi" }],
}));
await server.connect(new StdioServerTransport());
