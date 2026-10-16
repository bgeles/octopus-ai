import { describe, expect, it } from "vitest";
import { MAX_TOOL_BODY, eventFromMemoryHook, stringifyResponse, summarizeToolInput, truncate } from "./memoryHooks.js";

describe("hooks de memória", () => {
  it("PostToolUse vira observação com título do comando e corpo truncado", () => {
    const ev = eventFromMemoryHook({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "./mvnw -q test\n# comentário" }, tool_response: { stdout: "x".repeat(MAX_TOOL_BODY + 10), stderr: "" }, tool_use_id: "t1" });
    expect(ev).toMatchObject({ type: "observation", kind: "tool_use", title: "Bash ./mvnw -q test", toolName: "Bash", toolUseId: "t1", parentToolUseId: null });
    expect((ev as { body: string }).body).toContain("[truncado: 10 caracteres]");
  });

  it("leituras guardam só o título; MCP guarda o corpo", () => {
    const read = eventFromMemoryHook({ hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: "a.txt" }, tool_response: "conteúdo enorme" });
    expect(read).toMatchObject({ title: "Read a.txt", body: "" });
    const mcp = eventFromMemoryHook({ hook_event_name: "PostToolUse", tool_name: "mcp__octopus__task_update", tool_input: { status: "done", note: "ok" }, tool_response: [{ type: "text", text: "Task marcada" }] });
    expect(mcp).toMatchObject({ title: "mcp__octopus__task_update status=done note=ok", body: "Task marcada" });
  });

  it("Stop sem mensagem não gera nada; com mensagem vira turn_end", () => {
    expect(eventFromMemoryHook({ hook_event_name: "Stop", last_assistant_message: "  " })).toBeNull();
    expect(eventFromMemoryHook({ hook_event_name: "Stop", last_assistant_message: "Criei a V12." })).toMatchObject({ kind: "turn_end", title: "Fim do turno", body: "Criei a V12." });
  });

  it("SubagentStop, SessionEnd e compactações", () => {
    expect(eventFromMemoryHook({ hook_event_name: "SubagentStop", agent_id: "a1", agent_type: "testador", last_assistant_message: "IT verde", parent_tool_use_id: "tp" })).toMatchObject({ kind: "subagent_end", title: "Subagente testador", agentId: "a1", parentToolUseId: "tp" });
    expect(eventFromMemoryHook({ hook_event_name: "SessionEnd", reason: "other" })).toMatchObject({ kind: "session_end", body: "other" });
    expect(eventFromMemoryHook({ hook_event_name: "PreCompact", trigger: "auto" })).toEqual({ type: "compaction", phase: "pre", trigger: "auto", summary: null });
    expect(eventFromMemoryHook({ hook_event_name: "PostCompact", trigger: "manual", compact_summary: "resumo" })).toEqual({ type: "compaction", phase: "post", trigger: "manual", summary: "resumo" });
    expect(eventFromMemoryHook({ hook_event_name: "Notification" })).toBeNull();
    expect(eventFromMemoryHook({ hook_event_name: "InstructionsLoaded", file_path: "/p/CLAUDE.md", memory_type: "Project", load_reason: "session_start" })).toEqual({ type: "instructions_loaded", filePath: "/p/CLAUDE.md", memoryType: "Project", loadReason: "session_start" });
    expect(eventFromMemoryHook({ hook_event_name: "InstructionsLoaded" })).toBeNull();
  });

  it("helpers", () => {
    expect(truncate("abc", 5)).toBe("abc");
    expect(summarizeToolInput("X", { foo: 1, bar: "b" })).toBe("foo=1 bar=b");
    expect(summarizeToolInput("X", "texto")).toBe("texto");
    expect(stringifyResponse(null)).toBe("");
    expect(stringifyResponse({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] })).toBe("a\nb");
  });
});
