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

async function addMember(user: ReturnType<typeof userEvent.setup>, name: string, roleTitle: string, reportsTo?: string) {
  await user.click(screen.getByRole("button", { name: "Adicionar membro" }));
  const dialog = await screen.findByRole("dialog");
  await user.type(within(dialog).getByLabelText("Nome"), name);
  const roleSelect = within(dialog).getByLabelText("Cargo");
  const option = within(roleSelect).getByRole("option", { name: new RegExp(`^${roleTitle} ·`) });
  await user.selectOptions(roleSelect, option);
  if (reportsTo) {
    const bossSelect = within(dialog).getByLabelText("Reporta a");
    await user.selectOptions(bossSelect, within(bossSelect).getByRole("option", { name: new RegExp(`^${reportsTo} ·`) }));
  }
  await user.click(within(dialog).getByRole("button", { name: "Adicionar" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
}

describe("Time", () => {
  it("monta um time de 3 membros com delegação e mostra o organograma e os cards", async () => {
    const { user } = setup();
    await screen.findByDisplayValue("chat-core");
    await user.click(screen.getByRole("button", { name: "Time" }));
    const view = await screen.findByTestId("team-view");
    expect(view).toHaveTextContent("Ainda não há membros");
    expect(screen.getAllByTestId("org-node")).toHaveLength(1); // só o gestor

    await addMember(user, "Pedro", "Planejador");
    await addMember(user, "Ana", "Implementador");
    await addMember(user, "Téo", "Testador", "Ana");

    expect(screen.getAllByTestId("member-card")).toHaveLength(3);
    expect(screen.getByTestId("team-summary")).toHaveTextContent("3 membros · 0 em run · 0 aguardando você");
    // Organograma: gestor + 3 membros; Téo é filho de Ana (ramo aninhado).
    expect(screen.getAllByTestId("org-node")).toHaveLength(4);
    const branches = screen.getAllByTestId("org-branch");
    const ana = branches.find((b) => within(b).queryByText("Ana"))!;
    expect(within(ana).getByText("Téo")).toBeInTheDocument();

    // Card mostra cargo, responsabilidades do seed e ferramentas.
    const anaCard = screen.getByRole("article", { name: "Membro do time: Ana" });
    expect(anaCard).toHaveTextContent("Implementador");
    expect(anaCard).toHaveTextContent("Escrever testes junto com o código");
    expect(within(anaCard).getByText("Bash")).toBeInTheDocument();
    const teoCard = screen.getByRole("article", { name: "Membro do time: Téo" });
    expect(teoCard).toHaveTextContent("reporta a Ana");
  });

  it("a confiança é editada por membro, herda do cargo e aparece como badge no card", async () => {
    const { user, transport } = setup();
    await screen.findByDisplayValue("chat-core");
    await user.click(screen.getByRole("button", { name: "Time" }));
    await screen.findByTestId("team-view");
    // Cargo "Gestor de produto" já vem autônomo, delega e aprova: o card mostra sem override.
    await addMember(user, "Gabi", "Gestor de produto");
    const gabi = screen.getByRole("article", { name: "Membro do time: Gabi" });
    expect(within(gabi).getAllByTestId("trust-badge").map((b) => b.textContent)).toEqual(["autônomo", "delega", "aprova"]);

    // Rui: revisor (supervisionado por padrão) → vira gerenciado e aprovador pelo diálogo.
    await addMember(user, "Rui", "Revisor", "Gabi");
    const rui = screen.getByRole("article", { name: "Membro do time: Rui" });
    expect(within(rui).queryAllByTestId("trust-badge")).toHaveLength(0);
    await user.click(within(rui).getByRole("button", { name: "Ver ficha" }));
    await user.click(within(await screen.findByTestId("member-sheet")).getByRole("button", { name: "Editar membro" }));
    const dialog = await screen.findByRole("dialog");
    const fieldset = within(dialog).getByTestId("trust-fieldset");
    expect(within(fieldset).getByRole("radio", { name: /Padrão do cargo · supervisionado/ })).toBeChecked();
    await user.click(within(fieldset).getByRole("radio", { name: "Gerenciado" }));
    expect(fieldset).toHaveTextContent("sobe o organograma (Gabi)");
    await user.click(within(fieldset).getByRole("checkbox", { name: /Aprova o trabalho/ }));
    await user.click(within(dialog).getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const team = await transport.invoke("list_team", { projectId: "proj_demo" });
    const ruiNow = team.find((m) => m.profile.name === "Rui")!;
    expect(ruiNow.profile.autonomy).toBe("managed");
    expect(ruiNow.profile.canApprove).toBe(true);
    expect(ruiNow.profile.canAssignTasks).toBeNull();
    expect(ruiNow.trust).toEqual({ autonomy: "managed", canAssignTasks: false, canApprove: true });
    expect(screen.getByTestId("member-sheet")).toHaveTextContent("gerenciado · aprova quem reporta a ele");
    await user.click(within(screen.getByTestId("member-sheet")).getByRole("button", { name: "Time" }));
    expect(within(screen.getByRole("article", { name: "Membro do time: Rui" })).getAllByTestId("trust-badge").map((b) => b.textContent)).toEqual(["gerenciado", "aprova"]);
  });

  it("quem pode delegar vê o time e cria uma task para quem reporta a ele; a task mostra quem a criou", async () => {
    const { user, transport } = setup();
    await screen.findByDisplayValue("chat-core");
    const gabi = await transport.invoke("add_team_member", { projectId: "proj_demo", input: { name: "Gabi", roleId: "role_gestor_produto" } });
    const dani = await transport.invoke("add_team_member", { projectId: "proj_demo", input: { name: "Dani", roleId: "role_pesquisador", reportsToAgentId: gabi.profile.id } });
    await transport.invoke("set_setting", { key: "scheduler.paused", value: true });
    await transport.invoke("create_workflow_from_template", { input: { projectId: "proj_demo", templateId: "research-synthesis" } });
    await user.click(screen.getByRole("button", { name: "Time" }));
    await screen.findByTestId("team-view");

    // "Dar uma tarefa" à Gabi: o run nasce com as tools do board e o roteiro delega para a Dani.
    await user.click(within(screen.getByRole("article", { name: "Membro do time: Gabi" })).getByRole("button", { name: "Dar uma tarefa" }));
    await user.type(await screen.findByLabelText("Instrução para Gabi"), "Quebre o objetivo do trimestre em tasks para o time");
    await user.click(screen.getByRole("button", { name: "Enviar" }));
    await waitFor(async () => {
      const tasks = await transport.invoke("list_tasks", { projectId: "proj_demo" });
      expect(tasks).toHaveLength(1);
    }, { timeout: 3000 });
    const [task] = await transport.invoke("list_tasks", { projectId: "proj_demo" });
    expect(task?.title).toBe("Inventário de integrações externas");
    expect(task?.assignedAgentId).toBe(dani.profile.id);
    expect(task?.createdByAgentId).toBe(gabi.profile.id);
    const runs = await transport.invoke("list_runs", { projectId: "proj_demo" });
    expect(runs[0]?.options.boardTools).toBe(true);
    // Transcript: chamadas de delegação legíveis.
    const toolCalls = await screen.findAllByTestId("tool-call");
    expect(toolCalls.map((t) => t.textContent)).toEqual(expect.arrayContaining([expect.stringContaining("quem está no time"), expect.stringContaining("Inventário de integrações externas → Dani")]));

    // Board: card "criada por Gabi"; Time: Gabi criou 1, Dani tem 1 aberta.
    await user.click(screen.getByRole("button", { name: /^Board/ }));
    const card = await screen.findByTestId("task-card");
    expect(within(card).getByTestId("created-by")).toHaveTextContent("criada por Gabi");
    expect(card).toHaveTextContent("Dani");
    await user.click(card);
    expect(within(await screen.findByTestId("task-detail")).getByTestId("task-history")).toHaveTextContent("agente Gabi · criou em Pesquisar pelo board");
    await user.click(screen.getByRole("button", { name: "Time" }));
    expect(within(screen.getByRole("article", { name: "Membro do time: Gabi" })).getByTestId("task-load")).toHaveTextContent("criou 1");
    expect(within(screen.getByRole("article", { name: "Membro do time: Dani" })).getByTestId("task-load")).toHaveTextContent("1 task aberta");
  });

  it("a ficha mostra responsabilidades, como trabalha, delegação e permite editar", async () => {
    const { user, transport } = setup();
    await screen.findByDisplayValue("chat-core");
    await user.click(screen.getByRole("button", { name: "Time" }));
    await screen.findByTestId("team-view");
    await addMember(user, "Ana", "Implementador");
    await addMember(user, "Téo", "Testador", "Ana");

    await user.click(within(screen.getByRole("article", { name: "Membro do time: Ana" })).getByRole("button", { name: "Ver ficha" }));
    const sheet = await screen.findByTestId("member-sheet");
    expect(within(sheet).getByRole("heading", { level: 1 })).toHaveTextContent("Ana");
    expect(within(sheet).getByRole("region", { name: "Responsabilidades" })).toHaveTextContent("Executar uma task por vez");
    expect(within(sheet).getByRole("region", { name: "Como trabalha" })).toHaveTextContent("aceitar edições");
    expect(within(sheet).getByTestId("delegate")).toHaveTextContent("Téo");

    await user.click(within(sheet).getByRole("button", { name: "Editar membro" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Instruções específicas (opcional)"), "Prefira Java 21.");
    await user.type(within(dialog).getByLabelText("Orçamento por run (US$)"), "5");
    await user.click(within(dialog).getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(screen.getByTestId("member-sheet")).toHaveTextContent("Prefira Java 21."));
    expect(screen.getByTestId("member-sheet")).toHaveTextContent("US$ 5,00 por run");
    const team = await transport.invoke("list_team", { projectId: "proj_demo" });
    expect(team.find((m) => m.profile.name === "Ana")?.profile.maxBudgetUsd).toBe(5);
  });

  it("'Dar uma tarefa' leva ao composer e o run nasce com as opções do membro e o delegado como subagente", async () => {
    const { user, transport } = setup();
    await screen.findByDisplayValue("chat-core");
    await user.click(screen.getByRole("button", { name: "Time" }));
    await screen.findByTestId("team-view");
    await addMember(user, "Ana", "Implementador");
    await addMember(user, "Téo", "Testador", "Ana");

    await user.click(within(screen.getByRole("article", { name: "Membro do time: Ana" })).getByRole("button", { name: "Dar uma tarefa" }));
    expect(await screen.findByTestId("run-as-banner")).toHaveTextContent("Tarefa para Ana");
    expect((screen.getByTestId("run-as-select") as HTMLSelectElement).value).toMatch(/^agent_/);
    await user.type(screen.getByLabelText("Instrução para Ana"), "Crie a migração V12");
    await user.click(screen.getByRole("button", { name: "Enviar" }));

    const runs = await transport.invoke("list_runs", { projectId: "proj_demo" });
    const run = runs[0]!;
    expect(run.agentProfileId).toMatch(/^agent_/);
    expect(run.options.systemPromptAppend).toContain("Você é Ana, Implementador");
    expect(run.options.systemPromptAppend).toContain("Escrever testes junto com o código");
    expect(run.options.permissionMode).toBe("acceptEdits");
    expect(Object.keys(run.options.agents ?? {})).toEqual(["t-o"]);
    expect(run.options.agents?.["t-o"]?.description).toMatch(/^Testador/);

    // Enquanto o run está ativo, o membro aparece "em run" no time.
    await user.click(screen.getByRole("button", { name: "Time" }));
    await waitFor(() => expect(screen.getByRole("article", { name: "Membro do time: Ana" })).toHaveAttribute("data-status", expect.stringMatching(/active|waiting/)));
    expect(screen.getByTestId("team-summary")).toHaveTextContent(/1 em run|1 aguardando você/);
  });

  it("remover um membro tira o delegado da cadeia e mantém o time coerente", async () => {
    const { user, transport } = setup();
    await screen.findByDisplayValue("chat-core");
    await user.click(screen.getByRole("button", { name: "Time" }));
    await screen.findByTestId("team-view");
    await addMember(user, "Ana", "Implementador");
    await addMember(user, "Téo", "Testador", "Ana");
    await user.click(within(screen.getByRole("article", { name: "Membro do time: Ana" })).getByRole("button", { name: "Ver ficha" }));
    await user.click(await screen.findByRole("button", { name: "Editar membro" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Remover do time" }));
    await waitFor(() => expect(screen.getAllByTestId("member-card")).toHaveLength(1));
    const team = await transport.invoke("list_team", { projectId: "proj_demo" });
    expect(team[0]?.profile.name).toBe("Téo");
    expect(team[0]?.reportsToAgentId).toBeNull();
    expect(screen.getByRole("article", { name: "Membro do time: Téo" })).toHaveTextContent("reporta a você");
  });
});
