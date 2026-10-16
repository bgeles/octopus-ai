import { expect, test } from "@playwright/test";

test.describe("Segurança · Auditoria (mock)", () => {
  test("após um run aprovado, a auditoria lista os eventos e a cadeia está íntegra", async ({ page }) => {
    await page.goto("/");
    await page.getByLabel("Instrução para o agente").fill("rodar testes");
    await page.getByRole("button", { name: "Enviar" }).click();
    await page.getByTestId("approval-card").getByRole("button", { name: "Permitir uma vez" }).click();
    await expect(page.getByTestId("run-status")).toHaveText("Concluído");

    await page.getByRole("button", { name: "Segurança" }).click();
    await page.getByRole("tab", { name: /Auditoria/ }).click();
    await expect(page.getByTestId("audit-integrity")).toHaveAttribute("data-ok", "true");
    await expect(page.getByTestId("audit-row").first()).toHaveAttribute("data-kind", "run.finished");
    await expect(page.getByTestId("audit-row").filter({ hasText: "permitiu Bash" })).toHaveCount(1);
  });
});
