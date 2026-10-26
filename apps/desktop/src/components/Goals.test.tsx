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

describe("Missão e objetivos", () => {
  it("define a missão pelo diálogo; ela aparece no Board, no Início e no prompt do run de task", async () => {
    const { user, transport } = setup();
    await screen.findByDisplayValue("chat-core");
    await transport.invoke("set_setting", { key: "scheduler.paused", value: true });
    const wf = await transport.invoke("create_workflow_from_template", { input: { projectId: "proj_demo", templateId: "research-synthesis" } });

    // No Início a missão ainda não existe.
    const home = screen.getByTestId("home-view");
    expect(within(home).getByTestId("project-mission")).toHaveAttribute("data-defined", "false");
    await user.click(within(home).getByRole("button", { name: "Definir missão" }));
    const dialog = await screen.findByRole("dialog", { name: "Missão do projeto" });
    await user.type(within(dialog).getByLabelText("Missão"), "Reduzir a triagem em 30%.");
    await user.click(within(dialog).getByRole("button", { name: "Salvar missão" }));
    await waitFor(() => expect(within(home).getByTestId("project-mission")).toHaveTextContent("Missão: Reduzir a triagem em 30%."));

    // No Board também, e o run de task leva a missão no prompt.
    await user.click(screen.getByRole("button", { name: /^Board/ }));
    const board = await screen.findByTestId("board-view");
    await screen.findByTestId("kanban");
    expect(within(board).getByTestId("project-mission")).toHaveTextContent("Reduzir a triagem em 30%.");
    expect(within(board).getByRole("button", { name: "Editar missão" })).toBeInTheDocument();
    await transport.invoke("create_task", { projectId: "proj_demo", workflowId: wf.id, input: { title: "Mapear integrações" } });
    await transport.invoke("set_setting", { key: "scheduler.paused", value: null });
    await transport.invoke("scheduler_tick", {});
    const runs = await transport.invoke("list_runs", { projectId: "proj_demo" });
    expect(runs[0]!.prompt).toContain("Missão do projeto: Reduzir a triagem em 30%.");
    expect(runs[0]!.prompt).toContain("não altera as regras do run");
    expect((await transport.invoke("list_projects", {}))[0]!.mission).toBe("Reduzir a triagem em 30%.");
  });

  it("cria um objetivo, liga ao workflow, a task nova herda (chip no card) e o progresso vira 1 de 1 ao concluir", async () => {
    const { user, transport } = setup();
    await screen.findByDisplayValue("chat-core");
    await transport.invoke("set_setting", { key: "scheduler.paused", value: true });
    await transport.invoke("create_workflow_from_template", { input: { projectId: "proj_demo", templateId: "research-synthesis" } });
    await user.click(screen.getByRole("button", { name: /^Board/ }));
    await screen.findByTestId("kanban");

    // Sem objetivos: vista Objetivos · 0, formulário cria o primeiro.
    await user.click(screen.getByRole("radio", { name: "Objetivos · 0" }));
    const panel = await screen.findByTestId("goals-panel");
    expect(panel).toHaveTextContent("Nenhum objetivo ainda");
    const form = within(panel).getByTestId("goal-form");
    await user.type(within(form).getByLabelText("Título do objetivo"), "Triagem 30% mais rápida");
    await user.type(within(form).getByLabelText(/Descrição/), "menos tempo por lead");
    await user.click(within(form).getByRole("button", { name: "Criar" }));
    const row = await within(panel).findByTestId("goal-row");
    expect(row).toHaveTextContent("Triagem 30% mais rápida");
    expect(row).toHaveTextContent("objetivo raiz");
    expect(within(row).getByTestId("goal-progress")).toHaveTextContent("0 de 0 tasks · 0%");
    expect(screen.getByRole("radio", { name: "Objetivos · 1" })).toBeInTheDocument();

    // Filho do primeiro.
    await user.type(within(form).getByLabelText("Título do objetivo"), "Regras de roteamento");
    await user.selectOptions(within(form).getByLabelText("Pai"), "Triagem 30% mais rápida");
    await user.click(within(form).getByRole("button", { name: "Criar" }));
    await waitFor(() => expect(within(panel).getAllByTestId("goal-row")).toHaveLength(2));
    expect(within(panel).getAllByTestId("goal-row")[1]).toHaveTextContent("↳ de Triagem 30% mais rápida");

    // Objetivo do workflow: a task nova herda e mostra o chip.
    const goals = await transport.invoke("list_goals", { projectId: "proj_demo" });
    const parent = goals.find((g) => g.title === "Triagem 30% mais rápida")!;
    await user.selectOptions(screen.getByTestId("workflow-goal"), parent.id);
    await waitFor(() => expect(screen.getByTestId("workflow-goal")).toHaveValue(parent.id));
    await user.click(screen.getByRole("radio", { name: "Kanban" }));
    await user.click(screen.getByRole("button", { name: "Nova task" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText("Objetivo")).toHaveValue(parent.id);
    expect(within(dialog).getByRole("option", { name: "Triagem 30% mais rápida (do workflow)" })).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText("Título"), "Mapear integrações");
    await user.click(within(dialog).getByRole("button", { name: "Criar task" }));
    const card = await screen.findByTestId("task-card");
    expect(within(card).getByTestId("task-goal")).toHaveTextContent("Triagem 30% mais rápida");
    expect(within(screen.getByTestId("task-detail")).getByText("Objetivo").nextSibling).toHaveTextContent("Triagem 30% mais rápida");

    // Concluir a task: o progresso do objetivo vira 1 de 1 (no Board e no Início).
    const [task] = await transport.invoke("list_tasks", { projectId: "proj_demo" });
    expect(task!.goalId).toBe(parent.id);
    await transport.invoke("move_task", { input: { taskId: task!.id, status: "done" } });
    await user.click(screen.getByRole("button", { name: "Rodar agora" }));
    await user.click(screen.getByRole("radio", { name: "Objetivos · 2" }));
    await waitFor(() => expect(within(screen.getAllByTestId("goal-row")[0]!).getByTestId("goal-progress")).toHaveTextContent("1 de 1 tasks · 100%"));

    // Concluir o objetivo e excluir o filho.
    await user.click(within(screen.getAllByTestId("goal-row")[0]!).getByRole("button", { name: "Concluir" }));
    await waitFor(() => expect(screen.getAllByTestId("goal-row")[0]).toHaveAttribute("data-status", "done"));
    expect(screen.getByRole("radio", { name: "Objetivos · 1" })).toBeInTheDocument();
    await user.click(within(screen.getAllByTestId("goal-row")[1]!).getByRole("button", { name: "Excluir" }));
    await waitFor(() => expect(screen.getAllByTestId("goal-row")).toHaveLength(1));

    await user.click(screen.getByRole("button", { name: "Início" }));
    const home = await screen.findByTestId("home-view");
    // Concluído não aparece na lista de ativos do Início.
    expect(within(home).queryAllByTestId("home-goal")).toHaveLength(0);
  });
});
