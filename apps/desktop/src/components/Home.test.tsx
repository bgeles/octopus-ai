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

describe("Início", () => {
  it("abre em Início com cards zerados, chamadas para montar o time e a versão no rodapé", async () => {
    setup();
    await screen.findByDisplayValue("chat-core");
    const home = screen.getByTestId("home-view");
    expect(within(home).getByTestId("card-active")).toHaveTextContent("0");
    expect(within(home).getByTestId("card-waiting")).toHaveTextContent("0 aprovações de ferramenta · 0 tasks em gate");
    expect(within(home).getByTestId("card-spend")).toHaveTextContent("sem limite definido");
    expect(within(home).getByTestId("home-team")).toHaveTextContent("Ainda não há membros");
    expect(within(home).getByRole("button", { name: "Adicionar membro" })).toBeInTheDocument();
    await within(home).findByText(/Nada aconteceu ainda/);
    expect(screen.getByTestId("app-version")).toHaveTextContent("Octopus AI 0.1.0");
    expect(screen.getByRole("button", { name: "Início" })).toHaveAttribute("aria-current", "page");
  });

  it("mostra o time atuando, a atividade ao vivo e as entregas; as linhas abrem a task e o run", async () => {
    const { user, transport } = setup();
    await screen.findByDisplayValue("chat-core");
    const rui = await transport.invoke("add_team_member", { projectId: "proj_demo", input: { name: "Rui", roleId: "role_revisor", autonomy: "managed", canApprove: true } });
    const ana = await transport.invoke("add_team_member", { projectId: "proj_demo", input: { name: "Ana", roleId: "role_pesquisador", reportsToAgentId: rui.profile.id, autonomy: "managed" } });
    await transport.invoke("set_setting", { key: "scheduler.paused", value: true });
    const wf = await transport.invoke("create_workflow_from_template", { input: { projectId: "proj_demo", templateId: "research-synthesis" } });
    await transport.invoke("create_task", { projectId: "proj_demo", workflowId: wf.id, input: { title: "Mapear integrações", assignedAgentId: ana.profile.id } });
    await transport.invoke("set_setting", { key: "scheduler.paused", value: null });
    await user.click(screen.getByRole("button", { name: "Atualizar" }));
    const home = screen.getByTestId("home-view");
    await waitFor(() => expect(within(home).getAllByTestId("home-member")).toHaveLength(2));
    await act(async () => {
      await transport.invoke("scheduler_tick", {});
    });

    // Ana em run: card e painel do time acompanham sem clique (board:changed).
    await waitFor(() => expect(within(home).getByTestId("card-active")).toHaveTextContent("1"));
    const anaRow = within(home).getAllByTestId("home-member").find((r) => r.textContent?.includes("Ana"))!;
    expect(anaRow).toHaveAttribute("data-status", "active");
    expect(anaRow).toHaveTextContent("Mapear integrações");

    // A cadeia termina sozinha: Rui revisa e aprova duas vezes; a task vira entrega.
    await waitFor(() => expect(within(home).getByTestId("card-deliveries")).toHaveTextContent("1"), { timeout: 8000 });
    const feed = within(home).getByTestId("home-activity");
    const texts = within(feed).getAllByTestId("activity-row").map((r) => r.textContent ?? "");
    expect(texts.some((t) => t.includes("agente Rui") && t.includes("aprovou"))).toBe(true);
    expect(texts.some((t) => t.includes("Ana") && t.includes("iniciou run"))).toBe(true);
    expect(within(home).getByTestId("home-deliveries")).toHaveTextContent("Mapear integrações");
    expect(screen.getByRole("button", { name: /^Board/ })).not.toHaveTextContent("1");

    // Linha do feed abre a task no Board; "abrir run" abre a transcrição.
    await user.click(within(feed).getAllByRole("button", { name: "Mapear integrações" })[0]!);
    expect(await screen.findByTestId("task-detail")).toHaveTextContent("Mapear integrações");
    await user.click(screen.getByRole("button", { name: "Início" }));
    await user.click(within(screen.getByTestId("home-activity")).getAllByRole("button", { name: "abrir run" })[0]!);
    expect(await screen.findByTestId("run-status")).toBeInTheDocument();
    expect(screen.getByTestId("run-member")).toHaveTextContent(/Rui|Ana/);
    expect(screen.getByTestId("run-task")).toHaveTextContent("Mapear integrações");
  });

  it("pausar e retomar pelo painel do Início e o cartão Aguardando você leva às aprovações", async () => {
    const { user, transport } = setup();
    await screen.findByDisplayValue("chat-core");
    const pedro = await transport.invoke("add_team_member", { projectId: "proj_demo", input: { name: "Pedro", roleId: "role_pesquisador" } });
    await transport.invoke("set_setting", { key: "scheduler.paused", value: true });
    const wf = await transport.invoke("create_workflow_from_template", { input: { projectId: "proj_demo", templateId: "research-synthesis" } });
    await transport.invoke("create_task", { projectId: "proj_demo", workflowId: wf.id, input: { title: "Levantar", assignedAgentId: pedro.profile.id } });
    await user.click(screen.getByRole("button", { name: "Atualizar" }));
    const home = screen.getByTestId("home-view");
    const row = await within(home).findByTestId("home-member");
    expect(row).toHaveTextContent("próxima: Levantar");
    await user.click(within(row).getByRole("button", { name: "Pausar" }));
    await waitFor(() => expect(within(home).getByTestId("home-member")).toHaveAttribute("data-status", "paused"));
    expect(within(home).getByTestId("home-member")).toHaveTextContent("fica pronta esperando");
    await user.click(within(within(home).getByTestId("home-member")).getByRole("button", { name: "Rodar agora" }));
    await waitFor(() => expect(within(home).getByTestId("home-member")).toHaveAttribute("data-status", "active"), { timeout: 3000 });
    await waitFor(() => expect(within(home).getByTestId("card-waiting")).toHaveTextContent("1 task em gate"), { timeout: 4000 });
    await user.click(within(home).getByTestId("card-waiting"));
    expect(await screen.findByTestId("task-detail")).toHaveTextContent("Levantar");
  });
});
