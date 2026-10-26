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
    await page.getByTestId("task-detail").getByLabel("Comentário").fill("Cite as fontes no resumo.");
    await page.getByTestId("task-detail").getByRole("button", { name: "Comentar" }).click();
    await expect(page.getByTestId("task-comment")).toContainText("Cite as fontes");
    await page.getByTestId("task-detail").getByRole("button", { name: "Aprovar e seguir" }).click();
    await expect(card).toHaveAttribute("data-status", "running");

    // Segundo estágio: aprovar e concluir; a entrega aparece na task e na aba Entregas.
    await expect(card).toHaveAttribute("data-status", "waiting_approval", { timeout: 10_000 });
    await page.getByTestId("task-detail").getByRole("button", { name: "Aprovar e concluir" }).click();
    await expect(card).toHaveAttribute("data-status", "done");
    await expect(page.getByTestId("task-result")).toContainText("Como verificar");
    await expect(page.getByTestId("task-history").getByTestId("task-run")).toHaveCount(2);
    await expect(page.getByTestId("task-comment")).toContainText("Cite as fontes");
    await page.getByTestId("task-detail").getByRole("button", { name: "Ver diff" }).click();
    await expect(page.getByTestId("task-diff")).toContainText("V12__add_triage_status.sql");
    await page.getByRole("radio", { name: /Entregas · 1/ }).click();
    await expect(page.getByTestId("delivery-row")).toContainText("Mapear integrações");
    await expect(page.getByTestId("workflow-report")).toContainText("Relatório final");
    await expect(page.getByTestId("report-progress")).toContainText("1 de 1");

    // Missão e objetivos: a missão fica no Board; o objetivo criado aparece com progresso.
    await page.getByRole("button", { name: "Definir missão" }).click();
    await page.getByRole("dialog", { name: "Missão do projeto" }).getByLabel("Missão", { exact: true }).fill("Reduzir a triagem em 30%.");
    await page.getByRole("button", { name: "Salvar missão" }).click();
    await expect(page.getByTestId("project-mission")).toContainText("Missão: Reduzir a triagem em 30%.");
    await page.getByRole("radio", { name: "Objetivos · 0" }).click();
    await page.getByTestId("goal-form").getByLabel("Título do objetivo").fill("Triagem 30% mais rápida");
    await page.getByTestId("goal-form").getByRole("button", { name: "Criar" }).click();
    await expect(page.getByTestId("goal-row")).toContainText("0 de 0 tasks");
    await expect(page.getByRole("radio", { name: "Objetivos · 1" })).toBeVisible();
  });
});
