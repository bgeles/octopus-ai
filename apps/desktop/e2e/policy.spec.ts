import { expect, test } from "@playwright/test";

test.describe("Segurança · Política (mock)", () => {
  test("lista as regras do catálogo e simula um comando destrutivo", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Segurança" }).click();
    await expect(page.getByTestId("policy-rule")).toHaveCount(7);
    await page.getByRole("button", { name: "Simular" }).click();
    await expect(page.getByTestId("policy-sim-result")).toHaveAttribute("data-behavior", "deny");
    await expect(page.getByTestId("policy-sim-result")).toContainText("Comando destrutivo fora da pasta do projeto");
    await page.getByRole("tab", { name: /Auditoria/ }).click();
    await expect(page.getByTestId("audit-row").first()).toHaveAttribute("data-kind", "policy.deny");
  });
});
