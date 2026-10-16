import { expect, test } from "@playwright/test";

test.describe("Onboarding (instalação nova, mock)", () => {
  test("conclui os 4 passos e entra no app com o projeto criado", async ({ page }) => {
    await page.goto("/?fresh=1");
    await expect(page.getByTestId("onboarding")).toBeVisible();
    await expect(page.getByTestId("check-node")).toHaveAttribute("data-ok", "true");
    await page.getByRole("button", { name: "Continuar" }).click();
    await page.getByRole("button", { name: "Continuar" }).click();
    await page.getByLabel("Nome").fill("meu-app");
    await page.getByLabel("Pasta").fill("/Users/dev/meu-app");
    await page.getByRole("button", { name: "Continuar" }).click();
    await page.getByRole("radiogroup", { name: "Tema" }).getByRole("radio", { name: "Escuro" }).click();
    await page.getByRole("button", { name: "Concluir e abrir o Octopus" }).click();

    await expect(page.getByTestId("onboarding")).toBeHidden();
    await expect(page.getByLabel("Projeto selecionado")).toHaveValue(/proj_/);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Run ao vivo");
  });

  test("sem login do Claude Code mostra a orientação", async ({ page }) => {
    await page.goto("/?fresh=1&auth=0");
    await expect(page.getByTestId("check-auth")).toHaveAttribute("data-ok", "false");
    await expect(page.getByRole("note")).toContainText("claude");
  });
});
