import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  JsonRpcMessageSchema,
  NOTIFICATION_SCHEMAS,
  REQUEST_SCHEMAS,
  RunEventSchema,
  isNotification,
  isRequest,
  parseJsonRpcLine,
} from "./index.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(fixturesDir, name), "utf8"));
}

describe("fixtures do protocolo", () => {
  const files = readdirSync(fixturesDir).filter((f) => f.endsWith(".json"));

  it("existem fixtures para requests e notificações", () => {
    expect(files).toContain("run-start.request.json");
    expect(files).toContain("run-events.notifications.json");
  });

  for (const file of files.filter((f) => f.endsWith(".request.json"))) {
    it(`${file} é um request válido com params tipados`, () => {
      const message = JsonRpcMessageSchema.parse(loadFixture(file));
      expect(isRequest(message)).toBe(true);
      if (!isRequest(message)) return;
      const schema = REQUEST_SCHEMAS[message.method];
      expect(() => schema.params.parse(message.params)).not.toThrow();
    });
  }

  for (const file of files.filter((f) => f.endsWith(".notifications.json"))) {
    it(`${file} contém notificações válidas com params tipados`, () => {
      const list = loadFixture(file);
      expect(Array.isArray(list)).toBe(true);
      for (const raw of list as unknown[]) {
        const message = JsonRpcMessageSchema.parse(raw);
        expect(isNotification(message)).toBe(true);
        if (!isNotification(message)) continue;
        const schema = NOTIFICATION_SCHEMAS[message.method];
        expect(() => schema.parse(message.params)).not.toThrow();
      }
    });
  }
});

describe("RunEventSchema", () => {
  it("aplica defaults em campos opcionais", () => {
    const event = RunEventSchema.parse({ type: "assistant_text", text: "olá" });
    expect(event).toEqual({ type: "assistant_text", text: "olá", messageId: null, parentToolUseId: null });
  });

  it("rejeita tipo de evento desconhecido", () => {
    expect(() => RunEventSchema.parse({ type: "nope" })).toThrow();
  });
});

describe("parseJsonRpcLine", () => {
  it("rejeita método desconhecido", () => {
    expect(() => parseJsonRpcLine('{"jsonrpc":"2.0","id":1,"method":"x.y"}')).toThrow();
  });

  it("aceita resposta com result", () => {
    const message = parseJsonRpcLine('{"jsonrpc":"2.0","id":1,"result":{"accepted":true}}');
    expect(isRequest(message)).toBe(false);
    expect(isNotification(message)).toBe(false);
  });
});
