import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "../App";
import { createMockTransport } from "../lib/mockTransport";

function setup(options: Parameters<typeof createMockTransport>[0] = {}) {
  const transport = createMockTransport({ tickMs: 5, freshInstall: true, ...options });
  const user = userEvent.setup();
  render(<App transport={transport} />);
  return { transport, user };
}

describe("Onboarding (instalação nova)", () => {
  it("guia pelos 4 passos, cria o projeto e grava as preferências", async () => {
    const { user, transport } = setup();
    const onboarding = await screen.findByTestId("onboarding");
    expect(within(onboarding).getByRole("heading", { level: 1 })).toHaveTextContent("O que o Octopus precisa nesta máquina");
    await waitFor(() => expect(screen.getByTestId("check-node")).toHaveAttribute("data-ok", "true"));
    expect(screen.getByTestId("check-auth")).toHaveAttribute("data-ok", "true");

    await user.click(screen.getByRole("button", { name: "Continuar" }));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Como o agente vai se autenticar");
    await user.click(screen.getByLabelText(/API key/));
    await user.click(screen.getByRole("button", { name: "Continuar" }));

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Seu primeiro projeto");
    await user.type(screen.getByLabelText("Nome"), "meu-app");
    await user.type(screen.getByLabelText("Pasta"), "/Users/dev/meu-app");
    await user.click(screen.getByRole("button", { name: "Continuar" }));

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Escolha o tema");
    await user.click(within(screen.getByRole("radiogroup", { name: "Tema" })).getByRole("radio", { name: "Escuro" }));
    await user.click(screen.getByRole("button", { name: "Concluir e abrir o Octopus" }));

    // Entra no app com o projeto criado e o tema aplicado.
    expect(await screen.findByDisplayValue("meu-app")).toBeInTheDocument();
    expect(screen.queryByTestId("onboarding")).not.toBeInTheDocument();
    expect(document.documentElement.dataset.theme).toBe("dark");
    const settings = await transport.invoke("get_settings", {});
    expect(settings.defaultAuthMode).toBe("api_key");
    expect(settings.theme).toBe("dark");
    expect(typeof settings["onboarding.completedAt"]).toBe("string");
  });

  it("sem login do Claude Code mostra a orientação, mas deixa continuar", async () => {
    setup({ environment: { claudeAuth: false } });
    await screen.findByTestId("onboarding");
    await waitFor(() => expect(screen.getByTestId("check-auth")).toHaveAttribute("data-ok", "false"));
    expect(screen.getByRole("note")).toHaveTextContent(/rode claude no Terminal/i);
    expect(screen.getByRole("button", { name: "Continuar" })).toBeEnabled();
  });

  it("sem Node não deixa continuar", async () => {
    setup({ environment: { node: false } });
    await screen.findByTestId("onboarding");
    await waitFor(() => expect(screen.getByTestId("check-node")).toHaveAttribute("data-ok", "false"));
    expect(screen.getByRole("button", { name: "Continuar" })).toBeDisabled();
    expect(screen.getByText(/Node e runtime são obrigatórios/)).toBeInTheDocument();
  });

  it("importar um backup no passo 3 traz projetos e preferências e conclui o onboarding", async () => {
    const { user } = setup();
    await screen.findByTestId("onboarding");
    await waitFor(() => expect(screen.getByTestId("check-node")).toHaveAttribute("data-ok", "true"));
    await user.click(screen.getByRole("button", { name: "Continuar" }));
    await user.click(screen.getByRole("button", { name: "Continuar" }));

    await user.type(screen.getByLabelText("Arquivo de configurações"), "/tmp/octopus-config.json");
    await user.click(screen.getByRole("button", { name: "Ver prévia" }));
    const preview = await screen.findByTestId("import-preview");
    expect(preview).toHaveTextContent("chat-core, frontend-chat");
    await user.click(within(preview).getByRole("button", { name: "Restaurar" }));

    // O backup traz onboarding.completedAt: o app abre direto, com os dois projetos.
    expect(await screen.findByDisplayValue("chat-core")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "frontend-chat" })).toBeInTheDocument();
    expect(screen.queryByTestId("onboarding")).not.toBeInTheDocument();
  });
});
