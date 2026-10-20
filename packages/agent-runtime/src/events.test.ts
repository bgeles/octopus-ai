import { RunEventSchema } from "@octopus/protocol";
import { describe, expect, it } from "vitest";
import { mapSdkMessage, stringifyToolResult } from "./events.js";

describe("mapSdkMessage", () => {
  it("system/init vira session_init", () => {
    const events = mapSdkMessage({
      type: "system",
      subtype: "init",
      session_id: "s1",
      model: "claude-opus-5-5",
      tools: ["Read", "Bash"],
      mcp_servers: [{ name: "memoria", status: "connected" }],
      permissionMode: "default",
      skills: ["flyway-migration"],
    });
    expect(events).toEqual([
      {
        type: "session_init",
        sessionId: "s1",
        model: "claude-opus-5-5",
        tools: ["Read", "Bash"],
        mcpServers: [{ name: "memoria", status: "connected" }],
        permissionMode: "default",
        skills: ["flyway-migration"],
      },
    ]);
  });

  it("outros subtipos de system são ignorados", () => {
    expect(mapSdkMessage({ type: "system", subtype: "api_retry", session_id: "s1" })).toEqual([]);
  });

  it("assistant com texto, tool_use e usage gera três eventos", () => {
    const events = mapSdkMessage({
      type: "assistant",
      parent_tool_use_id: null,
      message: {
        id: "msg_1",
        content: [
          { type: "text", text: "Vou ler o arquivo." },
          { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "a.txt" } },
        ],
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: null },
      },
      modelUsage: { "claude-opus-5-5": { contextWindow: 1000000 } },
    });
    expect(events.map((e) => e.type)).toEqual(["assistant_text", "tool_use", "usage"]);
    expect(events[1]).toMatchObject({ toolUseId: "toolu_1", name: "Read", input: { file_path: "a.txt" }, parentToolUseId: null });
    expect(events[2]).toEqual({
      type: "usage",
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheCreationTokens: 0 },
      contextWindow: 1000000,
      messageId: "msg_1",
      parentToolUseId: null,
    });
  });

  it("mensagens de subagente carregam parent_tool_use_id e emitem usage só para o custo", () => {
    const events = mapSdkMessage({
      type: "assistant",
      parent_tool_use_id: "toolu_parent",
      message: { id: "msg_sub", content: [{ type: "text", text: "sub" }], usage: { input_tokens: 1, output_tokens: 1 } },
    });
    expect(events).toEqual([
      { type: "assistant_text", messageId: "msg_sub", text: "sub", parentToolUseId: "toolu_parent" },
      {
        type: "usage",
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
        contextWindow: null,
        messageId: "msg_sub",
        parentToolUseId: "toolu_parent",
      },
    ]);
  });

  it("user com tool_result vira tool_result com conteúdo achatado", () => {
    const events = mapSdkMessage({
      type: "user",
      parent_tool_use_id: null,
      message: {
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "linha 1" }, { type: "text", text: "linha 2" }], is_error: false },
        ],
      },
    });
    expect(events).toEqual([{ type: "tool_result", toolUseId: "toolu_1", content: "linha 1\nlinha 2", isError: false, parentToolUseId: null }]);
  });

  it("stream_event com text_delta vira assistant_text_delta", () => {
    const events = mapSdkMessage({
      type: "stream_event",
      parent_tool_use_id: null,
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "Olá" } },
    });
    expect(events).toEqual([{ type: "assistant_text_delta", text: "Olá", parentToolUseId: null }]);
  });

  it("stream_event de outro tipo é ignorado", () => {
    expect(mapSdkMessage({ type: "stream_event", event: { type: "message_start" } })).toEqual([]);
  });

  it("result de sucesso carrega custo, uso e texto", () => {
    const [event] = mapSdkMessage({
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: "s1",
      duration_ms: 1234.6,
      num_turns: 3,
      total_cost_usd: 0.05,
      usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10, cache_creation_input_tokens: 2 },
      stop_reason: "end_turn",
      result: "feito",
    });
    expect(event).toEqual({
      type: "result",
      sessionId: "s1",
      subtype: "success",
      isError: false,
      costUsd: 0.05,
      durationMs: 1235,
      numTurns: 3,
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheCreationTokens: 2 },
      stopReason: "end_turn",
      resultText: "feito",
    });
  });

  it("result com subtype error_* é marcado como erro", () => {
    const [event] = mapSdkMessage({ type: "result", subtype: "error_max_turns", session_id: "s1" });
    expect(event).toMatchObject({ type: "result", isError: true, costUsd: null, usage: null });
  });

  it("todo evento produzido valida contra o RunEventSchema", () => {
    const samples = [
      { type: "system", subtype: "init", session_id: "s", model: "m" },
      { type: "assistant", message: { content: [{ type: "text", text: "x" }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] } },
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "d" } } },
      { type: "result", subtype: "success", session_id: "s" },
    ];
    for (const sample of samples) {
      for (const event of mapSdkMessage(sample)) {
        expect(() => RunEventSchema.parse(event)).not.toThrow();
      }
    }
  });

  it("tipos desconhecidos retornam lista vazia", () => {
    expect(mapSdkMessage({ type: "tool_progress" })).toEqual([]);
  });
});

describe("stringifyToolResult", () => {
  it("lida com string, lista mista e objeto", () => {
    expect(stringifyToolResult("a")).toBe("a");
    expect(stringifyToolResult(["a", { type: "text", text: "b" }, { type: "image", data: "zz" }])).toBe('a\nb\n{"type":"image","data":"zz"}');
    expect(stringifyToolResult({ k: 1 })).toBe('{"k":1}');
    expect(stringifyToolResult(undefined)).toBe("");
  });
});
