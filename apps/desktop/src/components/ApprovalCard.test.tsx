import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApprovalCard, type ApprovalRequest } from "./ApprovalCard";

const base = { runId: "run_1", requestId: "perm_1", reason: null, at: "2026-10-16T13:00:00Z" };

function kinds() {
  return screen.getAllByTestId("diff-line").map((el) => `${el.dataset.kind}:${el.textContent?.replace(/^\s*\d*\s*\d*\s*[+−]?\s*/, "").trim()}`);
}

describe("ApprovalCard", () => {
  it("Edit mostra o diff entre old_string e new_string", () => {
    const request: ApprovalRequest = { ...base, toolName: "Edit", input: { file_path: "a.java", old_string: "x();\ny();", new_string: "x();\nz();" } };
    render(<ApprovalCard request={request} onDecide={() => {}} busy={false} />);
    expect(screen.getByTestId("diff-added")).toHaveTextContent("+1");
    expect(screen.getByTestId("diff-removed")).toHaveTextContent("−1");
    expect(kinds()).toEqual(["equal:x();", "removed:y();", "added:z();"]);
  });

  it("Write em arquivo existente compara com o conteúdo lido do projeto", async () => {
    const readFile = vi.fn(async (path: string) => ({ path, exists: true, content: "a\nb\n", truncated: false }));
    const request: ApprovalRequest = { ...base, toolName: "Write", input: { file_path: "notas.txt", content: "a\nc\n" } };
    render(<ApprovalCard request={request} onDecide={() => {}} busy={false} readFile={readFile} />);
    expect(screen.getByText(/Carregando o arquivo atual/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("write-kind")).toHaveTextContent("sobrescreve arquivo"));
    expect(readFile).toHaveBeenCalledWith("notas.txt");
    expect(kinds()).toEqual(["equal:a", "removed:b", "added:c"]);
  });

  it("Write em arquivo novo marca 'arquivo novo' e mostra tudo como adicionado", async () => {
    const readFile = vi.fn(async (path: string) => ({ path, exists: false, content: "", truncated: false }));
    const request: ApprovalRequest = { ...base, toolName: "Write", input: { file_path: "novo.sql", content: "CREATE INDEX i ON t (c);\n" } };
    render(<ApprovalCard request={request} onDecide={() => {}} busy={false} readFile={readFile} />);
    await waitFor(() => expect(screen.getByTestId("write-kind")).toHaveTextContent("arquivo novo"));
    expect(kinds()).toEqual(["added:CREATE INDEX i ON t (c);"]);
  });

  it("sem readFile, Write mostra só o conteúdo novo", () => {
    const request: ApprovalRequest = { ...base, toolName: "Write", input: { file_path: "novo.sql", content: "x\n" } };
    render(<ApprovalCard request={request} onDecide={() => {}} busy={false} />);
    expect(screen.queryByTestId("write-kind")).not.toBeInTheDocument();
    expect(kinds()).toEqual(["added:x"]);
  });

  it("permitir envia a nota como motivo e negar usa a nota como mensagem", async () => {
    const user = userEvent.setup();
    const onDecide = vi.fn();
    const request: ApprovalRequest = { ...base, toolName: "Bash", input: { command: "./mvnw test", description: "roda os testes" }, reason: "fora do somente leitura" };
    render(<ApprovalCard request={request} onDecide={onDecide} busy={false} />);
    const card = screen.getByTestId("approval-card");
    expect(within(card).getByTestId("preview-command")).toHaveTextContent("./mvnw test");
    expect(within(card).getByTestId("preview-command")).toHaveTextContent("# roda os testes");
    expect(within(card).getByText("fora do somente leitura")).toBeInTheDocument();

    await user.click(within(card).getByRole("button", { name: "Permitir uma vez" }));
    expect(onDecide).toHaveBeenLastCalledWith("run_1", "perm_1", { behavior: "allow" }, null);

    await user.type(within(card).getByLabelText("Motivo da decisão"), "  testes são esperados ");
    await user.click(within(card).getByRole("button", { name: "Permitir uma vez" }));
    expect(onDecide).toHaveBeenLastCalledWith("run_1", "perm_1", { behavior: "allow" }, "testes são esperados");

    await user.click(within(card).getByRole("button", { name: "Negar" }));
    expect(onDecide).toHaveBeenLastCalledWith("run_1", "perm_1", { behavior: "deny", message: "testes são esperados" }, "testes são esperados");
  });

  it("ferramentas sem preview dedicado mantêm a entrada completa disponível", () => {
    const request: ApprovalRequest = { ...base, toolName: "WebFetch", input: { url: "https://exemplo.com" } };
    render(<ApprovalCard request={request} onDecide={() => {}} busy={false} />);
    expect(screen.queryByTestId("diff")).not.toBeInTheDocument();
    expect(screen.getByText("https://exemplo.com", { selector: "code" })).toBeInTheDocument();
    expect(screen.getByText("Ver entrada completa")).toBeInTheDocument();
  });
});
