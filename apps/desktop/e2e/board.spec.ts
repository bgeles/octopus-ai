import { expect, test } from "@playwright/test";

test.describe("Board (mock)", () => {
  test("cria workflow pelo modelo, abre uma task, o scheduler roda e o gate pede sua aprovação", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Board" }).click();
    await expect(page.getByTestId("workflow-template")).toHaveCount(2);
    await page.getByTestId("workflow-template").nth(1).getByRole("button", { name: "Usar este workflow" }).click();
    await expect(page.getByTestId("stage-chip")).toHaveCount(2);

    await page.getByRole("button", { name: "Nova task" }).click();
    const dialog = page.getByRole("dialog", { name: "Pesquisa paralela → Síntese" });
    await dialog.getByLabel("Título", { exact: true }).fill("Mapear integrações");
    await dialog.getByRole("button", { name: "Criar task" }).click();

    const card = page.getByTestId("task-card");
    await expect(card).toHaveAttribute("data-status", "running");
    await expect(card).toHaveAttribute("data-status", "waiting_approval", { timeout: 10_000 });
    await expect(page.getByTestId("task-detail")).toContainText("aguardando você");
    await page.getByTestId("task-detail").getByRole("button", { name: "Aprovar e seguir" }).click();
    await expect(card).toHaveAttribute("data-status", "running");

    // Segundo estágio: aprovar e concluir; a entrega aparece na task e na aba Entregas.
    await expect(card).toHaveAttribute("data-status", "waiting_approval", { timeout: 10_000 });
    await page.getByTestId("task-detail").getByRole("button", { name: "Aprovar e concluir" }).click();
    await expect(card).toHaveAttribute("data-status", "done");
    await expect(page.getByTestId("task-result")).toContainText("Como verificar");
    await page.getByTestId("task-detail").getByRole("button", { name: "Ver diff" }).click();
    await expect(page.getByTestId("task-diff")).toContainText("V12__add_triage_status.sql");
    await page.getByRole("radio", { name: /Entregas · 1/ }).click();
    await expect(page.getByTestId("delivery-row")).toContainText("Mapear integrações");
    await expect(page.getByTestId("workflow-report")).toContainText("Relatório final");
    await expect(page.getByTestId("report-progress")).toContainText("1 de 1");
  });
});
