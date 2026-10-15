/**
 * Tipos da ponte UI <-> core Rust. Espelham `src-tauri/src/store/models.rs` e os comandos em `commands.rs`.
 * Eventos de run vêm de `@octopus/protocol`.
 */
import type { HelloResult, PermissionDecision, RunEvent, RunEventNotification, RunOptions, SessionSummary } from "@octopus/protocol";

export type { HelloResult, PermissionDecision, RunEvent, RunEventNotification, RunOptions, SessionSummary };

export type AuthMode = "subscription" | "api_key";

export type Project = {
  id: string;
  name: string;
  path: string;
  authMode: AuthMode;
  createdAt: string;
};

export type RunStatus = "queued" | "running" | "waiting_approval" | "completed" | "failed" | "interrupted";

export type Run = {
  id: string;
  projectId: string;
  prompt: string;
  options: RunOptions;
  status: RunStatus;
  claudeSessionId: string | null;
  model: string | null;
  startedAt: string;
  endedAt: string | null;
  costUsd: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  numTurns: number | null;
  stopReason: string | null;
  resultText: string | null;
  errorMessage: string | null;
};

export type StoredRunEvent = {
  runId: string;
  seq: number;
  at: string;
  kind: string;
  event: RunEvent;
};

export type RuntimeLog = { level: "debug" | "info" | "warn" | "error"; message: string };

/** Assinaturas dos comandos Tauri (nome -> args -> resultado). */
export type Commands = {
  runtime_info: { args: Record<string, never>; result: HelloResult };
  list_projects: { args: Record<string, never>; result: Project[] };
  create_project: { args: { input: { name: string; path: string } }; result: Project };
  delete_project: { args: { projectId: string }; result: boolean };
  list_runs: { args: { projectId: string; limit?: number }; result: Run[] };
  get_run: { args: { runId: string }; result: Run | null };
  list_run_events: { args: { runId: string }; result: StoredRunEvent[] };
  start_run: { args: { input: { projectId: string; prompt: string; options?: RunOptions } }; result: Run };
  interrupt_run: { args: { runId: string }; result: boolean };
  decide_permission: { args: { input: { runId: string; requestId: string; decision: PermissionDecision } }; result: boolean };
  list_sessions: { args: { projectId: string }; result: SessionSummary[] };
};

export type CommandName = keyof Commands;

/** Eventos emitidos pelo core (nome -> payload). */
export type Events = {
  "run:event": RunEventNotification;
  "runtime:log": RuntimeLog;
  "runtime:exited": number | null;
};

export type EventName = keyof Events;
