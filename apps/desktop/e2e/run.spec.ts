import { expect, test } from "@playwright/test";

test.describe("Run ao vivo (mock)", () => {
  test("inicia um run, aprova a permissão e vê o resultado", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Run ao vivo");
    await expect(page.getByTestId("run-status")).toHaveText("Pronto");

    await page.getByLabel("Instrução para o agente").fill("Liste as migrações e resuma a última");
    await page.getByRole("button", { name: "Enviar" }).click();

    await expect(page.getByTestId("transcript-user")).toContainText("Liste as migrações");
    await expect(page.getByTestId("run-status")).toHaveText("Executando");
    await expect(page.getByTestId("tool-call")).toContainText("Glob");

    const approval = page.getByTestId("approval-card");
    await expect(approval).toContainText("Bash");
    await expect(page.getByTestId("run-status")).toHaveText("Aguardando aprovação");
    await approval.getByRole("button", { name: "Permitir uma vez" }).click();

    await expect(page.getByTestId("run-status")).toHaveText("Concluído");
    await expect(page.getByText("US$ 0,04")).toBeVisible();
    await expect(page.getByRole("progressbar", { name: "Uso do contexto" })).toHaveAttribute("aria-valuenow", "9");
  });

  test("interrompe um run em andamento", async ({ page }) => {
    await page.goto("/");
    await page.getByLabel("Instrução para o agente").fill("qualquer coisa");
    await page.getByRole("button", { name: "Enviar" }).click();
    await page.getByRole("button", { name: "Interromper" }).click();
    await expect(page.getByTestId("run-status")).toHaveText("Interrompido");
    await expect(page.getByRole("alert")).toContainText("interrompido");
  });
});
