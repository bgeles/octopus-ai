import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "../App";
import { createMockTransport, fixtureRunEvents } from "../lib/mockTransport";
import { describePattern } from "./PolicyTab";

function withCommand(command: string) {
  return fixtureRunEvents().map((n) => (n.event.type === "permission_request" ? { ...n, event: { ...n.event, input: { command }, reason: null } } : n));
}

function setup(options: Parameters<typeof createMockTransport>[0] = {}) {
  const transport = createMockTransport({ tickMs: 5, ...options });
  const user = userEvent.setup();
  render(<App transport={transport} />);
  return { transport, user };
}

describe("Segurança · Política", () => {
  it("lista as regras do catálogo, simula um comando e alterna uma regra", async () => {
    const { user } = setup();
    await screen.findByDisplayValue("chat-core");
    await user.click(screen.getByRole("button", { name: "Segurança" }));
    const tab = await screen.findByTestId("policy-tab");
    const rules = await within(tab).findAllByTestId("policy-rule");
    expect(rules).toHaveLength(7);
    expect(rules[0]).toHaveTextContent("Comando destrutivo fora da pasta do projeto");
    expect(rules[0]).toHaveTextContent("nega");
    expect(rules[0]).toHaveTextContent("global");

    await user.click(within(tab).getByRole("button", { name: "Simular" }));
    const result = await within(tab).findByTestId("policy-sim-result");
    expect(result).toHaveAttribute("data-behavior", "deny");
    expect(result).toHaveTextContent("Comando destrutivo fora da pasta do projeto");
    expect(within(tab).getAllByTestId("policy-event")[0]).toHaveTextContent("negou");

    await user.clear(within(tab).getByLabelText("Comando para simular"));
    await user.type(within(tab).getByLabelText("Comando para simular"), "curl https://example.com");
    await user.click(within(tab).getByRole("button", { name: "Simular" }));
    await waitFor(() => expect(within(tab).getByTestId("policy-sim-result")).toHaveAttribute("data-behavior", "ask"));

    // Desativar a regra de rede: curl passa a passar.
    const network = rules.find((r) => r.getAttribute("data-rule-id") === "rule_network_ask")!;
    await user.click(within(network).getByRole("switch"));
    await waitFor(() => expect(screen.getByTestId("policy-tab").querySelector('[data-rule-id="rule_network_ask"]')).toHaveAttribute("data-enabled", "false"));
    await user.click(within(screen.getByTestId("policy-tab")).getByRole("button", { name: "Simular" }));
    await waitFor(() => expect(within(screen.getByTestId("policy-tab")).getByTestId("policy-sim-result")).toHaveAttribute("data-behavior", "pass"));
  });

  it("regra do projeto só aperta: permitir é recusado, perguntar é aceito", async () => {
    const { user } = setup();
    await screen.findByDisplayValue("chat-core");
    await user.click(screen.getByRole("button", { name: "Segurança" }));
    await screen.findByTestId("policy-tab");
    await user.click(screen.getByRole("button", { name: "Nova regra" }));
    const dialog = await screen.findByRole("dialog");
    await user.selectOptions(within(dialog).getByLabelText("Tipo"), "tool");
    await user.type(within(dialog).getByLabelText("Padrão"), "WebFetch");
    expect(within(dialog).getByRole("option", { name: "permite (só global)" })).toBeDisabled();
    await user.selectOptions(within(dialog).getByLabelText("Ação"), "ask");
    await user.type(within(dialog).getByLabelText("Motivo (o agente recebe este texto)"), "Web só com você olhando");
    await user.click(within(dialog).getByRole("button", { name: "Criar regra" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const rows = screen.getAllByTestId("policy-rule");
    expect(rows).toHaveLength(8);
    const created = rows.find((r) => r.textContent?.includes("Web só com você olhando"))!;
    expect(created).toHaveTextContent("chat-core");
    expect(created).toHaveTextContent("pergunta");
    await user.click(within(created).getByRole("button", { name: "Remover" }));
    await waitFor(() => expect(screen.getAllByTestId("policy-rule")).toHaveLength(7));
  });

  it("no run, a política nega o comando com o motivo visível e pergunta com o motivo da regra", async () => {
    const { user } = setup({ events: withCommand("rm -rf /tmp/x") });
    await screen.findByDisplayValue("chat-core");
    await user.type(screen.getByLabelText("Instrução para o agente"), "limpe o tmp");
    await user.click(screen.getByRole("button", { name: "Enviar" }));
    // Nada de aprovação: o motor negou antes, e o agente vê o motivo como erro da ferramenta.
    const failed = await screen.findByLabelText("falhou");
    await user.click(failed.closest("button")!);
    expect(screen.getByText(/Bloqueado pela política: Comando destrutivo fora da pasta do projeto/)).toBeInTheDocument();
    expect(screen.queryByTestId("approval-card")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("run-status")).toHaveTextContent("Concluído"), { timeout: 3000 });
  });

  it("comando de rede vira aprovação com o motivo da regra", async () => {
    const { user } = setup({ events: withCommand("curl https://registry-1.docker.io/v2/") });
    await screen.findByDisplayValue("chat-core");
    await user.type(screen.getByLabelText("Instrução para o agente"), "baixe a imagem");
    await user.click(screen.getByRole("button", { name: "Enviar" }));
    const approval = await screen.findByTestId("approval-card");
    expect(approval).toHaveTextContent("Saída de rede exige aprovação");
    expect(within(approval).getByTestId("preview-command")).toHaveTextContent("curl https://registry-1.docker.io/v2/");
  });

  it("descreve as sentinelas", () => {
    expect(describePattern("@outside-project")).toMatch(/fora da pasta do projeto/);
    expect(describePattern("x")).toBe("x");
  });
});
