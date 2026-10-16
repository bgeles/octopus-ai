import { useState } from "react";
import type { ImportMode, ImportPreview } from "../lib/types";

type ImportPreviewPanelProps = {
  preview: ImportPreview;
  busy: boolean;
  onConfirm: (mode: ImportMode) => void;
  onCancel: () => void;
  title?: string;
};

export function ImportPreviewPanel({ preview, busy, onConfirm, onCancel, title = "Restaurar" }: ImportPreviewPanelProps) {
  const [mode, setMode] = useState<ImportMode>("merge");
  return (
    <aside aria-label="Prévia da restauração" className="flex flex-col gap-2.5 rounded-md border-[1.5px] border-ink bg-paper p-4" data-testid="import-preview">
      <div className="flex items-baseline gap-2.5">
        <span className="eyebrow text-brand">{title}</span>
        <span className="text-xs text-slate">
          exportado em {new Date(preview.exportedAt).toLocaleString("pt-BR")} · schema {preview.schemaVersion}
        </span>
      </div>
      <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[13px]">
        <Row label="Projetos novos" value={preview.projectsNew} />
        <Row label="Projetos iguais" value={preview.projectsSame} />
        <Row label="Conflitos" value={preview.projectsConflict} tone="warning" hint="mesmo id ou pasta com dados diferentes" />
        <Row label={mode === "replace" ? "Projetos removidos (com histórico)" : "Projetos só locais (mantidos)"} value={preview.projectsRemoved} tone={mode === "replace" ? "danger" : undefined} />
        <li className="flex justify-between gap-3">
          <span>Preferências</span>
          <span className="font-mono text-xs">{preview.settings}</span>
        </li>
      </ul>
      <div role="radiogroup" aria-label="Modo de restauração" className="flex rounded-md border hairline-strong bg-surface p-0.5 text-xs">
        {(["merge", "replace"] as ImportMode[]).map((option) => (
          <button key={option} type="button" role="radio" aria-checked={mode === option} onClick={() => setMode(option)} className={["flex-1 rounded-sm px-2 py-1.5 font-medium", mode === option ? "bg-ink text-paper" : "text-slate hover:text-ink"].join(" ")}>
            {option === "merge" ? "Mesclar" : "Substituir configurações"}
          </button>
        ))}
      </div>
      <span className="text-xs text-slate">Uma cópia "antes de restaurar" é criada automaticamente.</span>
      <div className="flex gap-2">
        <button type="button" disabled={busy} onClick={() => onConfirm(mode)} className="rounded-full bg-brand px-3.5 py-2 text-[13px] font-semibold text-white hover:bg-brand-hover disabled:opacity-50">
          {busy ? "Restaurando…" : title}
        </button>
        <button type="button" onClick={onCancel} className="rounded-md border hairline-strong bg-surface px-3.5 py-2 text-[13px] font-medium">
          Cancelar
        </button>
      </div>
    </aside>
  );
}

function Row({ label, value, tone, hint }: { label: string; value: string[]; tone?: "warning" | "danger"; hint?: string }) {
  const color = tone === "warning" ? "text-warning-ink" : tone === "danger" ? "text-brand-hover" : "";
  return (
    <li className={["flex justify-between gap-3", color].join(" ")} title={value.join(", ") || hint}>
      <span>{label}</span>
      <span className="font-mono text-xs">{value.length === 0 ? "0" : value.length <= 3 ? value.join(", ") : `${value.length}`}</span>
    </li>
  );
}
