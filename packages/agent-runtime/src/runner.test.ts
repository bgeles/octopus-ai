import type { RunEvent } from "@octopus/protocol";
import { describe, expect, it } from "vitest";
import type { SdkMessageLike } from "./events.js";
import { RunManager, type HookCallbackLike, type QueryFn, type QueryOptionsLike } from "./runner.js";
import type { RunHookNotification, RunMemoryCallNotification } from "@octopus/protocol";
import type { MemoryCaller } from "./octopusTools.js";

type Captured = { runId: string; event: RunEvent };

function collector() {
  const events: Captured[] = [];
  return { events, emit: (runId: string, event: RunEvent) => events.push({ runId, event }) };
}

/** Fábrica de QueryFn fake que reproduz uma sequência de mensagens do SDK. */
function fakeQuery(messages: SdkMessageLike[], onOptions?: (o: QueryOptionsLike) => void): QueryFn {
  return ({ options }) => {
    onOptions?.(options);
    return {
      async *[Symbol.asyncIterator]() {
        for (const m of messages) {
          if (options.abortController.signal.aborted) throw new Error("aborted");
          yield m;
        }
      },
      interrupt: async () => {},
    };
  };
}

const baseParams = { runId: "r1", cwd: "/tmp/proj", prompt: "olá", options: {} };

describe("RunManager", () => {
  it("emite eventos mapeados e remove o run ao terminar", async () => {
    const { events, emit } = collector();
    const manager = new RunManager(
      fakeQuery([
        { type: "system", subtype: "init", session_id: "s1", model: "m" },
        { type: "assistant", message: { content: [{ type: "text", text: "oi" }] } },
        { type: "result", subtype: "success", session_id: "s1", total_cost_usd: 0.01 },
      ]),
      emit,
    );
    manager.start(baseParams);
    expect(manager.activeRunIds).toEqual(["r1"]);
    await manager.drain();
    expect(manager.activeRunIds).toEqual([]);
    expect(events.map((e) => e.event.type)).toEqual(["session_init", "assistant_text", "result"]);
    expect(events.every((e) => e.runId === "r1")).toBe(true);
  });

  it("traduz RunOptions em opções do SDK", async () => {
    let seen: QueryOptionsLike | undefined;
    const manager = new RunManager(fakeQuery([{ type: "result", subtype: "success", session_id: "s" }], (o) => (seen = o)), () => {});
    manager.start({
      ...baseParams,
      options: {
        model: "claude-opus-5-5",
        permissionMode: "acceptEdits",
        maxTurns: 7,
        maxBudgetUsd: 2.5,
        resumeSessionId: "s-old",
        forkSession: true,
        systemPromptAppend: "Fale em português.",
        allowedTools: ["Read"],
        disallowedTools: ["Bash"],
        mcpServers: { docs: { type: "stdio", command: "npx", args: ["-y", "srv"] } },
        plugins: [{ type: "local", path: "/tmp/plugin", skipMcpDiscovery: true }],
        settingSources: ["project"],
        env: { ANTHROPIC_API_KEY: "sk-test" },
        agents: { teo: { description: "Testador", prompt: "Você é Téo.", tools: ["Read"] } },
      },
    });
    await manager.drain();
    expect(seen).toMatchObject({
      cwd: "/tmp/proj",
      model: "claude-opus-5-5",
      permissionMode: "acceptEdits",
      maxTurns: 7,
      maxBudgetUsd: 2.5,
      resume: "s-old",
      forkSession: true,
      systemPrompt: { type: "preset", preset: "claude_code", append: "Fale em português." },
      allowedTools: ["Read"],
      disallowedTools: ["Bash"],
      mcpServers: { docs: { type: "stdio", command: "npx", args: ["-y", "srv"] } },
      plugins: [{ type: "local", path: "/tmp/plugin", skipMcpDiscovery: true }],
      settingSources: ["project"],
      includePartialMessages: true,
      agents: { teo: { description: "Testador", prompt: "Você é Téo.", tools: ["Read"] } },
    });
    expect(seen?.env?.ANTHROPIC_API_KEY).toBe("sk-test");
    expect(typeof seen?.canUseTool).toBe("function");
  });

  it("com taskContext, monta o MCP octopus, libera a tool e emite task_update", async () => {
    const { events, emit } = collector();
    let seen: QueryOptionsLike | undefined;
    let capturedUpdate: ((status: "done" | "review" | "blocked", note: string | null) => void) | undefined;
    const factory = (opts: { task?: { onUpdate: typeof capturedUpdate } }) => {
      capturedUpdate = opts.task?.onUpdate;
      return { fake: "server" };
    };
    const manager = new RunManager(fakeQuery([{ type: "result", subtype: "success", session_id: "s" }], (o) => (seen = o)), emit, () => {}, factory as never);
    manager.start({ ...baseParams, options: { allowedTools: ["Read"], taskContext: { taskId: "task_1", title: "T", stage: "Implementar", allowedStatuses: ["done", "review", "blocked"] } } });
    capturedUpdate!("review", "ok");
    await manager.drain();
    expect(seen?.mcpServers).toEqual({ octopus: { fake: "server" } });
    expect(seen?.allowedTools).toEqual(["Read", "mcp__octopus__task_update"]);
    expect(events.map((e) => e.event.type)).toEqual(["task_update", "result"]);
    expect(events[0]?.event).toMatchObject({ type: "task_update", taskId: "task_1", status: "review", note: "ok" });
  });

  it("com policyHooks, PreToolUse espera o core e traduz deny/ask/pass; o motivo do ask vai para o permission_request", async () => {
    const { events, emit } = collector();
    const hooks: RunHookNotification[] = [];
    let seen: QueryOptionsLike | undefined;
    let canUseTool: QueryOptionsLike["canUseTool"] | undefined;
    const gate = (() => {
      let release!: () => void;
      const promise = new Promise<void>((r) => (release = r));
      return { promise, release };
    })();
    const gated: QueryFn = ({ options }) => {
      seen = options;
      canUseTool = options.canUseTool;
      return {
        async *[Symbol.asyncIterator]() {
          await gate.promise;
          yield { type: "result", subtype: "success", session_id: "s" };
        },
      };
    };
    const manager = new RunManager(gated, emit, () => {}, null, (h) => hooks.push(h), 50);
    manager.start({ ...baseParams, options: { policyHooks: true, sandbox: { enabled: true } } });
    expect(seen?.sandbox).toEqual({ enabled: true });
    const hook = seen?.hooks?.PreToolUse?.[0]?.hooks[0] as HookCallbackLike;
    expect(typeof hook).toBe("function");
    const signal = new AbortController().signal;

    // deny
    const denyP = hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "rm -rf /tmp/x" }, tool_use_id: "t1" }, "t1", { signal });
    expect(hooks).toHaveLength(1);
    expect(hooks[0]).toMatchObject({ runId: "r1", event: "PreToolUse", toolName: "Bash", input: { command: "rm -rf /tmp/x" }, toolUseId: "t1" });
    manager.decideHook("r1", hooks[0]!.hookId, { behavior: "deny", reason: "fora do projeto" });
    expect(await denyP).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "fora do projeto" } });

    // pass → sem opinião
    const passP = hook({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "a" } }, undefined, { signal });
    manager.decideHook("r1", hooks[1]!.hookId, { behavior: "pass" });
    expect(await passP).toEqual({});

    // ask → o motivo aparece no permission_request seguinte da mesma ferramenta/input
    const askP = hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "curl x" } }, undefined, { signal });
    manager.decideHook("r1", hooks[2]!.hookId, { behavior: "ask", reason: "rede exige aprovação" });
    expect(await askP).toMatchObject({ hookSpecificOutput: { permissionDecision: "ask" } });
    const permission = canUseTool!("Bash", { command: "curl x" }, { signal });
    expect(events.at(-1)?.event).toMatchObject({ type: "permission_request", toolName: "Bash", reason: "rede exige aprovação" });
    const requestId = (events.at(-1)!.event as { requestId: string }).requestId;
    manager.decidePermission("r1", requestId, { behavior: "allow" });
    await permission;

    // timeout → ask
    const slowP = hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } }, undefined, { signal });
    expect(await slowP).toMatchObject({ hookSpecificOutput: { permissionDecision: "ask" } });

    // hook desconhecido
    expect(() => manager.decideHook("r1", "hook_999", { behavior: "allow" })).toThrow(/não encontrado/);
    gate.release();
    await manager.drain();
  });

  it("com memory.capture, registra os seis hooks de memória e emite observation/compaction sem bloquear", async () => {
    let seen: QueryOptionsLike | undefined;
    const emitted: RunEvent[] = [];
    const manager = new RunManager(
      fakeQuery([{ type: "result", subtype: "success", is_error: false, session_id: "s", total_cost_usd: 0, duration_ms: 1, num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 } }], (o) => {
        seen = o;
      }),
      (_runId, event) => emitted.push(event),
    );
    manager.start({ runId: "r1", cwd: "/p", prompt: "oi", options: { memory: { capture: true }, policyHooks: false } });
    await manager.drain();
    const hooks = seen?.hooks ?? {};
    expect(Object.keys(hooks).sort()).toEqual(["InstructionsLoaded", "PostCompact", "PostToolUse", "PreCompact", "SessionEnd", "Stop", "SubagentStop"]);
    const post = hooks.PostToolUse?.[0]?.hooks[0] as HookCallbackLike;
    const signal = new AbortController().signal;
    expect(await post({ hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: "a.sql" }, tool_response: "ok", tool_use_id: "t1" }, "t1", { signal })).toEqual({});
    await (hooks.PostCompact?.[0]?.hooks[0] as HookCallbackLike)({ hook_event_name: "PostCompact", tool_name: "", tool_input: null, trigger: "auto", compact_summary: "resumo" }, undefined, { signal });
    const observation = emitted.find((e) => e.type === "observation");
    expect(observation).toMatchObject({ type: "observation", kind: "tool_use", title: "Write a.sql", body: "ok", toolUseId: "t1" });
    expect(emitted.find((e) => e.type === "compaction")).toMatchObject({ phase: "post", summary: "resumo" });
  });

  it("com memory.brief, injeta additionalContext uma vez e emite brief_injected", async () => {
    let seen: QueryOptionsLike | undefined;
    const emitted: RunEvent[] = [];
    const manager = new RunManager(
      fakeQuery([{ type: "result", subtype: "success", is_error: false, session_id: "s", total_cost_usd: 0, duration_ms: 1, num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 } }], (o) => {
        seen = o;
      }),
      (_runId, event) => emitted.push(event),
    );
    manager.start({ runId: "r1", cwd: "/p", prompt: "oi", options: { memory: { capture: false, brief: "## Memória\nUse Flyway.", briefItems: ["Migrações em Flyway"] } } });
    const hook = seen?.hooks?.UserPromptSubmit?.[0]?.hooks[0] as HookCallbackLike;
    const signal = new AbortController().signal;
    const first = await hook({ hook_event_name: "UserPromptSubmit", tool_name: "", tool_input: null }, undefined, { signal });
    expect(first).toEqual({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "## Memória\nUse Flyway." } });
    expect(await hook({ hook_event_name: "UserPromptSubmit", tool_name: "", tool_input: null }, undefined, { signal })).toEqual({});
    await manager.drain();
    expect(emitted.filter((e) => e.type === "brief_injected")).toEqual([{ type: "brief_injected", chars: 22, items: ["Migrações em Flyway"] }]);
    expect(seen?.hooks?.PostToolUse).toBeUndefined();
  });

  it("com memory.tools, monta o MCP com as tools de memória e faz o round trip run.memory_call → memory.result (com timeout)", async () => {
    let seen: QueryOptionsLike | undefined;
    let caller: MemoryCaller | undefined;
    const calls: RunMemoryCallNotification[] = [];
    const factory = (opts: { memory?: { call: MemoryCaller } }) => {
      caller = opts.memory?.call;
      return { fake: "server" };
    };
    const gate = (() => {
      let release!: () => void;
      const promise = new Promise<void>((r) => (release = r));
      return { promise, release };
    })();
    const gated: QueryFn = ({ options }) => {
      seen = options;
      return {
        async *[Symbol.asyncIterator]() {
          await gate.promise;
          yield { type: "result", subtype: "success", session_id: "s" };
        },
      };
    };
    const manager = new RunManager(gated, () => {}, () => {}, factory as never, null, 50, (call) => calls.push(call));
    manager.start({ runId: "r1", cwd: "/p", prompt: "oi", options: { allowedTools: ["Read"], memory: { capture: false, tools: true } } });
    expect(seen?.mcpServers).toEqual({ octopus: { fake: "server" } });
    expect(seen?.allowedTools).toEqual(["Read", "mcp__octopus__memory_search", "mcp__octopus__memory_write", "mcp__octopus__memory_handoff"]);
    const pending = caller!("search", { query: "flyway" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ runId: "r1", op: "search", args: { query: "flyway" } });
    expect(manager.resolveMemoryCall("r1", calls[0]!.callId, { ok: true, content: "1 página" })).toBe(true);
    expect(await pending).toEqual({ ok: true, content: "1 página" });
    const slow = await caller!("write", { kind: "note", title: "t", body: "b" });
    expect(slow.ok).toBe(false);
    expect(slow.content).toContain("não respondeu a tempo");
    expect(() => manager.resolveMemoryCall("r1", "mem_999", { ok: true, content: "" })).toThrow(/não encontrada/);
    // Chamada pendente quando o run acaba recebe erro, não fica presa.
    const orphan = caller!("handoff", { body: "x" });
    gate.release();
    await manager.drain();
    expect((await orphan).content).toContain("Run encerrado");
  });

  it("sem memory, nenhum hook de memória é registrado", async () => {
    let seen: QueryOptionsLike | undefined;
    const manager = new RunManager(
      fakeQuery([{ type: "result", subtype: "success", is_error: false, session_id: "s", total_cost_usd: 0, duration_ms: 1, num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 } }], (o) => {
        seen = o;
      }),
      () => {},
    );
    manager.start({ runId: "r2", cwd: "/p", prompt: "oi", options: {} });
    await manager.drain();
    expect(seen?.hooks).toBeUndefined();
  });

  it("rejeita run duplicado", async () => {
    const manager = new RunManager(fakeQuery([{ type: "result", subtype: "success", session_id: "s" }]), () => {});
    manager.start(baseParams);
    expect(() => manager.start(baseParams)).toThrow(/já está ativo/);
    await manager.drain();
  });

  it("emite error fatal quando o stream termina sem result", async () => {
    const { events, emit } = collector();
    const manager = new RunManager(fakeQuery([{ type: "system", subtype: "init", session_id: "s1", model: "m" }]), emit);
    manager.start(baseParams);
    await manager.drain();
    expect(events.at(-1)?.event).toMatchObject({ type: "error", fatal: true });
  });

  it("emite error fatal quando o SDK lança", async () => {
    const { events, emit } = collector();
    const failing: QueryFn = () => ({
      async *[Symbol.asyncIterator]() {
        throw new Error("sem credencial");
      },
    });
    const manager = new RunManager(failing, emit);
    manager.start(baseParams);
    await manager.drain();
    expect(events).toEqual([{ runId: "r1", event: { type: "error", message: "sem credencial", fatal: true } }]);
  });

  it("encaminha pedido de permissão e aplica a decisão", async () => {
    const { events, emit } = collector();
    let canUseTool: QueryOptionsLike["canUseTool"] | undefined;
    const manager = new RunManager(
      fakeQuery([{ type: "result", subtype: "success", session_id: "s" }], (o) => (canUseTool = o.canUseTool)),
      emit,
    );
    // Query fake que segura o stream até a permissão ser decidida.
    const gate = (() => {
      let release!: () => void;
      const promise = new Promise<void>((r) => (release = r));
      return { promise, release };
    })();
    const gated: QueryFn = ({ options }) => {
      canUseTool = options.canUseTool;
      return {
        async *[Symbol.asyncIterator]() {
          await gate.promise;
          yield { type: "result", subtype: "success", session_id: "s" };
        },
      };
    };
    const gatedManager = new RunManager(gated, emit);
    gatedManager.start(baseParams);
    void manager;

    const decision = canUseTool!("Bash", { command: "ls" }, { signal: new AbortController().signal });
    const request = events.find((e) => e.event.type === "permission_request")!.event;
    expect(request).toMatchObject({ type: "permission_request", toolName: "Bash", input: { command: "ls" } });
    const requestId = (request as { requestId: string }).requestId;

    expect(gatedManager.decidePermission("r1", requestId, { behavior: "allow", updatedInput: { command: "ls -la" } })).toBe(true);
    await expect(decision).resolves.toEqual({ behavior: "allow", updatedInput: { command: "ls -la" } });

    expect(() => gatedManager.decidePermission("r1", requestId, { behavior: "deny", message: "x" })).toThrow(/não encontrado/);
    gate.release();
    await gatedManager.drain();
  });

  it("nega permissões pendentes quando o run é interrompido", async () => {
    const { emit } = collector();
    let canUseTool: QueryOptionsLike["canUseTool"] | undefined;
    const blocking: QueryFn = ({ options }) => {
      canUseTool = options.canUseTool;
      return {
        async *[Symbol.asyncIterator]() {
          await new Promise<void>((resolve) => options.abortController.signal.addEventListener("abort", () => resolve(), { once: true }));
          throw new Error("abortado");
        },
      };
    };
    const manager = new RunManager(blocking, emit);
    manager.start(baseParams);
    const decision = canUseTool!("Write", { file_path: "x" }, { signal: new AbortController().signal });
    expect(await manager.interrupt("r1")).toBe(true);
    await manager.drain();
    await expect(decision).resolves.toMatchObject({ behavior: "deny" });
    expect(await manager.interrupt("r1")).toBe(false);
  });

  it("decidePermission em run inexistente lança RunNotFound", () => {
    const manager = new RunManager(fakeQuery([]), () => {});
    expect(() => manager.decidePermission("nope", "p", { behavior: "deny", message: "x" })).toThrow(/não encontrado/);
  });
});
