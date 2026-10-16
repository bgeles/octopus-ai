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

describe("Segurança · autenticação do projeto", () => {
  it("em modo API key sem chave o run é recusado; guardar a chave libera e a auditoria não registra o valor", async () => {
    const { user, transport } = setup();
    await screen.findByDisplayValue("chat-core");
    await user.click(screen.getByRole("button", { name: "Segurança" }));
    const section = await screen.findByTestId("auth-section");
    expect(section).toHaveAttribute("data-mode", "subscription");
    await user.click(within(section).getByRole("radio", { name: "API key" }));
    await waitFor(() => expect(screen.getByTestId("auth-section")).toHaveAttribute("data-mode", "api_key"));
    await waitFor(() => expect(screen.getByTestId("auth-key-status")).toHaveTextContent("Nenhuma chave no Keychain"));

    // Sem chave: o run nem começa.
    await user.click(screen.getByRole("button", { name: "Run ao vivo" }));
    await user.type(screen.getByLabelText("Instrução para o agente"), "oi");
    await user.click(screen.getByRole("button", { name: "Enviar" }));
    expect(await screen.findByRole("status")).toHaveTextContent(/usa API key, mas nenhuma chave está no Keychain/);
    expect((await transport.invoke("list_runs", { projectId: "proj_demo" })).length).toBe(0);

    // Guarda a chave (valor de teste do mock).
    await user.click(screen.getByRole("button", { name: "Segurança" }));
    await user.type(await screen.findByLabelText(/^API key \(vai para o Keychain/), "sk-ant-teste-123");
    await user.click(screen.getByRole("button", { name: "Guardar no Keychain" }));
    await waitFor(() => expect(screen.getByTestId("auth-key-status")).toHaveTextContent("Chave guardada no Keychain · conta octopus/proj_demo"));
    expect(screen.getByRole("button", { name: "Trocar chave" })).toBeInTheDocument();

    // A auditoria registra a troca, nunca o valor.
    const events = await transport.invoke("list_audit_events", { projectId: "proj_demo", limit: 50 });
    const secretEvent = events.find((e) => e.kind === "secret.set");
    expect(secretEvent).toBeDefined();
    expect(JSON.stringify(secretEvent)).not.toContain("sk-ant-teste-123");
    expect(JSON.stringify(secretEvent)).toContain("valor não registrado");

    // Com a chave, o run começa; o run gravado não leva env.
    await user.click(screen.getByRole("button", { name: "Run ao vivo" }));
    await user.type(screen.getByLabelText("Instrução para o agente"), "agora sim");
    await user.click(screen.getByRole("button", { name: "Enviar" }));
    await screen.findByTestId("approval-card");
    const runs = await transport.invoke("list_runs", { projectId: "proj_demo" });
    expect(runs.length).toBe(1);
    expect(JSON.stringify(runs[0])).not.toContain("sk-ant-teste-123");

    // Remover volta ao aviso.
    await user.click(screen.getByRole("button", { name: "Segurança" }));
    await user.click(await screen.findByRole("button", { name: "Remover do Keychain" }));
    await waitFor(() => expect(screen.getByTestId("auth-key-status")).toHaveTextContent("Nenhuma chave no Keychain"));

    // Voltar ao login do Claude Code esconde o campo.
    await user.click(within(screen.getByTestId("auth-section")).getByRole("radio", { name: "Login do Claude Code" }));
    await waitFor(() => expect(screen.getByTestId("auth-section")).toHaveAttribute("data-mode", "subscription"));
    expect(screen.queryByTestId("auth-key-status")).toBeNull();
  });
});
