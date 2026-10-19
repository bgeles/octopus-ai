import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "../App";
import { createMockTransport } from "../lib/mockTransport";

describe("Harness · hooks livres", () => {
  it("cria, testa e salva um hook; ele roda no run e o bloqueio vai para a auditoria", async () => {
    const transport = createMockTransport({ tickMs: 5 });
    const user = userEvent.setup();
    render(<App transport={transport} />);
    await screen.findByDisplayValue("chat-core");

    await user.click(screen.getByRole("button", { name: "Harness" }));
    await user.click(await screen.findByRole("tab", { name: /Hooks/ }));
    await user.click(screen.getByRole("button", { name: "Novo hook" }));
    const form = screen.getByRole("form", { name: "Novo hook" });
    await user.type(within(form).getByLabelText("Nome"), "Exigir testes");
    await user.selectOptions(within(form).getByLabelText("Evento"), "PostToolUse");
    await user.type(within(form).getByLabelText("Ferramentas (regex)"), "Bash(");
    await user.type(within(form).getByLabelText(/Comando/), 'echo "faltou teste" >&2; exit 2');

    // Regex inválida é recusada com a mensagem do core.
    await user.click(within(form).getByRole("button", { name: "Salvar" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Regex inválida no filtro: Bash(");
    await user.clear(within(form).getByLabelText("Ferramentas (regex)"));
    await user.type(within(form).getByLabelText("Ferramentas (regex)"), "Bash");

    await user.click(within(form).getByRole("button", { name: "Testar com exemplo" }));
    const test = await screen.findByTestId("hook-test");
    expect(test).toHaveAttribute("data-outcome", "blocked");
    expect(test).toHaveTextContent("saída 2 em 41 ms → bloqueia: faltou teste");

    await user.click(within(form).getByRole("button", { name: "Salvar" }));
    const row = await screen.findByTestId("hook-row");
    expect(row).toHaveAttribute("data-hook", "Exigir testes");
    expect(row).toHaveTextContent("PostToolUse");
    expect(screen.getByRole("tab", { name: "Hooks · 1" })).toBeInTheDocument();

    // O preview do perfil de execução mostra o hook.
    const preview = await transport.invoke("preview_run_options", { input: { projectId: "proj_demo" } });
    expect(preview.hooks.some((h) => h.origin === "Harness · Hooks" && h.event === "PostToolUse · Bash")).toBe(true);

    // No run: depois do Bash aprovado, o hook roda e bloqueia.
    await user.click(screen.getByRole("button", { name: "Run ao vivo" }));
    await user.type(screen.getByLabelText("Instrução para o agente"), "rode os testes");
    await user.click(screen.getByRole("button", { name: "Enviar" }));
    await user.click(within(await screen.findByTestId("approval-card")).getByRole("button", { name: "Permitir uma vez" }));
    const ran = await screen.findByTestId("hook-run");
    expect(ran).toHaveAttribute("data-outcome", "blocked");
    expect(ran).toHaveTextContent("hook · Exigir testes · PostToolUse (Bash) · 2 · bloqueou");
    const [run] = await transport.invoke("list_runs", { projectId: "proj_demo" });
    expect(run?.options.customHooks?.[0]).toMatchObject({ name: "Exigir testes", matcher: "Bash" });
    await waitFor(async () => {
      const audit = await transport.invoke("list_audit_events", { projectId: "proj_demo", kindPrefix: "hook.", limit: 10 });
      expect(audit.map((e) => e.kind)).toContain("hook.blocked");
    });

    // Desligar tira o hook dos próximos runs.
    await user.click(screen.getByRole("button", { name: "Harness" }));
    await user.click(await screen.findByRole("tab", { name: /Hooks/ }));
    await user.click(await screen.findByLabelText("Ativar Exigir testes"));
    await waitFor(async () => expect((await transport.invoke("list_custom_hooks", { projectId: "proj_demo" }))[0]?.enabled).toBe(false));
  }, 20_000);
});
