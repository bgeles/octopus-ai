import { FolderOpen } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { isTauri } from "../lib/transport";

type AddProjectDialogProps = {
  open: boolean;
  onClose: () => void;
  onCreate: (input: { name: string; path: string }) => Promise<void>;
};

export function AddProjectDialog({ open, onClose, onCreate }: AddProjectDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const pickFolder = async () => {
    if (!isTauri()) return;
    const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
    const selected = await openDialog({ directory: true, multiple: false, title: "Escolha a pasta do projeto" });
    if (typeof selected === "string") {
      setPath(selected);
      if (!name) setName(selected.split("/").filter(Boolean).pop() ?? "");
    }
  };

  const submit = async () => {
    setError(null);
    if (!name.trim() || !path.trim()) {
      setError("Informe nome e pasta do projeto.");
      return;
    }
    setSaving(true);
    try {
      await onCreate({ name: name.trim(), path: path.trim() });
      setName("");
      setPath("");
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <dialog ref={dialogRef} onClose={onClose} aria-labelledby="add-project-title" className="m-auto w-[480px] max-w-[calc(100vw-32px)] rounded-xl border hairline bg-white p-0 shadow-md backdrop:bg-black/40">
      <form
        method="dialog"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="flex flex-col gap-4 p-6"
      >
        <div className="flex flex-col gap-1">
          <div className="eyebrow text-brand">Novo projeto</div>
          <h2 id="add-project-title" className="m-0 font-display text-lg font-bold tracking-tight">
            Adicionar projeto
          </h2>
          <p className="m-0 text-[13px] text-slate">O agente trabalhará dentro desta pasta. As sessões ficam associadas a ela.</p>
        </div>
        <label className="flex flex-col gap-1 text-[13px] font-medium text-slate">
          Nome
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="chat-core" className="rounded-sm border hairline-strong px-3 py-2 text-sm text-ink" />
        </label>
        <label className="flex flex-col gap-1 text-[13px] font-medium text-slate">
          Pasta
          <div className="flex gap-2">
            <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="/Users/voce/projetos/chat-core" className="min-w-0 flex-1 rounded-sm border hairline-strong px-3 py-2 font-mono text-[13px] text-ink" />
            <button type="button" onClick={() => void pickFolder()} className="inline-flex items-center gap-1.5 rounded-md border hairline-strong px-3 py-2 text-[13px] font-medium text-ink hover:border-ink">
              <FolderOpen size={14} aria-hidden /> Escolher
            </button>
          </div>
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
            {saving ? "Salvando…" : "Adicionar"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
