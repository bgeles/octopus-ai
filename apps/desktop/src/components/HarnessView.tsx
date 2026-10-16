import { Plus, Server } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { Transport } from "../lib/transport";
import type { McpServer, McpServerConfig, McpServerInput, Project } from "../lib/types";
import { formatRelative } from "./SessionsView";

export type HarnessTab = "mcp" | "skills" | "profile";

type HarnessViewProps = {
  project: Project | null;
  transport: Transport;
  availableTabs?: HarnessTab[];
};

export function HarnessView({ project, transport, availableTabs = ["mcp"] }: HarnessViewProps) {
  const [tab, setTab] = useState<HarnessTab>("mcp");
  const [servers, setServers] = useState<McpServer[] | null>(null);
  const [editing, setEditing] = useState<McpServer | "new" | null>(null);
  const [checking, setChecking] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const projectId = project?.id ?? null;

  const refresh = useCallback(async () => {
    setServers(await transport.invoke("list_mcp_servers", { projectId }));
  }, [transport, projectId]);

  useEffect(() => {
    setServers(null);
    setEditing(null);
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
    { id: "skills", label: "Skills" },
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
