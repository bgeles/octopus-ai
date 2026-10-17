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
});
