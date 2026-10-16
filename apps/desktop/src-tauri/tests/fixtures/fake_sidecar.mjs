#!/usr/bin/env node
// Sidecar falso para os testes de integração do supervisor Rust.
// Implementa runtime.hello, run.start (reproduz as fixtures compartilhadas) e run.interrupt (sempre erro).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "../../../../../packages/protocol/fixtures/run-events.notifications.json");
const events = JSON.parse(readFileSync(fixtures, "utf8"));

const write = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

write({ jsonrpc: "2.0", method: "runtime.log", params: { level: "info", message: "fake pronto" } });

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const req = JSON.parse(line);
  switch (req.method) {
    case "runtime.hello":
      write({ jsonrpc: "2.0", id: req.id, result: { protocolVersion: 1, runtimeVersion: "fake", sdkVersion: "0.0.0" } });
      break;
    case "run.start": {
      write({ jsonrpc: "2.0", id: req.id, result: { accepted: true } });
      let seq = 0;
      for (const n of events) {
        const params = { ...n.params, runId: req.params.runId, seq: seq++ };
        setTimeout(() => write({ jsonrpc: "2.0", method: "run.event", params }), 5 * seq);
      }
      break;
    }
    case "run.interrupt":
      write({ jsonrpc: "2.0", id: req.id, error: { code: -32001, message: `Run ${req.params.runId} não encontrado` } });
      break;
    case "sessions.list":
      write({
        jsonrpc: "2.0",
        id: req.id,
        result: {
          sessions: [
            {
              sessionId: "5b3f2c1a-8d4e-4f6b-9a7c-2e1d0f9b8a6c",
              cwd: req.params.cwd,
              title: "Sessão falsa",
              tags: ["teste"],
              createdAt: "2026-10-15T17:00:00.000Z",
              lastUsedAt: "2026-10-15T17:02:21.500Z",
            },
          ],
        },
      });
      break;
    case "sessions.rename":
    case "sessions.tag":
      write({ jsonrpc: "2.0", id: req.id, result: { ok: true } });
      break;
    default:
      write({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: "Método desconhecido" } });
  }
});
rl.on("close", () => process.exit(0));
