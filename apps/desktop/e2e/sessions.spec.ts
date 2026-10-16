import { expect, test } from "@playwright/test";

test.describe("Sessões (mock)", () => {
  test("retoma uma sessão pela lista e o run continua com o mesmo id de sessão", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Sessões" }).click();

    const row = page.getByTestId("session-row").first();
    await expect(row).toContainText("Criar migração Flyway V12 para tabela leads");
    await row.getByRole("button", { name: "Retomar" }).click();

    const banner = page.getByTestId("resume-banner");
    await expect(banner).toContainText("Retomando");
    await expect(page.getByLabel("Instrução para o agente")).toBeFocused();

    await page.getByLabel("Instrução para o agente").fill("O que fizemos antes?");
    await page.getByRole("button", { name: "Enviar" }).click();
    await expect(banner).toBeHidden();
    await expect(page.getByTestId("run-status")).toHaveText("Executando");
    await expect(page.getByText("5b3f2c1a-8d4e-4f6b-9a7c-2e1d0f9b8a6c")).toBeVisible();
  });

  test("renomeia uma sessão inline", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Sessões" }).click();
    const row = page.getByTestId("session-row").first();
    await row.getByRole("button", { name: "Renomear" }).click();
    await row.getByLabel("Novo título").fill("Título novo");
    await row.getByLabel("Novo título").press("Enter");
    await expect(page.getByTestId("session-title").first()).toHaveText("Título novo");
  });
});
