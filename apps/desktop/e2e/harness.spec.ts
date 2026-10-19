import { expect, test } from "@playwright/test";

test.describe("Harness · MCP servers (mock)", () => {
  test("cadastra um MCP server global, testa a conexão e vê as tools", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Harness" }).click();
    await expect(page.getByTestId("mcp-row")).toHaveCount(1);
    await page.getByRole("button", { name: "Novo MCP server" }).click();
    const dialog = page.getByRole("dialog", { name: "Novo MCP server" });
    await dialog.getByLabel("Nome do MCP server").fill("docs");
    await dialog.getByLabel("Comando do MCP server").fill("npx -y @modelcontextprotocol/server-filesystem ~/Docs");
    await dialog.getByRole("button", { name: "Salvar" }).click();
    const row = page.getByTestId("mcp-row").filter({ hasText: "docs" });
    await expect(row).toHaveAttribute("data-health", "unknown");
    await row.getByRole("button", { name: "Testar" }).click();
    await expect(row).toHaveAttribute("data-health", "ok");
    await expect(page.getByRole("status")).toContainText("docs: conectado, 2 tools");
  });
});

test.describe("Harness · hooks livres (mock)", () => {
  test("cria um hook, testa com exemplo e ele aparece no run", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Harness" }).click();
    await page.getByRole("tab", { name: /Hooks/ }).click();
    await page.getByRole("button", { name: "Novo hook" }).click();
    const form = page.getByRole("form", { name: "Novo hook" });
    await form.getByLabel("Nome").fill("Guarda Bash");
    await form.getByLabel("Evento").selectOption("PostToolUse");
    await form.getByLabel("Ferramentas (regex)").fill("Bash");
    await form.getByLabel(/Comando/).fill('echo "use o wrapper" >&2; exit 2');
    await form.getByRole("button", { name: "Testar com exemplo" }).click();
    await expect(page.getByTestId("hook-test")).toContainText("bloqueia: use o wrapper");
    await form.getByRole("button", { name: "Salvar" }).click();
    await expect(page.getByRole("tab", { name: "Hooks · 1" })).toBeVisible();

    await page.getByRole("button", { name: "Run ao vivo" }).click();
    await page.getByLabel("Instrução para o agente").fill("rodar testes");
    await page.getByRole("button", { name: "Enviar" }).click();
    await page.getByTestId("approval-card").getByRole("button", { name: "Permitir uma vez" }).click();
    await expect(page.getByTestId("hook-run")).toHaveAttribute("data-outcome", "blocked");
  });
});
