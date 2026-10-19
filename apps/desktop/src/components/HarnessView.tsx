import { Plus, RefreshCw, Server, Sparkles } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { EFFORT_LABELS, EFFORT_LEVELS } from "../lib/effort";
import type { Transport } from "../lib/transport";
import { KNOWN_MODELS, type EffortLevel, projectDefaultsKey, type McpServer, type McpServerConfig, type McpServerInput, type Project, type ProjectDefaults, type RunPreview, type Skill, type TeamMember } from "../lib/types";
import { formatRelative } from "./SessionsView";

export type HarnessTab = "mcp" | "skills" | "profile";

type HarnessViewProps = {
  project: Project | null;
  transport: Transport;
  availableTabs?: HarnessTab[];
};

export function HarnessView({ project, transport, availableTabs = ["mcp", "skills", "profile"] }: HarnessViewProps) {
  const [tab, setTab] = useState<HarnessTab>("mcp");
  const [servers, setServers] = useState<McpServer[] | null>(null);
  const [editing, setEditing] = useState<McpServer | "new" | null>(null);
  const [checking, setChecking] = useState<string | null>(null);
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const [skillEditor, setSkillEditor] = useState<{ skillId: string | null; name: string; content: string } | null>(null);
  const [defaults, setDefaults] = useState<ProjectDefaults | null>(null);
  const [team, setTeam] = useState<TeamMember[]>([]);
  const [previewAgent, setPreviewAgent] = useState<string>("");
  const [previewPrompt, setPreviewPrompt] = useState("crie a próxima migração do banco");
  const [preview, setPreview] = useState<RunPreview | null>(null);
  const [showJson, setShowJson] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const projectId = project?.id ?? null;

  const refresh = useCallback(async () => {
    setServers(await transport.invoke("list_mcp_servers", { projectId }));
    if (projectId) {
      setSkills(await transport.invoke("list_skills", { projectId }));
      const [settings, members] = await Promise.all([transport.invoke("get_settings", {}), transport.invoke("list_team", { projectId }).catch(() => [] as TeamMember[])]);
      const raw = settings[projectDefaultsKey(projectId)] as ProjectDefaults | undefined;
      setDefaults(raw ?? {});
      setTeam(members);
    } else {
      setSkills([]);
      setDefaults({});
      setTeam([]);
    }
  }, [transport, projectId]);

  const saveDefaults = async (next: ProjectDefaults) => {
    if (!projectId) return;
    const clean: ProjectDefaults = {};
    if (next.model) clean.model = next.model;
    if (next.maxTurns) clean.maxTurns = next.maxTurns;
    if (next.effort) clean.effort = next.effort;
    await transport.invoke("set_setting", { key: projectDefaultsKey(projectId), value: Object.keys(clean).length ? clean : null });
    setDefaults(clean);
    setPreview(null);
  };

  useEffect(() => {
    setServers(null);
    setSkills(null);
    setEditing(null);
    setSkillEditor(null);
    setPreview(null);
    setPreviewAgent("");
    void refresh().catch((e) => setError(String(e)));
  }, [refresh]);

  const run = async (fn: () => Promise<void>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const tabs: { id: HarnessTab; label: string }[] = [
    { id: "mcp", label: servers ? `MCPs · ${servers.length}` : "MCPs" },
    { id: "skills", label: skills ? `Skills · ${skills.length}` : "Skills" },
    { id: "profile", label: "Perfil de execução" },
  ];

  return (
    <div className="flex flex-col gap-5 overflow-y-auto p-6" data-testid="harness-view">
      <div className="flex flex-wrap items-center gap-4">
        <div>
          <div className="eyebrow text-brand">{project?.name ?? ""}</div>
          <h1 className="m-0 font-display text-xl font-bold tracking-tight">Harness</h1>
        </div>
        <div role="tablist" aria-label="Seções do harness" className="ml-auto flex flex-wrap gap-2">
          {tabs.map((t) => {
            const available = availableTabs.includes(t.id);
            return (
              <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} disabled={!available} title={available ? undefined : "Chega nas próximas iterações da Fase 5"} onClick={() => setTab(t.id)} className={["rounded-full px-3.5 py-1.5 text-[13px] font-medium", tab === t.id ? "border-[1.5px] border-ink bg-ink text-paper" : "border hairline-strong bg-surface text-ink", available ? "" : "cursor-not-allowed opacity-40"].join(" ")}>
                {t.label}
              </button>
            );
          })}
        </div>
      </div>
      {error && (
        <div role="alert" className="rounded-md border border-brand bg-brand-soft px-3 py-2 text-[13px] text-brand-hover">
          {error}
        </div>
      )}
      {notice && (
        <div role="status" className="rounded-md border hairline bg-surface px-3 py-2 text-[13px] text-slate">
          {notice}
        </div>
      )}

      {tab === "mcp" && (
        <section aria-label="MCP servers" className="flex flex-col gap-3 rounded-xl border hairline bg-surface p-5">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex flex-col gap-0.5">
              <h2 className="m-0 font-display text-sm font-semibold">MCP servers</h2>
              <span className="text-xs text-slate">globais e deste projeto; entram em options.mcpServers dos runs (todos os ativos, ou só os escolhidos na ficha do membro). Valores de env e headers nunca vão para o backup.</span>
            </div>
            <button type="button" onClick={() => setEditing("new")} className="ml-auto inline-flex items-center gap-1.5 rounded-full bg-brand px-3.5 py-2 text-[13px] font-semibold text-white hover:bg-brand-hover">
              <Plus size={14} aria-hidden /> Novo MCP server
            </button>
          </div>
          <ul className="m-0 flex list-none flex-col p-0" data-testid="mcp-list">
            <li className="grid grid-cols-[30px_minmax(0,1.2fr)_70px_minmax(0,1.6fr)_minmax(0,1fr)_auto] items-center gap-3 border-b hairline py-2.5 text-[13px]" data-testid="mcp-row" data-name="octopus">
              <span role="switch" aria-checked="true" aria-disabled="true" aria-label="octopus sempre ativo" className="relative inline-block h-[18px] w-[30px] rounded-full bg-ink opacity-40">
                <span className="absolute top-0.5 right-0.5 size-3.5 rounded-full bg-surface" />
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="font-semibold">octopus</span>
                <span className="eyebrow text-slate">embutido</span>
              </span>
              <span className="justify-self-start rounded-full border hairline-strong px-2 text-[11px] font-semibold">sdk</span>
              <code className="truncate font-mono text-xs">task_update · memory_search · memory_write · memory_handoff</code>
              <Health ok text="sempre disponível · 4 tools" />
              <span />
            </li>
            {(servers ?? []).map((s) => (
              <li key={s.id} className="grid grid-cols-[30px_minmax(0,1.2fr)_70px_minmax(0,1.6fr)_minmax(0,1fr)_auto] items-center gap-3 border-b hairline py-2.5 text-[13px] last:border-b-0" data-testid="mcp-row" data-name={s.name} data-enabled={s.enabled} data-health={s.lastHealth ? (s.lastHealth.ok ? "ok" : "error") : "unknown"}>
                <button
                  type="button"
                  role="switch"
                  aria-checked={s.enabled}
                  aria-label={`${s.name} ativo`}
                  onClick={() =>
                    void run(async () => {
                      await transport.invoke("set_mcp_server_enabled", { serverId: s.id, enabled: !s.enabled });
                      await refresh();
                    })
                  }
                  className={["relative inline-block h-[18px] w-[30px] rounded-full", s.enabled ? "bg-ink" : "bg-mist"].join(" ")}
                >
                  <span className={["absolute top-0.5 size-3.5 rounded-full bg-surface", s.enabled ? "right-0.5" : "left-0.5"].join(" ")} />
                </button>
                <button type="button" onClick={() => setEditing(s)} className="flex min-w-0 flex-col text-left">
                  <span className="font-semibold">{s.name}</span>
                  <span className="eyebrow text-slate">{s.projectId ? (project?.name ?? "projeto") : "global"}</span>
                </button>
                <span className="justify-self-start rounded-full border hairline-strong px-2 text-[11px] font-semibold">{s.transport}</span>
                <code className="truncate font-mono text-xs" title={describeConfig(s.config)}>
                  {describeConfig(s.config)}
                </code>
                {s.lastHealth ? (
                  <Health ok={s.lastHealth.ok} text={s.lastHealth.ok ? `ok ${formatRelative(s.lastHealth.checkedAt)} · ${s.lastHealth.tools.length} ${s.lastHealth.tools.length === 1 ? "tool" : "tools"}${s.lastHealth.latencyMs != null ? ` · ${s.lastHealth.latencyMs} ms` : ""}` : `falhou ${formatRelative(s.lastHealth.checkedAt)} · ${s.lastHealth.error ?? "erro"}`} />
                ) : (
                  <Health ok={null} text="nunca testado" />
                )}
                <button
                  type="button"
                  disabled={checking === s.id}
                  onClick={() =>
                    void run(async () => {
                      setChecking(s.id);
                      try {
                        const updated = await transport.invoke("check_mcp_server", { serverId: s.id });
                        await refresh();
                        setNotice(updated.lastHealth?.ok ? `${updated.name}: conectado, ${updated.lastHealth.tools.length} tools (${updated.lastHealth.tools.map((t) => t.name).join(", ")}).` : `${updated.name}: falhou — ${updated.lastHealth?.error ?? "erro desconhecido"}.`);
                      } finally {
                        setChecking(null);
                      }
                    })
                  }
                  className="rounded-sm border hairline-strong bg-surface px-2.5 py-1 text-xs font-medium hover:border-ink disabled:opacity-50"
                >
                  {checking === s.id ? "Testando…" : "Testar"}
                </button>
              </li>
            ))}
            {servers !== null && servers.length === 0 && <li className="py-2 text-[13px] text-slate">Nenhum MCP server externo. Adicione um global (vale para todos os projetos) ou só deste projeto.</li>}
          </ul>
          <div className="flex gap-3 rounded-md border hairline bg-paper px-3 py-2.5 text-[13px]">
            <span className="eyebrow whitespace-nowrap text-slate">Teste de conexão</span>
            <span className="text-slate">O sidecar abre o servidor com o cliente MCP oficial, faz o handshake e lista as tools. O resultado fica guardado como última saúde.</span>
          </div>
        </section>
      )}

      {tab === "skills" && (
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-5 max-[900px]:grid-cols-1">
          <section aria-label="Skills" className="flex flex-col gap-3 rounded-xl border hairline bg-surface p-5">
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex flex-col gap-0.5">
                <h2 className="m-0 font-display text-sm font-semibold">Skills</h2>
                <span className="text-xs text-slate">pastas com SKILL.md em .claude/skills do projeto e em ~/.claude/skills. As do projeto o Claude Code carrega sozinho (quando as fontes de instruções incluem o projeto); as do usuário e as demais ativas entram num plugin local montado pelo Octopus, por membro ou para o projeto.</span>
              </div>
              <div className="ml-auto flex gap-2">
                <button
                  type="button"
                  disabled={!projectId}
                  onClick={() =>
                    void run(async () => {
                      if (!projectId) return;
                      const list = await transport.invoke("scan_skills", { projectId });
                      setSkills(list);
                      setNotice(`Varredura concluída: ${list.length} ${list.length === 1 ? "skill" : "skills"}.`);
                    })
                  }
                  className="inline-flex items-center gap-1.5 rounded-sm border hairline-strong bg-surface px-3 py-2 text-[13px] font-medium disabled:opacity-40"
                >
                  <RefreshCw size={14} aria-hidden /> Rescanear
                </button>
                <button type="button" disabled={!projectId} onClick={() => setSkillEditor({ skillId: null, name: "", content: "" })} className="inline-flex items-center gap-1.5 rounded-full bg-ink px-3.5 py-2 text-[13px] font-semibold text-paper disabled:opacity-40">
                  <Sparkles size={14} aria-hidden /> Nova skill
                </button>
              </div>
            </div>
            <ul className="m-0 flex list-none flex-col p-0" data-testid="skill-list">
              {(skills ?? []).map((sk) => (
                <li key={sk.id} className="grid grid-cols-[30px_minmax(0,1fr)_minmax(0,1.4fr)_auto] items-center gap-3 border-b hairline py-2.5 text-[13px] last:border-b-0" data-testid="skill-row" data-name={sk.name} data-enabled={sk.enabled} data-source={sk.source}>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={sk.enabled}
                    aria-label={`${sk.name} ativa`}
                    onClick={() =>
                      void run(async () => {
                        await transport.invoke("set_skill_enabled", { skillId: sk.id, enabled: !sk.enabled });
                        await refresh();
                      })
                    }
                    className={["relative inline-block h-[18px] w-[30px] rounded-full", sk.enabled ? "bg-ink" : "bg-mist"].join(" ")}
                  >
                    <span className={["absolute top-0.5 size-3.5 rounded-full bg-surface", sk.enabled ? "right-0.5" : "left-0.5"].join(" ")} />
                  </button>
                  <span className="flex min-w-0 flex-col">
                    <span className="font-semibold">{sk.name}</span>
                    <span className="eyebrow text-slate">{sk.projectId ? (project?.name ?? "projeto") : "usuário"}</span>
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">{sk.description || "—"}</span>
                    <code className="truncate font-mono text-[11px] text-slate" title={sk.path}>
                      {sk.path.replace(/^\/Users\/[^/]+/, "~")}/SKILL.md
                    </code>
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      void run(async () => {
                        const content = await transport.invoke("read_skill", { skillId: sk.id });
                        setSkillEditor({ skillId: sk.id, name: sk.name, content });
                      })
                    }
                    className="rounded-sm border hairline-strong bg-surface px-2.5 py-1 text-xs font-medium hover:border-ink"
                  >
                    {sk.projectId ? "Editar" : "Ver"}
                  </button>
                </li>
              ))}
              {skills !== null && skills.length === 0 && <li className="py-2 text-[13px] text-slate">Nenhuma skill encontrada. Crie uma aqui ou adicione uma pasta com SKILL.md em .claude/skills do projeto e rescaneie.</li>}
            </ul>
          </section>
          {skillEditor ? (
            <form
              aria-label={skillEditor.skillId ? "Editar skill" : "Nova skill"}
              className="flex flex-col gap-3 rounded-xl border hairline bg-surface p-5"
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  if (!projectId) return;
                  const saved = await transport.invoke("save_skill", { input: { skillId: skillEditor.skillId, projectId, name: skillEditor.name, content: skillEditor.content } });
                  setSkillEditor(null);
                  await refresh();
                  setNotice(skillEditor.skillId ? `SKILL.md de ${saved.name} gravado.` : `Skill ${saved.name} criada em .claude/skills.`);
                });
              }}
            >
              <h2 className="m-0 font-display text-sm font-semibold">{skillEditor.skillId ? `SKILL.md · ${skillEditor.name}` : "Nova skill do projeto"}</h2>
              {!skillEditor.skillId && (
                <label className="flex flex-col gap-1 text-xs font-medium text-slate">
                  Nome
                  <input aria-label="Nome da skill" value={skillEditor.name} onChange={(e) => setSkillEditor({ ...skillEditor, name: e.target.value })} placeholder="release-notes" className="rounded-sm border hairline-strong bg-surface px-2.5 py-1.5 text-[13px] text-ink" />
                </label>
              )}
              <label className="flex flex-col gap-1 text-xs font-medium text-slate">
                Conteúdo (SKILL.md, com frontmatter name/description)
                <textarea aria-label="Conteúdo da skill" value={skillEditor.content} onChange={(e) => setSkillEditor({ ...skillEditor, content: e.target.value })} rows={16} className="rounded-sm border hairline-strong bg-surface px-2.5 py-2 font-mono text-xs text-ink" />
              </label>
              <div className="flex gap-2">
                <button type="submit" disabled={!skillEditor.content.trim() || (!skillEditor.skillId && !skillEditor.name.trim())} className="rounded-full bg-ink px-3.5 py-2 text-[13px] font-semibold text-paper disabled:opacity-50">
                  Salvar
                </button>
                <button type="button" onClick={() => setSkillEditor(null)} className="rounded-sm border hairline-strong bg-surface px-3 py-2 text-[13px] font-medium">
                  Fechar
                </button>
              </div>
            </form>
          ) : (
            <div className="flex flex-col items-center gap-2 rounded-xl border hairline bg-surface p-10 text-center text-[13px] text-slate">
              <Sparkles size={22} aria-hidden />
              <span>Escolha uma skill para ver ou editar o SKILL.md, ou crie uma nova dentro do projeto.</span>
            </div>
          )}
        </div>
      )}

      {tab === "profile" && (
        <div className="grid grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] gap-5 max-[900px]:grid-cols-1">
          <section aria-label="Preview do run" className="flex flex-col gap-3 rounded-xl border hairline bg-surface p-5" data-testid="run-preview">
            <div className="flex flex-col gap-0.5">
              <h2 className="m-0 font-display text-sm font-semibold">O que vai para o SDK</h2>
              <span className="text-xs text-slate">cada camada deixa sua marca: cargo → membro → projeto → segurança → memória → harness. Nada aqui é editável; mude na origem. Sem efeitos colaterais (não consome handoff nem cria run).</span>
            </div>
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  if (!projectId) return;
                  setPreview(await transport.invoke("preview_run_options", { input: { projectId, agentProfileId: previewAgent || null, prompt: previewPrompt, options: { includePartialMessages: true } } }));
                });
              }}
            >
              <label className="flex flex-col gap-1 text-xs font-medium text-slate">
                Executar como
                <select aria-label="Membro do preview" value={previewAgent} onChange={(e) => setPreviewAgent(e.target.value)} className="rounded-sm border hairline-strong bg-surface px-2 py-1.5 text-[13px] text-ink">
                  <option value="">Run avulso (sem membro)</option>
                  {team.map((m) => (
                    <option key={m.profile.id} value={m.profile.id}>
                      {m.profile.name} · {m.role.title}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex min-w-[220px] flex-1 flex-col gap-1 text-xs font-medium text-slate">
                Pedido de exemplo
                <input aria-label="Pedido do preview" value={previewPrompt} onChange={(e) => setPreviewPrompt(e.target.value)} className="rounded-sm border hairline-strong bg-surface px-2.5 py-1.5 text-[13px] text-ink" />
              </label>
              <button type="submit" disabled={!projectId} className="rounded-full bg-ink px-3.5 py-2 text-[13px] font-semibold text-paper disabled:opacity-40">
                Gerar preview
              </button>
            </form>
            {preview && (
              <>
                <div className="flex flex-col" data-testid="preview-notes">
                  {preview.notes.map((n, i) => (
                    <div key={`${n.field}_${i}`} className="grid grid-cols-[150px_minmax(0,1fr)_auto] items-baseline gap-3 border-b hairline py-1.5 text-[13px] last:border-b-0" data-testid="preview-note" data-field={n.field} data-origin={n.origin}>
                      <span className="text-slate">{n.field}</span>
                      <code className="truncate font-mono text-xs" title={n.value}>
                        {n.value}
                      </code>
                      <span className="eyebrow text-right text-slate">{n.origin}</span>
                    </div>
                  ))}
                </div>
                <button type="button" aria-expanded={showJson} onClick={() => setShowJson((v) => !v)} className="self-start text-xs text-slate underline-offset-2 hover:underline">
                  {showJson ? "Esconder JSON" : "JSON completo (segredos redigidos)"}
                </button>
                {showJson && (
                  <pre className="m-0 max-h-80 overflow-auto rounded-md bg-sidebar p-3 font-mono text-[11px] leading-relaxed text-sidebar-ink" data-testid="preview-json">
                    {JSON.stringify(preview.options, null, 2)}
                  </pre>
                )}
              </>
            )}
          </section>
          <div className="flex min-w-0 flex-col gap-5">
            <section aria-label="Defaults do projeto" className="flex flex-col gap-3 rounded-xl border hairline bg-surface p-5" data-testid="project-defaults">
              <div className="flex flex-col gap-0.5">
                <h2 className="m-0 font-display text-sm font-semibold">Defaults do projeto</h2>
                <span className="text-xs text-slate">valem para runs avulsos e para membros sem valor próprio (modelo, esforço) e para as tasks do board (turnos)</span>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <label className="flex flex-col gap-1 text-xs font-medium text-slate">
                  Modelo padrão
                  <input aria-label="Modelo padrão do projeto" list="known-models" value={defaults?.model ?? ""} placeholder="padrão do Claude Code" onChange={(e) => setDefaults({ ...(defaults ?? {}), model: e.target.value || null })} onBlur={() => void run(() => saveDefaults(defaults ?? {}))} className="rounded-sm border hairline-strong bg-surface px-2.5 py-1.5 font-mono text-xs text-ink" />
                  <datalist id="known-models">
                    {KNOWN_MODELS.map((m) => (
                      <option key={m} value={m} />
                    ))}
                  </datalist>
                </label>
                <label className="flex flex-col gap-1 text-xs font-medium text-slate">
                  Máx. turnos por run do board
                  <input aria-label="Máximo de turnos do projeto" inputMode="numeric" value={defaults?.maxTurns ?? ""} placeholder="40" onChange={(e) => setDefaults({ ...(defaults ?? {}), maxTurns: e.target.value ? Number(e.target.value) : null })} onBlur={() => void run(() => saveDefaults(defaults ?? {}))} className="rounded-sm border hairline-strong bg-surface px-2.5 py-1.5 font-mono text-xs text-ink" />
                </label>
                <label className="flex flex-col gap-1 text-xs font-medium text-slate">
                  Esforço padrão
                  <select
                    aria-label="Esforço padrão do projeto"
                    value={defaults?.effort ?? ""}
                    onChange={(e) => {
                      const next = { ...(defaults ?? {}), effort: (e.target.value || null) as EffortLevel | null };
                      setDefaults(next);
                      void run(() => saveDefaults(next));
                    }}
                    className="rounded-sm border hairline-strong bg-surface px-2.5 py-1.5 text-xs text-ink"
                  >
                    <option value="">Padrão do modelo</option>
                    {EFFORT_LEVELS.map((level) => (
                      <option key={level} value={level}>
                        {EFFORT_LABELS[level]}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <span className="text-xs text-slate">Permissões, sandbox e orçamento ficam em Segurança; fontes de instruções em Memória → Contexto.</span>
            </section>
            <section aria-label="Hooks ativos" className="flex flex-col gap-2 rounded-xl border hairline bg-surface p-5" data-testid="hooks-list">
              <div className="flex flex-col gap-0.5">
                <h2 className="m-0 font-display text-sm font-semibold">Hooks declarativos ativos</h2>
                <span className="text-xs text-slate">o Octopus registra os hooks do SDK por você; cada linha diz onde se configura</span>
              </div>
              {preview ? (
                <ul className="m-0 flex list-none flex-col p-0">
                  {preview.hooks.map((h) => (
                    <li key={h.event} className="flex flex-col gap-0.5 border-b hairline py-2 text-[13px] last:border-b-0" data-testid="hook-row">
                      <span className="flex flex-wrap items-baseline justify-between gap-x-3">
                        <code className="font-mono text-xs">{h.event}</code>
                        <span className="eyebrow text-slate">{h.origin}</span>
                      </span>
                      <span className="text-slate">{h.description}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="m-0 text-[13px] text-slate">Gere um preview para ver os hooks que entram nesse run.</p>
              )}
            </section>
          </div>
        </div>
      )}

      {editing && (
        <McpServerDialog
          server={editing === "new" ? null : editing}
          project={project}
          onClose={() => setEditing(null)}
          onSave={async (input) => {
            await transport.invoke("save_mcp_server", { input });
            setEditing(null);
            await refresh();
            setNotice(input.id ? "MCP server atualizado (saúde zerada: teste de novo)." : "MCP server adicionado. Teste a conexão antes de usar.");
          }}
          onDelete={
            editing === "new"
              ? null
              : async () => {
                  await transport.invoke("delete_mcp_server", { serverId: editing.id });
                  setEditing(null);
                  await refresh();
                  setNotice("MCP server removido.");
                }
          }
        />
      )}
    </div>
  );
}

function Health({ ok, text }: { ok: boolean | null; text: string }) {
  const color = ok === true ? "text-success-ink" : ok === false ? "text-brand-hover" : "text-slate";
  const dot = ok === true ? "bg-success" : ok === false ? "bg-brand" : "bg-mist";
  return (
    <span className={["inline-flex min-w-0 items-center gap-1.5 text-xs", color].join(" ")}>
      <span className={["size-2 shrink-0 rounded-full", dot].join(" ")} />
      <span className="truncate" title={text}>
        {text}
      </span>
    </span>
  );
}

export function describeConfig(config: McpServerConfig): string {
  if (config.type === "stdio") return [config.command, ...(config.args ?? [])].join(" ") + (config.env && Object.keys(config.env).length ? ` · env ${Object.keys(config.env).join(", ")}` : "");
  return config.url + (config.headers && Object.keys(config.headers).length ? ` · header ${Object.keys(config.headers).join(", ")}` : "");
}

/** `KEY=valor` por linha → mapa. */
export function parseKeyValues(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return out;
}

function formatKeyValues(map: Record<string, string> | undefined): string {
  return Object.entries(map ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

type DialogProps = {
  server: McpServer | null;
  project: Project | null;
  onClose: () => void;
  onSave: (input: McpServerInput) => Promise<void>;
  onDelete: (() => Promise<void>) | null;
};

function McpServerDialog({ server, project, onClose, onSave, onDelete }: DialogProps) {
  const [name, setName] = useState(server?.name ?? "");
  const [scope, setScope] = useState<"global" | "project">(server ? (server.projectId ? "project" : "global") : project ? "project" : "global");
  const [transport, setTransport] = useState<McpServerConfig["type"]>(server?.config.type ?? "stdio");
  const [command, setCommand] = useState(server?.config.type === "stdio" ? [server.config.command, ...(server.config.args ?? [])].join(" ") : "");
  const [url, setUrl] = useState(server && server.config.type !== "stdio" ? server.config.url : "");
  const [kv, setKv] = useState(server ? (server.config.type === "stdio" ? formatKeyValues(server.config.env) : formatKeyValues(server.config.headers)) : "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError(null);
    let config: McpServerConfig;
    if (transport === "stdio") {
      const parts = command.trim().split(/\s+/).filter(Boolean);
      if (parts.length === 0) {
        setError("Informe o comando.");
        return;
      }
      const env = parseKeyValues(kv);
      config = { type: "stdio", command: parts[0]!, args: parts.slice(1), ...(Object.keys(env).length ? { env } : {}) };
    } else {
      if (!/^https?:\/\//.test(url.trim())) {
        setError("A URL precisa começar com http:// ou https://");
        return;
      }
      const headers = parseKeyValues(kv);
      config = { type: transport, url: url.trim(), ...(Object.keys(headers).length ? { headers } : {}) };
    }
    setBusy(true);
    try {
      await onSave({ id: server?.id ?? null, projectId: scope === "project" ? (project?.id ?? null) : null, name: name.trim(), config, enabled: server?.enabled ?? true });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div role="dialog" aria-modal="true" aria-label={server ? "Editar MCP server" : "Novo MCP server"} className="fixed inset-0 z-40 flex items-center justify-center bg-ink/30 p-6">
      <form
        className="flex w-full max-w-xl flex-col gap-3 rounded-xl border hairline bg-surface p-5 shadow-md"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="flex items-center gap-2">
          <Server size={16} aria-hidden className="text-slate" />
          <h2 className="m-0 font-display text-base font-semibold">{server ? "Editar MCP server" : "Novo MCP server"}</h2>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1 text-xs font-medium text-slate">
            Nome (como o agente vê)
            <input aria-label="Nome do MCP server" value={name} onChange={(e) => setName(e.target.value)} placeholder="docs" className="rounded-sm border hairline-strong bg-surface px-2.5 py-1.5 text-[13px] text-ink" />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-slate">
            Escopo
            <select aria-label="Escopo do MCP server" value={scope} onChange={(e) => setScope(e.target.value as "global" | "project")} className="rounded-sm border hairline-strong bg-surface px-2 py-1.5 text-[13px] text-ink">
              <option value="global">Global (todos os projetos)</option>
              <option value="project" disabled={!project}>
                Só {project?.name ?? "este projeto"}
              </option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-slate">
            Transporte
            <select aria-label="Transporte do MCP server" value={transport} onChange={(e) => setTransport(e.target.value as McpServerConfig["type"])} className="rounded-sm border hairline-strong bg-surface px-2 py-1.5 text-[13px] text-ink">
              <option value="stdio">stdio (processo local)</option>
              <option value="http">http (Streamable HTTP)</option>
              <option value="sse">sse</option>
            </select>
          </label>
          {transport === "stdio" ? (
            <label className="flex flex-col gap-1 text-xs font-medium text-slate">
              Comando e argumentos
              <input aria-label="Comando do MCP server" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx -y @modelcontextprotocol/server-filesystem ~/Docs" className="rounded-sm border hairline-strong bg-surface px-2.5 py-1.5 font-mono text-xs text-ink" />
            </label>
          ) : (
            <label className="flex flex-col gap-1 text-xs font-medium text-slate">
              URL
              <input aria-label="URL do MCP server" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.exemplo.com/jira" className="rounded-sm border hairline-strong bg-surface px-2.5 py-1.5 font-mono text-xs text-ink" />
            </label>
          )}
        </div>
        <label className="flex flex-col gap-1 text-xs font-medium text-slate">
          {transport === "stdio" ? "Variáveis de ambiente (KEY=valor por linha)" : "Headers (Nome=valor por linha)"}
          <textarea aria-label={transport === "stdio" ? "Variáveis de ambiente" : "Headers"} value={kv} onChange={(e) => setKv(e.target.value)} rows={3} className="rounded-sm border hairline-strong bg-surface px-2.5 py-1.5 font-mono text-xs text-ink" />
          <span className="text-[11px] text-slate">Valores ficam só no banco local; no backup saem em branco.</span>
        </label>
        {error && (
          <span role="alert" className="text-xs text-brand-hover">
            {error}
          </span>
        )}
        <div className="flex gap-2">
          <button type="submit" disabled={busy || !name.trim()} className="rounded-full bg-ink px-3.5 py-2 text-[13px] font-semibold text-paper disabled:opacity-50">
            Salvar
          </button>
          <button type="button" onClick={onClose} className="rounded-sm border hairline-strong bg-surface px-3 py-2 text-[13px] font-medium">
            Cancelar
          </button>
          {onDelete && (
            <button type="button" onClick={() => void onDelete()} className="ml-auto rounded-sm border hairline-strong bg-surface px-3 py-2 text-[13px] font-medium text-slate hover:border-brand hover:text-brand-hover">
              Remover
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
