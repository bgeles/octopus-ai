import { expect, test } from "@playwright/test";

test.describe("Memória (mock)", () => {
  test("o run gera o log de tarefas; criar e buscar página", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Run ao vivo" }).click();
    await page.getByLabel("Instrução para o agente").fill("rodar testes");
    await page.getByRole("button", { name: "Enviar" }).click();
    await page.getByTestId("approval-card").getByRole("button", { name: "Permitir uma vez" }).click();
    await expect(page.getByTestId("run-status")).toHaveText("Concluído");

    await page.getByRole("button", { name: "Memória" }).click();
    const row = page.getByTestId("memory-page-row").first();
    await expect(row).toContainText("Log de tarefas");
    await row.click();
    await expect(page.getByTestId("memory-page-body")).toContainText("Pedido: rodar testes");

    await page.getByRole("button", { name: "Nova página" }).click();
    await page.getByLabel("Título da página").fill("Testes exigem Postgres 16");
    await page.getByLabel("Conteúdo da página").fill("Os testes de integração sobem um Postgres 16 local.");
    await page.getByRole("button", { name: "Salvar" }).click();
    await expect(page.getByRole("status")).toContainText("Página criada.");
    await page.getByLabel("Buscar (FTS5)").fill("postgres");
    await expect(page.getByTestId("memory-page-row")).toHaveCount(1);
    await expect(page.getByTestId("memory-page-row")).toContainText("Testes exigem Postgres 16");
  });
});
