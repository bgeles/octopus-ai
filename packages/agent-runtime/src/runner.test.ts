import type { RunEvent } from "@octopus/protocol";
import { describe, expect, it } from "vitest";
import type { SdkMessageLike } from "./events.js";
import { RunManager, type QueryFn, type QueryOptionsLike } from "./runner.js";

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
        settingSources: ["project"],
        env: { ANTHROPIC_API_KEY: "sk-test" },
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
      settingSources: ["project"],
      includePartialMessages: true,
    });
    expect(seen?.env?.ANTHROPIC_API_KEY).toBe("sk-test");
    expect(typeof seen?.canUseTool).toBe("function");
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
