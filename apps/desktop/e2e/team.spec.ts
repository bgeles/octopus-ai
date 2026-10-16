import { expect, test } from "@playwright/test";

test.describe("Time (mock)", () => {
  test("adiciona dois membros com delegação e dá uma tarefa ao chefe", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Time" }).click();
    await expect(page.getByTestId("team-view")).toBeVisible();

    await page.getByRole("button", { name: "Adicionar membro" }).click();
    await page.getByLabel("Nome").fill("Ana");
    await page.getByLabel("Cargo").selectOption({ label: "Implementador · Código e migrações" });
    await page.getByRole("button", { name: "Adicionar" }).click();

    await page.getByRole("button", { name: "Adicionar membro" }).click();
    await page.getByLabel("Nome").fill("Téo");
    await page.getByLabel("Cargo").selectOption({ label: "Testador · Testes e qualidade" });
    await page.getByLabel("Reporta a").selectOption({ label: "Ana · Implementador" });
    await page.getByRole("button", { name: "Adicionar" }).click();

    await expect(page.getByTestId("member-card")).toHaveCount(2);
    await expect(page.getByTestId("org-node")).toHaveCount(3);
    await expect(page.getByTestId("team-summary")).toContainText("2 membros");

    await page.getByRole("article", { name: "Membro do time: Ana" }).getByRole("button", { name: "Dar uma tarefa" }).click();
    await expect(page.getByTestId("run-as-banner")).toContainText("Tarefa para Ana");
    await page.getByLabel("Instrução para Ana").fill("Crie a migração V12");
    await page.getByRole("button", { name: "Enviar" }).click();
    await expect(page.getByTestId("run-status")).toHaveText(/Executando|Aguardando aprovação/);

    await page.getByRole("button", { name: "Time" }).click();
    await expect(page.getByRole("article", { name: "Membro do time: Ana" })).toHaveAttribute("data-status", /active|waiting/);
  });
});
