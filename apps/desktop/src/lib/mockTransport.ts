/**
 * Transporte de mock: simula o core Rust + sidecar no navegador.
 * Reproduz as fixtures compartilhadas do protocolo para que a UI possa ser desenvolvida e testada
 * sem Tauri, sem Claude e sem rede. Também é o backend dos testes Playwright.
 */
import editApprovalEvents from "@octopus/protocol/fixtures/run-events-edit-approval.notifications.json";
import subagentEvents from "@octopus/protocol/fixtures/run-events-subagent.notifications.json";
import taskEvents from "@octopus/protocol/fixtures/run-events-task.notifications.json";
import fixtureEvents from "@octopus/protocol/fixtures/run-events.notifications.json";
import type { PermissionDecision, RunEventNotification } from "@octopus/protocol";
import type { Transport, Unlisten } from "./transport";
import type { AgentProfile, AppSettings, Approval, AuditEvent, BackupSnapshot, BudgetLine, BudgetPolicy, CommandName, Commands, ConfigExport, ContextEvent, ContextPin, EventName, Events, HookInfo, ImportMode, ImportPreview, ImportResult, McpServer, MemoryHandoff, MemoryObservation, MemoryPage, MemoryPageInput, MemoryPageKind, MemoryPageVersion, MemorySearchHit, PolicyDecision, PolicyRule, PreviewNote, Project, Role, Run, RunOptions, SandboxProfile, SessionSummary, Skill, Stage, StoredRunEvent, Task, TaskEvent, TeamMember, TeamMemberInput, TickReport, Workflow, WorkflowTemplate } from "./types";

type FixtureNotification = { params: RunEventNotification };

export type MockOptions = {
  /** Intervalo entre eventos reproduzidos, em ms. */
  tickMs?: number;
  /** Eventos a reproduzir em cada run. Padrão: fixture compartilhada do protocolo. */
  events?: RunEventNotification[];
  /** Projetos iniciais. */
  projects?: Project[];
  /** Instalação nova: sem projetos, sem preferências, onboarding pendente. */
  freshInstall?: boolean;
  /** Resultado das checagens de ambiente (padrão: tudo ok). */
  environment?: Partial<{ node: boolean; claudeAuth: boolean }>;
};

/** Catálogo inicial de cargos, igual ao seed da migration 0004. */
export function seedRoles(): Role[] {
  const at = "2026-10-16T00:00:00Z";
  const base = { scope: "global" as const, projectId: null, defaultModel: null, icon: null, createdAt: at, updatedAt: at };
  return [
    { ...base, id: "role_planejador", title: "Planejador", specialty: "Arquitetura e planos", responsibilitiesMd: "- Transformar o pedido em um plano com critérios de aceite claros.\n- Decompor o trabalho em tasks pequenas, com dependências explícitas.\n- Não alterar código: só ler, investigar e escrever o plano.", defaultPermissionMode: "plan", defaultTools: ["Read", "Glob", "Grep"], position: 1 },
    { ...base, id: "role_implementador", title: "Implementador", specialty: "Código e migrações", responsibilitiesMd: "- Executar uma task por vez, dentro da pasta do projeto.\n- Escrever testes junto com o código, nunca depois.\n- Pedir aprovação antes de comandos fora do projeto ou com rede.\n- Ao concluir, resumir o que mudou e por quê.", defaultPermissionMode: "acceptEdits", defaultTools: ["Read", "Glob", "Grep", "Edit", "Write", "Bash"], position: 2 },
    { ...base, id: "role_revisor", title: "Revisor", specialty: "Revisão de código e riscos", responsibilitiesMd: "- Revisar diffs em busca de bugs, riscos de segurança e desvios dos critérios de aceite.\n- Apontar problemas com arquivo e linha; sugerir a correção.\n- Nunca editar o código revisado.", defaultPermissionMode: "plan", defaultTools: ["Read", "Glob", "Grep", "Bash"], position: 3 },
    { ...base, id: "role_testador", title: "Testador", specialty: "Testes e qualidade", responsibilitiesMd: "- Rodar a suíte de testes e ampliar a cobertura das mudanças recentes.\n- Reportar falhas com passos para reproduzir.\n- Editar apenas arquivos de teste.", defaultPermissionMode: "acceptEdits", defaultTools: ["Read", "Glob", "Grep", "Edit", "Write", "Bash"], position: 4 },
    { ...base, id: "role_pesquisador", title: "Pesquisador", specialty: "Investigação e síntese", responsibilitiesMd: "- Investigar o código, a documentação e a web para responder a uma pergunta específica.\n- Entregar uma síntese curta com fontes e incertezas.\n- Não alterar arquivos do projeto.", defaultPermissionMode: "plan", defaultTools: ["Read", "Glob", "Grep", "WebSearch", "WebFetch"], position: 5 },
    { ...base, id: "role_documentador", title: "Documentador", specialty: "Documentação e comunicação", responsibilitiesMd: "- Manter README, docs e comentários alinhados ao código.\n- Escrever em português claro, com exemplos curtos.\n- Editar apenas documentação, salvo pedido explícito.", defaultPermissionMode: "acceptEdits", defaultTools: ["Read", "Glob", "Grep", "Edit", "Write"], position: 6 },
    { ...base, id: "role_seguranca", title: "Segurança", specialty: "Segurança e conformidade", responsibilitiesMd: "- Procurar segredos expostos, dependências vulneráveis e permissões excessivas.\n- Classificar o risco de cada achado e propor a mitigação.\n- Nunca executar comandos destrutivos.", defaultPermissionMode: "plan", defaultTools: ["Read", "Glob", "Grep", "Bash"], position: 7 },
  ];
}

export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "";
  const first = words[0]!;
  if (words.length === 1) return first.slice(0, 2).toUpperCase();
  return (first[0]! + words[words.length - 1]![0]!).toUpperCase();
}

/** Export de demonstração que o mock "lê" de qualquer caminho terminado em `.json`. */
export function demoConfigExport(): ConfigExport {
  return {
    schemaVersion: 1,
    exportedAt: "2026-10-16T12:00:00.000Z",
    appVersion: "0.1.0",
    settings: { theme: "dark", defaultAuthMode: "subscription", "onboarding.completedAt": "2026-10-16T11:00:00.000Z" },
    projects: [
      { id: "proj_demo", name: "chat-core", path: "/Users/dev/projetos/chat-core", authMode: "subscription", createdAt: "2026-10-15T10:00:00.000Z" },
      { id: "proj_frontend", name: "frontend-chat", path: "/Users/dev/projetos/frontend-chat", authMode: "subscription", createdAt: "2026-10-15T11:00:00.000Z" },
    ],
  };
}

export function fixtureRunEvents(): RunEventNotification[] {
  return (fixtureEvents as FixtureNotification[]).map((n) => n.params);
}

/** Roteiro alternativo: aprovações de Edit e Write (preview com diff). */
export function editApprovalRunEvents(): RunEventNotification[] {
  return (editApprovalEvents as FixtureNotification[]).map((n) => n.params);
}

/** Roteiro alternativo: agente principal delega a um subagente (parentToolUseId). */
export function subagentRunEvents(): RunEventNotification[] {
  return (subagentEvents as FixtureNotification[]).map((n) => n.params);
}

/** Roteiro de um run de task: o agente chama task_update(review) e termina. */
export function taskRunEvents(): RunEventNotification[] {
  return (taskEvents as FixtureNotification[]).map((n) => n.params);
}

export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  {
    id: "plan-implement-review-approve",
    name: "Planejar → Implementar → Revisar → Aprovar",
    stages: [
      { name: "Planejar", roleTitle: "Planejador", gate: false },
      { name: "Implementar", roleTitle: "Implementador", gate: false },
      { name: "Revisar", roleTitle: "Revisor", gate: false },
      { name: "Aprovar", roleTitle: null, gate: true },
    ],
  },
  {
    id: "research-synthesis",
    name: "Pesquisa paralela → Síntese",
    stages: [
      { name: "Pesquisar", roleTitle: "Pesquisador", gate: false },
      { name: "Sintetizar", roleTitle: "Documentador", gate: false },
    ],
  },
];

const TEMPLATE_INSTRUCTIONS: Record<string, string> = {
  Planejar: "Produza um plano curto com critérios de aceite e os passos de implementação. Não altere código.",
  Implementar: "Implemente seguindo o plano e os critérios de aceite, com testes.",
  Revisar: "Revise o diff produzido; aponte problemas com arquivo e linha.",
  Aprovar: "Aprovação humana.",
  Pesquisar: "Investigue a pergunta e entregue achados com fontes.",
  Sintetizar: "Sintetize os achados em um documento curto, claro, em português.",
};

/** Perfis de sandbox iguais ao seed da migration 0008. */
export function seedSandboxProfiles(): SandboxProfile[] {
  const creds = { envVars: [{ name: "ANTHROPIC_API_KEY", mode: "mask" as const, injectHosts: ["api.anthropic.com"] }] };
  return [
    { id: "sandbox_strict", name: "Estrito", description: "Comandos só dentro do sandbox; escrita só no projeto; sem rede fora da allowlist (vazia); leitura de credenciais negada.", builtin: true, position: 1, settings: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, network: { allowedDomains: [], strictAllowlist: true }, filesystem: { allowWrite: ["${PROJECT}", "${PROJECT}/.octopus/worktrees"], denyRead: ["~/.ssh", "~/.aws", "~/.config", "~/.gnupg", "~/.kube"] }, credentials: creds } },
    { id: "sandbox_dev", name: "Dev padrão", description: "Escrita só no projeto e leitura de credenciais negada; rede liberada para hosts comuns de desenvolvimento.", builtin: true, position: 2, settings: { enabled: true, failIfUnavailable: false, allowUnsandboxedCommands: false, network: { allowedDomains: ["github.com", "registry.npmjs.org", "pypi.org", "crates.io", "repo.maven.apache.org", "registry-1.docker.io"], strictAllowlist: false }, filesystem: { allowWrite: ["${PROJECT}", "${PROJECT}/.octopus/worktrees"], denyRead: ["~/.ssh", "~/.aws", "~/.gnupg", "~/.kube"] }, credentials: creds } },
    { id: "sandbox_readonly", name: "Somente leitura", description: "Nenhuma escrita em disco pelos comandos; sem rede; leitura de credenciais negada. Para investigar e planejar.", builtin: true, position: 3, settings: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, network: { allowedDomains: [], strictAllowlist: true }, filesystem: { allowWrite: [], denyWrite: ["${PROJECT}"], denyRead: ["~/.ssh", "~/.aws", "~/.config", "~/.gnupg", "~/.kube"] }, credentials: creds } },
  ];
}

/** Regras de política iguais ao seed da migration 0007. */
export function seedPolicyRules(): PolicyRule[] {
  const at = "2026-10-16T00:00:00Z";
  const base = { scope: "global" as const, projectId: null, builtin: true, createdAt: at, updatedAt: at };
  return [
    { ...base, id: "rule_destructive_outside", kind: "command", pattern: "@destructive-outside-project", action: "deny", reason: "Comando destrutivo fora da pasta do projeto", enabled: true, position: 1 },
    { ...base, id: "rule_git_push_protected", kind: "command", pattern: "git\\s+push\\b.*(--force\\b|-f\\b|\\bmain\\b|\\bmaster\\b)", action: "deny", reason: "Push forçado ou para branch protegida", enabled: true, position: 2 },
    { ...base, id: "rule_write_secrets", kind: "write", pattern: "**/.env|**/.env.*|**/*.pem|**/id_rsa*|**/id_ed25519*|**/secrets/**", action: "deny", reason: "Segredos nunca entram no repositório", enabled: true, position: 3 },
    { ...base, id: "rule_write_outside", kind: "write", pattern: "@outside-project", action: "deny", reason: "Confinamento de caminhos à pasta do projeto", enabled: true, position: 4 },
    { ...base, id: "rule_network_ask", kind: "command", pattern: "\\b(curl|wget|nc|ssh|scp)\\b", action: "ask", reason: "Saída de rede exige aprovação", enabled: true, position: 5 },
    { ...base, id: "rule_web_ask", kind: "tool", pattern: "WebFetch|WebSearch", action: "ask", reason: "Buscar na web só com você olhando", enabled: false, position: 6 },
    { ...base, id: "rule_mcp_octopus", kind: "mcp", pattern: "mcp__octopus__*", action: "allow", reason: "Ferramentas do próprio orquestrador", enabled: true, position: 7 },
  ];
}

/** Avaliação simplificada da política no mock (espelha a ordem deny > ask > allow do motor Rust). */
export function evaluatePolicyMock(rules: PolicyRule[], projectPath: string, toolName: string, input: unknown): PolicyDecision {
  const record = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  const rank = { deny: 3, ask: 2, allow: 1 } as const;
  let best: PolicyRule | null = null;
  const inside = (p: string) => (p.startsWith("/") ? p : `${projectPath}/${p}`).replace(/\/[^/]+\/\.\.(?=\/|$)/g, "").startsWith(projectPath);
  for (const rule of rules.filter((r) => r.enabled)) {
    let hit = false;
    if (rule.kind === "command" && toolName === "Bash" && typeof record.command === "string") {
      const cmd = record.command;
      if (rule.pattern === "@destructive-outside-project") hit = /\brm\s+-[a-z]*[rf][a-z]*\s+(\/|~|\$HOME|\.\.|\/(?!Users\/dev\/projetos\/chat-core))/i.test(cmd) || /\brm\s+-[a-z]*[rf][a-z]*\s+\/tmp/.test(cmd);
      else hit = new RegExp(rule.pattern).test(cmd);
    } else if (rule.kind === "write" && ["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(toolName) && typeof record.file_path === "string") {
      const path = record.file_path;
      if (rule.pattern === "@outside-project") hit = !inside(path);
      else hit = rule.pattern.split("|").some((g) => globToRegex(g).test(path) || globToRegex(g).test(`${projectPath}/${path}`));
    } else if (rule.kind === "tool") hit = rule.pattern.split("|").some((g) => globToRegex(g).test(toolName));
    else if (rule.kind === "mcp") hit = toolName.startsWith("mcp__") && rule.pattern.split("|").some((g) => globToRegex(g).test(toolName));
    if (hit && (!best || rank[rule.action] > rank[best.action])) best = rule;
  }
  if (!best) return { behavior: "pass", reason: null, ruleId: null };
  return { behavior: best.action, reason: best.reason || `Regra ${best.id}`, ruleId: best.id };
}

function globToRegex(glob: string): RegExp {
  const escaped = glob.trim().replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

/** Conteúdo "atual" de arquivos do projeto de demonstração, para o diff de Write. */
const MOCK_FILES: Record<string, string> = {
  "README.md": "# chat-core\n\nServiço de leads.\n",
  "src/main/java/com/acme/leads/LeadRepository.java": [
    "package com.acme.leads;",
    "",
    "import java.util.List;",
    "import org.springframework.data.jpa.repository.JpaRepository;",
    "",
    "public interface LeadRepository extends JpaRepository<Lead, Long> {",
    "    List<Lead> findByStatus(LeadStatus status);",
    "",
    "    List<Lead> findAll();",
    "}",
    "",
  ].join("\n"),
};

export function createMockTransport(options: MockOptions = {}): Transport & { emit: <E extends EventName>(e: E, p: Events[E]) => void; tamperAudit: (seq: number) => void } {
  const tickMs = options.tickMs ?? 120;
  const script = options.events ?? fixtureRunEvents();
  const listeners = new Map<EventName, Set<(payload: never) => void>>();
  const fresh = options.freshInstall ?? false;
  const projects: Project[] = options.projects ?? (fresh ? [] : [
    { id: "proj_demo", name: "chat-core", path: "/Users/dev/projetos/chat-core", authMode: "subscription", createdAt: new Date().toISOString(), sandboxProfileId: "sandbox_dev" },
  ]);
  const settings: AppSettings = fresh ? {} : { "onboarding.completedAt": "2026-10-15T10:00:00.000Z", defaultAuthMode: "subscription" };
  const roles: Role[] = seedRoles();
  const members: TeamMember[] = [];
  let memberCounter = 0;
  const findMember = (agentProfileId: string) => members.find((m) => m.profile.id === agentProfileId);
  const buildMember = (projectId: string, input: TeamMemberInput, existing?: TeamMember): TeamMember => {
    const role = roles.find((r) => r.id === input.roleId);
    if (!role) throw new Error(`Cargo ${input.roleId} não encontrado`);
    if (!input.name.trim()) throw new Error("Informe o nome do membro");
    if (input.reportsToAgentId) {
      if (existing && input.reportsToAgentId === existing.profile.id) throw new Error("Um membro não pode reportar a si mesmo");
      if (!members.some((m) => m.projectId === projectId && m.profile.id === input.reportsToAgentId)) throw new Error("O membro a quem reportar não está neste time");
    }
    const id = existing?.profile.id ?? `agent_${++memberCounter}`;
    const profile: AgentProfile = {
      id,
      projectId,
      roleId: role.id,
      name: input.name.trim(),
      avatarSeed: initials(input.name),
      instructionsMd: input.instructionsMd?.trim() || null,
      model: input.model ?? null,
      permissionMode: input.permissionMode ?? null,
      allowedTools: input.allowedTools ?? null,
      maxTurns: input.maxTurns ?? null,
      maxBudgetUsd: input.maxBudgetUsd ?? null,
      createdAt: existing?.profile.createdAt ?? new Date().toISOString(),
      mcpServerIds: input.mcpServerIds ?? null,
      skillIds: input.skillIds ?? null,
    };
    return {
      id: existing?.id ?? `member_${memberCounter}`,
      projectId,
      profile,
      role,
      reportsToAgentId: input.reportsToAgentId ?? null,
      position: existing?.position ?? members.filter((m) => m.projectId === projectId).length + 1,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    };
  };
  const workflows: Workflow[] = [];
  const tasks: Task[] = [];
  const taskEventsLog: TaskEvent[] = [];
  let wfCounter = 0;
  let taskCounter = 0;
  let tevCounter = 0;
  const pushTaskEvent = (taskId: string, kind: string, from: string | null, to: string | null, runId: string | null, actor: string, note: string | null) => {
    taskEventsLog.push({ id: `tev_${++tevCounter}`, taskId, at: new Date().toISOString(), kind, fromStage: from, toStage: to, runId, actor, note });
  };
  const requestedByRun = new Map<string, string>();
  const advanceTask = (task: Task, workflow: Workflow, actor: string, note: string | null, human: boolean) => {
    const index = workflow.stages.findIndex((s) => s.id === task.stageId);
    const next = workflow.stages[index + 1];
    const from = task.stageId;
    if (!next) task.status = "done";
    else {
      task.stageId = next.id;
      task.status = next.gate ? "waiting_approval" : "ready";
    }
    task.lockRunId = null;
    if (note) task.lastNote = note;
    task.updatedAt = new Date().toISOString();
    pushTaskEvent(task.id, human ? "approved" : task.status === "done" ? "completed" : "advanced", from, task.stageId, null, actor, note);
  };
  const finishTaskRun = (run: Run, success: boolean, error: string | null) => {
    if (!run.taskId) return;
    const task = tasks.find((t) => t.id === run.taskId);
    if (!task || task.lockRunId !== run.id) return;
    const workflow = workflows.find((w) => w.id === task.workflowId);
    if (!workflow) return;
    const requested = requestedByRun.get(run.id);
    if (!success) {
      task.status = "failed";
      task.lockRunId = null;
      task.lastNote = error ?? "run falhou";
      pushTaskEvent(task.id, "run_failed", task.stageId, task.stageId, run.id, "scheduler", task.lastNote);
    } else if (requested === "blocked") {
      task.status = "blocked";
      task.lockRunId = null;
      pushTaskEvent(task.id, "blocked", task.stageId, task.stageId, run.id, "agente", task.lastNote);
    } else if (requested === "review") {
      task.status = "waiting_approval";
      task.lockRunId = null;
      pushTaskEvent(task.id, "run_finished", task.stageId, task.stageId, run.id, "agente", "pediu revisão");
    } else {
      advanceTask(task, workflow, "scheduler", task.lastNote, false);
    }
    emit("board:changed", { started: [], failed: [], parked: 0, paused: false });
  };
  const runnableTasks = (projectId: string): Array<{ task: Task; workflow: Workflow; stage: Stage }> => {
    const out: Array<{ task: Task; workflow: Workflow; stage: Stage }> = [];
    for (const workflow of workflows.filter((w) => w.projectId === projectId)) {
      const active = tasks.filter((t) => t.workflowId === workflow.id && t.status === "running").length;
      let slots = Math.max(0, workflow.maxParallel - active);
      for (const task of tasks.filter((t) => t.workflowId === workflow.id && t.status === "ready")) {
        if (slots === 0) break;
        if (!task.dependsOn.every((dep) => tasks.some((t) => t.id === dep && t.status === "done"))) continue;
        const stage = workflow.stages.find((s) => s.id === task.stageId);
        if (!stage || stage.gate) continue;
        out.push({ task, workflow, stage });
        slots--;
      }
    }
    return out;
  };
  const rules: PolicyRule[] = seedPolicyRules();
  const sandboxProfiles = seedSandboxProfiles();
  const budgets: BudgetPolicy[] = [];
  const monthStart = () => {
    const d = new Date();
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01T00:00:00Z`;
  };
  const spentThisMonth = (projectId: string, agentId: string | null) => {
    let spent = 0;
    let count = 0;
    for (const r of runs.values()) {
      if (r.projectId !== projectId || r.startedAt < monthStart() || (agentId && r.agentProfileId !== agentId)) continue;
      spent += r.costUsd ?? 0;
      count++;
    }
    return { spent, count };
  };
  const budgetLine = (scope: BudgetLine["scope"], scopeId: string, label: string, projectId: string, agentId: string | null): BudgetLine => {
    const policy = budgets.find((b) => b.scope === scope && b.scopeId === scopeId) ?? null;
    const { spent, count } = spentThisMonth(projectId, agentId);
    const level = policy?.hardUsd != null && spent >= policy.hardUsd ? "hard" : policy?.softUsd != null && spent >= policy.softUsd ? "soft" : "ok";
    return { scope, scopeId, label, spentUsd: spent, softUsd: policy?.softUsd ?? null, hardUsd: policy?.hardUsd ?? null, maxTurns: policy?.maxTurns ?? null, runs: count, level };
  };
  const budgetStatus = (projectId: string) => {
    const project = projects.find((p) => p.id === projectId);
    if (!project) throw new Error(`Projeto ${projectId} não encontrado`);
    return {
      month: monthStart().slice(0, 7),
      project: budgetLine("project", projectId, project.name, projectId, null),
      agents: members.filter((m) => m.projectId === projectId).map((m) => budgetLine("agent", m.profile.id, `${m.profile.name} · ${m.role.title}`, projectId, m.profile.id)),
    };
  };
  const applyBudget = (projectId: string, agentId: string | null) => {
    const status = budgetStatus(projectId);
    for (const line of [status.project, ...(agentId ? status.agents.filter((a) => a.scopeId === agentId) : [])]) {
      if (line.hardUsd != null && line.spentUsd >= line.hardUsd) throw new Error(`Orçamento mensal esgotado para ${line.label}: US$ ${line.spentUsd.toFixed(2)} gastos de US$ ${line.hardUsd.toFixed(2)}. Aumente o limite em Segurança → Orçamentos.`);
    }
  };
  let ruleCounter = 0;
  const auditLog: AuditEvent[] = [];
  let tampered: number | null = null;
  const fakeHash = (seed: string) => {
    let h = 2166136261;
    for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
    return h.toString(16).padStart(8, "0").repeat(8);
  };
  // ------------------------------------------------------------------ memória (Fase 4)
  const observations: MemoryObservation[] = [];
  const pages: MemoryPage[] = [];
  const pageVersions: MemoryPageVersion[] = [];
  const contextEvents: ContextEvent[] = [];
  const handoffs: MemoryHandoff[] = [];
  const pins: ContextPin[] = [];
  const mcpServers: McpServer[] = [];
  const skillFiles = new Map<string, string>();
  const skills: Skill[] = [];
  const seedSkills = () => {
    if (skills.length > 0 || fresh) return;
    const ts = new Date().toISOString();
    for (const [projectId, name, path, description, source, content] of [
      ["proj_demo", "flyway-migration", "/Users/dev/projetos/chat-core/.claude/skills/flyway-migration", "Cria migrações Flyway versionadas com teste de integração", "project", "---\nname: flyway-migration\ndescription: Cria migrações Flyway versionadas com teste de integração\n---\n\n1. Rode ./mvnw flyway:info.\n2. Crie V<n+1>__descricao.sql.\n"],
      ["proj_demo", "java-review", "/Users/dev/projetos/chat-core/.claude/skills/java-review", "Revisão de código Java 21: records, nulls, concorrência", "project", "# Java review\n\nRevisão de código Java 21: records, nulls, concorrência.\n"],
      [null, "commit-ptbr", "/Users/dev/.claude/skills/commit-ptbr", "Mensagens de commit em pt-BR no padrão do time", "user", "---\nname: commit-ptbr\ndescription: Mensagens de commit em pt-BR no padrão do time\n---\n"],
    ] as const) {
      skills.push({ id: `skill_${name}`, projectId, name, path, description, source, enabled: true, createdAt: ts, updatedAt: ts });
      skillFiles.set(`skill_${name}`, content);
    }
  };
  seedSkills();
  const slugSkill = (title: string) => title.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "skill";
  const parseSkillMd = (text: string, fallback: string): [string, string] => {
    let name = fallback;
    let description = "";
    let body = text;
    if (text.startsWith("---\n")) {
      const end = text.indexOf("\n---", 4);
      if (end > 0) {
        for (const line of text.slice(4, end).split("\n")) {
          const idx = line.indexOf(":");
          if (idx <= 0) continue;
          const k = line.slice(0, idx).trim();
          const v = line.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
          if (k === "name" && v) name = v;
          if (k === "description" && v) description = v;
        }
        body = text.slice(end + 4);
      }
    }
    if (!description) description = body.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#"))?.slice(0, 200) ?? "";
    return [name, description];
  };
  const describeMcp = (c: McpServer["config"]) => (c.type === "stdio" ? c.command : c.url);
  const normMock = (s: string) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  /** Brief do run, como o core: handoff pendente da task (claim único) + páginas que casam com o pedido. */
  const buildBriefMock = (projectId: string, taskId: string | null, prompt: string, runId: string, claim = true): { text: string; items: string[] } | null => {
    const pending = handoffs.find((h) => h.projectId === projectId && !h.consumedAt && (taskId ? h.taskId === taskId : h.taskId === null));
    if (pending && claim) {
      pending.consumedByRunId = runId;
      pending.consumedAt = new Date().toISOString();
    }
    const words = normMock(prompt)
      .split(/[^a-z0-9_-]+/)
      .filter((w) => w.length >= 4)
      .slice(0, 16);
    let relevant = pages.filter((p) => p.projectId === projectId && !p.archivedAt && words.some((w) => normMock(p.title).includes(w) || normMock(p.bodyMd).includes(w))).slice(0, 3);
    if (relevant.length === 0) relevant = pages.filter((p) => p.projectId === projectId && !p.archivedAt && p.kind !== "tasklog").sort((a, b) => b.score - a.score).slice(0, 2);
    const projectPins = pins.filter((p) => p.projectId === projectId);
    if (!pending && relevant.length === 0 && projectPins.length === 0) return null;
    const items: string[] = [];
    let text = "## Memória do projeto (Octopus)\n";
    if (projectPins.length) {
      text += "\n### Pins de contexto (sempre presentes)\n";
      for (const pin of projectPins) {
        const content = pin.kind === "page" ? (pages.find((p) => p.id === pin.ref)?.bodyMd ?? "") : pin.kind === "file" ? `(conteúdo de ${pin.ref})` : pin.ref;
        text += `#### ${pin.label}\n${content.slice(0, 1500)}\n`;
        items.push(`pin: ${pin.label}`);
      }
    }
    if (pending) {
      text += `\n### Handoff pendente do run anterior desta task\n${pending.bodyMd.slice(0, 800)}\n`;
      items.push(`handoff: ${pending.bodyMd.slice(0, 60)}`);
    }
    if (relevant.length) {
      text += "\n### Páginas relevantes\n";
      for (const p of relevant) {
        text += `- **${p.title}** (${p.kind}): ${p.bodyMd.slice(0, 400)}\n`;
        items.push(p.title);
        if (claim) {
          p.accessCount += 1;
          p.score = Math.min(1, p.score + 0.05);
        }
      }
    }
    text += "\nUse a tool memory_search para mais contexto, memory_write para registrar decisões/armadilhas e memory_handoff para deixar uma nota ao próximo run se não terminar.\n";
    return { text, items };
  };
  const briefEvent = (runId: string, brief: { text: string; items: string[] }): RunEventNotification => ({ runId, seq: 0, at: new Date().toISOString(), event: { type: "brief_injected", chars: brief.text.length, items: brief.items } });
  const sanitizeMock = (text: string): [string, boolean] => {
    let redacted = false;
    let out = text.replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, () => {
      redacted = true;
      return "[redigido]";
    });
    out = out.replace(/\b([A-Z0-9_]*(?:api[_-]?key|token|secret|password|passwd|senha)[A-Z0-9_]*)\s*[=:]\s*["']?([^\s"'&;,]{6,})/gi, (_m, key: string) => {
      redacted = true;
      return `${key}=[redigido]`;
    });
    out = out.replace(/:\/\/[^/\s:@]+:[^@\s/]+@/g, () => {
      redacted = true;
      return "://[redigido]@";
    });
    return [out, redacted];
  };
  const slugifyMock = (title: string) =>
    title
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80) || "pagina";
  const savePageMock = (input: MemoryPageInput, reason: string, source: string): MemoryPage => {
    if (!input.title.trim()) throw new Error("A página precisa de título");
    const ts = new Date().toISOString();
    const [title] = sanitizeMock(input.title.trim());
    const [bodyMd] = sanitizeMock(input.bodyMd);
    let page = input.pageId ? pages.find((p) => p.id === input.pageId) : undefined;
    if (page) {
      Object.assign(page, { kind: input.kind, title, bodyMd, updatedAt: ts, versions: page.versions + 1 });
    } else {
      let slug = slugifyMock(title);
      if (pages.some((p) => p.projectId === input.projectId && p.slug === slug)) slug = `${slug}-${Math.random().toString(36).slice(2, 8)}`;
      page = { id: `page_${Math.random().toString(36).slice(2, 10)}`, projectId: input.projectId, kind: input.kind, slug, title, bodyMd, score: 0.5, accessCount: 0, lastAccessedAt: null, source, createdAt: ts, updatedAt: ts, archivedAt: null, versions: 1 };
      pages.unshift(page);
    }
    pageVersions.unshift({ id: `ver_${Math.random().toString(36).slice(2, 10)}`, pageId: page.id, title, bodyMd, reason, createdAt: ts });
    return page;
  };
  /** Consolidação bruta ao fim do run: entrada no log de tarefas do mês (como o core). */
  const consolidateRunMock = (run: Run) => {
    const month = run.startedAt.slice(0, 7);
    const files = observations
      .filter((o) => o.runId === run.id && o.kind === "tool_use" && ["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(o.toolName ?? ""))
      .map((o) => o.title.split(/\s+/)[1])
      .filter((f, i, arr): f is string => Boolean(f) && arr.indexOf(f) === i);
    const notes = observations.filter((o) => o.runId === run.id && (o.kind === "turn_end" || o.kind === "subagent_end") && o.body.trim()).map((o) => o.body.trim().slice(0, 400));
    const statusLabel = run.status === "completed" ? "concluído" : run.status === "failed" ? "falhou" : run.status === "interrupted" ? "interrompido" : run.status;
    let entry = `\n## ${run.startedAt.slice(0, 16).replace("T", " ")} · run ${run.id.slice(0, 12)} · ${statusLabel}${run.costUsd != null ? ` · US$ ${run.costUsd.toFixed(2)}` : ""}\n`;
    entry += `**Pedido:** ${run.prompt.trim().slice(0, 300)}\n`;
    if (run.resultText?.trim()) entry += `**Resultado:** ${run.resultText.trim().slice(0, 600)}\n`;
    if (run.errorMessage?.trim()) entry += `**Erro:** ${run.errorMessage.trim().slice(0, 300)}\n`;
    if (files.length) entry += `**Arquivos tocados:** ${files.join(", ")}\n`;
    if (notes.length) entry += `**Notas do agente:** ${notes.join(" · ")}\n`;
    const slug = `log-de-tarefas-${month}`;
    const existing = pages.find((p) => p.projectId === run.projectId && p.slug === slug);
    const saved = savePageMock(
      { projectId: run.projectId, pageId: existing?.id ?? null, kind: "tasklog", title: `Log de tarefas — ${month}`, bodyMd: existing ? `${existing.bodyMd.trimEnd()}\n${entry}` : `Entradas geradas automaticamente ao fim de cada run (consolidação bruta).\n${entry}` },
      `run ${run.id}`,
      "auto",
    );
    if (!existing) saved.slug = slug;
    const ts = new Date().toISOString();
    for (const o of observations) if (o.runId === run.id && !o.consolidatedAt) o.consolidatedAt = ts;
    // Consolidação com Haiku: um run só de memória, que grava páginas via memory_write.
    if (settings["memory.consolidation"] === "haiku" && run.kind === "agent" && observations.some((o) => o.runId === run.id)) {
      const crun: Run = {
        id: `run_mock_${++runCounter}`,
        projectId: run.projectId,
        prompt: `Consolidação de memória do run ${run.id}`,
        options: { model: "claude-haiku-5-5", permissionMode: "dontAsk", maxTurns: 8, maxBudgetUsd: 0.25, allowedTools: ["mcp__octopus__memory_write", "mcp__octopus__memory_search"], disallowedTools: ["Bash", "Edit", "Write", "Read"], policyHooks: false, memory: { capture: false, tools: true } },
        agentProfileId: null,
        taskId: null,
        kind: "consolidation",
        status: "running",
        claudeSessionId: null,
        model: "claude-haiku-5-5",
        startedAt: new Date().toISOString(),
        endedAt: null,
        costUsd: null,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        numTurns: null,
        stopReason: null,
        resultText: null,
        errorMessage: null,
      };
      runs.set(crun.id, crun);
      events.set(crun.id, []);
      const summary = notes[0] ?? run.resultText ?? run.prompt;
      const at = new Date().toISOString();
      const script: RunEventNotification[] = [
        { runId: crun.id, seq: 0, at, event: { type: "session_init", sessionId: `sess_${crun.id}`, model: "claude-haiku-5-5", tools: ["mcp__octopus__memory_write", "mcp__octopus__memory_search"], mcpServers: [{ name: "octopus", status: "connected" }], permissionMode: "dontAsk" } },
        { runId: crun.id, seq: 1, at, event: { type: "tool_use", toolUseId: `toolu_${crun.id}`, name: "mcp__octopus__memory_write", input: { kind: "decisions", title: `Aprendizados do run ${run.id.slice(-4)}`, body: summary.slice(0, 600), source: "haiku" }, parentToolUseId: null } },
        { runId: crun.id, seq: 2, at, event: { type: "tool_result", toolUseId: `toolu_${crun.id}`, content: "Página gravada na memória do projeto (decisions).", isError: false, parentToolUseId: null } },
        { runId: crun.id, seq: 3, at, event: { type: "assistant_text", messageId: null, text: "ok", parentToolUseId: null } },
        { runId: crun.id, seq: 4, at, event: { type: "result", sessionId: `sess_${crun.id}`, subtype: "success", isError: false, costUsd: 0.01, durationMs: 900, numTurns: 2, usage: null, stopReason: "end_turn", resultText: "ok" } },
      ];
      scriptByRun.set(crun.id, script);
      audit("sistema", "memory.consolidation.started", run.projectId, { runId: crun.id, sourceRunId: run.id, model: "claude-haiku-5-5" });
      schedule(crun.id, 0);
    }
    // Run de task que não terminou bem e sem handoff do agente: nota automática.
    if (run.status !== "completed" && run.taskId && !handoffs.some((h) => h.runId === run.id)) {
      let body = `Run ${statusLabel} sem handoff do agente.`;
      if (run.errorMessage?.trim()) body += `\n\n**O que falhou:** ${run.errorMessage.trim().slice(0, 400)}`;
      if (notes.length) body += `\n\n**Últimas notas do agente:** ${notes.join(" · ")}`;
      if (files.length) body += `\n\n**Arquivos tocados:** ${files.join(", ")}`;
      handoffs.unshift({ id: `hand_${Math.random().toString(36).slice(2, 10)}`, projectId: run.projectId, taskId: run.taskId, runId: run.id, bodyMd: body, source: "auto", createdAt: ts, consumedByRunId: null, consumedAt: null });
    }
  };

  /** Keychain de mentira: só para a UI; os valores nunca saem daqui. */
  const secrets = new Map<string, string>();
  const audit = (actor: string, kind: string, projectId: string | null, payload: unknown) => {
    const prevHash = auditLog[auditLog.length - 1]?.hash ?? "0".repeat(64);
    const ts = new Date().toISOString();
    const hash = fakeHash(`${prevHash}|${ts}|${actor}|${kind}|${projectId ?? ""}|${JSON.stringify(payload)}`);
    auditLog.push({ seq: auditLog.length + 1, ts, actor, kind, projectId, payload, prevHash, hash });
  };
  const snapshots: BackupSnapshot[] = [];
  const snapshotFiles = new Map<string, ConfigExport>();
  let snapshotCounter = 0;
  const exportConfig = (): ConfigExport => ({
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    appVersion: "0.1.0-mock",
    settings: { ...settings },
    projects: projects.map((p) => ({ ...p })),
  });
  const writeSnapshot = (reason: BackupSnapshot["reason"]): BackupSnapshot => {
    const config = exportConfig();
    const snapshot: BackupSnapshot = {
      id: `bkp_${++snapshotCounter}`,
      createdAt: config.exportedAt,
      path: `/mock/backups/octopus-config-${snapshotCounter}-${reason}.json`,
      schemaVersion: 1,
      reason,
      sizeBytes: JSON.stringify(config).length,
    };
    snapshots.unshift(snapshot);
    snapshotFiles.set(snapshot.id, config);
    const autos = snapshots.filter((s) => s.reason === "auto");
    for (const old of autos.slice(20)) {
      snapshots.splice(snapshots.indexOf(old), 1);
      snapshotFiles.delete(old.id);
    }
    return snapshot;
  };
  const sameProject = (a: Project, b: Project) => a.id === b.id && a.name === b.name && a.path === b.path && a.authMode === b.authMode;
  const previewImport = (config: ConfigExport): ImportPreview => {
    const preview: ImportPreview = { schemaVersion: config.schemaVersion, exportedAt: config.exportedAt, projectsNew: [], projectsSame: [], projectsConflict: [], projectsRemoved: [], settings: Object.keys(config.settings).length };
    for (const incoming of config.projects) {
      const existing = projects.find((p) => p.id === incoming.id || p.path === incoming.path);
      if (!existing) preview.projectsNew.push(incoming.name);
      else if (sameProject(existing, incoming)) preview.projectsSame.push(incoming.name);
      else preview.projectsConflict.push(`${incoming.name} ↔ ${existing.name}`);
    }
    for (const existing of projects) {
      if (!config.projects.some((p) => p.id === existing.id || p.path === existing.path)) preview.projectsRemoved.push(existing.name);
    }
    return preview;
  };
  const importConfig = (config: ConfigExport, mode: ImportMode): ImportResult => {
    const result: ImportResult = { projectsAdded: 0, projectsUpdated: 0, projectsRemoved: 0, settingsApplied: 0 };
    for (const incoming of config.projects) {
      const existing = projects.find((p) => p.id === incoming.id || p.path === incoming.path);
      if (!existing) {
        projects.push({ ...incoming });
        result.projectsAdded++;
      } else if (mode === "replace" && !sameProject(existing, incoming)) {
        Object.assign(existing, { name: incoming.name, path: incoming.path, authMode: incoming.authMode });
        result.projectsUpdated++;
      }
    }
    if (mode === "replace") {
      for (const existing of [...projects]) {
        if (!config.projects.some((p) => p.id === existing.id || p.path === existing.path)) {
          projects.splice(projects.indexOf(existing), 1);
          result.projectsRemoved++;
        }
      }
      for (const key of Object.keys(settings)) delete settings[key];
    }
    for (const [key, value] of Object.entries(config.settings)) {
      settings[key] = value;
      result.settingsApplied++;
    }
    return result;
  };
  const readExport = (path: string): ConfigExport => {
    if (!path.endsWith(".json")) throw new Error(`${path} não é um export válido`);
    const bySnapshot = snapshots.find((s) => s.path === path);
    return bySnapshot ? snapshotFiles.get(bySnapshot.id)! : demoConfigExport();
  };
  const runs = new Map<string, Run>();
  const events = new Map<string, StoredRunEvent[]>();
  const sessions: SessionSummary[] = [
    {
      sessionId: "5b3f2c1a-8d4e-4f6b-9a7c-2e1d0f9b8a6c",
      cwd: projects[0]?.path ?? "/",
      title: "Criar migração Flyway V12 para tabela leads",
      tags: ["migração"],
      createdAt: new Date(Date.now() - 3_600_000).toISOString(),
      lastUsedAt: new Date().toISOString(),
    },
  ];
  let forkCounter = 0;
  const approvals = new Map<string, Approval>();
  const approvalKey = (runId: string, requestId: string) => `${runId}:${requestId}`;
  const recordApproval = (run: Run, at: string, ev: Extract<RunEventNotification["event"], { type: "permission_request" }>) => {
    const key = approvalKey(run.id, ev.requestId);
    if (approvals.has(key)) return;
    approvals.set(key, {
      id: `appr_${approvals.size + 1}`,
      runId: run.id,
      projectId: run.projectId,
      runPrompt: run.prompt,
      requestId: ev.requestId,
      toolName: ev.toolName,
      toolInput: ev.input,
      reason: ev.reason,
      decision: null,
      decisionMessage: null,
      requestedAt: at,
      decidedAt: null,
    });
  };
  const closePendingApprovals = (runId: string) => {
    for (const approval of approvals.values()) {
      if (approval.runId === runId && approval.decision === null) {
        approval.decision = "deny";
        approval.decisionMessage = "Run encerrado antes da decisão";
        approval.decidedAt = new Date().toISOString();
      }
    }
  };
  const pendingTimers = new Map<string, ReturnType<typeof setTimeout>[]>();
  const scriptByRun = new Map<string, RunEventNotification[]>();
  const scriptFor = (runId: string) => scriptByRun.get(runId) ?? script;
  const pausedAt = new Map<string, number>();
  const seqByRun = new Map<string, number>();
  let runCounter = 0;

  const emit = <E extends EventName>(event: E, payload: Events[E]) => {
    for (const handler of listeners.get(event) ?? []) (handler as (p: Events[E]) => void)(payload);
  };

  const nextSeq = (runId: string) => {
    const seq = seqByRun.get(runId) ?? 0;
    seqByRun.set(runId, seq + 1);
    return seq;
  };

  /** Emite um evento avulso (fora do roteiro) com seq próprio e o persiste. */
  const emitEvent = (runId: string, event: RunEventNotification["event"]) => {
    const notification: RunEventNotification = { runId, seq: nextSeq(runId), at: new Date().toISOString(), event };
    if (event.type !== "assistant_text_delta") {
      events.get(runId)?.push({ runId, seq: notification.seq, at: notification.at, kind: event.type, event });
    }
    emit("run:event", notification);
  };

  const deliver = (runId: string, index: number) => {
    const run = runs.get(runId);
    const runScript = scriptFor(runId);
    if (!run || index >= runScript.length) return;
    const template = runScript[index]!;
    let event = template.event;
    // Retomar mantém o id da sessão; bifurcar nasce com um id novo (como o SDK faz).
    if (event.type === "session_init" && run.options.resumeSessionId) {
      const sessionId = run.options.forkSession ? `fork-${++forkCounter}-${run.options.resumeSessionId.slice(0, 8)}` : run.options.resumeSessionId;
      event = { ...event, sessionId };
    }
    const notification: RunEventNotification = { ...template, event, runId, seq: nextSeq(runId), at: new Date().toISOString() };
    const ev = notification.event;
    if (ev.type !== "assistant_text_delta") {
      events.get(runId)!.push({ runId, seq: notification.seq, at: notification.at, kind: ev.type, event: ev });
    }
    if (ev.type === "session_init") {
      run.status = "running";
      run.claudeSessionId = ev.sessionId;
      run.model = ev.model;
      audit("sistema", "run.started", run.projectId, { runId, sessionId: ev.sessionId, model: ev.model });
      if (!sessions.some((s) => s.sessionId === ev.sessionId)) {
        const project = projects.find((p) => p.id === run.projectId);
        sessions.unshift({ sessionId: ev.sessionId, cwd: project?.path ?? "/", title: run.prompt, tags: [], createdAt: notification.at, lastUsedAt: notification.at });
      }
    } else if (ev.type === "usage") {
      run.inputTokens = ev.usage.inputTokens;
      run.outputTokens = ev.usage.outputTokens;
      run.cacheReadTokens = ev.usage.cacheReadTokens;
    } else if (ev.type === "result") {
      run.status = ev.isError ? "failed" : "completed";
      run.costUsd = ev.costUsd;
      run.numTurns = ev.numTurns;
      run.resultText = ev.resultText;
      run.endedAt = notification.at;
      closePendingApprovals(run.id);
      finishTaskRun(run, !ev.isError, ev.resultText);
      audit("sistema", "run.finished", run.projectId, { runId, status: run.status, costUsd: ev.costUsd, numTurns: ev.numTurns });
      consolidateRunMock(run);
    } else if (ev.type === "tool_use" && ev.name === "mcp__octopus__memory_write" && run.kind === "consolidation") {
      const input = ev.input as { kind: MemoryPageKind; title: string; body: string; source?: string };
      const existing = pages.find((p) => p.projectId === run.projectId && !p.archivedAt && p.slug === slugifyMock(input.title));
      savePageMock({ projectId: run.projectId, pageId: existing?.id ?? null, kind: input.kind, title: input.title, bodyMd: input.body }, `run ${run.id} (agente)`, input.source === "haiku" ? "haiku" : "agent");
    } else if (ev.type === "observation") {
      const [title, r1] = sanitizeMock(ev.title);
      const [body, r2] = sanitizeMock(ev.body);
      observations.unshift({ id: `obs_${Math.random().toString(36).slice(2, 10)}`, projectId: run.projectId, runId: run.id, taskId: run.taskId ?? null, agentProfileId: run.agentProfileId ?? null, kind: ev.kind, title, body, toolName: ev.toolName, redacted: r1 || r2, createdAt: notification.at, consolidatedAt: null });
    } else if (ev.type === "brief_injected") {
      contextEvents.push({ id: `ctx_${Math.random().toString(36).slice(2, 10)}`, projectId: run.projectId, runId: run.id, kind: "brief", payload: { chars: ev.chars, items: ev.items }, createdAt: notification.at });
    } else if (ev.type === "instructions_loaded") {
      contextEvents.push({ id: `ctx_${Math.random().toString(36).slice(2, 10)}`, projectId: run.projectId, runId: run.id, kind: "instructions", payload: { filePath: ev.filePath, memoryType: ev.memoryType, loadReason: ev.loadReason }, createdAt: notification.at });
    } else if (ev.type === "compaction") {
      contextEvents.push({ id: `ctx_${Math.random().toString(36).slice(2, 10)}`, projectId: run.projectId, runId: run.id, kind: `compaction_${ev.phase}`, payload: { trigger: ev.trigger, summary: ev.summary }, createdAt: notification.at });
    } else if (ev.type === "task_update") {
      const task = tasks.find((t) => t.id === run.taskId);
      if (task) {
        requestedByRun.set(run.id, ev.status);
        if (ev.note) task.lastNote = ev.note;
        pushTaskEvent(task.id, "agent_update", null, null, run.id, "agente", `${ev.status}${ev.note ? `: ${ev.note}` : ""}`);
      }
    } else if (ev.type === "permission_request") {
      run.status = "waiting_approval";
      recordApproval(run, notification.at, ev);
    }
    if (ev.type === "permission_request") {
      // Como o hook PreToolUse em Rust: a política decide antes de perguntar.
      const project = projects.find((p) => p.id === run.projectId);
      const decision = evaluatePolicyMock(rules.filter((r) => r.scope === "global" || r.projectId === run.projectId), project?.path ?? "/", ev.toolName, ev.input);
      if (decision.behavior !== "pass") audit("política", `policy.${decision.behavior}`, run.projectId, { runId, tool: ev.toolName, input: ev.input, ruleId: decision.ruleId, reason: decision.reason });
      if (decision.behavior === "deny") {
        run.status = "running";
        events.get(runId)!.pop();
        approvals.delete(approvalKey(runId, ev.requestId));
        emitEvent(runId, { type: "tool_use", toolUseId: `toolu_${ev.requestId}`, name: ev.toolName, input: ev.input, parentToolUseId: null });
        emitEvent(runId, { type: "tool_result", toolUseId: `toolu_${ev.requestId}`, content: `Bloqueado pela política: ${decision.reason}`, isError: true, parentToolUseId: null });
        schedule(runId, index + 1);
        return;
      }
      if (decision.behavior === "ask" && decision.reason) {
        notification.event = { ...ev, reason: decision.reason };
        const stored = events.get(runId)!.at(-1);
        if (stored) stored.event = notification.event;
        const approval = approvals.get(approvalKey(runId, ev.requestId));
        if (approval) approval.reason = decision.reason;
      }
    }
    emit("run:event", notification);
    if (ev.type === "permission_request") {
      // Pausa até decide_permission.
      pausedAt.set(runId, index + 1);
      return;
    }
    schedule(runId, index + 1);
  };

  const schedule = (runId: string, index: number) => {
    if (index >= scriptFor(runId).length) return;
    const timer = setTimeout(() => deliver(runId, index), tickMs);
    pendingTimers.set(runId, [...(pendingTimers.get(runId) ?? []), timer]);
  };

  const handlers: { [C in CommandName]: (args: Commands[C]["args"]) => Promise<Commands[C]["result"]> } = {
    runtime_info: async () => ({ protocolVersion: 1, runtimeVersion: "mock", sdkVersion: "mock" }),
    list_projects: async () => [...projects],
    create_project: async ({ input }) => {
      const project: Project = {
        id: `proj_${projects.length + 1}`,
        name: input.name,
        path: input.path,
        authMode: "subscription",
        createdAt: new Date().toISOString(),
        sandboxProfileId: "sandbox_dev",
      };
      projects.unshift(project);
      audit("você", "config.project.created", project.id, { name: project.name, path: project.path });
      writeSnapshot("auto");
      return project;
    },
    delete_project: async ({ projectId }) => {
      const index = projects.findIndex((p) => p.id === projectId);
      if (index === -1) return false;
      projects.splice(index, 1);
      writeSnapshot("auto");
      return true;
    },
    list_runs: async ({ projectId, limit }) =>
      [...runs.values()]
        .filter((r) => r.projectId === projectId)
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        .slice(0, limit ?? 50),
    get_run: async ({ runId }) => runs.get(runId) ?? null,
    get_project_totals: async ({ projectId }) => {
      const list = [...runs.values()].filter((r) => r.projectId === projectId);
      return {
        projectId,
        runs: list.length,
        costUsd: list.reduce((sum, r) => sum + (r.costUsd ?? 0), 0),
        inputTokens: list.reduce((sum, r) => sum + r.inputTokens, 0),
        outputTokens: list.reduce((sum, r) => sum + r.outputTokens, 0),
        cacheReadTokens: list.reduce((sum, r) => sum + r.cacheReadTokens, 0),
      };
    },
    list_run_events: async ({ runId }) => [...(events.get(runId) ?? [])],
    start_run: async ({ input }) => {
      const project = projects.find((p) => p.id === input.projectId);
      if (!project) throw new Error(`Projeto ${input.projectId} não encontrado`);
      if (!input.prompt.trim()) throw new Error("O prompt não pode ser vazio");
      const member = input.agentProfileId ? findMember(input.agentProfileId) : undefined;
      if (input.agentProfileId && !member) throw new Error(`Membro ${input.agentProfileId} não encontrado`);
      applyBudget(project.id, member?.profile.id ?? null);
      // Projetos em modo API key precisam da chave no "Keychain" (aqui, em memória); ela nunca entra no run gravado.
      if (project.authMode === "api_key" && !secrets.has(project.id)) throw new Error(`O projeto ${project.name} usa API key, mas nenhuma chave está no Keychain. Informe em Segurança → Autenticação ou mude para o login do Claude Code.`);
      const requested = input.options ?? {};
      const options = member
        ? {
            ...requested,
            systemPromptAppend: [`Você é ${member.profile.name}, ${member.role.title} do time deste projeto. Especialidade: ${member.role.specialty}.`, "", "Responsabilidades:", member.role.responsibilitiesMd, member.profile.instructionsMd ? `\nInstruções específicas:\n${member.profile.instructionsMd}` : "", requested.systemPromptAppend ?? ""].join("\n").trim(),
            permissionMode: requested.permissionMode ?? member.profile.permissionMode ?? member.role.defaultPermissionMode ?? undefined,
            allowedTools: requested.allowedTools ?? member.profile.allowedTools ?? member.role.defaultTools ?? undefined,
            maxBudgetUsd: requested.maxBudgetUsd ?? member.profile.maxBudgetUsd ?? undefined,
            agents: Object.fromEntries(
              members
                .filter((m) => m.reportsToAgentId === member.profile.id)
                .map((m) => [m.profile.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "membro", { description: `${m.role.title} · ${m.role.specialty}`, prompt: `Você é ${m.profile.name}, ${m.role.title} do time deste projeto.`, tools: m.profile.allowedTools ?? m.role.defaultTools ?? undefined }]),
            ),
          }
        : requested;
      if (options.agents && Object.keys(options.agents).length === 0) delete options.agents;
      {
        const defaults = (settings[`project.${project.id}.defaults`] as { model?: string | null; maxTurns?: number | null } | undefined) ?? {};
        if (!options.model && defaults.model) options.model = defaults.model;
        if (!options.maxTurns && defaults.maxTurns) options.maxTurns = defaults.maxTurns;
      }
      {
        const chosen = member?.profile.mcpServerIds ?? null;
        const active = mcpServers.filter((s) => s.enabled && (s.projectId === null || s.projectId === project.id) && (!chosen || chosen.includes(s.id)));
        if (active.length) options.mcpServers = Object.fromEntries(active.map((s) => [s.name, s.config]));
        // Plugin local com as skills ativas que o Claude Code não carrega sozinho (as do usuário; as do projeto só sem settingSources "project").
        const chosenSkills = member?.profile.skillIds ?? null;
        const sources = settings[`project.${project.id}.settingSources`];
        const projectAuto = !Array.isArray(sources) || sources.includes("project");
        const pluginSkills = skills.filter((s) => s.enabled && (s.projectId === null || s.projectId === project.id) && (!chosenSkills || chosenSkills.includes(s.id)) && !(projectAuto && s.projectId !== null));
        if (pluginSkills.length) options.plugins = [{ type: "local", path: `/mock/data/projects/${project.id}/harness/plugin-${member?.profile.id ?? "project"}`, skipMcpDiscovery: true }];
      }
      const profile = sandboxProfiles.find((sp) => sp.id === (project.sandboxProfileId ?? "sandbox_dev"));
      if (profile) options.sandbox = profile.settings;
      options.policyHooks = true;
      const run: Run = {
        id: `run_mock_${++runCounter}`,
        projectId: project.id,
        prompt: input.prompt,
        options,
        agentProfileId: member?.profile.id ?? null,
        kind: "agent",
        taskId: null,
        status: "running",
        claudeSessionId: null,
        model: input.options?.model ?? null,
        startedAt: new Date().toISOString(),
        endedAt: null,
        costUsd: null,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        numTurns: null,
        stopReason: null,
        resultText: null,
        errorMessage: null,
      };
      runs.set(run.id, run);
      events.set(run.id, []);
      const brief = buildBriefMock(run.projectId, null, run.prompt, run.id);
      if (brief) scriptByRun.set(run.id, [briefEvent(run.id, brief), ...script]);
      schedule(run.id, 0);
      return { ...run };
    },
    interrupt_run: async ({ runId }) => {
      const run = runs.get(runId);
      if (!run || !["running", "waiting_approval", "queued"].includes(run.status)) return false;
      for (const t of pendingTimers.get(runId) ?? []) clearTimeout(t);
      pendingTimers.delete(runId);
      pausedAt.delete(runId);
      run.status = "interrupted";
      run.endedAt = new Date().toISOString();
      run.errorMessage = "Run interrompido pelo usuário";
      closePendingApprovals(runId);
      finishTaskRun(run, false, "Run interrompido pelo usuário");
      emitEvent(runId, { type: "error", message: "Run interrompido pelo usuário", fatal: true });
      consolidateRunMock(run);
      return true;
    },
    decide_permission: async ({ input }) => {
      const resume = pausedAt.get(input.runId);
      if (resume === undefined) return false;
      pausedAt.delete(input.runId);
      const run = runs.get(input.runId)!;
      run.status = "running";
      const decision: PermissionDecision = input.decision;
      const pending = events.get(input.runId)?.findLast((e) => e.event.type === "permission_request" && e.event.requestId === input.requestId);
      const toolName = pending?.event.type === "permission_request" ? pending.event.toolName : "Bash";
      const toolInput = pending?.event.type === "permission_request" ? pending.event.input : {};
      const approval = approvals.get(approvalKey(input.runId, input.requestId));
      if (approval && approval.decision === null) {
        approval.decision = decision.behavior;
        approval.decisionMessage = decision.behavior === "deny" ? decision.message : (input.note?.trim() || null);
        approval.decidedAt = new Date().toISOString();
        audit("você", `approval.${decision.behavior}`, run.projectId, { runId: input.runId, requestId: input.requestId, tool: toolName, message: approval.decisionMessage });
      }
      // Como no SDK: a ferramenta aprovada ou negada aparece como tool_use seguido do seu tool_result.
      const toolUseId = `toolu_${input.requestId}`;
      emitEvent(input.runId, { type: "tool_use", toolUseId, name: toolName, input: toolInput, parentToolUseId: null });
      if (decision.behavior === "deny") {
        emitEvent(input.runId, { type: "tool_result", toolUseId, content: `Negado: ${decision.message}`, isError: true, parentToolUseId: null });
      } else {
        emitEvent(input.runId, { type: "tool_result", toolUseId, content: toolName === "Bash" ? "Tests run: 12, Failures: 0" : "OK", isError: false, parentToolUseId: null });
      }
      schedule(input.runId, resume);
      return true;
    },
    list_approvals: async ({ projectId, limit }) =>
      [...approvals.values()]
        .filter((a) => a.projectId === projectId)
        .sort((a, b) => Number(a.decision !== null) - Number(b.decision !== null) || b.requestedAt.localeCompare(a.requestedAt))
        .slice(0, limit ?? 100)
        .map((a) => ({ ...a })),
    read_project_file: async ({ path, maxBytes }) => {
      const key = path.replace(/^\/Users\/dev\/projetos\/chat-core\//, "");
      const content = MOCK_FILES[key];
      if (content === undefined) return { path, exists: false, content: "", truncated: false };
      const limit = maxBytes ?? 256 * 1024;
      return { path, exists: true, content: content.slice(0, limit), truncated: content.length > limit };
    },
    get_settings: async () => ({ ...settings }),
    set_setting: async ({ key, value }) => {
      if (value === null || value === undefined) delete settings[key];
      else settings[key] = value;
      audit("você", "config.setting", null, { key, value });
      writeSnapshot("auto");
      return null;
    },
    check_environment: async () => {
      const env = { node: true, claudeAuth: true, ...options.environment };
      return {
        node: env.node ? { ok: true, detail: "/opt/homebrew/bin/node · v23.1.0" } : { ok: false, detail: "Node.js não encontrado no PATH nem nos caminhos usuais. Instale o Node ou aponte OCTOPUS_NODE." },
        sidecar: { ok: true, detail: "agent-runtime mock · Claude Agent SDK mock" },
        claudeAuth: env.claudeAuth ? { ok: true, detail: "credencial do Claude Code no Keychain · login pessoal" } : { ok: false, detail: "nenhuma credencial do Claude Code no Keychain nem ANTHROPIC_API_KEY. Rode `claude` no Terminal e faça login." },
        authMethod: env.claudeAuth ? "keychain" : null,
        checkedAt: new Date().toISOString(),
      };
    },
    config_export: async ({ destination }) => ({ snapshot: writeSnapshot("manual"), copiedTo: destination ?? null }),
    config_export_json: async () => exportConfig(),
    config_import_preview: async ({ path }) => previewImport(readExport(path)),
    config_import: async ({ input }) => {
      const config = readExport(input.path);
      writeSnapshot("pre-restore");
      const result = importConfig(config, input.mode);
      writeSnapshot("auto");
      return result;
    },
    config_backups_list: async () => snapshots.map((s) => ({ ...s })),
    config_backup_preview: async ({ id }) => {
      const config = snapshotFiles.get(id);
      if (!config) throw new Error(`Cópia ${id} não encontrada`);
      return previewImport(config);
    },
    config_backup_restore: async ({ input }) => {
      const config = snapshotFiles.get(input.id);
      if (!config) throw new Error(`Cópia ${input.id} não encontrada`);
      writeSnapshot("pre-restore");
      const result = importConfig(config, input.mode);
      writeSnapshot("auto");
      return result;
    },
    config_backup_reveal: async () => null,
    list_roles: async ({ projectId }) => roles.filter((r) => r.scope === "global" || r.projectId === projectId).map((r) => ({ ...r })),
    create_role: async ({ input }) => {
      if (!input.input.title.trim()) throw new Error("Informe o título do cargo");
      const at = new Date().toISOString();
      const role: Role = {
        id: `role_${roles.length + 1}`,
        scope: input.projectId ? "project" : "global",
        projectId: input.projectId ?? null,
        title: input.input.title.trim(),
        specialty: input.input.specialty ?? "",
        responsibilitiesMd: input.input.responsibilitiesMd ?? "",
        defaultModel: input.input.defaultModel ?? null,
        defaultPermissionMode: input.input.defaultPermissionMode ?? null,
        defaultTools: input.input.defaultTools ?? null,
        icon: input.input.icon ?? null,
        position: roles.length + 1,
        createdAt: at,
        updatedAt: at,
      };
      roles.push(role);
      writeSnapshot("auto");
      return { ...role };
    },
    update_role: async ({ roleId, input }) => {
      const role = roles.find((r) => r.id === roleId);
      if (!role) throw new Error(`Cargo ${roleId} não encontrado`);
      if (!input.title.trim()) throw new Error("Informe o título do cargo");
      Object.assign(role, { title: input.title.trim(), specialty: input.specialty ?? role.specialty, responsibilitiesMd: input.responsibilitiesMd ?? role.responsibilitiesMd, defaultModel: input.defaultModel ?? null, defaultPermissionMode: input.defaultPermissionMode ?? null, defaultTools: input.defaultTools ?? null, icon: input.icon ?? null, updatedAt: new Date().toISOString() });
      for (const m of members) if (m.role.id === roleId) m.role = { ...role };
      writeSnapshot("auto");
      return { ...role };
    },
    delete_role: async ({ roleId }) => {
      if (members.some((m) => m.role.id === roleId)) throw new Error("O cargo tem membro(s); mude o cargo deles antes de remover");
      const index = roles.findIndex((r) => r.id === roleId);
      if (index === -1) return false;
      roles.splice(index, 1);
      return true;
    },
    list_team: async ({ projectId }) => members.filter((m) => m.projectId === projectId).map((m) => ({ ...m, profile: { ...m.profile }, role: { ...m.role } })),
    add_team_member: async ({ projectId, input }) => {
      const member = buildMember(projectId, input);
      members.push(member);
      audit("você", "team.member.added", projectId, { agentProfileId: member.profile.id, name: member.profile.name, role: member.role.title });
      writeSnapshot("auto");
      return { ...member };
    },
    update_team_member: async ({ agentProfileId, input }) => {
      const existing = findMember(agentProfileId);
      if (!existing) throw new Error(`Membro ${agentProfileId} não encontrado`);
      const updated = buildMember(existing.projectId, input, existing);
      members.splice(members.indexOf(existing), 1, updated);
      writeSnapshot("auto");
      return { ...updated };
    },
    remove_team_member: async ({ agentProfileId }) => {
      const existing = findMember(agentProfileId);
      if (!existing) return false;
      members.splice(members.indexOf(existing), 1);
      for (const m of members) if (m.reportsToAgentId === agentProfileId) m.reportsToAgentId = null;
      for (const r of runs.values()) if (r.agentProfileId === agentProfileId) r.agentProfileId = null;
      writeSnapshot("auto");
      return true;
    },
    team_totals: async ({ projectId }) => {
      const byAgent = new Map<string, { runs: number; activeRuns: number; costUsd: number; lastRunAt: string | null }>();
      for (const r of runs.values()) {
        if (r.projectId !== projectId || !r.agentProfileId) continue;
        const t = byAgent.get(r.agentProfileId) ?? { runs: 0, activeRuns: 0, costUsd: 0, lastRunAt: null };
        t.runs++;
        if (["queued", "running", "waiting_approval"].includes(r.status)) t.activeRuns++;
        t.costUsd += r.costUsd ?? 0;
        if (!t.lastRunAt || r.startedAt > t.lastRunAt) t.lastRunAt = r.startedAt;
        byAgent.set(r.agentProfileId, t);
      }
      return [...byAgent].map(([agentProfileId, t]) => ({ agentProfileId, ...t }));
    },
    list_workflow_templates: async () => WORKFLOW_TEMPLATES.map((t) => ({ ...t, stages: t.stages.map((s) => ({ ...s })) })),
    list_workflows: async ({ projectId }) => workflows.filter((w) => w.projectId === projectId).map((w) => ({ ...w, stages: w.stages.map((s) => ({ ...s })) })),
    create_workflow: async ({ projectId, input }) => {
      if (!input.name.trim()) throw new Error("Informe o nome do workflow");
      if (input.stages.length === 0) throw new Error("Um workflow precisa de pelo menos um estágio");
      const wf: Workflow = { id: `wf_${++wfCounter}`, projectId, name: input.name.trim(), stages: input.stages.map((s) => ({ ...s })), useWorktrees: input.useWorktrees ?? false, maxParallel: Math.max(1, input.maxParallel ?? 1), createdAt: new Date().toISOString() };
      workflows.push(wf);
      writeSnapshot("auto");
      return { ...wf };
    },
    create_workflow_from_template: async ({ input }) => {
      const template = WORKFLOW_TEMPLATES.find((t) => t.id === input.templateId);
      if (!template) throw new Error(`Modelo ${input.templateId} não existe`);
      const team = members.filter((m) => m.projectId === input.projectId);
      const stages: Stage[] = template.stages.map((s, i) => ({
        id: `stage_${i + 1}`,
        name: s.name,
        agentProfileId: s.roleTitle ? (team.find((m) => m.role.title.toLowerCase() === s.roleTitle!.toLowerCase())?.profile.id ?? null) : null,
        gate: s.gate,
        instruction: TEMPLATE_INSTRUCTIONS[s.name] ?? null,
      }));
      const wf: Workflow = { id: `wf_${++wfCounter}`, projectId: input.projectId, name: template.name, stages, useWorktrees: input.useWorktrees ?? false, maxParallel: 1, createdAt: new Date().toISOString() };
      workflows.push(wf);
      writeSnapshot("auto");
      return { ...wf };
    },
    update_workflow: async ({ workflowId, input }) => {
      const wf = workflows.find((w) => w.id === workflowId);
      if (!wf) throw new Error(`Workflow ${workflowId} não encontrado`);
      Object.assign(wf, { name: input.name.trim(), stages: input.stages.map((s) => ({ ...s })), useWorktrees: input.useWorktrees ?? wf.useWorktrees, maxParallel: Math.max(1, input.maxParallel ?? wf.maxParallel) });
      return { ...wf };
    },
    delete_workflow: async ({ workflowId }) => {
      const index = workflows.findIndex((w) => w.id === workflowId);
      if (index === -1) return false;
      workflows.splice(index, 1);
      for (const t of [...tasks]) if (t.workflowId === workflowId) tasks.splice(tasks.indexOf(t), 1);
      return true;
    },
    list_tasks: async ({ projectId }) => tasks.filter((t) => t.projectId === projectId).map((t) => ({ ...t, dependsOn: [...t.dependsOn] })),
    create_task: async ({ projectId, workflowId, input }) => {
      if (!input.title.trim()) throw new Error("Informe o título da task");
      const wf = workflows.find((w) => w.id === workflowId);
      if (!wf) throw new Error(`Workflow ${workflowId} não encontrado`);
      const stageId = input.stageId ?? wf.stages[0]!.id;
      if (!wf.stages.some((s) => s.id === stageId)) throw new Error(`Estágio ${stageId} não existe neste workflow`);
      for (const dep of input.dependsOn ?? []) if (!tasks.some((t) => t.id === dep)) throw new Error(`Dependência ${dep} não encontrada`);
      const at = new Date().toISOString();
      const task: Task = { id: `task_${++taskCounter}`, projectId, workflowId, stageId, title: input.title.trim(), descriptionMd: input.descriptionMd?.trim() ?? "", acceptanceMd: input.acceptanceMd?.trim() ?? "", status: input.ready === false ? "backlog" : "ready", assignedAgentId: input.assignedAgentId ?? null, dependsOn: [...(input.dependsOn ?? [])], worktreePath: null, lockRunId: null, lastNote: null, position: tasks.length + 1, createdAt: at, updatedAt: at };
      tasks.push(task);
      pushTaskEvent(task.id, "created", null, stageId, null, "você", null);
      return { ...task };
    },
    update_task: async ({ taskId, input }) => {
      const task = tasks.find((t) => t.id === taskId);
      if (!task) throw new Error(`Task ${taskId} não encontrada`);
      if (!input.title.trim()) throw new Error("Informe o título da task");
      Object.assign(task, { title: input.title.trim(), descriptionMd: input.descriptionMd?.trim() ?? task.descriptionMd, acceptanceMd: input.acceptanceMd?.trim() ?? task.acceptanceMd, stageId: input.stageId ?? task.stageId, assignedAgentId: input.assignedAgentId ?? null, dependsOn: [...(input.dependsOn ?? task.dependsOn)], updatedAt: new Date().toISOString() });
      return { ...task };
    },
    delete_task: async ({ taskId }) => {
      const index = tasks.findIndex((t) => t.id === taskId);
      if (index === -1) return false;
      tasks.splice(index, 1);
      return true;
    },
    move_task: async ({ input }) => {
      const task = tasks.find((t) => t.id === input.taskId);
      if (!task) throw new Error(`Task ${input.taskId} não encontrada`);
      if (task.status === "running") throw new Error("A task está em run; interrompa o run antes de movê-la");
      const from = task.stageId;
      task.stageId = input.stageId ?? task.stageId;
      task.status = input.status;
      if (input.note) task.lastNote = input.note;
      task.updatedAt = new Date().toISOString();
      pushTaskEvent(task.id, "moved", from, task.stageId, null, "você", input.note ?? null);
      return { ...task };
    },
    approve_task: async ({ taskId, note }) => {
      const task = tasks.find((t) => t.id === taskId);
      if (!task) throw new Error(`Task ${taskId} não encontrada`);
      if (task.status !== "waiting_approval" && task.status !== "review") throw new Error("A task não está aguardando aprovação");
      const wf = workflows.find((w) => w.id === task.workflowId)!;
      advanceTask(task, wf, "você", note ?? "aprovado", true);
      return { ...task };
    },
    return_task: async ({ taskId, stageId, note }) => {
      const task = tasks.find((t) => t.id === taskId);
      if (!task) throw new Error(`Task ${taskId} não encontrada`);
      const from = task.stageId;
      task.stageId = stageId;
      task.status = "ready";
      if (note) task.lastNote = note;
      pushTaskEvent(task.id, "returned", from, stageId, null, "você", note ?? null);
      return { ...task };
    },
    list_task_events: async ({ taskId }) => taskEventsLog.filter((e) => e.taskId === taskId).map((e) => ({ ...e })),
    scheduler_tick: async () => {
      const report: TickReport = { started: [], failed: [], parked: 0, paused: settings["scheduler.paused"] === true };
      if (report.paused) return report;
      for (const project of projects) {
        for (const task of tasks.filter((t) => t.projectId === project.id && t.status === "ready")) {
          const wf = workflows.find((w) => w.id === task.workflowId);
          const stage = wf?.stages.find((s) => s.id === task.stageId);
          if (stage?.gate) {
            task.status = "waiting_approval";
            report.parked++;
          }
        }
        for (const { task, workflow, stage } of runnableTasks(project.id)) {
          const agentId = stage.agentProfileId ?? task.assignedAgentId;
          const member = agentId ? findMember(agentId) : undefined;
          const prompt = `Task ${task.id} do board "${workflow.name}", estágio "${stage.name}".\n\n# ${task.title}\n${task.descriptionMd}`;
          const run: Run = {
            id: `run_mock_${++runCounter}`,
            projectId: project.id,
            prompt,
            options: { maxTurns: 40, includePartialMessages: true, taskContext: { taskId: task.id, title: task.title, stage: stage.name, allowedStatuses: ["done", "review", "blocked"] }, ...(member ? { systemPromptAppend: `Você é ${member.profile.name}, ${member.role.title} do time deste projeto.`, permissionMode: member.profile.permissionMode ?? member.role.defaultPermissionMode ?? undefined } : {}) },
            agentProfileId: member?.profile.id ?? null,
            kind: "agent",
            taskId: task.id,
            status: "running",
            claudeSessionId: null,
            model: null,
            startedAt: new Date().toISOString(),
            endedAt: null,
            costUsd: null,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            numTurns: null,
            stopReason: null,
            resultText: null,
            errorMessage: null,
          };
          runs.set(run.id, run);
          events.set(run.id, []);
          const taskBrief = buildBriefMock(project.id, task.id, prompt, run.id);
          scriptByRun.set(run.id, taskBrief ? [briefEvent(run.id, taskBrief), ...taskRunEvents()] : taskRunEvents());
          task.status = "running";
          task.lockRunId = run.id;
          task.updatedAt = run.startedAt;
          pushTaskEvent(task.id, "run_started", task.stageId, task.stageId, run.id, "scheduler", null);
          schedule(run.id, 0);
          report.started.push({ taskId: task.id, runId: run.id, projectId: project.id });
        }
      }
      if (report.started.length > 0 || report.parked > 0) emit("board:changed", report);
      return report;
    },
    list_audit_events: async ({ projectId, kindPrefix, limit }) =>
      auditLog
        .filter((e) => (!projectId || e.projectId === projectId || e.projectId === null) && (!kindPrefix || e.kind.startsWith(kindPrefix)))
        .slice()
        .reverse()
        .slice(0, limit ?? 200)
        .map((e) => ({ ...e })),
    verify_audit: async () => {
      let expectedPrev = "0".repeat(64);
      let firstBroken: number | null = null;
      for (const e of auditLog) {
        const recomputed = tampered === e.seq ? "deadbeef".repeat(8) : fakeHash(`${e.prevHash}|${e.ts}|${e.actor}|${e.kind}|${e.projectId ?? ""}|${JSON.stringify(e.payload)}`);
        if (firstBroken === null && (e.prevHash !== expectedPrev || recomputed !== e.hash)) firstBroken = e.seq;
        expectedPrev = e.hash;
      }
      return { ok: firstBroken === null, events: auditLog.length, firstBrokenSeq: firstBroken, intactBefore: firstBroken === null ? auditLog.length : firstBroken - 1, checkedAt: new Date().toISOString() };
    },
    export_audit: async ({ destination }) => {
      const jsonl = auditLog.map((e) => JSON.stringify(e)).join("\n") + (auditLog.length ? "\n" : "");
      if (destination) {
        audit("você", "audit.exported", null, { path: destination, events: auditLog.length });
        return destination;
      }
      return jsonl;
    },
    list_policy_rules: async ({ projectId }) => rules.filter((r) => r.scope === "global" || r.projectId === projectId).map((r) => ({ ...r })),
    create_policy_rule: async ({ input }) => {
      if (!input.input.pattern.trim()) throw new Error("Informe o padrão da regra");
      if (input.projectId && input.input.action === "allow") throw new Error("Regras do projeto só podem apertar (negar ou perguntar); permitir só no escopo global");
      if (input.input.kind === "command" && !input.input.pattern.startsWith("@")) new RegExp(input.input.pattern);
      const at = new Date().toISOString();
      const rule: PolicyRule = { id: `rule_${++ruleCounter}`, scope: input.projectId ? "project" : "global", projectId: input.projectId ?? null, kind: input.input.kind, pattern: input.input.pattern.trim(), action: input.input.action, reason: input.input.reason?.trim() ?? "", enabled: input.input.enabled ?? true, builtin: false, position: rules.length + 1, createdAt: at, updatedAt: at };
      rules.push(rule);
      audit("você", "config.rule.created", rule.projectId, { ruleId: rule.id, kind: rule.kind, pattern: rule.pattern, action: rule.action });
      return { ...rule };
    },
    update_policy_rule: async ({ ruleId, input }) => {
      const rule = rules.find((r) => r.id === ruleId);
      if (!rule) throw new Error(`Regra ${ruleId} não encontrada`);
      if (rule.projectId && input.action === "allow") throw new Error("Regras do projeto só podem apertar (negar ou perguntar); permitir só no escopo global");
      Object.assign(rule, { kind: input.kind, pattern: input.pattern.trim(), action: input.action, reason: input.reason?.trim() ?? rule.reason, enabled: input.enabled ?? rule.enabled, updatedAt: new Date().toISOString() });
      audit("você", "config.rule.updated", rule.projectId, { ruleId: rule.id, action: rule.action, enabled: rule.enabled });
      return { ...rule };
    },
    set_policy_rule_enabled: async ({ ruleId, enabled }) => {
      const rule = rules.find((r) => r.id === ruleId);
      if (!rule) throw new Error(`Regra ${ruleId} não encontrada`);
      rule.enabled = enabled;
      rule.updatedAt = new Date().toISOString();
      audit("você", "config.rule.toggled", rule.projectId, { ruleId, enabled });
      return { ...rule };
    },
    delete_policy_rule: async ({ ruleId }) => {
      const rule = rules.find((r) => r.id === ruleId);
      if (!rule) return false;
      if (rule.builtin) throw new Error("Regras do catálogo não podem ser removidas; desative-a");
      rules.splice(rules.indexOf(rule), 1);
      audit("você", "config.rule.deleted", null, { ruleId });
      return true;
    },
    evaluate_policy: async ({ projectId, toolName, input }) => {
      const project = projects.find((p) => p.id === projectId);
      if (!project) throw new Error(`Projeto ${projectId} não encontrado`);
      const decision = evaluatePolicyMock(rules.filter((r) => r.scope === "global" || r.projectId === projectId), project.path, toolName, input);
      if (decision.behavior !== "pass") audit("política", `policy.${decision.behavior}`, projectId, { tool: toolName, input, ruleId: decision.ruleId, reason: decision.reason });
      return decision;
    },
    list_sandbox_profiles: async () => sandboxProfiles.map((p) => ({ ...p })),
    list_memory_pages: async ({ projectId, includeArchived }) => pages.filter((p) => p.projectId === projectId && (includeArchived || !p.archivedAt)).map((p) => ({ ...p })),
    get_memory_page: async ({ pageId }) => {
      const page = pages.find((p) => p.id === pageId);
      if (!page) return null;
      page.accessCount += 1;
      page.lastAccessedAt = new Date().toISOString();
      page.score = Math.min(1, page.score + 0.05);
      return { ...page };
    },
    search_memory: async ({ projectId, query, limit }) => {
      const terms = query
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .split(/[^a-z0-9_-]+/)
        .filter((t) => t.length >= 2);
      if (terms.length === 0) return [];
      const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      const hits: MemorySearchHit[] = [];
      for (const page of pages) {
        if (page.projectId !== projectId || page.archivedAt) continue;
        const title = norm(page.title);
        const body = norm(page.bodyMd);
        let rank = 0;
        let firstIdx = -1;
        for (const t of terms) {
          if (title.includes(t)) rank += 3;
          const idx = body.indexOf(t);
          if (idx >= 0) {
            rank += 1;
            if (firstIdx < 0) firstIdx = idx;
          }
        }
        if (rank === 0) continue;
        const start = Math.max(0, firstIdx - 40);
        const snippet = firstIdx >= 0 ? `${start > 0 ? "…" : ""}${page.bodyMd.slice(start, firstIdx)}«${page.bodyMd.slice(firstIdx, firstIdx + terms[0]!.length)}»${page.bodyMd.slice(firstIdx + terms[0]!.length, firstIdx + 80)}…` : page.title;
        hits.push({ page: { ...page }, snippet, rank: rank * (0.5 + page.score) });
      }
      return hits.sort((a, b) => b.rank - a.rank).slice(0, limit ?? 20);
    },
    save_memory_page: async ({ input }) => {
      const reason = input.pageId ? "edição manual" : "criação manual";
      const page = savePageMock(input, reason, "manual");
      audit("você", "memory.page", input.projectId, { pageId: page.id, kind: page.kind, title: page.title, reason });
      return { ...page };
    },
    set_memory_page_archived: async ({ pageId, archived }) => {
      const page = pages.find((p) => p.id === pageId);
      if (!page) throw new Error(`Página ${pageId} não encontrada`);
      page.archivedAt = archived ? new Date().toISOString() : null;
      audit("você", archived ? "memory.page.archived" : "memory.page.restored", page.projectId, { pageId, title: page.title });
      return { ...page };
    },
    list_memory_page_versions: async ({ pageId }) => pageVersions.filter((v) => v.pageId === pageId).map((v) => ({ ...v })),
    list_memory_observations: async ({ projectId, runId, limit }) => observations.filter((o) => o.projectId === projectId && (!runId || o.runId === runId)).slice(0, limit ?? 200).map((o) => ({ ...o })),
    list_context_events: async ({ runId }) => contextEvents.filter((c) => c.runId === runId).map((c) => ({ ...c })),
    list_context_pins: async ({ projectId }) => pins.filter((p) => p.projectId === projectId).map((p) => ({ ...p })),
    add_context_pin: async ({ projectId, input }) => {
      const ref = input.ref.trim();
      if (!ref) throw new Error("O pin precisa de um arquivo, página ou texto");
      if (input.kind === "page" && !pages.some((p) => p.id === ref)) throw new Error(`Página ${ref} não encontrada`);
      const label = input.label?.trim() || (input.kind === "page" ? (pages.find((p) => p.id === ref)?.title ?? ref) : input.kind === "text" ? ref.slice(0, 60) : ref);
      const pin: ContextPin = { id: `pin_${Math.random().toString(36).slice(2, 10)}`, projectId, kind: input.kind, ref, label, position: pins.length + 1, createdAt: new Date().toISOString() };
      pins.push(pin);
      audit("você", "context.pin.added", projectId, { pinId: pin.id, kind: pin.kind, label: pin.label });
      writeSnapshot("auto");
      return { ...pin };
    },
    remove_context_pin: async ({ projectId, pinId }) => {
      const index = pins.findIndex((p) => p.id === pinId);
      if (index === -1) return false;
      pins.splice(index, 1);
      audit("você", "context.pin.removed", projectId, { pinId });
      return true;
    },
    list_mcp_servers: async ({ projectId }) => mcpServers.filter((s) => s.projectId === null || (projectId && s.projectId === projectId)).sort((a, b) => Number(a.projectId !== null) - Number(b.projectId !== null) || a.name.localeCompare(b.name)).map((s) => ({ ...s })),
    save_mcp_server: async ({ input }) => {
      const name = input.name.trim();
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) throw new Error("Nome inválido: use letras, números, hífen ou sublinhado (até 64)");
      if (name === "octopus") throw new Error('O nome "octopus" é do servidor embutido');
      if (input.config.type !== "stdio" && !/^https?:\/\//.test(input.config.url)) throw new Error("A URL precisa começar com http:// ou https://");
      const clash = mcpServers.find((s) => s.name === name && (s.projectId ?? null) === (input.projectId ?? null) && s.id !== input.id);
      if (clash) throw new Error(`Já existe um MCP server chamado ${name} neste escopo`);
      const ts = new Date().toISOString();
      let server = input.id ? mcpServers.find((s) => s.id === input.id) : undefined;
      if (server) {
        Object.assign(server, { name, projectId: input.projectId ?? null, transport: input.config.type, config: input.config, enabled: input.enabled ?? server.enabled, lastHealth: null, updatedAt: ts });
      } else {
        server = { id: `mcp_${Math.random().toString(36).slice(2, 10)}`, projectId: input.projectId ?? null, name, transport: input.config.type, config: input.config, enabled: input.enabled ?? true, lastHealth: null, createdAt: ts, updatedAt: ts };
        mcpServers.push(server);
      }
      audit("você", input.id ? "harness.mcp.updated" : "harness.mcp.created", server.projectId, { serverId: server.id, name, transport: server.transport, config: describeMcp(server.config) });
      writeSnapshot("auto");
      return { ...server };
    },
    set_mcp_server_enabled: async ({ serverId, enabled }) => {
      const server = mcpServers.find((s) => s.id === serverId);
      if (!server) throw new Error(`MCP server ${serverId} não encontrado`);
      server.enabled = enabled;
      server.updatedAt = new Date().toISOString();
      audit("você", "harness.mcp.enabled", server.projectId, { serverId, name: server.name, enabled });
      return { ...server };
    },
    delete_mcp_server: async ({ serverId }) => {
      const index = mcpServers.findIndex((s) => s.id === serverId);
      if (index === -1) return false;
      const [server] = mcpServers.splice(index, 1);
      audit("você", "harness.mcp.deleted", server!.projectId, { serverId, name: server!.name });
      return true;
    },
    check_mcp_server: async ({ serverId }) => {
      const server = mcpServers.find((s) => s.id === serverId);
      if (!server) throw new Error(`MCP server ${serverId} não encontrado`);
      // Mock: falha quando o alvo contém "fail"; senão devolve duas tools.
      const target = describeMcp(server.config);
      const ok = !target.includes("fail");
      server.lastHealth = ok ? { ok: true, tools: [{ name: "read_file", description: "Lê um arquivo" }, { name: "list_dir", description: null }], error: null, latencyMs: 42, serverVersion: "mock 1.0", checkedAt: new Date().toISOString() } : { ok: false, tools: [], error: "ECONNREFUSED", latencyMs: 5, serverVersion: null, checkedAt: new Date().toISOString() };
      audit("você", "harness.mcp.checked", server.projectId, { serverId, name: server.name, ok, tools: server.lastHealth.tools.length, error: server.lastHealth.error });
      return { ...server };
    },
    list_skills: async ({ projectId }) => skills.filter((s) => s.projectId === null || s.projectId === projectId).sort((a, b) => Number(a.projectId === null) - Number(b.projectId === null) || a.name.localeCompare(b.name)).map((s) => ({ ...s })),
    scan_skills: async ({ projectId }) => {
      audit("você", "harness.skills.scanned", projectId, { count: skills.filter((s) => s.projectId === null || s.projectId === projectId).length });
      return handlers.list_skills({ projectId });
    },
    set_skill_enabled: async ({ skillId, enabled }) => {
      const skill = skills.find((s) => s.id === skillId);
      if (!skill) throw new Error(`Skill ${skillId} não encontrada`);
      skill.enabled = enabled;
      skill.updatedAt = new Date().toISOString();
      audit("você", "harness.skill.enabled", skill.projectId, { skillId, name: skill.name, enabled });
      return { ...skill };
    },
    read_skill: async ({ skillId }) => {
      if (!skills.some((s) => s.id === skillId)) throw new Error(`Skill ${skillId} não encontrada`);
      return skillFiles.get(skillId) ?? "";
    },
    save_skill: async ({ input }) => {
      const name = input.name.trim();
      if (!name) throw new Error("A skill precisa de nome");
      if (!input.content.trim()) throw new Error("O SKILL.md não pode ser vazio");
      const project = projects.find((p) => p.id === input.projectId);
      if (!project) throw new Error(`Projeto ${input.projectId} não encontrado`);
      const content = input.content.startsWith("---\n") ? input.content : `---\nname: ${name}\ndescription: ${input.content.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#"))?.slice(0, 120) ?? ""}\n---\n\n${input.content.trimStart()}`;
      const [parsedName, description] = parseSkillMd(content, name);
      const ts = new Date().toISOString();
      let skill = input.skillId ? skills.find((s) => s.id === input.skillId) : undefined;
      if (skill) {
        Object.assign(skill, { name: parsedName, description, updatedAt: ts });
      } else {
        skill = { id: `skill_${Math.random().toString(36).slice(2, 10)}`, projectId: project.id, name: parsedName, path: `${project.path}/.claude/skills/${slugSkill(name)}`, description, source: "project", enabled: true, createdAt: ts, updatedAt: ts };
        skills.push(skill);
      }
      skillFiles.set(skill.id, content);
      audit("você", input.skillId ? "harness.skill.updated" : "harness.skill.created", project.id, { skillId: skill.id, name: skill.name, path: skill.path });
      return { ...skill };
    },
    preview_run_options: async ({ input }) => {
      const project = projects.find((p) => p.id === input.projectId);
      if (!project) throw new Error(`Projeto ${input.projectId} não encontrado`);
      const member = input.agentProfileId ? findMember(input.agentProfileId) : undefined;
      if (input.agentProfileId && !member) throw new Error(`Membro ${input.agentProfileId} não encontrado`);
      const requested = input.options ?? {};
      const notes: PreviewNote[] = [];
      const note = (field: string, value: string, origin: string) => notes.push({ field, value, origin });
      const options: RunOptions = { ...requested };
      if (member) {
        options.systemPromptAppend = `Você é ${member.profile.name}, ${member.role.title} do time deste projeto.`;
        options.model = requested.model ?? member.profile.model ?? member.role.defaultModel ?? undefined;
        options.permissionMode = requested.permissionMode ?? member.profile.permissionMode ?? member.role.defaultPermissionMode ?? undefined;
        options.allowedTools = requested.allowedTools ?? member.profile.allowedTools ?? member.role.defaultTools ?? undefined;
        options.maxTurns = requested.maxTurns ?? member.profile.maxTurns ?? undefined;
        options.maxBudgetUsd = requested.maxBudgetUsd ?? member.profile.maxBudgetUsd ?? undefined;
        if (options.model) note("model", options.model, requested.model ? "pedido" : member.profile.model ? "membro" : "cargo");
        if (options.permissionMode) note("permissionMode", options.permissionMode, requested.permissionMode ? "pedido" : member.profile.permissionMode ? "membro" : "cargo");
        if (options.allowedTools) note("allowedTools", options.allowedTools.join(", "), requested.allowedTools ? "pedido" : member.profile.allowedTools ? "membro" : "cargo");
        if (options.maxTurns) note("maxTurns", String(options.maxTurns), requested.maxTurns ? "pedido" : "membro");
        if (options.maxBudgetUsd) note("maxBudgetUsd", options.maxBudgetUsd.toFixed(2), requested.maxBudgetUsd ? "pedido" : "membro");
        note("systemPrompt.append", `${options.systemPromptAppend.length} caracteres (cargo + membro)`, "cargo + membro");
      } else {
        if (options.model) note("model", options.model, "pedido");
        if (options.permissionMode) note("permissionMode", options.permissionMode, "pedido");
        if (options.maxTurns) note("maxTurns", String(options.maxTurns), "pedido");
      }
      const defaults = (settings[`project.${project.id}.defaults`] as { model?: string | null; maxTurns?: number | null } | undefined) ?? {};
      if (!options.model && defaults.model) {
        options.model = defaults.model;
        note("model", defaults.model, "projeto");
      }
      if (!options.maxTurns && defaults.maxTurns) {
        options.maxTurns = defaults.maxTurns;
        note("maxTurns", String(defaults.maxTurns), "projeto");
      }
      if (!options.model) note("model", "padrão do Claude Code", "padrão");
      options.policyHooks = true;
      const activeRules = rules.filter((r) => r.enabled && (r.scope === "global" || r.projectId === project.id));
      note("policyHooks", `true · ${activeRules.length} regras ativas (${activeRules.filter((r) => r.scope === "global").length} globais, ${activeRules.filter((r) => r.scope !== "global").length} do projeto)`, "segurança");
      const profile = sandboxProfiles.find((sp) => sp.id === (project.sandboxProfileId ?? "sandbox_dev"));
      if (profile) options.sandbox = profile.settings;
      note("sandbox", profile?.name ?? "Dev padrão", "segurança");
      const brief = buildBriefMock(project.id, null, input.prompt ?? "", "preview", false);
      options.memory = { capture: true, tools: true, ...(brief ? { brief: brief.text, briefItems: brief.items } : {}) };
      note("memory.brief", brief ? `${brief.text.length} caracteres · ${brief.items.join(" · ")}` : "nada ainda (memória vazia para este pedido)", "memória");
      note("memory.capture", "observações por hooks", "memória");
      const sources = settings[`project.${project.id}.settingSources`];
      if (Array.isArray(sources)) options.settingSources = sources as RunOptions["settingSources"];
      note("settingSources", !Array.isArray(sources) ? "padrão do Claude Code (usuário + projeto)" : sources.length === 0 ? "nenhuma (sem CLAUDE.md nem rules)" : sources.join(", "), "contexto");
      const chosen = member?.profile.mcpServerIds ?? null;
      const active = mcpServers.filter((s) => s.enabled && (s.projectId === null || s.projectId === project.id) && (!chosen || chosen.includes(s.id)));
      if (active.length) options.mcpServers = Object.fromEntries(active.map((s) => [s.name, s.config]));
      note("mcpServers", ["octopus (sdk)", ...active.map((s) => `${s.name} (${s.transport})`)].join(", "), "harness");
      const chosenSkills = member?.profile.skillIds ?? null;
      const projectAuto = !Array.isArray(sources) || sources.includes("project");
      const pluginSkills = skills.filter((s) => s.enabled && (s.projectId === null || s.projectId === project.id) && (!chosenSkills || chosenSkills.includes(s.id)) && !(projectAuto && s.projectId !== null)).map((s) => s.name);
      note("plugins", pluginSkills.length ? `1 local · skills ${pluginSkills.join(", ")}` : "nenhum plugin (skills do projeto já entram pelo settingSources)", "harness");
      if (project.authMode === "api_key") {
        const has = secrets.has(project.id);
        options.env = { ANTHROPIC_API_KEY: has ? "••• (Keychain)" : "(sem chave no Keychain!)" };
        note("env", `ANTHROPIC_API_KEY=${has ? "••• do Keychain" : "AUSENTE: o run vai falhar"}`, "autenticação");
      } else {
        note("env", "login do Claude Code (sem chave)", "autenticação");
      }
      const hooks: HookInfo[] = [{ event: "PreToolUse", description: `Motor de política em Rust (${activeRules.length} regras ativas): nega, pergunta ou deixa passar antes de cada ferramenta`, origin: "Segurança · Política" }];
      if (brief) hooks.push({ event: "UserPromptSubmit", description: "Injeta o brief de memória (handoff pendente, páginas relevantes, pins) uma vez por run", origin: "Memória · Contexto" });
      hooks.push(
        { event: "PostToolUse", description: "Observação por ferramenta (sanitizada) para a memória", origin: "Memória" },
        { event: "Stop · SubagentStop", description: "Resumo do turno e dos subagentes vira observação", origin: "Memória" },
        { event: "PreCompact · PostCompact", description: "Registra compactações e o resumo gerado", origin: "Memória · Contexto" },
        { event: "InstructionsLoaded", description: "Lista CLAUDE.md e rules carregados", origin: "Memória · Contexto" },
        { event: "SessionEnd", description: "Fecha o run; consolidação da memória em seguida", origin: "Memória" },
      );
      return { options, notes, hooks, pluginSkills };
    },
    check_update: async () => {
      const endpoint = typeof settings["updates.endpoint"] === "string" ? (settings["updates.endpoint"] as string).trim() : "";
      if (!endpoint) return { configured: false, currentVersion: "0.1.0", available: false, version: null, notes: null, date: null };
      if (endpoint.includes("offline")) throw new Error("Não consegui verificar: servidor indisponível");
      const available = endpoint.includes("nova");
      return { configured: true, currentVersion: "0.1.0", available, version: available ? "0.2.0" : null, notes: available ? "Melhorias no harness e correções." : null, date: available ? "2026-10-20T10:00:00Z" : null };
    },
    install_update: async () => {
      audit("você", "app.updated", null, { version: "0.2.0" });
      return null;
    },
    list_memory_handoffs: async ({ projectId }) => handoffs.filter((h) => h.projectId === projectId).sort((a, b) => Number(Boolean(a.consumedAt)) - Number(Boolean(b.consumedAt)) || b.createdAt.localeCompare(a.createdAt)).map((h) => ({ ...h })),
    rebuild_memory_index: async ({ projectId }) => {
      const n = pages.filter((p) => p.projectId === projectId).length;
      audit("você", "memory.reindex", projectId, { pages: n });
      return n;
    },
    update_project_auth: async ({ projectId, authMode }) => {
      const project = projects.find((p) => p.id === projectId);
      if (!project) throw new Error(`Projeto ${projectId} não encontrado`);
      project.authMode = authMode;
      audit("você", "config.project", projectId, { authMode });
      writeSnapshot("auto");
      return { ...project };
    },
    set_project_api_key: async ({ projectId, apiKey }) => {
      if (!apiKey.trim()) throw new Error("A chave não pode ser vazia");
      if (!projects.some((p) => p.id === projectId)) throw new Error(`Projeto ${projectId} não encontrado`);
      secrets.set(projectId, apiKey.trim());
      audit("você", "secret.set", projectId, { key: "ANTHROPIC_API_KEY", value: "valor não registrado" });
      return null;
    },
    clear_project_api_key: async ({ projectId }) => {
      secrets.delete(projectId);
      audit("você", "secret.cleared", projectId, { key: "ANTHROPIC_API_KEY" });
      return null;
    },
    has_project_api_key: async ({ projectId }) => secrets.has(projectId),
    set_project_sandbox: async ({ projectId, profileId }) => {
      const project = projects.find((p) => p.id === projectId);
      if (!project) throw new Error(`Projeto ${projectId} não encontrado`);
      if (!sandboxProfiles.some((p) => p.id === profileId)) throw new Error(`Perfil de sandbox ${profileId} não existe`);
      project.sandboxProfileId = profileId;
      audit("você", "config.sandbox", projectId, { profileId });
      writeSnapshot("auto");
      return { ...project };
    },
    get_budget_status: async ({ projectId }) => budgetStatus(projectId),
    set_budget_policy: async ({ input }) => {
      const { scope, scopeId } = input;
      const v = input.input;
      for (const n of [v.softUsd, v.hardUsd]) if (n != null && !(n > 0)) throw new Error("Valores de orçamento devem ser positivos");
      if (v.softUsd != null && v.hardUsd != null && v.softUsd > v.hardUsd) throw new Error("O aviso (soft) não pode ser maior que o limite (hard)");
      const index = budgets.findIndex((b) => b.scope === scope && b.scopeId === scopeId);
      if (v.softUsd == null && v.hardUsd == null && v.maxTurns == null) {
        if (index >= 0) budgets.splice(index, 1);
        audit("você", "config.budget", null, { scope, scopeId, removed: true });
        return null;
      }
      const at = new Date().toISOString();
      const policy: BudgetPolicy = { id: index >= 0 ? budgets[index]!.id : `budget_${budgets.length + 1}`, scope, scopeId, softUsd: v.softUsd ?? null, hardUsd: v.hardUsd ?? null, maxTurns: v.maxTurns ?? null, createdAt: index >= 0 ? budgets[index]!.createdAt : at, updatedAt: at };
      if (index >= 0) budgets.splice(index, 1, policy);
      else budgets.push(policy);
      audit("você", "config.budget", null, { scope, scopeId, softUsd: policy.softUsd, hardUsd: policy.hardUsd, maxTurns: policy.maxTurns });
      writeSnapshot("auto");
      return { ...policy };
    },
    list_sessions: async () => sessions.map((s) => ({ ...s, tags: [...s.tags] })),
    rename_session: async ({ input }) => {
      const session = sessions.find((s) => s.sessionId === input.sessionId);
      if (!session) throw new Error(`Sessão ${input.sessionId} não encontrada`);
      if (!input.title.trim()) throw new Error("Informe um título para a sessão");
      session.title = input.title.trim();
      return true;
    },
    tag_session: async ({ input }) => {
      const session = sessions.find((s) => s.sessionId === input.sessionId);
      if (!session) throw new Error(`Sessão ${input.sessionId} não encontrada`);
      const tag = input.tag?.trim();
      session.tags = tag ? [tag] : [];
      return true;
    },
  };

  return {
    emit,
    /** Só para testes: simula edição manual do log fora do app. */
    tamperAudit: (seq: number) => {
      tampered = seq;
    },
    invoke: async (command, args) => handlers[command](args as never) as never,
    listen: async (event, handler) => {
      const set = listeners.get(event) ?? new Set();
      set.add(handler as (payload: never) => void);
      listeners.set(event, set);
      const unlisten: Unlisten = () => set.delete(handler as (payload: never) => void);
      return unlisten;
    },
  };
}
