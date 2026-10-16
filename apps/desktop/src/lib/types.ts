/**
 * Tipos da ponte UI <-> core Rust. Espelham `src-tauri/src/store/models.rs` e os comandos em `commands.rs`.
 * Eventos de run vêm de `@octopus/protocol`.
 */
import type { AgentDefinition, HelloResult, PermissionDecision, PermissionMode, RunEvent, RunEventNotification, RunOptions, SessionSummary } from "@octopus/protocol";

export type { AgentDefinition, HelloResult, PermissionDecision, PermissionMode, RunEvent, RunEventNotification, RunOptions, SessionSummary };

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
  /** Membro do time que executou o run (null = run avulso). */
  agentProfileId: string | null;
};

// ---------------------------------------------------------------------------
// Time (Fase 2b): cargos, perfis e membros. Espelham `store::team`.
// ---------------------------------------------------------------------------

export type RoleScope = "global" | "project";

export type Role = {
  id: string;
  scope: RoleScope;
  projectId: string | null;
  title: string;
  specialty: string;
  responsibilitiesMd: string;
  defaultModel: string | null;
  defaultPermissionMode: PermissionMode | null;
  defaultTools: string[] | null;
  icon: string | null;
  position: number;
  createdAt: string;
  updatedAt: string;
};

export type RoleInput = {
  title: string;
  specialty?: string;
  responsibilitiesMd?: string;
  defaultModel?: string | null;
  defaultPermissionMode?: PermissionMode | null;
  defaultTools?: string[] | null;
  icon?: string | null;
};

export type AgentProfile = {
  id: string;
  projectId: string | null;
  roleId: string;
  name: string;
  avatarSeed: string;
  instructionsMd: string | null;
  model: string | null;
  permissionMode: PermissionMode | null;
  allowedTools: string[] | null;
  maxTurns: number | null;
  maxBudgetUsd: number | null;
  createdAt: string;
};

export type TeamMember = {
  id: string;
  projectId: string;
  profile: AgentProfile;
  role: Role;
  /** null = reporta ao gestor (você). */
  reportsToAgentId: string | null;
  position: number;
  createdAt: string;
};

export type TeamMemberInput = {
  name: string;
  roleId: string;
  reportsToAgentId?: string | null;
  instructionsMd?: string | null;
  model?: string | null;
  permissionMode?: PermissionMode | null;
  allowedTools?: string[] | null;
  maxTurns?: number | null;
  maxBudgetUsd?: number | null;
};

export type AgentTotals = {
  agentProfileId: string;
  runs: number;
  activeRuns: number;
  costUsd: number;
  lastRunAt: string | null;
};

export type StoredRunEvent = {
  runId: string;
  seq: number;
  at: string;
  kind: string;
  event: RunEvent;
};

/** Sessão escolhida para o próximo run: retomar (mesma sessão) ou bifurcar (sessão nova a partir dela). */
export type ResumeTarget = {
  sessionId: string;
  title: string | null;
  fork: boolean;
};

export type ApprovalDecisionKind = "allow" | "deny";

/** Espelha `store::models::Approval`. */
export type Approval = {
  id: string;
  runId: string;
  projectId: string;
  runPrompt: string;
  requestId: string;
  toolName: string;
  toolInput: unknown;
  reason: string | null;
  decision: ApprovalDecisionKind | null;
  decisionMessage: string | null;
  requestedAt: string;
  decidedAt: string | null;
};

/** Espelha `store::models::ProjectTotals`: custo e tokens acumulados de todos os runs do projeto. */
export type ProjectTotals = {
  projectId: string;
  runs: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
};

/** Preferências do app (`app_setting`), chave -> valor JSON. */
export type AppSettings = Record<string, unknown>;

export type CheckItem = { ok: boolean; detail: string };

/** Espelha `commands_config::EnvironmentCheck`. */
export type EnvironmentCheck = {
  node: CheckItem;
  sidecar: CheckItem;
  claudeAuth: CheckItem;
  authMethod: "keychain" | "api_key" | "credentials_file" | null;
  checkedAt: string;
};

/** Espelha `store::config::ConfigExport` (só configurações; nunca runs, eventos ou chaves). */
export type ConfigExport = {
  schemaVersion: number;
  exportedAt: string;
  appVersion: string;
  settings: AppSettings;
  projects: Project[];
};

export type ImportMode = "merge" | "replace";

export type ImportPreview = {
  schemaVersion: number;
  exportedAt: string;
  projectsNew: string[];
  projectsSame: string[];
  projectsConflict: string[];
  projectsRemoved: string[];
  settings: number;
};

export type ImportResult = { projectsAdded: number; projectsUpdated: number; projectsRemoved: number; settingsApplied: number };

export type SnapshotReason = "auto" | "manual" | "pre-restore";

export type BackupSnapshot = {
  id: string;
  createdAt: string;
  path: string;
  schemaVersion: number;
  reason: SnapshotReason;
  sizeBytes: number;
};

export type ExportOutcome = { snapshot: BackupSnapshot; copiedTo: string | null };

/** Espelha `commands::FilePreview`. */
export type FilePreview = {
  path: string;
  exists: boolean;
  content: string;
  truncated: boolean;
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
  start_run: { args: { input: { projectId: string; prompt: string; options?: RunOptions; agentProfileId?: string | null } }; result: Run };
  interrupt_run: { args: { runId: string }; result: boolean };
  decide_permission: { args: { input: { runId: string; requestId: string; decision: PermissionDecision; note?: string | null } }; result: boolean };
  list_sessions: { args: { projectId: string }; result: SessionSummary[] };
  rename_session: { args: { input: { projectId: string; sessionId: string; title: string } }; result: boolean };
  tag_session: { args: { input: { projectId: string; sessionId: string; tag: string | null } }; result: boolean };
  list_approvals: { args: { projectId: string; limit?: number }; result: Approval[] };
  get_project_totals: { args: { projectId: string }; result: ProjectTotals };
  get_settings: { args: Record<string, never>; result: AppSettings };
  set_setting: { args: { key: string; value: unknown }; result: null };
  check_environment: { args: Record<string, never>; result: EnvironmentCheck };
  config_export: { args: { destination?: string | null }; result: ExportOutcome };
  config_export_json: { args: Record<string, never>; result: ConfigExport };
  config_import_preview: { args: { path: string }; result: ImportPreview };
  config_import: { args: { input: { path: string; mode: ImportMode } }; result: ImportResult };
  config_backups_list: { args: Record<string, never>; result: BackupSnapshot[] };
  config_backup_preview: { args: { id: string }; result: ImportPreview };
  config_backup_restore: { args: { input: { id: string; mode: ImportMode } }; result: ImportResult };
  config_backup_reveal: { args: { id: string }; result: null };
  list_roles: { args: { projectId?: string | null }; result: Role[] };
  create_role: { args: { input: { projectId?: string | null; input: RoleInput } }; result: Role };
  update_role: { args: { roleId: string; input: RoleInput }; result: Role };
  delete_role: { args: { roleId: string }; result: boolean };
  list_team: { args: { projectId: string }; result: TeamMember[] };
  add_team_member: { args: { projectId: string; input: TeamMemberInput }; result: TeamMember };
  update_team_member: { args: { agentProfileId: string; input: TeamMemberInput }; result: TeamMember };
  remove_team_member: { args: { agentProfileId: string }; result: boolean };
  team_totals: { args: { projectId: string }; result: AgentTotals[] };
  read_project_file: { args: { projectId: string; path: string; maxBytes?: number }; result: FilePreview };
};

export type CommandName = keyof Commands;

/** Eventos emitidos pelo core (nome -> payload). */
export type Events = {
  "run:event": RunEventNotification;
  "runtime:log": RuntimeLog;
  "runtime:exited": number | null;
};

export type EventName = keyof Events;
