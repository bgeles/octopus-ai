import { useEffect, useRef, useState } from "react";
import type { Project } from "../lib/types";

type MissionDialogProps = {
  open: boolean;
  project: Project | null;
  onClose: () => void;
  onSave: (mission: string | null) => Promise<void>;
};

export const MAX_MISSION_CHARS = 2000;

/** Diálogo da missão do projeto: uma frase ou um parágrafo; vazio apaga. */
export function MissionDialog({ open, project, onClose, onSave }: MissionDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [mission, setMission] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setMission(project?.mission ?? "");
    setError(null);
  }, [open, project]);

  const submit = async () => {
    setError(null);
    if (mission.trim().length > MAX_MISSION_CHARS) {
      setError(`A missão pode ter no máximo ${MAX_MISSION_CHARS} caracteres.`);
      return;
    }
    setSaving(true);
    try {
      await onSave(mission.trim() || null);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <dialog ref={dialogRef} onClose={onClose} aria-labelledby="mission-dialog-title" className="m-auto w-[560px] max-w-[calc(100vw-32px)] rounded-xl border hairline bg-surface p-0 text-ink shadow-md backdrop:bg-black/40">
      <form
        method="dialog"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="flex flex-col gap-4 p-6"
      >
        <div className="flex flex-col gap-1">
          <div className="eyebrow text-brand">{project?.name ?? "Projeto"}</div>
          <h2 id="mission-dialog-title" className="m-0 font-display text-lg font-bold tracking-tight">
            Missão do projeto
          </h2>
          <p className="m-0 text-[13px] text-slate">O porquê do trabalho. Entra no prompt de todo run de task e de todo membro como contexto; não muda política, sandbox nem permissões.</p>
        </div>
        <label className="flex flex-col gap-1 text-[13px] font-medium text-slate">
          Missão
          <textarea aria-label="Missão" value={mission} onChange={(e) => setMission(e.target.value)} rows={4} maxLength={MAX_MISSION_CHARS + 1} placeholder="Reduzir o tempo de triagem de leads em 30% até dezembro, sem perder leads qualificados." className="resize-y rounded-sm border hairline-strong bg-surface px-3 py-2 text-sm text-ink" />
          <span className="text-xs font-normal">
            {mission.trim().length} de {MAX_MISSION_CHARS}
          </span>
        </label>
        {error && (
          <div role="alert" className="rounded-md bg-brand-soft px-3 py-2 text-[13px] text-brand-hover">
            {error}
          </div>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="rounded-md border hairline-strong px-3.5 py-2 text-[13px] font-medium text-ink">
            Cancelar
          </button>
          <button type="submit" disabled={saving} className="rounded-full bg-brand px-4 py-2 text-[13px] font-semibold text-white hover:bg-brand-hover disabled:opacity-50">
            {saving ? "Salvando…" : "Salvar missão"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
