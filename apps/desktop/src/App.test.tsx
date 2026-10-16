import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "./App";
import { createMockTransport } from "./lib/mockTransport";

function setup() {
  const transport = createMockTransport({ tickMs: 5 });
  const user = userEvent.setup();
  render(<App transport={transport} />);
  return { transport, user };
}

describe("App (fluxo da Fase 0 com transporte de mock)", () => {
  it("carrega o projeto padrão e mostra o estado vazio", async () => {
    setup();
    expect(await screen.findByDisplayValue("chat-core")).toBeInTheDocument();
    expect(screen.getByText(/Nenhum run ainda/)).toBeInTheDocument();
    expect(screen.getByTestId("run-status")).toHaveTextContent("Pronto");
  });

  it("inicia um run, mostra streaming, pede aprovação e conclui após permitir", async () => {
    const { user } = setup();
    await screen.findByDisplayValue("chat-core");

    await user.type(screen.getByLabelText("Instrução para o agente"), "Liste as migrações");
    await user.click(screen.getByRole("button", { name: "Enviar" }));

    // Prompt do usuário entra no transcript e o header reflete o run.
    expect(await screen.findByTestId("transcript-user")).toHaveTextContent("Liste as migrações");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Liste as migrações");

    // Streaming e chamada de ferramenta.
    await waitFor(() => expect(screen.getByText(/Vou localizar as migrações/)).toBeInTheDocument());
    const toolCall = await screen.findByTestId("tool-call");
    expect(within(toolCall).getByText("Glob")).toBeInTheDocument();

    // Pedido de permissão pausa o run.
    const approval = await screen.findByTestId("approval-card");
    expect(within(approval).getByText("Bash")).toBeInTheDocument();
    expect(screen.getByTestId("run-status")).toHaveTextContent("Aguardando aprovação");

    await user.click(within(approval).getByRole("button", { name: "Permitir uma vez" }));

    // Após permitir, o run segue até o resultado.
    await waitFor(() => expect(screen.getByTestId("run-status")).toHaveTextContent("Concluído"), { timeout: 3000 });
    expect(screen.queryByTestId("approval-card")).not.toBeInTheDocument();
    expect(screen.getByText("US$ 0,04")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Uso do contexto" })).toHaveAttribute("aria-valuenow", "9");
  });

  it("negar a permissão registra o erro da ferramenta e o run continua", async () => {
    const { user } = setup();
    await screen.findByDisplayValue("chat-core");
    await user.type(screen.getByLabelText("Instrução para o agente"), "x");
    await user.click(screen.getByRole("button", { name: "Enviar" }));

    const approval = await screen.findByTestId("approval-card");
    await user.type(within(approval).getByLabelText("Motivo da negativa"), "sem rede");
    await user.click(within(approval).getByRole("button", { name: "Negar" }));

    // A ferramenta negada aparece como chamada com falha; expandindo, o motivo está no resultado.
    const failed = await screen.findByLabelText("falhou");
    await user.click(failed.closest("button")!);
    expect(screen.getByText(/Negado: sem rede/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("run-status")).toHaveTextContent("Concluído"), { timeout: 3000 });
  });

  it("interromper encerra o run e o botão some", async () => {
    const { user } = setup();
    await screen.findByDisplayValue("chat-core");
    await user.type(screen.getByLabelText("Instrução para o agente"), "x");
    await user.click(screen.getByRole("button", { name: "Enviar" }));

    const interrupt = await screen.findByRole("button", { name: "Interromper" });
    await user.click(interrupt);

    await waitFor(() => expect(screen.getByTestId("run-status")).toHaveTextContent("Interrompido"));
    expect(screen.queryByRole("button", { name: "Interromper" })).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/interrompido/i);
  });

  it("alterna o tema pelo seletor da sidebar e persiste a escolha", async () => {
    window.localStorage.clear();
    delete document.documentElement.dataset.theme;
    const { user } = setup();
    await screen.findByDisplayValue("chat-core");

    const group = screen.getByRole("radiogroup", { name: "Tema" });
    expect(within(group).getByRole("radio", { name: "Sistema" })).toHaveAttribute("aria-checked", "true");
    expect(document.documentElement.dataset.theme).toBeUndefined();

    await user.click(within(group).getByRole("radio", { name: "Escuro" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(window.localStorage.getItem("octopus.theme")).toBe("dark");

    await user.click(within(group).getByRole("radio", { name: "Sistema" }));
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it("lista runs e sessões na visão Sessões e reabre um run com seu histórico", async () => {
    const { user } = setup();
    await screen.findByDisplayValue("chat-core");
    await user.type(screen.getByLabelText("Instrução para o agente"), "Primeiro run");
    await user.click(screen.getByRole("button", { name: "Enviar" }));
    await screen.findByTestId("approval-card");

    await user.click(screen.getByRole("button", { name: /Sessões/ }));
    expect(await screen.findByText("Criar migração Flyway V12 para tabela leads")).toBeInTheDocument();
    const runButton = screen.getByRole("button", { name: /Primeiro run/ });
    await user.click(runButton);

    expect(await screen.findByTestId("transcript-user")).toHaveTextContent("Primeiro run");
    expect(screen.getByTestId("tool-call")).toBeInTheDocument();
  });
});
