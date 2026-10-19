import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "../App";
import { createMockTransport } from "../lib/mockTransport";

function setup() {
  const transport = createMockTransport({ tickMs: 5 });
  const user = userEvent.setup();
  render(<App transport={transport} />);
  return { transport, user };
}

describe("Segurança · sandbox e orçamentos", () => {
  it("troca o perfil de sandbox do projeto e o header reflete", async () => {
    const { user, transport } = setup();
    await screen.findByDisplayValue("chat-core");
    expect(screen.getByTestId("sandbox-chip")).toHaveTextContent("Sandbox Dev padrão");
    await user.click(screen.getByRole("button", { name: "Segurança" }));
    const section = await screen.findByTestId("sandbox-section");
    expect(section).toHaveAttribute("data-profile", "sandbox_dev");
    await user.click(within(section).getByRole("radio", { name: "Estrito" }));
    await waitFor(() => expect(screen.getByTestId("sandbox-section")).toHaveAttribute("data-profile", "sandbox_strict"));
    expect(screen.getByTestId("sandbox-section")).toHaveTextContent("allowlist estrita · nenhum host liberado");
    const projects = await transport.invoke("list_projects", {});
    expect(projects[0]?.sandboxProfileId).toBe("sandbox_strict");

    // O run leva o sandbox do perfil e os hooks de política.
    await user.click(screen.getByRole("button", { name: "Run ao vivo" }));
    expect(screen.getByTestId("sandbox-chip")).toHaveTextContent("Sandbox Estrito");
    await user.type(screen.getByLabelText("Instrução para o agente"), "x");
    await user.click(screen.getByRole("button", { name: "Enviar" }));
    await screen.findByTestId("approval-card");
    const runs = await transport.invoke("list_runs", { projectId: "proj_demo" });
    expect(runs[0]?.options.sandbox?.failIfUnavailable).toBe(true);
    expect(runs[0]?.options.policyHooks).toBe(true);
  });

  it("define orçamento, mostra o aviso ao passar do soft e bloqueia novos runs no hard", async () => {
    const { user, transport } = setup();
    await screen.findByDisplayValue("chat-core");
    await user.click(screen.getByRole("button", { name: "Segurança" }));
    await user.click(await screen.findByRole("tab", { name: "Orçamentos" }));
    const tab = await screen.findByTestId("budget-tab");
    const card = await within(tab).findByTestId("budget-card");
    expect(card).toHaveTextContent("sem limite");
    await user.click(within(card).getByRole("button", { name: "Definir limite" }));
    await user.type(within(card).getByLabelText("Aviso de chat-core"), "0.03");
    await user.type(within(card).getByLabelText("Limite de chat-core"), "0.05");
    await user.type(within(card).getByLabelText("Turnos de chat-core"), "12");
    await user.click(within(card).getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(within(tab).getByTestId("budget-card")).toHaveTextContent("soft 0.03 · hard 0.05"));
    expect(within(tab).getByTestId("budget-card")).toHaveTextContent("máx. 12 turnos por run");

    // Um run de US$ 0,04 passa do aviso.
    await user.click(screen.getByRole("button", { name: "Run ao vivo" }));
    await user.type(screen.getByLabelText("Instrução para o agente"), "primeiro");
    await user.click(screen.getByRole("button", { name: "Enviar" }));
    const approval = await screen.findByTestId("approval-card");
    await user.click(within(approval).getByRole("button", { name: "Permitir uma vez" }));
    await waitFor(() => expect(screen.getByTestId("run-status")).toHaveTextContent("Concluído"), { timeout: 3000 });
    await waitFor(() => expect(screen.getByTestId("budget-chip")).toHaveAttribute("data-level", "soft"));

    // O segundo run estoura o hard no meio (0,04 fechado + ≈0,03 estimado ≥ 0,05): o Octopus o interrompe.
    await user.type(screen.getByLabelText("Instrução para o agente"), "segundo");
    await user.click(screen.getByRole("button", { name: "Enviar" }));
    await user.click(within(await screen.findByTestId("approval-card")).getByRole("button", { name: "Permitir uma vez" }));
    await waitFor(() => expect(screen.getByTestId("run-status")).toHaveTextContent("Interrompido · orçamento"), { timeout: 3000 });
    expect(await screen.findByTestId("budget-stop-banner")).toHaveTextContent("Orçamento mensal esgotado para chat-core durante o run");
    await waitFor(() => expect(screen.getByTestId("budget-chip")).toHaveAttribute("data-level", "hard"));
    const stopped = (await transport.invoke("list_runs", { projectId: "proj_demo" }))[0]!;
    expect(stopped).toMatchObject({ status: "interrupted", stopCause: "budget", costUsd: null });
    expect(stopped.estCostUsd).toBeCloseTo(0.0292, 4);
    // O terceiro é recusado na largada.
    await user.type(screen.getByLabelText("Instrução para o agente"), "terceiro");
    await user.click(screen.getByRole("button", { name: "Enviar" }));
    expect(await screen.findByRole("status")).toHaveTextContent(/Orçamento mensal esgotado para chat-core/);
    expect((await transport.invoke("list_runs", { projectId: "proj_demo" })).length).toBe(2);

    // Aviso maior que limite é recusado.
    await user.click(screen.getByRole("button", { name: "Segurança" }));
    await user.click(await screen.findByRole("tab", { name: "Orçamentos" }));
    const card2 = await screen.findByTestId("budget-card");
    expect(card2).toHaveAttribute("data-level", "hard");
    await user.click(within(card2).getByRole("button", { name: "Editar limites" }));
    await user.clear(within(card2).getByLabelText("Aviso de chat-core"));
    await user.type(within(card2).getByLabelText("Aviso de chat-core"), "9");
    await user.click(within(card2).getByRole("button", { name: "Salvar" }));
    expect(await within(card2).findByRole("alert")).toHaveTextContent("O aviso (soft) não pode ser maior que o limite (hard)");
  }, 20_000);
});
