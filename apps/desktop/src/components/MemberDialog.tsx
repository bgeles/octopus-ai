import { useEffect, useRef, useState } from "react";
import { EFFORT_LABELS, EFFORT_LEVELS } from "../lib/effort";
import type { EffortLevel, McpServer, PermissionMode, Role, Skill, TeamMember, TeamMemberInput } from "../lib/types";

type MemberDialogProps = {
  open: boolean;
  roles: Role[];
  team: TeamMember[];
  /** Membro em edição; ausente = novo. */
  member?: TeamMember | null;
  onClose: () => void;
  onSave: (input: TeamMemberInput) => Promise<void>;
  onRemove?: () => Promise<void>;
  /** MCP servers e skills disponíveis no projeto (Harness); vazio = seção oculta. */
  mcpServers?: McpServer[];
  skills?: Skill[];
};

const PERMISSION_LABELS: Record<PermissionMode, string> = {
  default: "Perguntar antes de agir",
  acceptEdits: "Aceitar edições de arquivos",
  plan: "Somente planejar",
  dontAsk: "Negar o que pediria aprovação",
  auto: "Classificador automático",
};

export function MemberDialog({ open, roles, team, member = null, onClose, onSave, onRemove, mcpServers = [], skills = [] }: MemberDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState("");
  const [roleId, setRoleId] = useState("");
  const [reportsTo, setReportsTo] = useState("");
  const [instructions, setInstructions] = useState("");
  const [permissionMode, setPermissionMode] = useState<"" | PermissionMode>("");
  const [maxBudget, setMaxBudget] = useState("");
  const [effort, setEffort] = useState<"" | EffortLevel>("");
  /** `null` = todos os ativos; lista = subconjunto escolhido. */
  const [mcpSel, setMcpSel] = useState<string[] | null>(null);
  const [skillSel, setSkillSel] = useState<string[] | null>(null);
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
    setError(null);
    setName(member?.profile.name ?? "");
    setRoleId(member?.profile.roleId ?? roles[0]?.id ?? "");
    setMcpSel(member?.profile.mcpServerIds ?? null);
    setSkillSel(member?.profile.skillIds ?? null);
    setReportsTo(member?.reportsToAgentId ?? "");
    setInstructions(member?.profile.instructionsMd ?? "");
    setPermissionMode(member?.profile.permissionMode ?? "");
    setMaxBudget(member?.profile.maxBudgetUsd != null ? String(member.profile.maxBudgetUsd) : "");
    setEffort(member?.profile.effort ?? "");
  }, [open, member, roles]);

  const role = roles.find((r) => r.id === roleId) ?? null;
  const candidates = team.filter((m) => m.profile.id !== member?.profile.id);

  const submit = async () => {
    setError(null);
    if (!name.trim()) {
      setError("Informe o nome do membro.");
      return;
    }
    if (!roleId) {
      setError("Escolha um cargo.");
      return;
    }
    const budget = maxBudget.trim() ? Number(maxBudget.replace(",", ".")) : null;
    if (budget !== null && (Number.isNaN(budget) || budget <= 0)) {
      setError("Orçamento inválido.");
      return;
    }
    setSaving(true);
    try {
      await onSave({ name: name.trim(), roleId, reportsToAgentId: reportsTo || null, instructionsMd: instructions.trim() || null, permissionMode: permissionMode || null, maxBudgetUsd: budget, effort: effort || null, mcpServerIds: mcpSel, skillIds: skillSel });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <dialog ref={dialogRef} onClose={onClose} aria-labelledby="member-dialog-title" className="m-auto w-[560px] max-w-[calc(100vw-32px)] rounded-xl border hairline bg-surface p-0 text-ink shadow-md backdrop:bg-black/40">
      <form
        method="dialog"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="flex flex-col gap-4 p-6"
      >
        <div className="flex flex-col gap-1">
          <div className="eyebrow text-brand">{member ? "Editar membro" : "Novo membro"}</div>
          <h2 id="member-dialog-title" className="m-0 font-display text-lg font-bold tracking-tight">
            {member ? member.profile.name : "Adicionar ao time"}
          </h2>
          <p className="m-0 text-[13px] text-slate">O membro herda as responsabilidades do cargo; instruções específicas e limites são opcionais.</p>
        </div>

        <label className="flex flex-col gap-1 text-[13px] font-medium text-slate">
          Nome
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ana" className="rounded-sm border hairline-strong bg-surface px-3 py-2 text-sm text-ink" />
        </label>

        <label className="flex flex-col gap-1 text-[13px] font-medium text-slate">
          Cargo
          <select aria-label="Cargo" value={roleId} onChange={(e) => setRoleId(e.target.value)} className="rounded-sm border hairline-strong bg-surface px-3 py-2 text-sm text-ink">
            {roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.title} · {r.specialty}
              </option>
            ))}
          </select>
        </label>
        {role && (
          <div className="rounded-md bg-paper px-3.5 py-3 text-[13px]" data-testid="role-preview">
            <div className="mb-1 text-xs font-medium text-slate">Responsabilidades do cargo</div>
            <p className="m-0 whitespace-pre-line text-ink">{role.responsibilitiesMd}</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {(role.defaultTools ?? []).map((t) => (
                <span key={t} className="rounded-full border hairline-strong px-2 py-0.5 font-mono text-[11px]">
                  {t}
                </span>
              ))}
              {role.defaultPermissionMode && <span className="rounded-full border hairline-strong px-2 py-0.5 text-[11px]">{PERMISSION_LABELS[role.defaultPermissionMode]}</span>}
            </div>
          </div>
        )}

        <label className="flex flex-col gap-1 text-[13px] font-medium text-slate">
          Reporta a
          <select aria-label="Reporta a" value={reportsTo} onChange={(e) => setReportsTo(e.target.value)} className="rounded-sm border hairline-strong bg-surface px-3 py-2 text-sm text-ink">
            <option value="">Você (gestor)</option>
            {candidates.map((m) => (
              <option key={m.profile.id} value={m.profile.id}>
                {m.profile.name} · {m.role.title}
              </option>
            ))}
          </select>
        </label>
        <span className="-mt-3 text-xs text-slate">Quem reporta a um membro vira subagente dele: o chefe pode delegar tarefas.</span>

        <label className="flex flex-col gap-1 text-[13px] font-medium text-slate">
          Instruções específicas (opcional)
          <textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={3} placeholder="Ex.: prefira Java 21; nunca toque em migrations antigas." className="resize-y rounded-sm border hairline-strong bg-surface px-3 py-2 text-sm text-ink" />
        </label>

        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1 text-[13px] font-medium text-slate">
            Permissões
            <select aria-label="Permissões" value={permissionMode} onChange={(e) => setPermissionMode(e.target.value as "" | PermissionMode)} className="rounded-sm border hairline-strong bg-surface px-3 py-2 text-sm text-ink">
              <option value="">Padrão do cargo</option>
              {(Object.keys(PERMISSION_LABELS) as PermissionMode[]).map((mode) => (
                <option key={mode} value={mode}>
                  {PERMISSION_LABELS[mode]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[13px] font-medium text-slate">
            Esforço
            <select aria-label="Esforço do membro" value={effort} onChange={(e) => setEffort(e.target.value as "" | EffortLevel)} className="rounded-sm border hairline-strong bg-surface px-3 py-2 text-sm text-ink">
              <option value="">Padrão do projeto</option>
              {EFFORT_LEVELS.map((level) => (
                <option key={level} value={level}>
                  {EFFORT_LABELS[level]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[13px] font-medium text-slate">
            Orçamento por run (US$)
            <input value={maxBudget} onChange={(e) => setMaxBudget(e.target.value)} placeholder="sem limite" inputMode="decimal" className="rounded-sm border hairline-strong bg-surface px-3 py-2 text-sm text-ink" />
          </label>
        </div>

        {(mcpServers.length > 0 || skills.length > 0) && (
          <div className="grid grid-cols-2 gap-3">
            {mcpServers.length > 0 && (
              <HarnessPicker label="MCP servers" items={mcpServers.map((s) => ({ id: s.id, label: s.name, hint: s.enabled ? s.transport : `${s.transport} · desativado` }))} selection={mcpSel} onChange={setMcpSel} />
            )}
            {skills.length > 0 && (
              <HarnessPicker label="Skills" items={skills.map((s) => ({ id: s.id, label: s.name, hint: s.enabled ? (s.projectId ? "projeto" : "usuário") : "desativada" }))} selection={skillSel} onChange={setSkillSel} />
            )}
          </div>
        )}

        {error && (
          <div role="alert" className="rounded-md bg-brand-soft px-3 py-2 text-[13px] text-brand-hover">
            {error}
          </div>
        )}

        <div className="flex items-center gap-2 pt-2">
          {member && onRemove && (
            <button
              type="button"
              onClick={() => {
                void onRemove().then(onClose);
              }}
              className="rounded-md border hairline-strong px-3.5 py-2 text-[13px] font-medium text-brand-hover hover:border-brand"
            >
              Remover do time
            </button>
          )}
          <button type="button" onClick={onClose} className="ml-auto rounded-md border hairline-strong px-3.5 py-2 text-[13px] font-medium text-ink">
            Cancelar
          </button>
          <button type="submit" disabled={saving} className="rounded-full bg-brand px-4 py-2 text-[13px] font-semibold text-white hover:bg-brand-hover disabled:opacity-50">
            {saving ? "Salvando…" : member ? "Salvar" : "Adicionar"}
          </button>
        </div>
      </form>
    </dialog>
  );
}

type PickerProps = {
  label: string;
  items: { id: string; label: string; hint: string }[];
  /** `null` = todos os ativos. */
  selection: string[] | null;
  onChange: (selection: string[] | null) => void;
};

function HarnessPicker({ label, items, selection, onChange }: PickerProps) {
  const all = selection === null;
  return (
    <fieldset className="m-0 flex flex-col gap-1.5 rounded-md border hairline p-3" data-testid={`picker-${label}`}>
      <legend className="px-1 text-[13px] font-medium text-slate">{label}</legend>
      <label className="flex items-center gap-2 text-[13px]">
        <input type="checkbox" checked={all} onChange={(e) => onChange(e.target.checked ? null : [])} />
        Todos os ativos do projeto
      </label>
      {!all &&
        items.map((item) => (
          <label key={item.id} className="flex items-center gap-2 pl-5 text-[13px]">
            <input type="checkbox" checked={selection!.includes(item.id)} onChange={(e) => onChange(e.target.checked ? [...selection!, item.id] : selection!.filter((id) => id !== item.id))} />
            <span className="font-medium">{item.label}</span>
            <span className="text-xs text-slate">{item.hint}</span>
          </label>
        ))}
    </fieldset>
  );
}
