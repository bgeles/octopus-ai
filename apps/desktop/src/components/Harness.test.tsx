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

  it("skills: lista as encontradas, liga/desliga, edita o SKILL.md e cria uma nova no projeto", async () => {
    const { user, transport } = setup();
    await screen.findByDisplayValue("chat-core");
    await user.click(screen.getByRole("button", { name: "Harness" }));
    await user.click(await screen.findByRole("tab", { name: /Skills · 3/ }));
    const rows = await screen.findAllByTestId("skill-row");
    expect(rows.map((r) => r.getAttribute("data-name"))).toEqual(["flyway-migration", "java-review", "commit-ptbr"]);
    expect(rows[2]).toHaveAttribute("data-source", "user");

    await user.click(within(rows[2]!).getByRole("switch", { name: "commit-ptbr ativa" }));
    await waitFor(() => expect(screen.getAllByTestId("skill-row")[2]).toHaveAttribute("data-enabled", "false"));

    await user.click(within(screen.getAllByTestId("skill-row")[0]!).getByRole("button", { name: "Editar" }));
    const editor = await screen.findByRole("form", { name: "Editar skill" });
    const textarea = within(editor).getByLabelText("Conteúdo da skill");
    expect((textarea as HTMLTextAreaElement).value).toContain("name: flyway-migration");
    await user.type(textarea, "\n3. Rode MigrationIT.");
    await user.click(within(editor).getByRole("button", { name: "Salvar" }));
    expect(await screen.findByRole("status")).toHaveTextContent("SKILL.md de flyway-migration gravado.");
    expect(await transport.invoke("read_skill", { skillId: "skill_flyway-migration" })).toContain("3. Rode MigrationIT.");

    await user.click(screen.getByRole("button", { name: "Nova skill" }));
    const form = await screen.findByRole("form", { name: "Nova skill" });
    await user.type(within(form).getByLabelText("Nome da skill"), "Release notes");
    await user.type(within(form).getByLabelText("Conteúdo da skill"), "Gera notas de versão a partir do git log.");
    await user.click(within(form).getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(screen.getAllByTestId("skill-row")).toHaveLength(4));
    const created = (await transport.invoke("list_skills", { projectId: "proj_demo" })).find((s) => s.name === "Release notes")!;
    expect(created.path).toBe("/Users/dev/projetos/chat-core/.claude/skills/release-notes");
    expect(created.description).toBe("Gera notas de versão a partir do git log.");
    expect(await transport.invoke("read_skill", { skillId: created.id })).toMatch(/^---\nname: Release notes\n/);
    await user.click(screen.getByRole("button", { name: "Rescanear" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Varredura concluída: 4 skills.");
  });

  it("a ficha do membro escolhe MCP servers e skills; o run dele leva só os escolhidos e o plugin com as skills do usuário", async () => {
    const { user, transport } = setup();
    await screen.findByDisplayValue("chat-core");
    await transport.invoke("save_mcp_server", { input: { projectId: null, name: "docs", config: { type: "stdio", command: "npx", args: ["-y", "srv"] } } });
    await transport.invoke("save_mcp_server", { input: { projectId: "proj_demo", name: "jira", config: { type: "http", url: "https://mcp.example.com/jira" } } });

    await user.click(screen.getByRole("button", { name: "Time" }));
    await screen.findByTestId("team-view");
    await user.click(screen.getByRole("button", { name: "Adicionar membro" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Nome"), "Ana");
    const roleSelect = within(dialog).getByLabelText("Cargo");
    await user.selectOptions(roleSelect, within(roleSelect).getByRole("option", { name: /^Implementador ·/ }));
    const mcpPicker = await within(dialog).findByTestId("picker-MCP servers");
    await user.click(within(mcpPicker).getByRole("checkbox", { name: "Todos os ativos do projeto" }));
    await user.click(within(mcpPicker).getByRole("checkbox", { name: /^docs/ }));
    const skillPicker = within(dialog).getByTestId("picker-Skills");
    await user.click(within(skillPicker).getByRole("checkbox", { name: "Todos os ativos do projeto" }));
    await user.click(within(skillPicker).getByRole("checkbox", { name: /^commit-ptbr/ }));
    await user.click(within(dialog).getByRole("button", { name: "Adicionar" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const [member] = await transport.invoke("list_team", { projectId: "proj_demo" });
    expect(member?.profile.mcpServerIds).toHaveLength(1);
    expect(member?.profile.skillIds).toEqual(["skill_commit-ptbr"]);

    await user.click(within(screen.getByRole("article", { name: "Membro do time: Ana" })).getByRole("button", { name: "Dar uma tarefa" }));
    await user.type(screen.getByLabelText("Instrução para Ana"), "oi");
    await user.click(screen.getByRole("button", { name: "Enviar" }));
    await screen.findByTestId("approval-card");
    const [run] = await transport.invoke("list_runs", { projectId: "proj_demo" });
    expect(Object.keys(run!.options.mcpServers ?? {})).toEqual(["docs"]);
    expect(run!.options.plugins).toEqual([{ type: "local", path: `/mock/data/projects/proj_demo/harness/plugin-${member!.profile.id}`, skipMcpDiscovery: true }]);
  });

  it("perfil de execução: defaults do projeto entram no preview com origem e o JSON não traz segredos", async () => {
    const { user, transport } = setup();
    await screen.findByDisplayValue("chat-core");
    await transport.invoke("update_project_auth", { projectId: "proj_demo", authMode: "api_key" });
    await transport.invoke("set_project_api_key", { projectId: "proj_demo", apiKey: "sk-ant-teste-preview" });
    await transport.invoke("save_mcp_server", { input: { projectId: null, name: "docs", config: { type: "stdio", command: "npx" } } });

    await user.click(screen.getByRole("button", { name: "Harness" }));
    await user.click(await screen.findByRole("tab", { name: "Perfil de execução" }));
    const defaultsBox = await screen.findByTestId("project-defaults");
    await user.type(within(defaultsBox).getByLabelText("Modelo padrão do projeto"), "claude-sonnet-5-5");
    await user.tab();
    await user.type(within(defaultsBox).getByLabelText("Máximo de turnos do projeto"), "25");
    await user.tab();
    await waitFor(async () => expect((await transport.invoke("get_settings", {}))["project.proj_demo.defaults"]).toEqual({ model: "claude-sonnet-5-5", maxTurns: 25 }));

    await user.click(screen.getByRole("button", { name: "Gerar preview" }));
    const notes = await screen.findAllByTestId("preview-note");
    const byField = (f: string) => notes.filter((n) => n.getAttribute("data-field") === f).map((n) => n.getAttribute("data-origin"));
    expect(byField("model")).toEqual(["projeto"]);
    expect(byField("maxTurns")).toEqual(["projeto"]);
    expect(byField("policyHooks")).toEqual(["segurança"]);
    expect(byField("mcpServers")).toEqual(["harness"]);
    expect(notes.find((n) => n.getAttribute("data-field") === "mcpServers")).toHaveTextContent("octopus (sdk), docs (stdio)");
    expect(notes.find((n) => n.getAttribute("data-field") === "env")).toHaveTextContent("••• do Keychain");
    expect(screen.getAllByTestId("hook-row").map((r) => r.textContent)).toEqual(expect.arrayContaining([expect.stringContaining("PreToolUse"), expect.stringContaining("PostToolUse")]));
    await user.click(screen.getByRole("button", { name: "JSON completo (segredos redigidos)" }));
    const json = screen.getByTestId("preview-json").textContent ?? "";
    expect(json).toContain('"model": "claude-sonnet-5-5"');
    expect(json).not.toContain("sk-ant-teste-preview");
    expect((await transport.invoke("list_runs", { projectId: "proj_demo" })).length).toBe(0);

    // O default de modelo vale no run avulso.
    await user.click(screen.getByRole("button", { name: "Run ao vivo" }));
    await user.type(screen.getByLabelText("Instrução para o agente"), "oi");
    await user.click(screen.getByRole("button", { name: "Enviar" }));
    await screen.findByTestId("approval-card");
    const [run] = await transport.invoke("list_runs", { projectId: "proj_demo" });
    expect(run?.options.model).toBe("claude-sonnet-5-5");
  });
});

