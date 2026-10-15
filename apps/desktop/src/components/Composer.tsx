import { useState } from "react";
import type { PermissionMode } from "@octopus/protocol";

type ComposerProps = {
  disabled: boolean;
  busy: boolean;
  onSubmit: (prompt: string, options: { permissionMode: PermissionMode; maxTurns: number }) => void;
};

const PERMISSION_LABELS: Record<PermissionMode, string> = {
  default: "Perguntar antes de agir",
  acceptEdits: "Aceitar edições de arquivos",
  plan: "Somente planejar",
  dontAsk: "Negar o que pediria aprovação",
  auto: "Classificador automático",
};

export function Composer({ disabled, busy, onSubmit }: ComposerProps) {
  const [prompt, setPrompt] = useState("");
  const [permissionMode, setPermissionMode] = useState<PermissionMode>("default");
  const [maxTurns, setMaxTurns] = useState(40);

  const submit = () => {
    const text = prompt.trim();
    if (!text || disabled || busy) return;
    onSubmit(text, { permissionMode, maxTurns });
    setPrompt("");
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="flex flex-col gap-2 border-t hairline bg-white px-6 pt-4 pb-5"
    >
      <label htmlFor="prompt" className="text-xs font-medium text-slate">
        Instrução para o agente
      </label>
      <div className="flex flex-wrap items-end gap-2.5">
        <textarea
          id="prompt"
          rows={2}
          value={prompt}
          disabled={disabled}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
          }}
          placeholder={disabled ? "Selecione um projeto para começar" : "Ex.: liste as migrações e resuma a última (⌘↵ envia)"}
          className="min-w-0 flex-1 basis-80 resize-y rounded-sm border hairline-strong bg-white px-3 py-2.5 text-sm text-ink disabled:bg-paper"
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
        <label className="flex items-center gap-1.5">
          Permissões
          <select value={permissionMode} onChange={(e) => setPermissionMode(e.target.value as PermissionMode)} disabled={disabled} className="rounded-sm border hairline-strong bg-white px-2 py-1 text-xs text-ink">
            {(Object.keys(PERMISSION_LABELS) as PermissionMode[]).map((mode) => (
              <option key={mode} value={mode}>
                {PERMISSION_LABELS[mode]}
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
            className="w-16 rounded-sm border hairline-strong bg-white px-2 py-1 text-xs text-ink"
          />
        </label>
      </div>
    </form>
  );
}
