import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "../App";
import { createMockTransport } from "../lib/mockTransport";
import { describeConfig, parseKeyValues } from "./HarnessView";

function setup() {
  const transport = createMockTransport({ tickMs: 5 });
  const user = userEvent.setup();
  render(<App transport={transport} />);
  return { transport, user };
}

describe("Harness · MCP servers", () => {
  it("cadastra, testa, desativa e remove um MCP server; os ativos entram no run", async () => {
    const { user, transport } = setup();
    await screen.findByDisplayValue("chat-core");
    await user.click(screen.getByRole("button", { name: "Harness" }));
    const view = await screen.findByTestId("harness-view");
    expect(within(view).getAllByTestId("mcp-row")).toHaveLength(1); // octopus embutido

    await user.click(within(view).getByRole("button", { name: "Novo MCP server" }));
    const dialog = await screen.findByRole("dialog", { name: "Novo MCP server" });
    await user.type(within(dialog).getByLabelText("Nome do MCP server"), "docs");
    await user.selectOptions(within(dialog).getByLabelText("Escopo do MCP server"), "global");
    await user.type(within(dialog).getByLabelText("Comando do MCP server"), "npx -y @modelcontextprotocol/server-filesystem ~/Docs");
    await user.type(within(dialog).getByLabelText("Variáveis de ambiente"), "LOG_LEVEL=warn");
    await user.click(within(dialog).getByRole("button", { name: "Salvar" }));
    const row = await waitFor(() => screen.getAllByTestId("mcp-row").find((r) => r.getAttribute("data-name") === "docs")!);
    expect(row).toHaveAttribute("data-health", "unknown");
    expect(row).toHaveTextContent("global");
    expect(row).toHaveTextContent("npx -y @modelcontextprotocol/server-filesystem ~/Docs · env LOG_LEVEL");

    await user.click(within(row).getByRole("button", { name: "Testar" }));
    await waitFor(() => expect(screen.getAllByTestId("mcp-row").find((r) => r.getAttribute("data-name") === "docs")).toHaveAttribute("data-health", "ok"));
    expect(screen.getByRole("status")).toHaveTextContent("docs: conectado, 2 tools (read_file, list_dir).");

    // Um run leva os servidores ativos (sem o octopus, que o sidecar acrescenta).
    await user.click(screen.getByRole("button", { name: "Run ao vivo" }));
    await user.type(screen.getByLabelText("Instrução para o agente"), "oi");
    await user.click(screen.getByRole("button", { name: "Enviar" }));
    await screen.findByTestId("approval-card");
    const [run] = await transport.invoke("list_runs", { projectId: "proj_demo" });
    expect(run?.options.mcpServers).toEqual({ docs: { type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "~/Docs"], env: { LOG_LEVEL: "warn" } } });

    // Servidor do projeto que falha no teste; desativado não entra no run.
    await user.click(screen.getByRole("button", { name: "Harness" }));
    await user.click(await screen.findByRole("button", { name: "Novo MCP server" }));
    const d2 = await screen.findByRole("dialog", { name: "Novo MCP server" });
    await user.type(within(d2).getByLabelText("Nome do MCP server"), "jira");
    await user.selectOptions(within(d2).getByLabelText("Transporte do MCP server"), "http");
    await user.type(within(d2).getByLabelText("URL do MCP server"), "mcp.fail.example.com");
    await user.click(within(d2).getByRole("button", { name: "Salvar" }));
    expect(await within(d2).findByRole("alert")).toHaveTextContent("A URL precisa começar com http:// ou https://");
    await user.clear(within(d2).getByLabelText("URL do MCP server"));
    await user.type(within(d2).getByLabelText("URL do MCP server"), "https://mcp.fail.example.com/jira");
    await user.type(within(d2).getByLabelText("Headers"), "Authorization=Bearer abc");
    await user.click(within(d2).getByRole("button", { name: "Salvar" }));
    const jira = await waitFor(() => screen.getAllByTestId("mcp-row").find((r) => r.getAttribute("data-name") === "jira")!);
    expect(jira).toHaveTextContent("chat-core");
    await user.click(within(jira).getByRole("button", { name: "Testar" }));
    await waitFor(() => expect(screen.getAllByTestId("mcp-row").find((r) => r.getAttribute("data-name") === "jira")).toHaveAttribute("data-health", "error"));
    await user.click(within(screen.getAllByTestId("mcp-row").find((r) => r.getAttribute("data-name") === "jira")!).getByRole("switch", { name: "jira ativo" }));
    await waitFor(() => expect(screen.getAllByTestId("mcp-row").find((r) => r.getAttribute("data-name") === "jira")).toHaveAttribute("data-enabled", "false"));
    const servers = await transport.invoke("list_mcp_servers", { projectId: "proj_demo" });
    expect(servers.map((s) => [s.name, s.enabled])).toEqual([
      ["docs", true],
      ["jira", false],
    ]);

    // Remover pelo diálogo de edição; auditoria registra sem valores de env.
    await user.click(within(screen.getAllByTestId("mcp-row").find((r) => r.getAttribute("data-name") === "docs")!).getByRole("button", { name: /docs/ }));
    const edit = await screen.findByRole("dialog", { name: "Editar MCP server" });
    await user.click(within(edit).getByRole("button", { name: "Remover" }));
    await waitFor(() => expect(screen.getAllByTestId("mcp-row").some((r) => r.getAttribute("data-name") === "docs")).toBe(false));
    const audit = await transport.invoke("list_audit_events", { kindPrefix: "harness.", limit: 50 });
    expect(audit.map((e) => e.kind)).toEqual(expect.arrayContaining(["harness.mcp.created", "harness.mcp.checked", "harness.mcp.enabled", "harness.mcp.deleted"]));
    expect(JSON.stringify(audit)).not.toContain("Bearer abc");
  });

  it("helpers", () => {
    expect(parseKeyValues("A=1\n# comentário\nB = x=y\ninválido")).toEqual({ A: "1", B: "x=y" });
    expect(describeConfig({ type: "http", url: "https://x", headers: { Authorization: "t" } })).toBe("https://x · header Authorization");
    expect(describeConfig({ type: "stdio", command: "npx", args: ["a"] })).toBe("npx a");
  });
});
