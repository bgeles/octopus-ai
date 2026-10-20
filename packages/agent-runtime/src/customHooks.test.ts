import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CustomHook } from "@octopus/protocol";
import { describe, expect, it } from "vitest";
import { interpretHookRun, runCustomHook, sanitizeOutput, type HookProcessResult } from "./customHooks.js";

const hook = (over: Partial<CustomHook> = {}): CustomHook => ({ id: "hook_1", name: "Guarda", event: "PreToolUse", command: "true", timeoutSec: 5, ...over });
const raw = (over: Partial<HookProcessResult> = {}): HookProcessResult => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 12, ...over });

describe("interpretHookRun", () => {
  it("saída 2 num PreToolUse nega com o stderr como motivo", () => {
    const r = interpretHookRun(hook(), raw({ exitCode: 2, stderr: "Migrações só em db/migration\n" }));
    expect(r.outcome).toBe("blocked");
    expect(r.message).toBe("Migrações só em db/migration");
    expect(r.output).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "Migrações só em db/migration" } });
  });

  it("saída 2 num Stop vira decision block; num evento que não bloqueia é só erro", () => {
    expect(interpretHookRun(hook({ event: "Stop" }), raw({ exitCode: 2, stderr: "faltou teste" })).output).toEqual({ decision: "block", reason: "faltou teste" });
    const n = interpretHookRun(hook({ event: "Notification" }), raw({ exitCode: 2, stderr: "x" }));
    expect(n.outcome).toBe("error");
    expect(n.output).toEqual({});
  });

  it("outra saída e tempo esgotado não bloqueiam", () => {
    expect(interpretHookRun(hook(), raw({ exitCode: 1, stderr: "comando não encontrado" }))).toMatchObject({ outcome: "error", message: "Saída 1: comando não encontrado", output: {} });
    expect(interpretHookRun(hook(), raw({ exitCode: null, timedOut: true }))).toMatchObject({ outcome: "timeout", output: {} });
  });

  it("JSON no stdout: allow e updatedInput são descartados; ask passa", () => {
    const allow = interpretHookRun(hook(), raw({ stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { command: "rm -rf /" } } }) }));
    expect(allow).toMatchObject({ outcome: "ok", output: {} });
    const ask = interpretHookRun(hook(), raw({ stdout: JSON.stringify({ hookSpecificOutput: { permissionDecision: "ask", permissionDecisionReason: "rede" } }) }));
    expect(ask.outcome).toBe("ok");
    expect(ask.message).toBe("Pediu aprovação: rede");
    expect(ask.output).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: "rede" } });
    expect(interpretHookRun(hook(), raw({ stdout: "{quebrado" })).outcome).toBe("error");
  });

  it("texto no stdout de UserPromptSubmit vira contexto; em PreToolUse é ignorado", () => {
    expect(interpretHookRun(hook({ event: "UserPromptSubmit" }), raw({ stdout: "branch atual: main\n" })).output).toEqual({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "branch atual: main" } });
    expect(interpretHookRun(hook(), raw({ stdout: "oi" })).output).toEqual({});
  });

  it("sanitizeOutput mantém continue:false e systemMessage", () => {
    expect(sanitizeOutput("PostToolUse", { continue: false, stopReason: "chega", systemMessage: "ok", suppressOutput: true, decision: "approve" })).toEqual({ continue: false, stopReason: "chega", systemMessage: "ok" });
  });
});

describe("runCustomHook com /bin/sh", () => {
  const cwd = mkdtempSync(join(tmpdir(), "octopus-hook-"));

  it("passa o JSON do evento no stdin e roda na pasta do projeto", async () => {
    const r = await runCustomHook(
      hook({ command: `read input; case "$input" in *'"tool_name":"Bash"'*) echo "nada de Bash em $(basename "$PWD")" >&2; exit 2;; esac` }),
      { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } },
      cwd,
    );
    expect(r.outcome).toBe("blocked");
    expect(r.message).toMatch(/^nada de Bash em octopus-hook-/);
    expect(r.exitCode).toBe(2);
  });

  it("expõe CLAUDE_PROJECT_DIR e variáveis extras, e não deixa o comando passar do tempo", async () => {
    const ok = await runCustomHook(hook({ event: "SessionStart", command: 'printf "%s %s" "$CLAUDE_PROJECT_DIR" "$OCTOPUS_RUN_ID"' }), {}, cwd, undefined, { OCTOPUS_RUN_ID: "run_7" });
    expect(ok.output).toEqual({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: `${cwd} run_7` } });
    const slow = await runCustomHook(hook({ command: "sleep 5", timeoutSec: 1 }), {}, cwd);
    expect(slow.outcome).toBe("timeout");
    expect(slow.durationMs).toBeLessThan(4000);
  });
});
