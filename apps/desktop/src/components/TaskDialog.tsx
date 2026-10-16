import { useEffect, useRef, useState } from "react";
import type { Task, TaskInput, TeamMember, Workflow } from "../lib/types";

type TaskDialogProps = {
  open: boolean;
  workflow: Workflow | null;
  tasks: Task[];
  team: TeamMember[];
  onClose: () => void;
  onCreate: (input: TaskInput) => Promise<void>;
};

export function TaskDialog({ open, workflow, tasks, team, onClose, onCreate }: TaskDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [acceptance, setAcceptance] = useState("");
  const [stageId, setStageId] = useState("");
  const [dependsOn, setDependsOn] = useState("");
  const [ready, setReady] = useState(true);
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
    setTitle("");
    setDescription("");
    setAcceptance("");
    setDependsOn("");
    setReady(true);
    setError(null);
    setStageId(workflow?.stages[0]?.id ?? "");
  }, [open, workflow]);

  const submit = async () => {
    setError(null);
    if (!title.trim()) {
      setError("Informe o título da task.");
      return;
    }
    setSaving(true);
    try {
      await onCreate({ title: title.trim(), descriptionMd: description.trim(), acceptanceMd: acceptance.trim(), stageId: stageId || null, dependsOn: dependsOn ? [dependsOn] : [], ready });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const memberName = (id: string | null) => team.find((m) => m.profile.id === id)?.profile.name ?? null;

  return (
    <dialog ref={dialogRef} onClose={onClose} aria-labelledby="task-dialog-title" className="m-auto w-[560px] max-w-[calc(100vw-32px)] rounded-xl border hairline bg-surface p-0 text-ink shadow-md backdrop:bg-black/40">
      <form
        method="dialog"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="flex flex-col gap-4 p-6"
      >
        <div className="flex flex-col gap-1">
          <div className="eyebrow text-brand">Nova task</div>
          <h2 id="task-dialog-title" className="m-0 font-display text-lg font-bold tracking-tight">
            {workflow ? workflow.name : "Task"}
          </h2>
          <p className="m-0 text-[13px] text-slate">O scheduler começa pelo estágio escolhido assim que as dependências estiverem concluídas.</p>
        </div>
        <label className="flex flex-col gap-1 text-[13px] font-medium text-slate">
          Título
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Corrigir N+1 em LeadRepository.findAll" className="rounded-sm border hairline-strong bg-surface px-3 py-2 text-sm text-ink" />
        </label>
        <label className="flex flex-col gap-1 text-[13px] font-medium text-slate">
          Descrição
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} placeholder="O que fazer e o contexto necessário" className="resize-y rounded-sm border hairline-strong bg-surface px-3 py-2 text-sm text-ink" />
        </label>
        <label className="flex flex-col gap-1 text-[13px] font-medium text-slate">
          Critérios de aceite
          <textarea value={acceptance} onChange={(e) => setAcceptance(e.target.value)} rows={2} placeholder="- Testes verdes&#10;- Sem alteração em migrações antigas" className="resize-y rounded-sm border hairline-strong bg-surface px-3 py-2 text-sm text-ink" />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1 text-[13px] font-medium text-slate">
            Começa em
            <select aria-label="Começa em" value={stageId} onChange={(e) => setStageId(e.target.value)} className="rounded-sm border hairline-strong bg-surface px-3 py-2 text-sm text-ink">
              {(workflow?.stages ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                  {s.gate ? " · você" : memberName(s.agentProfileId) ? ` · ${memberName(s.agentProfileId)}` : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[13px] font-medium text-slate">
            Depende de
            <select aria-label="Depende de" value={dependsOn} onChange={(e) => setDependsOn(e.target.value)} className="rounded-sm border hairline-strong bg-surface px-3 py-2 text-sm text-ink">
              <option value="">Nenhuma</option>
              {tasks.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="flex items-center gap-2 text-[13px]">
          <input type="checkbox" checked={ready} onChange={(e) => setReady(e.target.checked)} />
          Entrar na fila agora (desmarque para deixar no backlog)
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
            {saving ? "Criando…" : "Criar task"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
