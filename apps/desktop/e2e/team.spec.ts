import { expect, test } from "@playwright/test";

test.describe("Time (mock)", () => {
  test("adiciona dois membros com delegação e dá uma tarefa ao chefe", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Time" }).click();
    await expect(page.getByTestId("team-view")).toBeVisible();

    const dialog = page.getByRole("dialog", { name: "Adicionar ao time" });
    await page.getByRole("button", { name: "Adicionar membro" }).click();
    await dialog.getByLabel("Nome", { exact: true }).fill("Ana");
    await dialog.getByLabel("Cargo", { exact: true }).selectOption({ label: "Implementador · Código e migrações" });
    await dialog.getByRole("button", { name: "Adicionar" }).click();

    await page.getByRole("button", { name: "Adicionar membro" }).click();
    await dialog.getByLabel("Nome", { exact: true }).fill("Téo");
    await dialog.getByLabel("Cargo", { exact: true }).selectOption({ label: "Testador · Testes e qualidade" });
    await dialog.getByLabel("Reporta a", { exact: true }).selectOption({ label: "Ana · Implementador" });
    await dialog.getByRole("button", { name: "Adicionar" }).click();

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
