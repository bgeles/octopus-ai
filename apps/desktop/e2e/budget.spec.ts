import { expect, test } from "@playwright/test";

test.describe("Segurança · Sandbox e Orçamentos (mock)", () => {
  test("troca o perfil de sandbox e um limite estourado bloqueia novos runs", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("sandbox-chip")).toHaveText(/Sandbox Dev padrão/);

    await page.getByRole("button", { name: "Segurança" }).click();
    await page.getByRole("radio", { name: "Somente leitura" }).click();
    await expect(page.getByTestId("sandbox-section")).toHaveAttribute("data-profile", "sandbox_readonly");

    await page.getByRole("tab", { name: "Orçamentos" }).click();
    const card = page.getByTestId("budget-card").first();
    await card.getByRole("button", { name: "Definir limite" }).click();
    await card.getByLabel("Limite de chat-core").fill("0.03");
    await card.getByRole("button", { name: "Salvar" }).click();
    await expect(card).toContainText("hard 0.03");

    await page.getByRole("button", { name: "Run ao vivo" }).click();
    await expect(page.getByTestId("sandbox-chip")).toHaveText(/Sandbox Somente leitura/);
    await page.getByLabel("Instrução para o agente").fill("rodar testes");
    await page.getByRole("button", { name: "Enviar" }).click();
    await page.getByTestId("approval-card").getByRole("button", { name: "Permitir uma vez" }).click();
    await expect(page.getByTestId("run-status")).toHaveText("Concluído");
    await expect(page.getByTestId("budget-chip")).toHaveAttribute("data-level", "hard");

    await page.getByLabel("Instrução para o agente").fill("de novo");
    await page.getByRole("button", { name: "Enviar" }).click();
    await expect(page.getByRole("status")).toContainText("Orçamento mensal esgotado para chat-core");
  });
});
