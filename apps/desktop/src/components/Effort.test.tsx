import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "../App";
import { createMockTransport } from "../lib/mockTransport";

describe("Esforço por run", () => {
  it("o composer mostra o padrão do projeto e manda o nível escolhido só para aquele run", async () => {
    const transport = createMockTransport({ tickMs: 5 });
    await transport.invoke("set_setting", { key: "project.proj_demo.defaults", value: { effort: "medium" } });
    const user = userEvent.setup();
    render(<App transport={transport} />);
    await screen.findByDisplayValue("chat-core");

    const select = await screen.findByTestId("effort-select");
    await waitFor(() => expect(within(select).getAllByRole("option")[0]).toHaveTextContent("Padrão (médio, do projeto)"));
    await user.selectOptions(select, "max");
    await user.type(screen.getByLabelText("Instrução para o agente"), "pense fundo");
    await user.click(screen.getByRole("button", { name: "Enviar" }));
    expect(await screen.findByTestId("run-effort")).toHaveTextContent("esforço máximo");
    const [run] = await transport.invoke("list_runs", { projectId: "proj_demo" });
    expect(run?.options.effort).toBe("max");
    // A escolha vale só para aquele run: o seletor volta ao padrão.
    expect(screen.getByTestId("effort-select")).toHaveValue("");
  });

  it("rodando como membro, vale o esforço da ficha quando o composer fica no padrão", async () => {
    const transport = createMockTransport({ tickMs: 5 });
    await transport.invoke("add_team_member", { projectId: "proj_demo", input: { name: "Lia", roleId: "role_implementador", effort: "low" } });
    const user = userEvent.setup();
    render(<App transport={transport} />);
    await screen.findByDisplayValue("chat-core");

    const runAs = await screen.findByTestId("run-as-select");
    const lia = within(runAs).getByRole("option", { name: /Lia/ }) as HTMLOptionElement;
    await user.selectOptions(runAs, lia.value);
    await waitFor(() => expect(within(screen.getByTestId("effort-select")).getAllByRole("option")[0]).toHaveTextContent("Padrão (baixo, de Lia)"));
    await user.type(screen.getByLabelText("Instrução para Lia"), "tarefa simples");
    await user.click(screen.getByRole("button", { name: "Enviar" }));
    expect(await screen.findByTestId("run-effort")).toHaveTextContent("esforço baixo");
    const [run] = await transport.invoke("list_runs", { projectId: "proj_demo" });
    expect(run?.options.effort).toBe("low");
  });
});
