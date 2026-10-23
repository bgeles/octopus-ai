/**
 * Tipos da ponte UI <-> core Rust. Espelham `src-tauri/src/store/models.rs` e os comandos em `commands.rs`.
 * Eventos de run vêm de `@octopus/protocol`.
 */
import type { AgentDefinition, CustomHookEvent, EffortLevel, HelloResult, HookOutcome, HookRunResult, McpCheckResult, McpServerConfig, McpToolInfo, PermissionDecision, PermissionMode, RunEvent, RunEventNotification, RunOptions, SandboxSettings, SessionSummary, TaskContext, TaskStatusUpdate } from "@octopus/protocol";

export type { AgentDefinition, CustomHookEvent, EffortLevel, HelloResult, HookOutcome, HookRunResult, McpCheckResult, McpServerConfig, McpToolInfo, PermissionDecision, PermissionMode, RunEvent, RunEventNotification, RunOptions, SandboxSettings, SessionSummary, TaskContext, TaskStatusUpdate };

export type AuthMode = "subscription" | "api_key";

export type Project = {
  id: string;
  name: string;
  path: string;
  authMode: AuthMode;
  createdAt: string;
  /** Perfil de sandbox do projeto (padrão sandbox_dev). */
  sandboxProfileId?: string | null;
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
  /** Task do board que o run executa (null = run avulso). */
  taskId: string | null;
  /** `agent` (pedido do usuário ou do scheduler) ou `consolidation` (memória com Haiku). */
  kind: RunKind;
  /** Custo estimado pelos tokens de cada resposta (vale enquanto `costUsd` não chega). */
  estCostUsd?: number;
  /** `budget` quando o Octopus interrompeu o run por orçamento esgotado. */
  stopCause?: "budget" | null;
};

export type RunKind = "agent" | "consolidation";
export type ConsolidationMode = "raw" | "haiku";
export const CONSOLIDATION_SETTING = "memory.consolidation";
export const CONSOLIDATION_MODEL = "claude-haiku-5-5";

// ---------------------------------------------------------------------------
// Orquestração (Fase 2c): workflows, tasks e scheduler. Espelham `store::orchestration`.
// ---------------------------------------------------------------------------

export type Stage = {
  id: string;
  name: string;
  agentProfileId: string | null;
  gate: boolean;
  instruction: string | null;
};

export type Workflow = {
  id: string;
  projectId: string;
  name: string;
  stages: Stage[];
  useWorktrees: boolean;
  maxParallel: number;
  createdAt: string;
};

export type WorkflowInput = { name: string; stages: Stage[]; useWorktrees?: boolean; maxParallel?: number };

export type WorkflowTemplate = { id: string; name: string; stages: { name: string; roleTitle: string | null; gate: boolean }[] };

export type TaskStatus = "backlog" | "ready" | "running" | "waiting_approval" | "review" | "done" | "blocked" | "failed";

export type Task = {
  id: string;
  projectId: string;
  workflowId: string;
  stageId: string;
  title: string;
  descriptionMd: string;
  acceptanceMd: string;
  status: TaskStatus;
  assignedAgentId: string | null;
  dependsOn: string[];
  worktreePath: string | null;
  lockRunId: string | null;
  lastNote: string | null;
  position: number;
  createdAt: string;
  updatedAt: string;
  /** Entrega: resumo em markdown deixado pelo agente (task_update.result) ou o texto final do run. */
  resultMd: string | null;
  /** Arquivos tocados (Write/Edit…) no run que entregou. */
  filesChanged: string[];
  resultRunId: string | null;
  /** Commit em que o trabalho começou; base do diff. */
  baseCommit: string | null;
};

export type FileDiff = { path: string; status: "added" | "modified" | "deleted" | "renamed"; before: string; after: string; truncated: boolean };

export type TaskDiff = {
  available: boolean;
  reason: string | null;
  base: string | null;
  /** `worktree` (branch da task) ou `project` (pasta do projeto; pode incluir mudanças de fora). */
  scope: "worktree" | "project";
  files: FileDiff[];
};

export type TaskInput = {
  title: string;
  descriptionMd?: string;
  acceptanceMd?: string;
  stageId?: string | null;
  assignedAgentId?: string | null;
  dependsOn?: string[];
  ready?: boolean;
};

export type TaskEvent = {
  id: string;
  taskId: string;
  at: string;
  kind: string;
  fromStage: string | null;
  toStage: string | null;
  runId: string | null;
  actor: string;
  note: string | null;
};

// ---------------------------------------------------------------------------
// Segurança (Fase 3). Espelham `store::audit`.
// ---------------------------------------------------------------------------

export type AuditEvent = {
  seq: number;
  ts: string;
  actor: string;
  kind: string;
  projectId: string | null;
  payload: unknown;
  prevHash: string;
  hash: string;
};

export type SandboxProfile = { id: string; name: string; description: string; builtin: boolean; settings: SandboxSettings; position: number };

export type BudgetScope = "project" | "agent";
export type BudgetPolicy = { id: string; scope: BudgetScope; scopeId: string; softUsd: number | null; hardUsd: number | null; maxTurns: number | null; createdAt: string; updatedAt: string };
export type BudgetInput = { softUsd?: number | null; hardUsd?: number | null; maxTurns?: number | null };
export type BudgetLine = { scope: BudgetScope; scopeId: string; label: string; spentUsd: number; softUsd: number | null; hardUsd: number | null; maxTurns: number | null; runs: number; liveUsd?: number; level: "ok" | "soft" | "hard" };
export type BudgetStatus = { month: string; project: BudgetLine; agents: BudgetLine[] };

export type RuleKind = "command" | "write" | "tool" | "mcp";
export type RuleAction = "allow" | "deny" | "ask";

export type PolicyRule = {
  id: string;
  scope: "global" | "project";
  projectId: string | null;
  kind: RuleKind;
  pattern: string;
  action: RuleAction;
  reason: string;
  enabled: boolean;
  builtin: boolean;
  position: number;
  createdAt: string;
  updatedAt: string;
};

export type PolicyRuleInput = { kind: RuleKind; pattern: string; action: RuleAction; reason?: string; enabled?: boolean };

export type PolicyDecision = { behavior: "allow" | "deny" | "ask" | "pass"; reason: string | null; ruleId: string | null };

export type AuditVerification = {
  ok: boolean;
  events: number;
  firstBrokenSeq: number | null;
  intactBefore: number;
  checkedAt: string;
};

export type TickReport = {
  started: { taskId: string; runId: string; projectId: string }[];
  failed: [string, string][];
  parked: number;
  paused: boolean;
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
  /** Esforço padrão do membro (null = do projeto, senão do modelo). */
  effort?: EffortLevel | null;
  createdAt: string;
  /** MCP servers escolhidos (null = todos os ativos do escopo). */
  mcpServerIds?: string[] | null;
  /** Skills escolhidas (null = todas as ativas). */
  skillIds?: string[] | null;
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
  effort?: EffortLevel | null;
  mcpServerIds?: string[] | null;
  skillIds?: string[] | null;
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
  mcpServers?: McpServer[];
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
  list_workflow_templates: { args: Record<string, never>; result: WorkflowTemplate[] };
  list_workflows: { args: { projectId: string }; result: Workflow[] };
  create_workflow: { args: { projectId: string; input: WorkflowInput }; result: Workflow };
  create_workflow_from_template: { args: { input: { projectId: string; templateId: string; useWorktrees?: boolean } }; result: Workflow };
  update_workflow: { args: { workflowId: string; input: WorkflowInput }; result: Workflow };
  delete_workflow: { args: { workflowId: string }; result: boolean };
  list_tasks: { args: { projectId: string }; result: Task[] };
  create_task: { args: { projectId: string; workflowId: string; input: TaskInput }; result: Task };
  update_task: { args: { taskId: string; input: TaskInput }; result: Task };
  delete_task: { args: { taskId: string }; result: boolean };
  move_task: { args: { input: { taskId: string; stageId?: string | null; status: TaskStatus; note?: string | null } }; result: Task };
  approve_task: { args: { taskId: string; note?: string | null }; result: Task };
  return_task: { args: { taskId: string; stageId: string; note?: string | null }; result: Task };
  list_task_events: { args: { taskId: string }; result: TaskEvent[] };
  task_diff: { args: { taskId: string }; result: TaskDiff };
  scheduler_tick: { args: Record<string, never>; result: TickReport };
  list_audit_events: { args: { projectId?: string | null; kindPrefix?: string | null; limit?: number }; result: AuditEvent[] };
  verify_audit: { args: Record<string, never>; result: AuditVerification };
  export_audit: { args: { destination?: string | null }; result: string };
  list_policy_rules: { args: { projectId?: string | null }; result: PolicyRule[] };
  create_policy_rule: { args: { input: { projectId?: string | null; input: PolicyRuleInput } }; result: PolicyRule };
  update_policy_rule: { args: { ruleId: string; input: PolicyRuleInput }; result: PolicyRule };
  set_policy_rule_enabled: { args: { ruleId: string; enabled: boolean }; result: PolicyRule };
  delete_policy_rule: { args: { ruleId: string }; result: boolean };
  evaluate_policy: { args: { projectId: string; toolName: string; input: unknown }; result: PolicyDecision };
  list_sandbox_profiles: { args: Record<string, never>; result: SandboxProfile[] };
  set_project_sandbox: { args: { projectId: string; profileId: string }; result: Project };
  get_budget_status: { args: { projectId: string }; result: BudgetStatus };
  set_budget_policy: { args: { input: { scope: BudgetScope; scopeId: string; input: BudgetInput } }; result: BudgetPolicy | null };
  /** Modo de autenticação do projeto (a chave em si fica no Keychain). */
  update_project_auth: { args: { projectId: string; authMode: AuthMode }; result: Project };
  /** Guarda a API key no Keychain; a auditoria registra só que houve troca. */
  set_project_api_key: { args: { projectId: string; apiKey: string }; result: null };
  clear_project_api_key: { args: { projectId: string }; result: null };
  has_project_api_key: { args: { projectId: string }; result: boolean };
  read_project_file: { args: { projectId: string; path: string; maxBytes?: number }; result: FilePreview };
  // Memória (Fase 4)
  list_memory_pages: { args: { projectId: string; includeArchived?: boolean }; result: MemoryPage[] };
  /** Conta o acesso (sobe o score de recall). */
  get_memory_page: { args: { pageId: string }; result: MemoryPage | null };
  search_memory: { args: { projectId: string; query: string; limit?: number }; result: MemorySearchHit[] };
  save_memory_page: { args: { input: MemoryPageInput }; result: MemoryPage };
  set_memory_page_archived: { args: { pageId: string; archived: boolean }; result: MemoryPage };
  list_memory_page_versions: { args: { pageId: string }; result: MemoryPageVersion[] };
  list_memory_observations: { args: { projectId: string; runId?: string | null; limit?: number }; result: MemoryObservation[] };
  list_context_events: { args: { runId: string }; result: ContextEvent[] };
  /** Reconstrói o índice a partir dos arquivos .md da wiki; devolve quantas páginas entraram. */
  rebuild_memory_index: { args: { projectId: string }; result: number };
  list_memory_handoffs: { args: { projectId: string }; result: MemoryHandoff[] };
  list_context_pins: { args: { projectId: string }; result: ContextPin[] };
  add_context_pin: { args: { projectId: string; input: ContextPinInput }; result: ContextPin };
  remove_context_pin: { args: { projectId: string; pinId: string }; result: boolean };
  // Harness (Fase 5)
  list_mcp_servers: { args: { projectId?: string | null }; result: McpServer[] };
  save_mcp_server: { args: { input: McpServerInput }; result: McpServer };
  set_mcp_server_enabled: { args: { serverId: string; enabled: boolean }; result: McpServer };
  delete_mcp_server: { args: { serverId: string }; result: boolean };
  /** Abre o servidor pelo sidecar, lista as tools e guarda a saúde. */
  check_mcp_server: { args: { serverId: string }; result: McpServer };
  list_custom_hooks: { args: { projectId?: string | null }; result: CustomHookRecord[] };
  save_custom_hook: { args: { input: CustomHookInput }; result: CustomHookRecord };
  set_custom_hook_enabled: { args: { hookId: string; enabled: boolean }; result: CustomHookRecord };
  delete_custom_hook: { args: { hookId: string }; result: boolean };
  test_custom_hook: { args: { input: { projectId: string; hook: CustomHookInput; toolName?: string | null; toolInput?: unknown } }; result: HookRunResult };
  list_skills: { args: { projectId: string }; result: Skill[] };
  /** Varre .claude/skills do projeto e ~/.claude/skills. */
  scan_skills: { args: { projectId: string }; result: Skill[] };
  set_skill_enabled: { args: { skillId: string; enabled: boolean }; result: Skill };
  read_skill: { args: { skillId: string }; result: string };
  save_skill: { args: { input: SkillInput }; result: Skill };
  /** Preview, sem efeitos colaterais, do RunOptions que um run receberia (segredos redigidos). */
  preview_run_options: { args: { input: { projectId: string; agentProfileId?: string | null; prompt?: string; options?: RunOptions } }; result: RunPreview };
  /** Consulta o manifesto latest.json em `updates.endpoint` (sem endereço: configured=false). */
  check_update: { args: Record<string, never>; result: UpdateInfo };
  /** Baixa, verifica a assinatura, instala e reinicia. */
  install_update: { args: Record<string, never>; result: null };
};

export type UpdateInfo = { configured: boolean; currentVersion: string; available: boolean; version: string | null; notes: string | null; date: string | null };
export const UPDATES_ENDPOINT_SETTING = "updates.endpoint";

export type ProjectDefaults = { model?: string | null; maxTurns?: number | null; effort?: EffortLevel | null };
export const projectDefaultsKey = (projectId: string) => `project.${projectId}.defaults`;
export const KNOWN_MODELS = ["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];
export type PreviewNote = { field: string; value: string; origin: string };
export type HookInfo = { event: string; description: string; origin: string };
export type RunPreview = { options: RunOptions; notes: PreviewNote[]; hooks: HookInfo[]; pluginSkills: string[] };

export type Skill = {
  id: string;
  /** null = skill do usuário (~/.claude/skills). */
  projectId: string | null;
  name: string;
  path: string;
  description: string;
  source: "project" | "user" | "manual";
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};
export type SkillInput = { skillId?: string | null; projectId: string; name: string; content: string };

// ---------------------------------------------------------------------- harness

export type McpHealth = { ok: boolean; tools: McpToolInfo[]; error: string | null; latencyMs: number | null; serverVersion: string | null; checkedAt: string };
export type McpServer = {
  id: string;
  /** null = global. */
  projectId: string | null;
  name: string;
  transport: "stdio" | "sse" | "http";
  config: McpServerConfig;
  enabled: boolean;
  lastHealth: McpHealth | null;
  createdAt: string;
  updatedAt: string;
};
export type McpServerInput = { id?: string | null; projectId?: string | null; name: string; config: McpServerConfig; enabled?: boolean };

/** Hook livre (Harness → Hooks): comando de shell do usuário num evento do agente. */
export type CustomHookRecord = {
  id: string;
  /** null = todos os projetos. */
  projectId: string | null;
  name: string;
  event: CustomHookEvent;
  matcher: string | null;
  command: string;
  timeoutSec: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type CustomHookInput = { id?: string | null; projectId?: string | null; name: string; event: CustomHookEvent; matcher?: string | null; command: string; timeoutSec?: number; enabled?: boolean };

/** Pin de contexto: arquivo do projeto, página da memória ou texto, sempre injetado no brief. */
export type ContextPinKind = "file" | "page" | "text";
export type ContextPin = { id: string; projectId: string; kind: ContextPinKind; ref: string; label: string; position: number; createdAt: string };
export type ContextPinInput = { kind: ContextPinKind; ref: string; label?: string | null };
export type SettingSourcesChoice = "default" | "project" | "none";
export const settingSourcesKey = (projectId: string) => `project.${projectId}.settingSources`;

// ---------------------------------------------------------------------- memória

export type MemoryPageKind = "decisions" | "architecture" | "pitfalls" | "tasklog" | "handoff" | "note";
export const MEMORY_PAGE_KINDS: MemoryPageKind[] = ["decisions", "architecture", "pitfalls", "tasklog", "handoff", "note"];
export const MEMORY_KIND_LABELS: Record<MemoryPageKind, string> = {
  decisions: "decisões",
  architecture: "arquitetura",
  pitfalls: "armadilhas",
  tasklog: "log de tarefas",
  handoff: "handoff",
  note: "nota",
};

export type MemoryPage = {
  id: string;
  projectId: string;
  kind: MemoryPageKind;
  slug: string;
  title: string;
  bodyMd: string;
  score: number;
  accessCount: number;
  lastAccessedAt: string | null;
  source: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  versions: number;
};

export type MemoryPageVersion = { id: string; pageId: string; title: string; bodyMd: string; reason: string; createdAt: string };
export type MemorySearchHit = { page: MemoryPage; snippet: string; rank: number };
export type MemoryPageInput = { projectId: string; pageId?: string | null; kind: MemoryPageKind; title: string; bodyMd: string };

export type MemoryObservation = {
  id: string;
  projectId: string;
  runId: string | null;
  taskId: string | null;
  agentProfileId: string | null;
  kind: "tool_use" | "turn_end" | "subagent_end" | "session_end";
  title: string;
  body: string;
  toolName: string | null;
  redacted: boolean;
  createdAt: string;
  consolidatedAt: string | null;
};

export type ContextEvent = { id: string; projectId: string; runId: string; kind: string; payload: unknown; createdAt: string };

/** Nota de passagem entre runs ("onde parei / o que falhou / o que falta"), consumida uma vez. */
export type MemoryHandoff = {
  id: string;
  projectId: string;
  taskId: string | null;
  runId: string | null;
  bodyMd: string;
  source: "agent" | "auto" | string;
  createdAt: string;
  consumedByRunId: string | null;
  consumedAt: string | null;
};

export type CommandName = keyof Commands;

/** Eventos emitidos pelo core (nome -> payload). */
export type Events = {
  "run:event": RunEventNotification;
  "runtime:log": RuntimeLog;
  "runtime:exited": number | null;
  "board:changed": TickReport;
  /** Menu bar ou notificação pediu para abrir uma tela. */
  "app:navigate": string;
  /** Menu bar pediu para abrir um run ativo. */
  "app:open-run": string;
  /** O Octopus interrompeu runs porque o orçamento mensal estourou no meio deles. */
  "budget:stopped": BudgetStopped;
  /** Custo estimado de um run ativo mudou. */
  "run:cost": { runId: string; estCostUsd: number };
};

export type BudgetStopped = { runIds: string[]; reason: string };

export type EventName = keyof Events;
