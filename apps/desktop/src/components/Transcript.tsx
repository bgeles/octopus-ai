import { AlertTriangle, Check, ChevronRight, X } from "lucide-react";
import { useState } from "react";
import { subagentTree, topLevelItems, type PendingPermission, type SubagentNode, type TranscriptItem } from "../state/runReducer";
import { ApprovalCard, summarizeInput, type DecideFn, type ReadFileFn } from "./ApprovalCard";
import { subagentCounters } from "./RunSidebar";

type TranscriptProps = {
  runId: string | null;
  items: TranscriptItem[];
  pendingPermissions: PendingPermission[];
  onDecide: DecideFn;
  deciding?: string | null;
  readFile?: ReadFileFn;
};

export function Transcript({ runId, items, pendingPermissions, onDecide, deciding, readFile }: TranscriptProps) {
  if (items.length === 0 && pendingPermissions.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-center text-slate">
        <p className="max-w-sm">Nenhum run ainda. Descreva uma tarefa abaixo e acompanhe o agente trabalhando aqui.</p>
      </div>
    );
  }

  // Itens de subagentes ficam aninhados sob a chamada Agent que os originou.
  const tree = subagentTree(items);
  const nodesById = new Map(tree.map((n) => [n.toolUseId, n]));
  // Agrupa itens contíguos do assistente/ferramentas em um "turno".
  const groups = groupItems(topLevelItems(items, tree));

  return (
    <div className="flex w-full max-w-[920px] flex-col gap-4 p-6" aria-live="polite">
      {groups.map((group) =>
        group.kind === "user" ? (
          <article key={group.id} className="flex gap-3" data-testid="transcript-user">
            <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-ink text-[11px] font-semibold text-paper">Você</div>
            <div className="flex flex-1 flex-col gap-1">
              <div className="text-xs text-slate">Você · {formatTime(group.at)}</div>
              <div className="rounded-xl border hairline bg-surface px-3.5 py-3 whitespace-pre-wrap">{group.text}</div>
            </div>
          </article>
        ) : (
          <article key={group.id} className="flex gap-3" data-testid="transcript-assistant">
            <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-brand text-white">
              <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="9" r="5" />
                <path d="M7 13c-1 3-3 5-4 6" />
                <path d="M17 13c1 3 3 5 4 6" />
              </svg>
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <div className="text-xs text-slate">Agente · {formatTime(group.at)}</div>
              {group.items.map((item) => {
                if (item.kind === "assistant") {
                  return (
                    <p key={item.id} className={["m-0 whitespace-pre-wrap text-ink", item.parentToolUseId ? "border-l-2 border-mist pl-3 text-[13px]" : ""].join(" ")}>
                      {item.text}
                      {item.streaming && <span aria-label="gerando" className="ml-0.5 inline-block h-[1em] w-[2px] translate-y-[2px] animate-pulse bg-brand" />}
                    </p>
                  );
                }
                if (item.kind === "tool") return <ToolCall key={item.id} item={item} subagent={nodesById.get(item.toolUseId) ?? null} />;
                if (item.kind === "error") {
                  return (
                    <div key={item.id} role="alert" className="flex items-start gap-2 rounded-md border border-brand/40 bg-brand-soft px-3 py-2 text-[13px] text-brand-hover">
                      <AlertTriangle size={14} aria-hidden className="mt-0.5 shrink-0" />
                      <span>{item.message}</span>
                    </div>
                  );
                }
                return null;
              })}
            </div>
          </article>
        ),
      )}

      {pendingPermissions.map((permission) => (
        <ApprovalCard
          key={permission.requestId}
          request={{ runId: runId ?? "", requestId: permission.requestId, toolName: permission.toolName, input: permission.input, reason: permission.reason, at: permission.at }}
          onDecide={onDecide}
          busy={deciding === permission.requestId}
          readFile={readFile}
          inset
        />
      ))}
    </div>
  );
}

function ToolCall({ item, subagent = null }: { item: Extract<TranscriptItem, { kind: "tool" }>; subagent?: SubagentNode | null }) {
  const [open, setOpen] = useState(false);
  const summary = subagent ? subagent.name : summarizeInput(item.name, item.input);
  const status = item.result === null ? "pending" : item.isError ? "error" : "ok";
  return (
    <div className={["rounded-md border hairline bg-surface text-[13px]", item.parentToolUseId ? "ml-3" : "", subagent ? "border-l-2 border-l-ink" : ""].join(" ")} data-testid="tool-call">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-center gap-2 px-3 py-2 text-left">
        {status === "pending" && <span aria-label="executando" className="size-3.5 shrink-0 animate-spin rounded-full border-2 border-mist border-t-brand" />}
        {status === "ok" && <Check size={14} aria-label="concluída" className="shrink-0 text-success" />}
        {status === "error" && <X size={14} aria-label="falhou" className="shrink-0 text-brand" />}
        <span className="font-semibold text-ink">{subagent ? "Subagente" : item.name}</span>
        <span className={["min-w-0 flex-1 truncate text-xs", subagent ? "text-ink" : "font-mono text-slate"].join(" ")}>{summary}</span>
        {subagent && <span className="shrink-0 text-xs text-slate">{subagentCounters(subagent)}</span>}
        <ChevronRight size={14} aria-hidden className={["shrink-0 text-slate transition-transform", open ? "rotate-90" : ""].join(" ")} />
      </button>
      {subagent && <SubagentActivity node={subagent} />}
      {open && (
        <div className="flex flex-col gap-2 border-t hairline px-3 py-2">
          <div>
            <div className="mb-1 text-xs font-medium text-slate">Entrada</div>
            <pre className="m-0 max-h-48 overflow-auto rounded-sm bg-paper p-2 font-mono text-xs whitespace-pre-wrap">{JSON.stringify(item.input, null, 2)}</pre>
          </div>
          {item.result !== null && (
            <div>
              <div className="mb-1 text-xs font-medium text-slate">{item.isError ? "Erro" : "Resultado"}</div>
              <pre className="m-0 max-h-64 overflow-auto rounded-sm bg-paper p-2 font-mono text-xs whitespace-pre-wrap">{item.result}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

type Group = { kind: "user"; id: string; text: string; at: string } | { kind: "assistant"; id: string; at: string; items: TranscriptItem[] };

function groupItems(items: TranscriptItem[]): Group[] {
  const groups: Group[] = [];
  for (const item of items) {
    if (item.kind === "user") {
      groups.push({ kind: "user", id: item.id, text: item.text, at: item.at });
      continue;
    }
    const last = groups[groups.length - 1];
    if (last && last.kind === "assistant") {
      last.items.push(item);
    } else {
      groups.push({ kind: "assistant", id: `group_${item.id}`, at: item.at, items: [item] });
    }
  }
  return groups;
}

function SubagentActivity({ node }: { node: SubagentNode }) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <div className="flex flex-col gap-1.5 border-t hairline px-3 py-2" data-testid="subagent-group" data-status={node.status}>
      <button type="button" onClick={() => setCollapsed((c) => !c)} aria-expanded={!collapsed} className="flex items-center gap-2 text-left text-xs text-slate">
        <ChevronRight size={12} aria-hidden className={["transition-transform", collapsed ? "" : "rotate-90"].join(" ")} />
        <span>
          Atividade do subagente{node.subagentType ? ` (${node.subagentType})` : ""} · {node.status === "running" ? "em execução" : node.status === "error" ? "falhou" : "concluído"}
        </span>
      </button>
      {!collapsed && (
        <div className="flex flex-col gap-1.5 border-l-2 border-mist pl-3">
          {node.children.length === 0 && <span className="text-xs text-slate">Aguardando a primeira ação…</span>}
          {node.children.map((child) => {
            if (child.kind === "tool") return <ToolCall key={child.id} item={{ ...child, parentToolUseId: null }} />;
            if (child.kind !== "assistant") return null;
            return (
              <p key={child.id} className="m-0 text-[13px] whitespace-pre-wrap text-ink">
                {child.text}
                {child.streaming && <span aria-label="gerando" className="ml-0.5 inline-block h-[1em] w-[2px] translate-y-[2px] animate-pulse bg-brand" />}
              </p>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}
