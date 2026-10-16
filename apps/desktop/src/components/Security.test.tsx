import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "../App";
import { createMockTransport } from "../lib/mockTransport";
import { summarize } from "./SecurityView";

function setup() {
  const transport = createMockTransport({ tickMs: 5 });
  const user = userEvent.setup();
  render(<App transport={transport} />);
  return { transport, user };
}

describe("Segurança · Auditoria", () => {
  it("lista os eventos encadeados de um run com aprovação e verifica a cadeia", async () => {
    const { user } = setup();
    await screen.findByDisplayValue("chat-core");
    await user.type(screen.getByLabelText("Instrução para o agente"), "rodar testes");
    await user.click(screen.getByRole("button", { name: "Enviar" }));
    const approval = await screen.findByTestId("approval-card");
    await user.type(within(approval).getByLabelText("Motivo da decisão"), "testes esperados");
    await user.click(within(approval).getByRole("button", { name: "Permitir uma vez" }));
    await waitFor(() => expect(screen.getByTestId("run-status")).toHaveTextContent("Concluído"), { timeout: 3000 });

    await user.click(screen.getByRole("button", { name: "Segurança" }));
    const view = await screen.findByTestId("security-view");
    await user.click(within(view).getByRole("tab", { name: /Auditoria/ }));
    await waitFor(() => expect(within(view).getByTestId("audit-integrity")).toHaveAttribute("data-ok", "true"));
    expect(within(view).getByTestId("audit-integrity")).toHaveTextContent(/Cadeia de hashes íntegra · \d+ eventos/);

    const rows = await within(view).findAllByTestId("audit-row");
    const kinds = rows.map((r) => r.getAttribute("data-kind"));
    expect(kinds[0]).toBe("run.finished"); // mais recente primeiro
    expect(kinds).toContain("run.started");
    expect(kinds).toContain("approval.allow");
    const allowRow = rows.find((r) => r.getAttribute("data-kind") === "approval.allow")!;
    expect(allowRow).toHaveTextContent("você · permitiu Bash · motivo: testes esperados");

    // Filtro por família.
    await user.click(within(view).getByRole("button", { name: "Aprovações" }));
    await waitFor(() => expect(within(view).getAllByTestId("audit-row").every((r) => r.getAttribute("data-kind")?.startsWith("approval."))).toBe(true));

    // Todas as abas da Fase 3 estão disponíveis.
    expect(within(view).getByRole("tab", { name: "Política" })).toBeEnabled();
    expect(within(view).getByRole("tab", { name: "Orçamentos" })).toBeEnabled();
  });

  it("alterar um evento fora do app quebra a verificação a partir dele", async () => {
    const { user, transport } = setup();
    await screen.findByDisplayValue("chat-core");
    await transport.invoke("set_setting", { key: "theme", value: "dark" });
    await transport.invoke("set_setting", { key: "theme", value: "light" });
    await transport.invoke("set_setting", { key: "theme", value: "dark" });
    transport.tamperAudit(2);

    await user.click(screen.getByRole("button", { name: "Segurança" }));
    await user.click(await screen.findByRole("tab", { name: /Auditoria/ }));
    const integrity = await screen.findByTestId("audit-integrity");
    await waitFor(() => expect(integrity).toHaveAttribute("data-ok", "false"));
    expect(integrity).toHaveTextContent("Cadeia de hashes quebrada no evento #2");
    expect(integrity).toHaveTextContent("1 evento íntegro antes dele");
    expect(screen.getByRole("tab", { name: /Auditoria · 3 eventos/ })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Exportar JSONL" }));
    expect(await screen.findByRole("status")).toHaveTextContent("3 eventos em JSONL");
  });

  it("resume eventos de forma legível", () => {
    const base = { seq: 1, ts: "t", actor: "você", projectId: null, prevHash: "", hash: "" };
    expect(summarize({ ...base, kind: "approval.deny", payload: { tool: "Bash", message: "sem rede" } })).toBe("negou Bash · sem rede");
    expect(summarize({ ...base, kind: "run.finished", payload: { runId: "run_abc123", status: "completed", costUsd: 0.5 } })).toBe("run abc123 completed · US$ 0,50");
    expect(summarize({ ...base, kind: "outro", payload: { a: 1, b: "x" } })).toBe("a=1 · b=x");
  });
});
