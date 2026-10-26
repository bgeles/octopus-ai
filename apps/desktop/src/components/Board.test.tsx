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
    expect(chips[3]).toHaveTextContent("gate: você");
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

    // A entrega fica visível na própria task: resumo do agente, arquivos tocados e o diff contra o commit base.
    const done = screen.getByTestId("task-detail");
    const result = within(done).getByTestId("task-result");
    expect(result).toHaveTextContent("Como verificar:");
    expect(result).toHaveTextContent("./mvnw -q test");
    expect(within(done).getByText(/Arquivos alterados · 1/)).toBeInTheDocument();
    expect(within(done).getByTestId("task-files")).toHaveTextContent("V12__add_triage_status.sql");
    expect(within(screen.getByTestId("task-card")).getByLabelText("com entrega")).toBeInTheDocument();
    await user.click(within(done).getByRole("button", { name: "Ver diff" }));
    const diff = await within(done).findByTestId("task-diff");
    expect(within(diff).getAllByTestId("diff").length).toBeGreaterThanOrEqual(1);
    expect(diff).toHaveTextContent("V12__add_triage_status.sql");
    expect(tasks[0]?.filesChanged).toEqual(["src/main/resources/db/migration/V12__add_triage_status.sql"]);
    expect(tasks[0]?.resultMd).toContain("## Entrega");

    // A aba Entregas lista as tasks concluídas com o resumo; clicar abre o painel.
    await user.click(screen.getByRole("radio", { name: /Entregas · 1/ }));
    // Relatório final gerado sozinho quando a última task concluiu: 1 de 1, custo e a entrega.
    const report = screen.getByTestId("workflow-report");
    expect(within(report).getByTestId("report-progress")).toHaveTextContent("1 de 1 task");
    expect(report).toHaveTextContent("gerado quando a última task concluiu");
    expect(within(report).getByTestId("report-body")).toHaveTextContent("Tasks: 1 de 1 concluídas");
    expect(within(report).getByTestId("report-body")).toHaveTextContent("Criada a migração");
    expect(within(report).queryByTestId("report-summary")).not.toBeInTheDocument();
    const reports = await transport.invoke("list_workflow_reports", { projectId: "proj_demo" });
    expect(reports).toHaveLength(1);
    expect(reports[0]?.trigger).toBe("auto");
    expect(reports[0]?.tasks[0]?.filesChanged).toEqual(["src/main/resources/db/migration/V12__add_triage_status.sql"]);
    const rows = within(screen.getByTestId("deliveries")).getAllByTestId("delivery-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("Mapear integrações");
    expect(rows[0]).toHaveTextContent("Criada a migração");
    expect(rows[0]).toHaveTextContent("1 arquivo");
    expect(screen.queryByTestId("kanban")).not.toBeVisible();
    await user.click(screen.getByRole("radio", { name: "Kanban" }));
    expect(screen.getByTestId("kanban")).toBeVisible();
    const runs = await transport.invoke("list_runs", { projectId: "proj_demo" });
    expect(runs).toHaveLength(2);
    expect(runs.every((r) => r.taskId === tasks[0]?.id)).toBe(true);
    expect(runs[0]?.options.taskContext?.stage).toBe("Sintetizar");
  });

  it("com confiança configurada a task é revisada pelo gestor e concluída sem nenhum clique seu", async () => {
    const { user, transport } = setup();
    await screen.findByDisplayValue("chat-core");
    // Rui (revisor gerenciado que aprova) ← Ana (pesquisadora gerenciada). Gate final por política.
    const rui = await transport.invoke("add_team_member", { projectId: "proj_demo", input: { name: "Rui", roleId: "role_revisor", autonomy: "managed", canApprove: true } });
    await transport.invoke("add_team_member", { projectId: "proj_demo", input: { name: "Ana", roleId: "role_pesquisador", reportsToAgentId: rui.profile.id, autonomy: "managed" } });
    await transport.invoke("set_setting", { key: "scheduler.paused", value: true });
    const wf = await transport.invoke("create_workflow_from_template", { input: { projectId: "proj_demo", templateId: "research-synthesis" } });
    await user.click(screen.getByRole("button", { name: /^Board/ }));
    await screen.findByTestId("kanban");
    expect(screen.getAllByTestId("stage-chip")[0]).toHaveTextContent("Ana · Pesquisador");

    // Atribuída à Ana: no segundo estágio (sem Documentador no time) ela continua responsável.
    const ana = (await transport.invoke("list_team", { projectId: "proj_demo" })).find((m) => m.profile.name === "Ana")!;
    await transport.invoke("create_task", { projectId: "proj_demo", workflowId: wf.id, input: { title: "Mapear integrações", assignedAgentId: ana.profile.id } });
    await transport.invoke("set_setting", { key: "scheduler.paused", value: null });
    await user.click(screen.getByRole("button", { name: "Rodar agora" }));
    const card = await screen.findByTestId("task-card");
    await waitFor(() => expect(card).toHaveAttribute("data-status", "running"));

    // O run da Ana pede revisão: vai para o Rui, não para você (badge do Board não sobe).
    await waitFor(() => expect(screen.getByTestId("task-card")).toHaveAttribute("data-status", "review"), { timeout: 3000 });
    expect(screen.getByTestId("task-card")).toHaveTextContent("em revisão por Rui");
    expect(screen.getByRole("button", { name: /^Board/ })).not.toHaveTextContent("1");

    // O scheduler inicia o run de revisão do Rui, que aprova; a task segue para Sintetizar e roda de novo.
    await waitFor(() => {
      const runs = [...document.querySelectorAll("[data-testid=task-card]")];
      expect(runs[0]).toHaveAttribute("data-status", "running");
    }, { timeout: 4000 });
    const runs = await transport.invoke("list_runs", { projectId: "proj_demo" });
    const review = runs.find((r) => r.kind === "review");
    expect(review?.agentProfileId).toBe(rui.profile.id);
    expect(review?.options.taskContext?.mode).toBe("review");
    expect(review?.options.disallowedTools).toContain("Write");

    // Segundo estágio também pede revisão → Rui aprova → concluída. Nenhum botão foi clicado.
    await waitFor(() => expect(screen.getByTestId("task-card")).toHaveAttribute("data-status", "done"), { timeout: 8000 });
    await user.click(screen.getByTestId("task-card"));
    const detail = await screen.findByTestId("task-detail");
    const history = within(detail).getByTestId("task-history");
    expect(history).toHaveTextContent("política · encaminhou para revisão");
    expect(history).toHaveTextContent("agente Rui · aprovou");
    expect(screen.queryByRole("button", { name: /Aprovar/ })).not.toBeInTheDocument();
  });

  it("o chip do gate alterna entre você e a política; com gestor autônomo no topo o gate se auto-aprova", async () => {
    const { user, transport } = setup();
    await screen.findByDisplayValue("chat-core");
    const gabi = await transport.invoke("add_team_member", { projectId: "proj_demo", input: { name: "Gabi", roleId: "role_gestor_produto" } });
    await transport.invoke("set_setting", { key: "scheduler.paused", value: true });
    const wf = await transport.invoke("create_workflow_from_template", { input: { projectId: "proj_demo", templateId: "plan-implement-review-approve" } });
    await user.click(screen.getByRole("button", { name: /^Board/ }));
    await screen.findByTestId("kanban");
    const gate = screen.getByTestId("gate-approver");
    expect(gate).toHaveTextContent("gate: você");
    await user.click(gate);
    await waitFor(() => expect(screen.getByTestId("gate-approver")).toHaveTextContent("gate: por política"));
    const stages = (await transport.invoke("list_workflows", { projectId: "proj_demo" }))[0]!.stages;
    expect(stages[3]?.approver).toBe("policy");

    // Task da Gabi criada direto no gate: ao estacionar, a política auto-aprova e conclui.
    await transport.invoke("create_task", { projectId: "proj_demo", workflowId: wf.id, input: { title: "Roadmap", stageId: stages[3]!.id, assignedAgentId: gabi.profile.id } });
    await transport.invoke("set_setting", { key: "scheduler.paused", value: null });
    await user.click(screen.getByRole("button", { name: "Rodar agora" }));
    await waitFor(() => expect(screen.getByTestId("task-card")).toHaveAttribute("data-status", "done"));
    await user.click(screen.getByTestId("task-card"));
    expect(within(await screen.findByTestId("task-detail")).getByTestId("task-history")).toHaveTextContent("política · auto-aprovou por política");
  });

  it("o relatório pode ser gerado sob demanda com pendentes e ganha resumo executivo do Haiku quando ligado", async () => {
    const { user, transport } = setup();
    await screen.findByDisplayValue("chat-core");
    await transport.invoke("set_setting", { key: "board.reportSummary", value: "haiku" });
    await transport.invoke("set_setting", { key: "scheduler.paused", value: true });
    const wf = await transport.invoke("create_workflow_from_template", { input: { projectId: "proj_demo", templateId: "research-synthesis" } });
    await transport.invoke("create_task", { projectId: "proj_demo", workflowId: wf.id, input: { title: "Pendente" } });
    await user.click(screen.getByRole("button", { name: /^Board/ }));
    await screen.findByTestId("kanban");
    await user.click(screen.getByRole("radio", { name: /Entregas · 0/ }));
    const empty = screen.getByTestId("workflow-report");
    expect(empty).toHaveTextContent("0 de 1 task concluída");
    await user.click(within(empty).getByRole("button", { name: "Gerar relatório agora" }));
    const report = await screen.findByTestId("report-progress");
    expect(report).toHaveTextContent("0 de 1 task");
    expect(screen.getByTestId("report-body")).toHaveTextContent("Pendentes");
    // Haiku ligado: o resumo chega sozinho (run kind report) e o Início mostra o card compacto.
    await waitFor(() => expect(screen.getByTestId("report-summary")).toHaveAttribute("data-status", "done"), { timeout: 3000 });
    expect(screen.getByTestId("report-summary")).toHaveTextContent("Entregas no prazo");
    const runs = await transport.invoke("list_runs", { projectId: "proj_demo" });
    expect(runs.some((r) => r.kind === "report")).toBe(true);
    await user.click(screen.getByRole("button", { name: "Início" }));
    expect(within(await screen.findByTestId("home-reports")).getByTestId("report-summary")).toHaveTextContent("Entregas no prazo");
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
