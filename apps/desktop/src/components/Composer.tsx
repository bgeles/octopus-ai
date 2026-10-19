import { GitFork, History } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { EffortLevel, PermissionMode } from "@octopus/protocol";
import { EFFORT_LABELS, EFFORT_LEVELS } from "../lib/effort";
import type { ResumeTarget, TeamMember } from "../lib/types";
import { Avatar } from "./Avatar";

type ComposerProps = {
  disabled: boolean;
  busy: boolean;
  resumeTarget?: ResumeTarget | null;
  onCancelResume?: () => void;
  /** Membros do time disponíveis para "Executar como". */
  team?: TeamMember[];
  runAs?: TeamMember | null;
  onRunAsChange?: (member: TeamMember | null) => void;
  onSubmit: (prompt: string, options: { permissionMode: PermissionMode; maxTurns: number; effort: EffortLevel | null }) => void;
  /** Esforço que vale sem escolha no composer (do membro ou do projeto), para o rótulo "Padrão". */
  defaultEffort?: EffortLevel | null;
};

const PERMISSION_LABELS: Record<PermissionMode, string> = {
  default: "Perguntar antes de agir",
  acceptEdits: "Aceitar edições de arquivos",
  plan: "Somente planejar",
  dontAsk: "Negar o que pediria aprovação",
  auto: "Classificador automático",
};

export function Composer({ disabled, busy, resumeTarget = null, onCancelResume, team = [], runAs = null, onRunAsChange, onSubmit, defaultEffort = null }: ComposerProps) {
  const [prompt, setPrompt] = useState("");
  const [permissionMode, setPermissionMode] = useState<PermissionMode>("default");
  const [maxTurns, setMaxTurns] = useState(40);
  /** `null` = padrão (membro → projeto → modelo); vale só para o próximo run. */
  const [effort, setEffort] = useState<EffortLevel | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Ao escolher retomar/bifurcar, o foco vai direto para a instrução.
  useEffect(() => {
    if (resumeTarget || runAs) textareaRef.current?.focus();
  }, [resumeTarget, runAs]);

  // Ao escolher um membro, as permissões do composer seguem o padrão dele (perfil, senão cargo); o usuário pode mudar.
  useEffect(() => {
    if (runAs) setPermissionMode(runAs.profile.permissionMode ?? runAs.role.defaultPermissionMode ?? "default");
  }, [runAs]);

  const submit = () => {
    const text = prompt.trim();
    if (!text || disabled || busy) return;
    onSubmit(text, { permissionMode, maxTurns, effort });
    setPrompt("");
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="flex flex-col gap-2 border-t hairline bg-surface px-6 pt-4 pb-5"
    >
      {resumeTarget && (
        <div role="status" data-testid="resume-banner" className="flex flex-wrap items-center gap-2.5 rounded-md border border-brand bg-brand-soft px-3.5 py-2.5 text-[13px] text-brand-hover">
          {resumeTarget.fork ? <GitFork size={14} aria-hidden /> : <History size={14} aria-hidden />}
          <span>
            <strong>{resumeTarget.fork ? "Bifurcando a partir de" : "Retomando"}</strong> a sessão “{resumeTarget.title ?? resumeTarget.sessionId.slice(0, 8)}” · a próxima instrução {resumeTarget.fork ? "abre uma sessão nova com o histórico copiado" : "continua com o contexto anterior"}
          </span>
          <span className="font-mono text-[11px] text-slate">{resumeTarget.sessionId.slice(0, 8)}…</span>
          <button type="button" onClick={onCancelResume} className="ml-auto rounded-sm border border-brand px-2.5 py-1 text-xs font-semibold text-brand-hover hover:bg-surface">
            Cancelar
          </button>
        </div>
      )}
      {runAs && (
        <div role="status" data-testid="run-as-banner" className="flex flex-wrap items-center gap-2.5 rounded-md border hairline bg-paper px-3.5 py-2 text-[13px]">
          <Avatar initials={runAs.profile.avatarSeed} size={24} />
          <span>
            Tarefa para <strong>{runAs.profile.name}</strong> · {runAs.role.title}: as responsabilidades do cargo e os delegados entram no run.
          </span>
          <button type="button" onClick={() => onRunAsChange?.(null)} className="ml-auto rounded-sm border hairline-strong px-2.5 py-1 text-xs font-semibold text-ink hover:border-ink">
            Sem membro
          </button>
        </div>
      )}
      <label htmlFor="prompt" className="text-xs font-medium text-slate">
        {runAs ? `Instrução para ${runAs.profile.name}` : "Instrução para o agente"}
      </label>
      <div className="flex flex-wrap items-end gap-2.5">
        <textarea
          id="prompt"
          ref={textareaRef}
          rows={2}
          value={prompt}
          disabled={disabled}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
          }}
          placeholder={disabled ? "Selecione um projeto para começar" : resumeTarget ? "Ex.: o que fizemos antes? (⌘↵ envia)" : "Ex.: liste as migrações e resuma a última (⌘↵ envia)"}
          className="min-w-0 flex-1 basis-80 resize-y rounded-sm border hairline-strong bg-surface px-3 py-2.5 text-sm text-ink disabled:bg-paper"
        />
        <button
          type="submit"
          disabled={disabled || busy || prompt.trim().length === 0}
          className="rounded-full bg-brand px-4.5 py-2.5 text-[13px] font-semibold text-white hover:bg-brand-hover disabled:opacity-50"
        >
          {busy ? "Iniciando…" : "Enviar"}
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-3 text-xs text-slate">
        {team.length > 0 && (
          <label className="flex items-center gap-1.5">
            Executar como
            <select
              value={runAs?.profile.id ?? ""}
              onChange={(e) => onRunAsChange?.(team.find((m) => m.profile.id === e.target.value) ?? null)}
              disabled={disabled}
              className="rounded-sm border hairline-strong bg-surface px-2 py-1 text-xs text-ink"
              data-testid="run-as-select"
            >
              <option value="">Agente avulso</option>
              {team.map((m) => (
                <option key={m.profile.id} value={m.profile.id}>
                  {m.profile.name} · {m.role.title}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="flex items-center gap-1.5">
          Permissões
          <select value={permissionMode} onChange={(e) => setPermissionMode(e.target.value as PermissionMode)} disabled={disabled} className="rounded-sm border hairline-strong bg-surface px-2 py-1 text-xs text-ink">
            {(Object.keys(PERMISSION_LABELS) as PermissionMode[]).map((mode) => (
              <option key={mode} value={mode}>
                {PERMISSION_LABELS[mode]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5">
          Esforço
          <select aria-label="Esforço" value={effort ?? ""} onChange={(e) => setEffort((e.target.value || null) as EffortLevel | null)} disabled={disabled} className="rounded-sm border hairline-strong bg-surface px-2 py-1 text-xs text-ink" data-testid="effort-select">
            <option value="">{defaultEffort ? `Padrão (${EFFORT_LABELS[defaultEffort].toLowerCase()}${runAs?.profile.effort ? `, de ${runAs.profile.name}` : ", do projeto"})` : "Padrão do modelo"}</option>
            {EFFORT_LEVELS.map((level) => (
              <option key={level} value={level}>
                {EFFORT_LABELS[level]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5">
          Máx. turnos
          <input
            type="number"
            min={1}
            max={500}
            value={maxTurns}
            disabled={disabled}
            onChange={(e) => setMaxTurns(Math.max(1, Number(e.target.value) || 1))}
            className="w-16 rounded-sm border hairline-strong bg-surface px-2 py-1 text-xs text-ink"
          />
        </label>
      </div>
    </form>
  );
}
