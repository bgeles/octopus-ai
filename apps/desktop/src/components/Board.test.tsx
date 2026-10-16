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

async function seedTeam(transport: ReturnType<typeof createMockTransport>) {
  await transport.invoke("add_team_member", { projectId: "proj_demo", input: { name: "Pedro", roleId: "role_planejador" } });
  await transport.invoke("add_team_member", { projectId: "proj_demo", input: { name: "Ana", roleId: "role_implementador" } });
  await transport.invoke("add_team_member", { projectId: "proj_demo", input: { name: "Rui", roleId: "role_revisor" } });
}

describe("Board e scheduler", () => {
  it("cria o workflow pelo modelo com os responsáveis do time e mostra os estágios", async () => {
    const { user, transport } = setup();
    await screen.findByDisplayValue("chat-core");
    await seedTeam(transport);
    await user.click(screen.getByRole("button", { name: /^Board/ }));
    const view = await screen.findByTestId("board-view");
    const templates = await within(view).findAllByTestId("workflow-template");
    expect(templates).toHaveLength(2);
    await user.click(within(templates[0]!).getByRole("button", { name: "Usar este workflow" }));

    await waitFor(() => expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Planejar → Implementar → Revisar → Aprovar"));
    const chips = screen.getAllByTestId("stage-chip");
    expect(chips).toHaveLength(4);
    expect(chips[0]).toHaveTextContent("Pedro · Planejador");
    expect(chips[1]).toHaveTextContent("Ana · Implementador");
    expect(chips[3]).toHaveTextContent("gate humano");
    expect(chips[3]).toHaveTextContent("Você");
    expect(screen.getByTestId("scheduler-status")).toHaveTextContent("Scheduler ativo · 1 run por vez");
  });

  it("task criada entra na fila, o scheduler inicia o run do responsável, o agente pede revisão e você aprova até concluir", async () => {
    const { user, transport } = setup();
    await screen.findByDisplayValue("chat-core");
    await seedTeam(transport);
    await transport.invoke("create_workflow_from_template", { input: { projectId: "proj_demo", templateId: "research-synthesis" } });
    await user.click(screen.getByRole("button", { name: /^Board/ }));
    await screen.findByTestId("kanban");

    await user.click(screen.getByRole("button", { name: "Nova task" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Título"), "Mapear integrações");
    await user.type(within(dialog).getByLabelText("Descrição"), "Listar todas as integrações externas.");
    await user.click(within(dialog).getByRole("button", { name: "Criar task" }));

    // O scheduler roda logo depois de criar: a task vai para "em run" no estágio Pesquisar (sem Pesquisador no time → run avulso).
    const card = await screen.findByTestId("task-card");
    await waitFor(() => expect(card).toHaveAttribute("data-status", "running"));
    expect(screen.getAllByTestId("stage-chip")[0]).toHaveTextContent("sem responsável (run avulso)");

    // O roteiro do run de task termina com task_update(review): a task fica aguardando você, com a nota do agente.
    await waitFor(() => expect(screen.getByTestId("task-card")).toHaveAttribute("data-status", "waiting_approval"), { timeout: 3000 });
    const detail = screen.getByTestId("task-detail");
    expect(detail).toHaveTextContent("aguardando você");
    await waitFor(() => expect(within(detail).getByTestId("task-note")).toHaveTextContent("V12 criada; LeadRepositoryIT verde."));
    expect(within(detail).getByTestId("task-history")).toHaveTextContent("agente atualizou");
    expect(screen.getByRole("button", { name: /^Board/ })).toHaveTextContent("1");

    // Aprovar segue para Sintetizar; o scheduler começa o próximo run.
    await user.type(within(detail).getByLabelText("Observação"), "bom levantamento");
    await user.click(within(detail).getByRole("button", { name: "Aprovar e seguir" }));
    await waitFor(() => expect(screen.getByTestId("task-card")).toHaveAttribute("data-status", "running"), { timeout: 3000 });
    const columns = screen.getAllByTestId("kanban-column");
    expect(within(columns[1]!).getByTestId("task-card")).toBeInTheDocument();

    // Segundo run também pede revisão; aprovar no último estágio conclui.
    await waitFor(() => expect(screen.getByTestId("task-card")).toHaveAttribute("data-status", "waiting_approval"), { timeout: 3000 });
    await user.click(within(screen.getByTestId("task-detail")).getByRole("button", { name: "Aprovar e concluir" }));
    await waitFor(() => expect(screen.getByTestId("task-card")).toHaveAttribute("data-status", "done"));
    const tasks = await transport.invoke("list_tasks", { projectId: "proj_demo" });
    expect(tasks[0]?.status).toBe("done");
    const runs = await transport.invoke("list_runs", { projectId: "proj_demo" });
    expect(runs).toHaveLength(2);
    expect(runs.every((r) => r.taskId === tasks[0]?.id)).toBe(true);
    expect(runs[0]?.options.taskContext?.stage).toBe("Sintetizar");
  });

  it("respeita dependências: a segunda task só roda depois da primeira concluir, e o scheduler pode ser pausado", async () => {
    const { user, transport } = setup();
    await screen.findByDisplayValue("chat-core");
    await transport.invoke("create_workflow_from_template", { input: { projectId: "proj_demo", templateId: "research-synthesis" } });
    const wf = (await transport.invoke("list_workflows", { projectId: "proj_demo" }))[0]!;
    await transport.invoke("set_setting", { key: "scheduler.paused", value: true });
    const first = await transport.invoke("create_task", { projectId: "proj_demo", workflowId: wf.id, input: { title: "Primeira" } });
    await transport.invoke("create_task", { projectId: "proj_demo", workflowId: wf.id, input: { title: "Segunda", dependsOn: [first.id] } });

    await user.click(screen.getByRole("button", { name: /^Board/ }));
    await screen.findByTestId("kanban");
    expect(screen.getByTestId("scheduler-status")).toHaveTextContent("Scheduler pausado");
    await user.click(screen.getByRole("button", { name: "Rodar agora" }));
    // Pausado: ninguém roda.
    expect(screen.getAllByTestId("task-card").every((c) => c.getAttribute("data-status") === "ready")).toBe(true);

    await user.click(screen.getByRole("button", { name: "Retomar scheduler" }));
    await user.click(screen.getByRole("button", { name: "Rodar agora" }));
    await waitFor(() => {
      const cards = screen.getAllByTestId("task-card");
      expect(cards.find((c) => c.textContent?.includes("Primeira"))).toHaveAttribute("data-status", "running");
      expect(cards.find((c) => c.textContent?.includes("Segunda"))).toHaveAttribute("data-status", "ready");
    });
  });
});
