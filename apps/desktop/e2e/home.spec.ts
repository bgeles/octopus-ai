import { expect, test } from "@playwright/test";

test.describe("Início (mock)", () => {
  test("abre em Início com a versão no rodapé; o time aparece atuando e pode ser pausado pelo painel", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("home-view")).toBeVisible();
    await expect(page.getByTestId("app-version")).toContainText("Octopus AI 0.1.0");
    await expect(page.getByTestId("home-team")).toContainText("Ainda não há membros");

    // Adiciona um membro pelo Início → Time.
    await page.getByTestId("home-view").getByRole("button", { name: "Adicionar membro" }).click();
    const dialog = page.getByRole("dialog", { name: "Adicionar ao time" });
    await dialog.getByLabel("Nome", { exact: true }).fill("Ana");
    await dialog.getByLabel("Cargo", { exact: true }).selectOption({ label: "Implementador · Código e migrações" });
    await dialog.getByRole("button", { name: "Adicionar" }).click();
    await expect(page.getByRole("article", { name: "Membro do time: Ana" })).toBeVisible();

    // Dar uma tarefa e voltar ao Início: Ana em run, feed com o run, card de membros em run.
    await page.getByRole("article", { name: "Membro do time: Ana" }).getByRole("button", { name: "Dar uma tarefa" }).click();
    await page.getByLabel("Instrução para Ana").fill("Crie a migração V12");
    await page.getByRole("button", { name: "Enviar" }).click();
    await page.getByRole("button", { name: "Início" }).click();
    const row = page.getByTestId("home-member");
    await expect(row).toHaveAttribute("data-status", /active|waiting/);
    await expect(page.getByTestId("home-activity")).toContainText("iniciou um run");
    await expect(page.getByTestId("card-active")).toContainText("1");

    // Pausar e retomar pelo painel.
    await row.getByRole("button", { name: "Pausar" }).click();
    await expect(row.getByRole("button", { name: "Retomar" })).toBeVisible();
    await expect(page.getByTestId("home-activity")).toContainText("pausou Ana");
    await row.getByRole("button", { name: "Retomar" }).click();
    await expect(row.getByRole("button", { name: "Pausar" })).toBeVisible();

    // Sobre em Configurações.
    await page.getByRole("button", { name: "Configurações" }).click();
    await expect(page.getByTestId("about-version")).toContainText("0.1.0");
  });
});
