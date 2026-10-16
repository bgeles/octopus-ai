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
});
