import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { summarizeInput } from "./ApprovalCard";
import { Transcript } from "./Transcript";
import { formatDuration, formatTokens, formatUsd } from "./RunSidebar";

describe("Transcript", () => {
  it("expande uma chamada de ferramenta para mostrar entrada e resultado", async () => {
    const user = userEvent.setup();
    render(
      <Transcript
        runId="r1"
        items={[
          { kind: "tool", id: "t", toolUseId: "t", name: "Read", input: { file_path: "a.txt" }, result: "conteúdo", isError: false, parentToolUseId: null, at: "2026-10-15T17:00:00Z" },
        ]}
        pendingPermissions={[]}
        onDecide={() => {}}
      />,
    );
    const toggle = screen.getByRole("button", { expanded: false });
    expect(toggle).toHaveTextContent("Read");
    expect(toggle).toHaveTextContent("a.txt");
    await user.click(toggle);
    expect(screen.getByText("Resultado")).toBeInTheDocument();
    expect(screen.getByText("conteúdo")).toBeInTheDocument();
  });

  it("chama onDecide com deny e o motivo digitado", async () => {
    const user = userEvent.setup();
    const onDecide = vi.fn();
    render(
      <Transcript runId="r1" items={[]} pendingPermissions={[{ requestId: "p1", toolName: "Bash", input: { command: "rm -rf x" }, reason: "destrutivo", at: "t" }]} onDecide={onDecide} />,
    );
    expect(screen.getByTestId("preview-command")).toHaveTextContent("rm -rf x");
    await user.type(screen.getByLabelText("Motivo da decisão"), "não");
    await user.click(screen.getByRole("button", { name: "Negar" }));
    expect(onDecide).toHaveBeenCalledWith("r1", "p1", { behavior: "deny", message: "não" }, "não");
    await user.click(screen.getByRole("button", { name: "Permitir uma vez" }));
    expect(onDecide).toHaveBeenCalledWith("r1", "p1", { behavior: "allow" }, "não");
  });
});

describe("helpers de formatação", () => {
  it("summarizeInput prefere campos conhecidos", () => {
    expect(summarizeInput("Bash", { command: "ls", description: "x" })).toBe("ls");
    expect(summarizeInput("Read", { file_path: "a" })).toBe("a");
    expect(summarizeInput("X", { foo: 1 })).toBe("foo=1");
    expect(summarizeInput("X", {})).toBe("X");
    expect(summarizeInput("X", "texto")).toBe("texto");
  });

  it("formata tokens, dinheiro e duração", () => {
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(88_000)).toBe("88k");
    expect(formatTokens(1_000_000)).toBe("1M");
    expect(formatTokens(1_500_000)).toBe("1.5M");
    expect(formatUsd(1.5)).toBe("US$ 1,50");
    expect(formatDuration(252_000)).toBe("04:12");
  });
});
