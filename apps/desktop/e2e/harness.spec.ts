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
