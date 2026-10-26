import memoryEvents from "@octopus/protocol/fixtures/run-events-memory.notifications.json";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "../App";
import { createMockTransport } from "../lib/mockTransport";
import type { RunEventNotification } from "../lib/types";

function setup(events?: RunEventNotification[]) {
  const transport = createMockTransport({ tickMs: 5, events });
  const user = userEvent.setup();
  render(<App transport={transport} />);
  return { transport, user };
}

describe("Memória", () => {
  it("ao fim de um run, o log de tarefas do mês aparece como página com pedido e resultado", async () => {
    const { user } = setup();
    await screen.findByDisplayValue("chat-core");
    await user.click(screen.getByRole("button", { name: "Run ao vivo" }));
    await user.type(screen.getByLabelText("Instrução para o agente"), "rodar testes");
    await user.click(screen.getByRole("button", { name: "Enviar" }));
    await user.click(within(await screen.findByTestId("approval-card")).getByRole("button", { name: "Permitir uma vez" }));
    await waitFor(() => expect(screen.getByTestId("run-status")).toHaveTextContent("Concluído"), { timeout: 3000 });

    await user.click(screen.getByRole("button", { name: "Memória" }));
    const list = await screen.findByTestId("memory-page-list");
    const row = await within(list).findByTestId("memory-page-row");
    expect(row).toHaveAttribute("data-kind", "tasklog");
    expect(row).toHaveTextContent(/Log de tarefas — \d{4}-\d{2}/);
    await user.click(row);
    const page = await screen.findByTestId("memory-page");
    expect(within(page).getByTestId("memory-page-body")).toHaveTextContent("Pedido: rodar testes");
    expect(within(page).getByTestId("memory-page-body")).toHaveTextContent("concluído");
    expect(page).toHaveTextContent("consolidação automática");
  });

  it("observações chegam sanitizadas; busca, nova página, histórico e arquivar funcionam", async () => {
    const { user, transport } = setup(memoryEvents.map((n) => n.params as unknown as RunEventNotification));
    await screen.findByDisplayValue("chat-core");
    await user.click(screen.getByRole("button", { name: "Run ao vivo" }));
    await user.type(screen.getByLabelText("Instrução para o agente"), "crie a V12");
    await user.click(screen.getByRole("button", { name: "Enviar" }));
    await waitFor(() => expect(screen.getByTestId("run-status")).toHaveTextContent("Concluído"), { timeout: 3000 });

    await user.click(screen.getByRole("button", { name: "Memória" }));
    await user.click(await screen.findByRole("tab", { name: /Observações/ }));
    const rows = await screen.findAllByTestId("observation-row");
    expect(rows.length).toBe(5);
    const bash = rows.find((r) => r.textContent?.includes("Bash ./mvnw -q test"))!;
    expect(bash).toHaveAttribute("data-redacted", "true");
    expect(bash.textContent).not.toContain("sk-ant-api03-abcdef");
    expect(bash.textContent).not.toContain("s3cr3t-pass");
    expect(bash.textContent).toContain("[redigido]");
    expect(bash.textContent).toContain("consolidada");
    const stored = await transport.invoke("list_memory_observations", { projectId: "proj_demo" });
    expect(JSON.stringify(stored)).not.toContain("s3cr3t-pass");

    // O log de tarefas consolidou arquivos tocados e notas do agente.
    await user.click(screen.getByRole("tab", { name: /Páginas/ }));
    await user.click(await screen.findByTestId("memory-page-row"));
    const body = within(await screen.findByTestId("memory-page")).getByTestId("memory-page-body");
    expect(body).toHaveTextContent("Arquivos tocados: src/main/resources/db/migration/V12__add_triage_status.sql");
    expect(body).toHaveTextContent("Notas do agente:");

    // Nova página manual e busca.
    await user.click(screen.getByRole("button", { name: "Nova página" }));
    await user.selectOptions(screen.getByLabelText("Tipo da página"), "decisions");
    await user.type(screen.getByLabelText("Título da página"), "Migrações sempre em Flyway versionado");
    await user.type(screen.getByLabelText("Conteúdo da página"), "Toda alteração de esquema entra como migração Flyway. **Nunca** editar migração aplicada.");
    await user.click(screen.getByRole("button", { name: "Salvar" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Página criada.");
    expect(within(screen.getByTestId("memory-page")).getByRole("heading", { level: 2 })).toHaveTextContent("Migrações sempre em Flyway versionado");
    expect(screen.getAllByTestId("memory-page-row").length).toBe(2);
    await user.type(screen.getByLabelText("Buscar (FTS5)"), "flyway");
    await waitFor(() => expect(screen.getAllByTestId("memory-page-row").length).toBe(1));
    expect(screen.getByTestId("memory-page-row")).toHaveTextContent("«Flyway»");

    // Histórico após edição.
    await user.click(screen.getByRole("button", { name: "Editar" }));
    await user.type(screen.getByLabelText("Conteúdo da página"), " Criar V13+.");
    await user.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Histórico · 2/ })).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /Histórico · 2/ }));
    const history = within(screen.getByRole("region", { name: "Histórico de versões" }));
    expect(history.getByText("edição manual")).toBeInTheDocument();
    expect(history.getByText("criação manual")).toBeInTheDocument();

    // Arquivar some da lista (busca limpa) e fica registrado na auditoria.
    await user.clear(screen.getByLabelText("Buscar (FTS5)"));
    await user.click(screen.getByRole("button", { name: "Arquivar" }));
    await waitFor(() => expect(screen.getAllByTestId("memory-page-row").length).toBe(1));
    const audit = await transport.invoke("list_audit_events", { projectId: "proj_demo", limit: 50 });
    expect(audit.some((e) => e.kind === "memory.page.archived")).toBe(true);
    expect(audit.some((e) => e.kind === "memory.page")).toBe(true);
  });

  it("o run seguinte recebe o brief com as páginas relevantes e o sidebar mostra o que entrou", async () => {
    const { user, transport } = setup();
    await screen.findByDisplayValue("chat-core");
    await user.click(screen.getByRole("button", { name: "Run ao vivo" }));
    await transport.invoke("save_memory_page", { input: { projectId: "proj_demo", kind: "pitfalls", title: "Testes exigem Postgres 16", bodyMd: "Os testes de integração sobem um Postgres 16 local." } });
    await transport.invoke("save_memory_page", { input: { projectId: "proj_demo", kind: "note", title: "Convenções de commit", bodyMd: "Mensagens em pt-BR." } });
    await user.type(screen.getByLabelText("Instrução para o agente"), "rodar testes");
    await user.click(screen.getByRole("button", { name: "Enviar" }));
    const chip = await screen.findByTestId("brief-chip");
    expect(chip).toHaveTextContent("Memória injetada");
    expect(chip).toHaveTextContent("Testes exigem Postgres 16");
    expect(chip).not.toHaveTextContent("Convenções de commit");
    const events = await transport.invoke("list_run_events", { runId: (await transport.invoke("list_runs", { projectId: "proj_demo" }))[0]!.id });
    expect(events[0]?.event.type).toBe("brief_injected");
  });

  it("run de task interrompido gera handoff automático, que o próximo run da task consome", async () => {
    const { user, transport } = setup();
    await screen.findByDisplayValue("chat-core");
    await user.click(screen.getByRole("button", { name: "Run ao vivo" }));
    const wf = await transport.invoke("create_workflow_from_template", { input: { projectId: "proj_demo", templateId: "research-synthesis" } });
    await transport.invoke("set_setting", { key: "scheduler.paused", value: true });
    const task = await transport.invoke("create_task", { projectId: "proj_demo", workflowId: wf.id, input: { title: "Mapear integrações", descriptionMd: "Listar integrações externas." } });
    await transport.invoke("set_setting", { key: "scheduler.paused", value: false });
    await transport.invoke("scheduler_tick", {});
    const [run] = await transport.invoke("list_runs", { projectId: "proj_demo" });
    expect(run?.taskId).toBe(task.id);
    expect(await transport.invoke("interrupt_run", { runId: run!.id })).toBe(true);

    await user.click(screen.getByRole("button", { name: "Memória" }));
    await user.click(await screen.findByRole("tab", { name: /Handoffs · 1 pendente/ }));
    const row = await screen.findByTestId("handoff-row");
    expect(row).toHaveAttribute("data-consumed", "false");
    expect(row).toHaveAttribute("data-source", "auto");
    expect(row).toHaveTextContent("Mapear integrações");
    expect(row).toHaveTextContent("interrompido");
    expect(row).toHaveTextContent("O que falhou: Run interrompido pelo usuário");

    // A task volta para a fila; o próximo run dela consome o handoff.
    await transport.invoke("move_task", { input: { taskId: task.id, stageId: null, status: "ready", note: null } });
    await transport.invoke("scheduler_tick", {});
    const runs = await transport.invoke("list_runs", { projectId: "proj_demo" });
    const next = runs.find((r) => r.id !== run!.id)!;
    const handoffs = await transport.invoke("list_memory_handoffs", { projectId: "proj_demo" });
    expect(handoffs[0]?.consumedByRunId).toBe(next.id);
    // Os eventos do mock chegam de forma assíncrona.
    await waitFor(async () => {
      const nextEvents = await transport.invoke("list_run_events", { runId: next.id });
      expect(nextEvents[0]?.event).toMatchObject({ type: "brief_injected" });
      expect((nextEvents[0]?.event as { items: string[] }).items[0]).toMatch(/^handoff: Run interrompido/);
    });
  });

  it("com consolidação Haiku ligada, um run de memória grava páginas marcadas como Haiku e aparece como consolidação", async () => {
    const { user, transport } = setup(memoryEvents.map((n) => n.params as unknown as RunEventNotification));
    await screen.findByDisplayValue("chat-core");
    await user.click(screen.getByRole("button", { name: "Memória" }));
    const mode = await screen.findByTestId("consolidation-mode");
    await waitFor(() => expect(mode).toHaveAttribute("data-mode", "raw"));
    await user.click(within(mode).getByRole("radio", { name: /Com Haiku/ }));
    expect(await screen.findByRole("status")).toHaveTextContent("Haiku");
    expect((await transport.invoke("get_settings", {}))["memory.consolidation"]).toBe("haiku");

    await user.click(screen.getByRole("button", { name: "Run ao vivo" }));
    await user.type(screen.getByLabelText("Instrução para o agente"), "crie a V12");
    await user.click(screen.getByRole("button", { name: "Enviar" }));
    await waitFor(() => expect(screen.getByTestId("run-status")).toHaveTextContent("Concluído"), { timeout: 3000 });
    await waitFor(async () => {
      const pages = await transport.invoke("list_memory_pages", { projectId: "proj_demo" });
      expect(pages.some((p) => p.source === "haiku" && p.kind === "decisions")).toBe(true);
    });
    const runs = await transport.invoke("list_runs", { projectId: "proj_demo" });
    expect(runs.find((r) => r.kind === "consolidation")?.model).toBe("claude-haiku-5-5");
    expect(runs.find((r) => r.kind === "consolidation")?.options.disallowedTools).toContain("Bash");

    await user.click(screen.getByRole("button", { name: "Sessões" }));
    expect(await screen.findByText("consolidação · Haiku")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Memória" }));
    const row = (await screen.findAllByTestId("memory-page-row")).find((r) => r.textContent?.includes("Aprendizados do run"))!;
    await user.click(row);
    expect(await screen.findByTestId("memory-page")).toHaveTextContent("consolidação com Haiku");
    const audit = await transport.invoke("list_audit_events", { projectId: "proj_demo", limit: 50 });
    expect(audit.some((e) => e.kind === "memory.consolidation.started")).toBe(true);
  });

  it("pins de contexto entram no brief; a aba Contexto mostra instruções e compactações do último run", async () => {
    const { user, transport } = setup(memoryEvents.map((n) => n.params as unknown as RunEventNotification));
    await screen.findByDisplayValue("chat-core");
    await user.click(screen.getByRole("button", { name: "Memória" }));
    await user.click(await screen.findByRole("tab", { name: /Contexto/ }));
    await user.type(screen.getByLabelText("Referência do pin"), "Prefira Java 21 e records.");
    await user.type(screen.getByLabelText("Rótulo do pin"), "Regra Java");
    await user.click(screen.getByRole("button", { name: "Adicionar pin" }));
    const row = await screen.findByTestId("pin-row");
    expect(row).toHaveAttribute("data-kind", "text");
    expect(row).toHaveTextContent("Regra Java");
    expect(screen.getByRole("tab", { name: /Contexto · 1 pin/ })).toBeInTheDocument();

    await user.click(within(screen.getByTestId("setting-sources")).getByRole("radio", { name: "Só o projeto" }));
    await waitFor(() => expect(screen.getByTestId("setting-sources")).toHaveAttribute("data-choice", "project"));
    expect((await transport.invoke("get_settings", {}))["project.proj_demo.settingSources"]).toEqual(["project", "local"]);

    await user.click(screen.getByRole("button", { name: "Run ao vivo" }));
    await user.type(screen.getByLabelText("Instrução para o agente"), "crie a V12");
    await user.click(screen.getByRole("button", { name: "Enviar" }));
    const chip = await screen.findByTestId("brief-chip");
    expect(chip).toHaveTextContent("pin: Regra Java");
    await waitFor(() => expect(screen.getByTestId("run-status")).toHaveTextContent("Concluído"), { timeout: 3000 });
    expect(screen.getByTestId("compaction-history")).toHaveTextContent("1 compactação neste run");
    expect(screen.getByTestId("compaction-history")).toHaveTextContent("automática · Contexto da task T-21");
    expect(screen.getByTestId("instructions-loaded")).toHaveTextContent("chat-core/CLAUDE.md · projeto");

    await user.click(screen.getByRole("button", { name: "Memória" }));
    await user.click(await screen.findByRole("tab", { name: /Contexto/ }));
    const events = await screen.findAllByTestId("context-event");
    expect(events.map((e) => e.getAttribute("data-kind"))).toEqual(expect.arrayContaining(["brief", "instructions", "compaction_pre", "compaction_post"]));
    await user.click(screen.getByRole("button", { name: "Remover pin Regra Java" }));
    await waitFor(() => expect(screen.queryByTestId("pin-row")).toBeNull());
  });
});

