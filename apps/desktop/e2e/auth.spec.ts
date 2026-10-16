import { expect, test } from "@playwright/test";

test.describe("Segurança · Autenticação do projeto (mock)", () => {
  test("API key sem chave recusa o run; guardar a chave no Keychain libera", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Segurança" }).click();
    await page.getByRole("radio", { name: "API key" }).click();
    await expect(page.getByTestId("auth-section")).toHaveAttribute("data-mode", "api_key");
    await expect(page.getByTestId("auth-key-status")).toContainText("Nenhuma chave no Keychain");

    await page.getByRole("button", { name: "Run ao vivo" }).click();
    await page.getByLabel("Instrução para o agente").fill("oi");
    await page.getByRole("button", { name: "Enviar" }).click();
    await expect(page.getByRole("status")).toContainText("nenhuma chave está no Keychain");

    await page.getByRole("button", { name: "Segurança" }).click();
    await page.getByLabel(/^API key \(vai para o Keychain/).fill("sk-ant-teste-e2e");
    await page.getByRole("button", { name: "Guardar no Keychain" }).click();
    await expect(page.getByTestId("auth-key-status")).toContainText("Chave guardada no Keychain");

    await page.getByRole("button", { name: "Run ao vivo" }).click();
    await page.getByLabel("Instrução para o agente").fill("agora sim");
    await page.getByRole("button", { name: "Enviar" }).click();
    await expect(page.getByTestId("approval-card")).toBeVisible();
  });
});
