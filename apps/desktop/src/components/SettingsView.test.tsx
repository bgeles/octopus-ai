import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "../App";
import { createMockTransport } from "../lib/mockTransport";
import { formatBytes } from "./SettingsView";

function setup() {
  const transport = createMockTransport({ tickMs: 5 });
  const user = userEvent.setup();
  render(<App transport={transport} />);
  return { transport, user };
}

describe("Configurações e backup local", () => {
  it("mostra ambiente, preferências e exporta uma cópia manual", async () => {
    const { user, transport } = setup();
    await screen.findByDisplayValue("chat-core");
    await user.click(screen.getByRole("button", { name: "Configurações" }));
    const view = await screen.findByTestId("settings-view");
    await waitFor(() => expect(within(view).getByTestId("check-node")).toHaveAttribute("data-ok", "true"));
    expect(within(view).getByText("Nenhuma cópia ainda", { exact: false })).toBeInTheDocument();

    await user.click(within(view).getByRole("button", { name: "Exportar agora…" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Cópia manual criada");
    const rows = await screen.findAllByTestId("snapshot-row");
    expect(rows[0]).toHaveAttribute("data-reason", "manual");
    expect(rows[0]).toHaveTextContent("exportada");

    // Preferência salva via set_setting e refletida no mock.
    await user.click(within(within(view).getByRole("radiogroup", { name: "Autenticação padrão" })).getByRole("radio", { name: "API key" }));
    await waitFor(async () => expect((await transport.invoke("get_settings", {})).defaultAuthMode).toBe("api_key"));
    // Mudar o tema também persiste em app_setting.
    await user.click(within(within(view).getByRole("radiogroup", { name: "Tema" })).getByRole("radio", { name: "Claro" }));
    await waitFor(async () => expect((await transport.invoke("get_settings", {})).theme).toBe("light"));
  });

  it("restaura uma cópia local com prévia e cria a cópia 'antes de restaurar'", async () => {
    const { user, transport } = setup();
    await screen.findByDisplayValue("chat-core");
    // Cópia manual do estado inicial (1 projeto).
    await transport.invoke("config_export", { destination: null });
    // Projeto novo muda a configuração.
    await transport.invoke("create_project", { input: { name: "extra", path: "/tmp/extra" } });

    await user.click(screen.getByRole("button", { name: "Configurações" }));
    const rows = await screen.findAllByTestId("snapshot-row");
    const manual = rows.find((r) => r.getAttribute("data-reason") === "manual")!;
    await user.click(within(manual).getByRole("button", { name: "Restaurar" }));
    const preview = await screen.findByTestId("import-preview");
    expect(preview).toHaveTextContent("Projetos iguais");
    await user.click(within(preview).getByRole("radio", { name: "Substituir configurações" }));
    expect(preview).toHaveTextContent("Projetos removidos (com histórico)");
    expect(preview).toHaveTextContent("extra");
    await user.click(within(preview).getByRole("button", { name: "Restaurar" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Configurações restauradas");
    const projects = await transport.invoke("list_projects", {});
    expect(projects.map((p) => p.name)).toEqual(["chat-core"]);
    const snapshots = await transport.invoke("config_backups_list", {});
    expect(snapshots.some((s) => s.reason === "pre-restore")).toBe(true);
  });

  it("'Refazer onboarding' volta à tela de boas-vindas", async () => {
    const { user } = setup();
    await screen.findByDisplayValue("chat-core");
    await user.click(screen.getByRole("button", { name: "Configurações" }));
    await user.click(await screen.findByRole("button", { name: "Refazer onboarding" }));
    expect(await screen.findByTestId("onboarding")).toBeInTheDocument();
  });

  it("os limites do board são editados e gravados nas preferências (padrão = null)", async () => {
    const { user, transport } = setup();
    await screen.findByDisplayValue("chat-core");
    await user.click(screen.getByRole("button", { name: "Configurações" }));
    const prefs = await screen.findByTestId("board-prefs");
    const returns = within(prefs).getByLabelText("Devoluções por agentes antes de subir para você") as HTMLInputElement;
    expect(returns.value).toBe("2");
    await user.clear(returns);
    await user.type(returns, "4");
    await user.tab();
    await waitFor(async () => expect((await transport.invoke("get_settings", {}))["board.maxAgentReturns"]).toBe(4));
    await user.clear(returns);
    await user.type(returns, "2");
    await user.tab();
    await waitFor(async () => expect((await transport.invoke("get_settings", {}))["board.maxAgentReturns"]).toBeUndefined());
  });

  it("formata tamanhos", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(18_000)).toBe("18 KB");
    expect(formatBytes(2_500_000)).toBe("2.4 MB");
  });
});
