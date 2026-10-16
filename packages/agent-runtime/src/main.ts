#!/usr/bin/env node
/**
 * Entrada do sidecar: stdio NDJSON <-> RpcServer <-> RunManager (Claude Agent SDK).
 * stdout é exclusivo do protocolo; logs vão para stderr.
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { PROTOCOL_VERSION, type RunEvent } from "@octopus/protocol";
import { createSdkMcpServer, listSessions, query, renameSession, tagSession, tool } from "@anthropic-ai/claude-agent-sdk";
import { RpcServer } from "./rpc.js";
import { RunManager, type QueryFn } from "./runner.js";
import { toSessionSummary } from "./sessions.js";
import { createTaskToolsFactory } from "./taskTools.js";

const require = createRequire(import.meta.url);
const runtimeVersion: string = require("../package.json").version;
const sdkVersion: string = resolveSdkVersion();

/** O SDK não exporta `./package.json`; subimos a partir do arquivo de entrada até achar o manifesto. */
function resolveSdkVersion(): string {
  try {
    let dir = dirname(require.resolve("@anthropic-ai/claude-agent-sdk"));
    for (let depth = 0; depth < 6; depth++) {
      const candidate = join(dir, "package.json");
      if (existsSync(candidate)) {
        const pkg = JSON.parse(readFileSync(candidate, "utf8")) as { name?: string; version?: string };
        if (pkg.name === "@anthropic-ai/claude-agent-sdk" && pkg.version) return pkg.version;
      }
      dir = dirname(dir);
    }
  } catch {
    // cai no fallback abaixo
  }
  return "desconhecida";
}

const writeLine = (line: string) => {
  process.stdout.write(line + "\n");
};
const log = (level: "debug" | "info" | "warn" | "error", message: string) => {
  process.stderr.write(`[agent-runtime] ${level}: ${message}\n`);
  server.notify("runtime.log", { level, message });
};

const server = new RpcServer(writeLine);

const seqByRun = new Map<string, number>();
const emit = (runId: string, event: RunEvent) => {
  const seq = seqByRun.get(runId) ?? 0;
  seqByRun.set(runId, seq + 1);
  server.notify("run.event", { runId, seq, at: new Date().toISOString(), event });
  if (event.type === "result" || (event.type === "error" && event.fatal)) {
    seqByRun.delete(runId);
  }
};

// O cast isola o restante do sidecar dos tipos do SDK; a compatibilidade estrutural é coberta por testes.
const runs = new RunManager(query as unknown as QueryFn, emit, log, createTaskToolsFactory(createSdkMcpServer as never, tool as never), (hook) => server.notify("run.hook", hook));

server.register("runtime.hello", async () => ({ protocolVersion: PROTOCOL_VERSION, runtimeVersion, sdkVersion }));

server.register("run.start", async (params) => {
  runs.start(params);
  return { accepted: true } as const;
});

server.register("run.interrupt", async ({ runId }) => ({ interrupted: await runs.interrupt(runId) }));

server.register("permission.decide", async ({ runId, requestId, decision }) => ({
  applied: runs.decidePermission(runId, requestId, decision),
}));

server.register("hook.decide", async ({ runId, hookId, decision }) => ({
  applied: runs.decideHook(runId, hookId, decision),
}));

server.register("sessions.list", async ({ cwd }) => {
  const sessions = await listSessions({ dir: cwd });
  return { sessions: sessions.map((s) => toSessionSummary(s, cwd)) };
});

server.register("sessions.rename", async ({ sessionId, cwd, title }) => {
  await renameSession(sessionId, title, { dir: cwd });
  return { ok: true } as const;
});

server.register("sessions.tag", async ({ sessionId, cwd, tag }) => {
  await tagSession(sessionId, tag, { dir: cwd });
  return { ok: true } as const;
});

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
let processing: Promise<void> = Promise.resolve();
rl.on("line", (line) => {
  // Serializa o processamento para preservar a ordem das respostas.
  processing = processing.then(() => server.handleLine(line));
});
rl.on("close", async () => {
  log("info", "stdin fechado; encerrando runs ativos");
  await Promise.all(runs.activeRunIds.map((id) => runs.interrupt(id)));
  await runs.drain();
  process.exit(0);
});

process.on("uncaughtException", (error) => {
  log("error", `uncaughtException: ${error.stack ?? error.message}`);
});
process.on("unhandledRejection", (reason) => {
  log("error", `unhandledRejection: ${String(reason)}`);
});

log("info", `agent-runtime ${runtimeVersion} pronto (sdk ${sdkVersion}, protocolo ${PROTOCOL_VERSION})`);
