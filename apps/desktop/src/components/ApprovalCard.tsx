import { useEffect, useState } from "react";
import type { FilePreview, PermissionDecision } from "../lib/types";
import { DiffView } from "./DiffView";

/** O que o card precisa saber de um pedido de permissão, venha do run ao vivo ou da lista persistida. */
export type ApprovalRequest = {
  runId: string;
  requestId: string;
  toolName: string;
  input: unknown;
  reason: string | null;
  at: string;
  /** Prompt do run, quando o card aparece fora do transcript. */
  runPrompt?: string | null;
};

export type DecideFn = (runId: string, requestId: string, decision: PermissionDecision, note: string | null) => void;
export type ReadFileFn = (path: string) => Promise<FilePreview>;

type ApprovalCardProps = {
  request: ApprovalRequest;
  onDecide: DecideFn;
  busy: boolean;
  /** Lê o arquivo atual do projeto para o diff de `Write`. Sem ele, mostra só o conteúdo novo. */
  readFile?: ReadFileFn;
  /** Indentação do transcript (alinha com as mensagens do agente). */
  inset?: boolean;
};

type WritePreviewState = { status: "idle" | "loading" | "error" } | { status: "ready"; preview: FilePreview };

export function ApprovalCard({ request, onDecide, busy, readFile, inset = false }: ApprovalCardProps) {
  const [note, setNote] = useState("");
  const input = asRecord(request.input);
  const filePath = stringField(input, "file_path");
  const [writePreview, setWritePreview] = useState<WritePreviewState>({ status: "idle" });

  useEffect(() => {
    if (request.toolName !== "Write" || !filePath || !readFile) return;
    let cancelled = false;
    setWritePreview({ status: "loading" });
    readFile(filePath)
      .then((preview) => {
        if (!cancelled) setWritePreview({ status: "ready", preview });
      })
      .catch(() => {
        if (!cancelled) setWritePreview({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [request.toolName, filePath, readFile]);

  const summary = summarizeInput(request.toolName, request.input);
  const trimmedNote = note.trim();

  return (
    <section
      aria-label={`Aprovação necessária: ${request.toolName}`}
      className={[inset ? "ml-10" : "", "flex flex-col gap-2.5 rounded-xl border-[1.5px] border-brand bg-surface p-3.5"].join(" ")}
      data-testid="approval-card"
      data-request-id={request.requestId}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="eyebrow text-brand">Aprovação necessária</span>
        {request.runPrompt && <span className="truncate text-xs text-slate">Run: {request.runPrompt}</span>}
        {request.reason && <span className="ml-auto text-xs text-slate">{request.reason}</span>}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <span className="font-semibold text-ink">{request.toolName}</span>
        <code className="min-w-0 flex-1 truncate rounded-sm bg-paper px-2.5 py-1.5 font-mono text-xs text-ink">{summary}</code>
        {request.toolName === "Write" && writePreview.status === "ready" && (
          <span className={["rounded-full px-2 py-0.5 text-[11px] font-semibold", writePreview.preview.exists ? "bg-warning-soft text-warning-ink" : "bg-success-soft text-success-ink"].join(" ")} data-testid="write-kind">
            {writePreview.preview.exists ? "sobrescreve arquivo" : "arquivo novo"}
          </span>
        )}
      </div>

      <Preview request={request} input={input} writePreview={writePreview} />

      <details className="text-xs text-slate">
        <summary className="cursor-pointer">Ver entrada completa</summary>
        <pre className="m-0 mt-1 max-h-48 overflow-auto rounded-sm bg-paper p-2 font-mono whitespace-pre-wrap">{JSON.stringify(request.input, null, 2)}</pre>
      </details>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => onDecide(request.runId, request.requestId, { behavior: "allow" }, trimmedNote || null)}
          className="rounded-full bg-brand px-3.5 py-2 text-[13px] font-semibold text-white hover:bg-brand-hover disabled:opacity-50"
        >
          Permitir uma vez
        </button>
        <label className="sr-only" htmlFor={`note-${request.runId}-${request.requestId}`}>
          Motivo da decisão
        </label>
        <input
          id={`note-${request.runId}-${request.requestId}`}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Motivo (opcional, fica no histórico do run)"
          className="min-w-0 flex-1 basis-56 rounded-sm border hairline-strong bg-surface px-2.5 py-1.5 text-[13px]"
        />
        <button
          type="button"
          disabled={busy}
          onClick={() => onDecide(request.runId, request.requestId, { behavior: "deny", message: trimmedNote || "Negado pelo usuário" }, trimmedNote || null)}
          className="rounded-md border hairline-strong bg-surface px-3.5 py-2 text-[13px] font-medium text-ink hover:border-ink disabled:opacity-50"
        >
          Negar
        </button>
      </div>
    </section>
  );
}

function Preview({ request, input, writePreview }: { request: ApprovalRequest; input: Record<string, unknown> | null; writePreview: WritePreviewState }) {
  switch (request.toolName) {
    case "Bash": {
      const command = stringField(input, "command");
      if (!command) return null;
      return (
        <pre className="m-0 overflow-x-auto rounded-md bg-sidebar px-3 py-2.5 font-mono text-xs text-sidebar-ink" data-testid="preview-command">
          {command}
          {stringField(input, "description") ? `\n# ${stringField(input, "description")}` : ""}
        </pre>
      );
    }
    case "Edit": {
      const oldString = stringField(input, "old_string") ?? "";
      const newString = stringField(input, "new_string") ?? "";
      return <DiffView before={oldString} after={newString} />;
    }
    case "Write": {
      const content = stringField(input, "content") ?? "";
      if (writePreview.status === "loading") return <p className="m-0 text-xs text-slate">Carregando o arquivo atual para comparar…</p>;
      if (writePreview.status === "ready" && writePreview.preview.exists) return <DiffView before={writePreview.preview.content} after={content} />;
      return <DiffView before="" after={content} context={Number.MAX_SAFE_INTEGER} />;
    }
    default:
      return null;
  }
}

export function summarizeInput(toolName: string, input: unknown): string {
  if (typeof input !== "object" || input === null) return input === undefined || input === null ? "" : String(input);
  const record = input as Record<string, unknown>;
  // Tools de delegação do Octopus: resumo legível em vez de chave=valor.
  if (toolName === "mcp__octopus__team_list") return "quem está no time e para quem posso delegar";
  if (toolName === "mcp__octopus__task_create" && typeof record.title === "string") return `${record.title}${typeof record.assignee === "string" ? ` → ${record.assignee}` : ""}`;
  if (toolName === "mcp__octopus__task_assign" && typeof record.taskId === "string") return `${record.taskId} → ${String(record.assignee ?? "")}`;
  if (toolName === "mcp__octopus__task_list") return typeof record.status === "string" ? `tasks ${record.status}` : "tasks abertas";
  const preferred = ["command", "file_path", "pattern", "path", "query", "url", "prompt", "description"];
  for (const key of preferred) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  const keys = Object.keys(record);
  if (keys.length === 0) return toolName;
  return keys.map((k) => `${k}=${JSON.stringify(record[k])}`).join(" ");
}

function asRecord(input: unknown): Record<string, unknown> | null {
  return typeof input === "object" && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : null;
}

function stringField(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" ? value : null;
}
