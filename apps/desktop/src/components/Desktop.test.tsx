import { act, render, screen, waitFor, within } from "@testing-library/react";
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

describe("Menu bar e notificações", () => {
  it("o menu bar navega para Aprovações e abre um run ativo", async () => {
    const { transport, user } = setup();
    await screen.findByDisplayValue("chat-core");
    act(() => transport.emit("app:navigate", "approvals"));
    expect(await screen.findByRole("heading", { name: "Aprovações" })).toBeInTheDocument();
    act(() => transport.emit("app:navigate", "nada"));
    expect(screen.getByRole("heading", { name: "Aprovações" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Run ao vivo" }));
    await user.type(screen.getByLabelText("Instrução para o agente"), "rodar testes");
    await user.click(screen.getByRole("button", { name: "Enviar" }));
    await screen.findByTestId("approval-card");
    const [run] = await transport.invoke("list_runs", { projectId: "proj_demo" });
    await user.click(screen.getByRole("button", { name: "Sessões" }));
    act(() => transport.emit("app:open-run", run!.id));
    await waitFor(() => expect(screen.getByTestId("approval-card")).toBeInTheDocument());
  });

  it("preferências de notificação ficam salvas", async () => {
    const { transport, user } = setup();
    await screen.findByDisplayValue("chat-core");
    await user.click(screen.getByRole("button", { name: "Configurações" }));
    const box = await screen.findByTestId("notification-prefs");
    const runs = within(box).getByRole("switch", { name: "Run concluído ou falhou" });
    expect(runs).toHaveAttribute("aria-checked", "false");
    expect(within(box).getByRole("switch", { name: "Aprovação pendente" })).toHaveAttribute("aria-checked", "true");
    await user.click(runs);
    await waitFor(() => expect(within(screen.getByTestId("notification-prefs")).getByRole("switch", { name: "Run concluído ou falhou" })).toHaveAttribute("aria-checked", "true"));
    expect((await transport.invoke("get_settings", {}))["notifications.runs"]).toBe(true);
  });

  it("atualizações: sem endereço não procura; com manifesto mostra a versão nova e instala", async () => {
    const { transport, user } = setup();
    await screen.findByDisplayValue("chat-core");
    await user.click(screen.getByRole("button", { name: "Configurações" }));
    const box = await screen.findByTestId("updates");
    await user.click(within(box).getByRole("button", { name: "Verificar agora" }));
    await waitFor(() => expect(within(box).getByTestId("update-status")).toHaveTextContent("Versão 0.1.0 · atualizações não configuradas"));

    await user.type(within(box).getByLabelText("Endereço do manifesto de atualização"), "http://releases.empresa.com/latest.json");
    await user.click(within(box).getByRole("button", { name: "Verificar agora" }));
    expect(await within(box).findByRole("alert")).toHaveTextContent("Use https://");

    await user.clear(within(box).getByLabelText("Endereço do manifesto de atualização"));
    await user.type(within(box).getByLabelText("Endereço do manifesto de atualização"), "https://releases.empresa.com/nova/latest.json");
    await user.click(within(box).getByRole("button", { name: "Verificar agora" }));
    await waitFor(() => expect(within(box).getByTestId("update-status")).toHaveTextContent("Versão 0.2.0 disponível (instalada: 0.1.0)"));
    expect((await transport.invoke("get_settings", {}))["updates.endpoint"]).toBe("https://releases.empresa.com/nova/latest.json");
    await user.click(within(box).getByRole("button", { name: "Instalar e reiniciar" }));
    await waitFor(async () => expect((await transport.invoke("list_audit_events", { limit: 10 })).some((e) => e.kind === "app.updated")).toBe(true));
  });

  it("atalhos: ⌘3 abre Aprovações, ⌘N foca o composer e ⌘. interrompe o run", async () => {
    const { user, transport } = setup();
    await screen.findByDisplayValue("chat-core");
    await user.keyboard("{Meta>}3{/Meta}");
    expect(await screen.findByRole("heading", { name: "Aprovações" })).toBeInTheDocument();
    await user.keyboard("{Meta>}9{/Meta}");
    expect(await screen.findByTestId("shortcuts")).toHaveTextContent("⌘1 … ⌘9");
    await user.keyboard("{Meta>}n{/Meta}");
    await waitFor(() => expect(screen.getByLabelText("Instrução para o agente")).toHaveFocus());
    await user.type(screen.getByLabelText("Instrução para o agente"), "rodar testes");
    await user.keyboard("{Meta>}{Enter}{/Meta}");
    await screen.findByTestId("approval-card");
    await user.keyboard("{Meta>}.{/Meta}");
    await waitFor(async () => expect((await transport.invoke("list_runs", { projectId: "proj_demo" }))[0]?.status).toBe("interrupted"));
  });
});

