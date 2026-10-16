import { Archive, BookOpen, History, Plus, RefreshCw, Search } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { Transport } from "../lib/transport";
import { CONSOLIDATION_MODEL, CONSOLIDATION_SETTING, MEMORY_KIND_LABELS, MEMORY_PAGE_KINDS, type ConsolidationMode, type MemoryHandoff, type MemoryObservation, type MemoryPage, type MemoryPageKind, type MemoryPageVersion, type MemorySearchHit, type Project, type Task } from "../lib/types";
import { formatRelative } from "./SessionsView";

export type MemoryTab = "pages" | "observations" | "handoffs" | "context";

type MemoryViewProps = {
  project: Project | null;
  transport: Transport;
  availableTabs?: MemoryTab[];
};

const KIND_COLOR: Record<MemoryPageKind, string> = {
  decisions: "text-brand-hover",
  architecture: "text-success-ink",
  pitfalls: "text-warning-ink",
  tasklog: "text-slate",
  handoff: "text-brand",
  note: "text-slate",
};

export function MemoryView({ project, transport, availableTabs = ["pages", "observations", "handoffs"] }: MemoryViewProps) {
  const [tab, setTab] = useState<MemoryTab>("pages");
  const [pages, setPages] = useState<MemoryPage[] | null>(null);
  const [observations, setObservations] = useState<MemoryObservation[] | null>(null);
  const [handoffs, setHandoffs] = useState<MemoryHandoff[] | null>(null);
  const [consolidation, setConsolidation] = useState<ConsolidationMode | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<MemorySearchHit[] | null>(null);
  const [selected, setSelected] = useState<MemoryPage | null>(null);
  const [versions, setVersions] = useState<MemoryPageVersion[] | null>(null);
  const [editing, setEditing] = useState<{ pageId: string | null; kind: MemoryPageKind; title: string; bodyMd: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const projectId = project?.id ?? null;

  const refreshPages = useCallback(async () => {
    if (!projectId) return;
    const list = await transport.invoke("list_memory_pages", { projectId });
    setPages(list);
    setSelected((current) => (current ? (list.find((p) => p.id === current.id) ?? null) : null));
  }, [transport, projectId]);

  const refreshObservations = useCallback(async () => {
    if (!projectId) return;
    setObservations(await transport.invoke("list_memory_observations", { projectId, limit: 200 }));
  }, [transport, projectId]);

  const refreshHandoffs = useCallback(async () => {
    if (!projectId) return;
    const [list, taskList] = await Promise.all([transport.invoke("list_memory_handoffs", { projectId }), transport.invoke("list_tasks", { projectId }).catch(() => [] as Task[])]);
    setHandoffs(list);
    setTasks(taskList);
  }, [transport, projectId]);

  useEffect(() => {
    transport
      .invoke("get_settings", {})
      .then((s) => setConsolidation(s[CONSOLIDATION_SETTING] === "haiku" ? "haiku" : "raw"))
      .catch(() => setConsolidation("raw"));
  }, [transport]);

  useEffect(() => {
    setPages(null);
    setObservations(null);
    setHandoffs(null);
    setSelected(null);
    setHits(null);
    setQuery("");
    void refreshPages().catch((e) => setError(String(e)));
    void refreshObservations().catch((e) => setError(String(e)));
    void refreshHandoffs().catch((e) => setError(String(e)));
  }, [refreshPages, refreshObservations, refreshHandoffs]);

  useEffect(() => {
    if (!projectId) return;
    const q = query.trim();
    if (!q) {
      setHits(null);
      return;
    }
    const timer = setTimeout(() => {
      transport
        .invoke("search_memory", { projectId, query: q, limit: 20 })
        .then(setHits)
        .catch((e) => setError(String(e)));
    }, 150);
    return () => clearTimeout(timer);
  }, [transport, projectId, query]);

  const openPage = async (page: MemoryPage) => {
    setEditing(null);
    setVersions(null);
    const fresh = (await transport.invoke("get_memory_page", { pageId: page.id })) ?? page;
    setSelected(fresh);
    setPages((list) => list?.map((p) => (p.id === fresh.id ? fresh : p)) ?? null);
  };

  const save = async () => {
    if (!projectId || !editing) return;
    setError(null);
    try {
      const page = await transport.invoke("save_memory_page", { input: { projectId, pageId: editing.pageId, kind: editing.kind, title: editing.title, bodyMd: editing.bodyMd } });
      setEditing(null);
      await refreshPages();
      setSelected(page);
      setNotice(editing.pageId ? "Página atualizada (nova versão)." : "Página criada.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const tabs: { id: MemoryTab; label: string }[] = [
    { id: "pages", label: pages ? `Páginas · ${pages.length}` : "Páginas" },
    { id: "observations", label: observations ? `Observações · ${observations.length}` : "Observações" },
    { id: "handoffs", label: handoffs ? `Handoffs · ${handoffs.filter((h) => !h.consumedAt).length} ${handoffs.filter((h) => !h.consumedAt).length === 1 ? "pendente" : "pendentes"}` : "Handoffs" },
    { id: "context", label: "Contexto" },
  ];
  const listed: { page: MemoryPage; snippet: string | null }[] = hits ? hits.map((h) => ({ page: h.page, snippet: h.snippet })) : (pages ?? []).map((page) => ({ page, snippet: null }));

  return (
    <div className="flex flex-col gap-5 overflow-y-auto p-6" data-testid="memory-view">
      <div className="flex flex-wrap items-center gap-4">
        <div>
          <div className="eyebrow text-brand">{project?.name ?? ""}</div>
          <h1 className="m-0 font-display text-xl font-bold tracking-tight">Memória</h1>
        </div>
        <div className="flex flex-col gap-1" data-testid="consolidation-mode" data-mode={consolidation ?? undefined}>
          <span className="text-xs font-medium text-slate">Consolidação ao fim de cada run</span>
          <div role="radiogroup" aria-label="Consolidação" className="flex rounded-md border hairline-strong p-0.5 text-[13px]">
            {(
              [
                ["raw", "Bruta (log de tarefas)"],
                ["haiku", `Com ${CONSOLIDATION_MODEL.includes("haiku") ? "Haiku" : CONSOLIDATION_MODEL}`],
              ] as [ConsolidationMode, string][]
            ).map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={consolidation === mode}
                disabled={consolidation === null}
                onClick={async () => {
                  await transport.invoke("set_setting", { key: CONSOLIDATION_SETTING, value: mode });
                  setConsolidation(mode);
                  setNotice(mode === "haiku" ? "Ao fim de cada run, um run barato com Haiku transforma as observações em páginas (decisões, arquitetura, armadilhas). O log bruto continua." : "Só o log de tarefas bruto, sem modelo.");
                }}
                className={["rounded-sm px-3 py-1.5 font-medium disabled:opacity-40", consolidation === mode ? "bg-ink text-paper" : "text-slate hover:text-ink"].join(" ")}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div role="tablist" aria-label="Seções da memória" className="ml-auto flex flex-wrap gap-2">
          {tabs.map((t) => {
            const available = availableTabs.includes(t.id);
            return (
              <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} disabled={!available} title={available ? undefined : "Chega nas próximas iterações da Fase 4"} onClick={() => setTab(t.id)} className={["rounded-full px-3.5 py-1.5 text-[13px] font-medium", tab === t.id ? "border-[1.5px] border-ink bg-ink text-paper" : "border hairline-strong bg-surface text-ink", available ? "" : "cursor-not-allowed opacity-40"].join(" ")}>
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

      {tab === "pages" && (
        <div className="grid grid-cols-[minmax(260px,340px)_minmax(0,1fr)] gap-5 max-[900px]:grid-cols-1">
          <section aria-label="Páginas da wiki" className="flex flex-col gap-2.5 rounded-xl border hairline bg-surface p-4">
            <label htmlFor="memory-search" className="eyebrow text-slate">
              Buscar (FTS5)
            </label>
            <div className="flex items-center gap-2 rounded-sm border hairline-strong bg-paper px-2.5">
              <Search size={14} aria-hidden className="text-slate" />
              <input id="memory-search" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="decisão, arquivo, erro…" className="w-full bg-transparent py-2 text-[13px] outline-none" />
            </div>
            <span className="text-xs text-slate">{hits ? `${hits.length} ${hits.length === 1 ? "página" : "páginas"} · relevância, score e uso` : pages ? `${pages.length} ${pages.length === 1 ? "página" : "páginas"} · mais recentes primeiro` : "Carregando…"}</span>
            <ul className="m-0 flex list-none flex-col gap-1 p-0" data-testid="memory-page-list">
              {listed.map(({ page, snippet }) => (
                <li key={page.id}>
                  <button type="button" onClick={() => void openPage(page)} className={["flex w-full flex-col gap-0.5 rounded-md border px-3 py-2 text-left", selected?.id === page.id ? "hairline bg-paper" : "border-transparent hover:bg-paper"].join(" ")} data-testid="memory-page-row" data-kind={page.kind}>
                    <span className={["eyebrow", KIND_COLOR[page.kind]].join(" ")}>{MEMORY_KIND_LABELS[page.kind]}</span>
                    <span className="text-[13px] font-semibold">{page.title}</span>
                    <span className="text-xs text-slate">
                      {snippet ?? `${formatRelative(page.updatedAt)} · ${page.versions} ${page.versions === 1 ? "versão" : "versões"} · usada ${page.accessCount}×`}
                    </span>
                  </button>
                </li>
              ))}
              {listed.length === 0 && pages !== null && <li className="px-3 py-2 text-[13px] text-slate">{hits ? "Nada encontrado." : "Ainda sem páginas: a primeira nasce ao fim do próximo run (log de tarefas) ou com “Nova página”."}</li>}
            </ul>
            <div className="mt-auto flex gap-2 border-t hairline pt-3">
              <button type="button" disabled={!project} onClick={() => setEditing({ pageId: null, kind: "note", title: "", bodyMd: "" })} className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-full bg-ink px-3 py-2 text-[13px] font-semibold text-paper disabled:opacity-40">
                <Plus size={14} aria-hidden /> Nova página
              </button>
              <button
                type="button"
                disabled={!project}
                onClick={async () => {
                  if (!projectId) return;
                  try {
                    const n = await transport.invoke("rebuild_memory_index", { projectId });
                    await refreshPages();
                    setNotice(`Índice reconstruído a partir da wiki: ${n} ${n === 1 ? "página" : "páginas"}.`);
                  } catch (e) {
                    setError(e instanceof Error ? e.message : String(e));
                  }
                }}
                className="inline-flex items-center gap-1.5 rounded-sm border hairline-strong bg-surface px-3 py-2 text-[13px] font-medium disabled:opacity-40"
              >
                <RefreshCw size={14} aria-hidden /> Reindexar
              </button>
            </div>
          </section>

          <div className="flex min-w-0 flex-col gap-5">
            {editing ? (
              <form
                aria-label={editing.pageId ? "Editar página" : "Nova página"}
                className="flex flex-col gap-3 rounded-xl border hairline bg-surface p-5"
                onSubmit={(e) => {
                  e.preventDefault();
                  void save();
                }}
              >
                <h2 className="m-0 font-display text-sm font-semibold">{editing.pageId ? "Editar página" : "Nova página"}</h2>
                <div className="flex flex-wrap gap-3">
                  <label className="flex flex-col gap-1 text-xs font-medium text-slate">
                    Tipo
                    <select aria-label="Tipo da página" value={editing.kind} onChange={(e) => setEditing({ ...editing, kind: e.target.value as MemoryPageKind })} className="rounded-sm border hairline-strong bg-surface px-2 py-1.5 text-[13px] text-ink">
                      {MEMORY_PAGE_KINDS.map((k) => (
                        <option key={k} value={k}>
                          {MEMORY_KIND_LABELS[k]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-1 flex-col gap-1 text-xs font-medium text-slate">
                    Título
                    <input aria-label="Título da página" value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} className="rounded-sm border hairline-strong bg-surface px-2.5 py-1.5 text-[13px] text-ink" />
                  </label>
                </div>
                <label className="flex flex-col gap-1 text-xs font-medium text-slate">
                  Conteúdo (markdown)
                  <textarea aria-label="Conteúdo da página" value={editing.bodyMd} onChange={(e) => setEditing({ ...editing, bodyMd: e.target.value })} rows={10} className="rounded-sm border hairline-strong bg-surface px-2.5 py-2 font-mono text-xs text-ink" />
                </label>
                <div className="flex gap-2">
                  <button type="submit" className="rounded-full bg-ink px-3.5 py-2 text-[13px] font-semibold text-paper">
                    Salvar
                  </button>
                  <button type="button" onClick={() => setEditing(null)} className="rounded-sm border hairline-strong bg-surface px-3 py-2 text-[13px] font-medium">
                    Cancelar
                  </button>
                </div>
              </form>
            ) : selected ? (
              <article aria-label={`Página: ${selected.title}`} className="flex flex-col gap-3 rounded-xl border hairline bg-surface p-5" data-testid="memory-page">
                <div className="flex flex-wrap items-start gap-3">
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className={["eyebrow", KIND_COLOR[selected.kind]].join(" ")}>{MEMORY_KIND_LABELS[selected.kind]}</span>
                    <h2 className="m-0 font-display text-lg font-bold tracking-tight">{selected.title}</h2>
                    <span className="text-xs text-slate">
                      memory/wiki/{selected.kind}/{selected.slug}.md · atualizada {formatRelative(selected.updatedAt)} ({selected.source === "auto" ? "consolidação automática" : selected.source === "haiku" ? "consolidação com Haiku" : selected.source === "agent" ? "pelo agente" : "você"}) · score {selected.score.toFixed(2)} · usada {selected.accessCount}×{selected.archivedAt ? " · arquivada" : ""}
                    </span>
                  </div>
                  <div className="ml-auto flex flex-wrap gap-2">
                    <button type="button" onClick={() => setEditing({ pageId: selected.id, kind: selected.kind, title: selected.title, bodyMd: selected.bodyMd })} className="rounded-sm border hairline-strong bg-surface px-3 py-1.5 text-[13px] font-medium">
                      Editar
                    </button>
                    <button
                      type="button"
                      aria-expanded={versions !== null}
                      onClick={async () => {
                        if (versions) {
                          setVersions(null);
                          return;
                        }
                        setVersions(await transport.invoke("list_memory_page_versions", { pageId: selected.id }));
                      }}
                      className="inline-flex items-center gap-1.5 rounded-sm border hairline-strong bg-surface px-3 py-1.5 text-[13px] font-medium"
                    >
                      <History size={14} aria-hidden /> Histórico · {selected.versions}
                    </button>
                    <button
                      type="button"
                      onClick={async () => {
                        const page = await transport.invoke("set_memory_page_archived", { pageId: selected.id, archived: !selected.archivedAt });
                        await refreshPages();
                        setSelected(page.archivedAt ? null : page);
                        setNotice(page.archivedAt ? "Página arquivada (continua na wiki e no histórico)." : "Página restaurada.");
                      }}
                      className="inline-flex items-center gap-1.5 rounded-sm border hairline-strong bg-surface px-3 py-1.5 text-[13px] font-medium text-slate hover:text-ink"
                    >
                      <Archive size={14} aria-hidden /> {selected.archivedAt ? "Restaurar" : "Arquivar"}
                    </button>
                  </div>
                </div>
                <div className="flex flex-col gap-2 text-[14px] leading-relaxed" data-testid="memory-page-body">
                  {renderMarkdown(selected.bodyMd)}
                </div>
                {versions && (
                  <section aria-label="Histórico de versões" className="flex flex-col gap-1 border-t hairline pt-3">
                    <h3 className="m-0 text-[13px] font-semibold">Versões</h3>
                    <ul className="m-0 flex list-none flex-col p-0 text-[13px]">
                      {versions.map((v) => (
                        <li key={v.id} className="flex justify-between gap-3 border-b hairline py-1.5 last:border-b-0">
                          <span>{v.reason}</span>
                          <span className="font-mono text-xs text-slate">
                            {formatRelative(v.createdAt)} · {v.bodyMd.length} caracteres
                          </span>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
              </article>
            ) : (
              <div className="flex flex-col items-center gap-2 rounded-xl border hairline bg-surface p-10 text-center text-[13px] text-slate">
                <BookOpen size={22} aria-hidden />
                <span>Escolha uma página à esquerda ou crie uma nova. As páginas são arquivos markdown na pasta de dados do app; o banco é só o índice.</span>
              </div>
            )}
          </div>
        </div>
      )}

      {tab === "handoffs" && (
        <section aria-label="Handoffs" className="flex flex-col gap-2 rounded-xl border hairline bg-surface p-5">
          <div className="flex items-baseline gap-3">
            <h2 className="m-0 font-display text-sm font-semibold">Handoffs entre runs</h2>
            <span className="text-xs text-slate">"onde parei / o que falhou / o que falta": deixados pelo agente (memory_handoff) ou gerados ao fim de um run que não terminou; o próximo run da mesma task recebe e consome</span>
          </div>
          <ul className="m-0 flex list-none flex-col p-0" data-testid="handoff-list">
            {(handoffs ?? []).map((h) => {
              const task = tasks.find((t) => t.id === h.taskId) ?? null;
              return (
                <li key={h.id} className={["flex flex-col gap-1 border-b hairline py-2.5 text-[13px] last:border-b-0", h.consumedAt ? "opacity-70" : ""].join(" ")} data-testid="handoff-row" data-consumed={Boolean(h.consumedAt)} data-source={h.source}>
                  <span className="flex flex-wrap items-baseline gap-2">
                    <span className={["eyebrow", h.consumedAt ? "text-slate" : "text-brand"].join(" ")}>{h.consumedAt ? "consumido" : "pendente"}</span>
                    <span className="font-semibold">{task ? task.title : h.taskId ? h.taskId : "run avulso"}</span>
                    <span className="font-mono text-xs text-slate">
                      {formatRelative(h.createdAt)} · {h.source === "auto" ? "gerado ao fim do run" : "deixado pelo agente"}
                      {h.consumedByRunId ? ` · lido pelo run ${h.consumedByRunId.slice(0, 12)}` : " · para o próximo run"}
                    </span>
                  </span>
                  <div className="flex flex-col gap-1 text-[13px]">{renderMarkdown(h.bodyMd)}</div>
                </li>
              );
            })}
            {handoffs !== null && handoffs.length === 0 && <li className="py-2 text-[13px] text-slate">Nenhum handoff ainda. Eles aparecem quando um run de task termina sem concluir ou quando o agente chama memory_handoff.</li>}
          </ul>
        </section>
      )}

      {tab === "observations" && (
        <section aria-label="Observações" className="flex flex-col gap-2 rounded-xl border hairline bg-surface p-5">
          <div className="flex items-baseline gap-3">
            <h2 className="m-0 font-display text-sm font-semibold">Observações recentes</h2>
            <span className="text-xs text-slate">capturadas por hooks PostToolUse, Stop, SubagentStop e SessionEnd; sanitizadas antes de gravar; viram o log de tarefas ao fim do run</span>
          </div>
          <ul className="m-0 flex list-none flex-col p-0" data-testid="observation-list">
            {(observations ?? []).map((o) => (
              <li key={o.id} className="grid grid-cols-[90px_minmax(0,1fr)] gap-3 border-b hairline py-2 text-[13px] last:border-b-0" data-testid="observation-row" data-kind={o.kind} data-redacted={o.redacted}>
                <span className="eyebrow text-slate">{o.kind === "tool_use" ? "ferramenta" : o.kind === "turn_end" ? "turno" : o.kind === "subagent_end" ? "subagente" : "sessão"}</span>
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="flex flex-wrap items-baseline gap-2">
                    <span className="font-semibold">{o.title}</span>
                    <span className="font-mono text-xs text-slate">{formatRelative(o.createdAt)}</span>
                    {o.redacted && <span className="rounded-sm bg-brand-soft px-1.5 py-0.5 font-mono text-[11px] text-brand-hover">segredo redigido</span>}
                    {o.consolidatedAt && <span className="text-xs text-slate">· consolidada</span>}
                  </span>
                  {o.body && <pre className="m-0 max-h-32 overflow-auto whitespace-pre-wrap font-mono text-xs text-slate">{o.body}</pre>}
                </div>
              </li>
            ))}
            {observations !== null && observations.length === 0 && <li className="py-2 text-[13px] text-slate">Nenhuma observação ainda. Elas aparecem conforme os runs usam ferramentas e encerram turnos.</li>}
          </ul>
        </section>
      )}
    </div>
  );
}

/** Markdown mínimo e seguro (sem HTML): títulos, negrito, código inline, listas e parágrafos. */
export function renderMarkdown(md: string): ReactNode[] {
  const out: ReactNode[] = [];
  const lines = md.split("\n");
  let list: string[] = [];
  const flushList = () => {
    if (list.length === 0) return;
    out.push(
      <ul key={`ul_${out.length}`} className="m-0 flex list-disc flex-col gap-0.5 pl-5">
        {list.map((item, i) => (
          <li key={i}>{inline(item)}</li>
        ))}
      </ul>,
    );
    list = [];
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^\s*[-*]\s+/.test(line)) {
      list.push(line.replace(/^\s*[-*]\s+/, ""));
      continue;
    }
    flushList();
    if (!line.trim()) continue;
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      const cls = level <= 2 ? "m-0 mt-2 font-display text-[15px] font-semibold" : "m-0 mt-1 text-[13px] font-semibold";
      out.push(
        <p key={`h_${out.length}`} role="heading" aria-level={Math.min(6, level + 2)} className={cls}>
          {inline(heading[2]!)}
        </p>,
      );
      continue;
    }
    out.push(
      <p key={`p_${out.length}`} className="m-0">
        {inline(line)}
      </p>,
    );
  }
  flushList();
  return out;
}

function inline(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const token = m[0];
    if (token.startsWith("**")) parts.push(<strong key={m.index}>{token.slice(2, -2)}</strong>);
    else parts.push(<code key={m.index} className="rounded-sm bg-paper px-1 font-mono text-xs">{token.slice(1, -1)}</code>);
    last = m.index + token.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}
