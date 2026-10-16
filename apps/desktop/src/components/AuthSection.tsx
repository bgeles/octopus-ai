import { useEffect, useState } from "react";
import type { AuthMode, Project } from "../lib/types";

type AuthSectionProps = {
  project: Project | null;
  hasKey: boolean | null;
  onChangeMode: (mode: AuthMode) => Promise<void>;
  onSaveKey: (apiKey: string) => Promise<void>;
  onClearKey: () => Promise<void>;
};

export function AuthSection({ project, hasKey, onChangeMode, onSaveKey, onClearKey }: AuthSectionProps) {
  const mode = project?.authMode ?? "subscription";
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setValue(""), [project?.id]);

  const run = async (fn: () => Promise<void>) => {
    setError(null);
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label="Autenticação do projeto" className="flex flex-col gap-3 rounded-xl border hairline bg-surface p-5" data-testid="auth-section" data-mode={mode} data-has-key={hasKey === null ? undefined : String(hasKey)}>
      <div className="flex items-baseline gap-3">
        <h2 className="m-0 font-display text-sm font-semibold">Autenticação deste projeto</h2>
        <span className="text-xs text-slate">O login do claude.ai vale só para uso pessoal; para distribuir o app a terceiros, use API key.</span>
      </div>
      <div role="radiogroup" aria-label="Modo de autenticação" className="flex rounded-md border hairline-strong p-0.5 text-[13px]">
        {(
          [
            ["subscription", "Login do Claude Code"],
            ["api_key", "API key"],
          ] as [AuthMode, string][]
        ).map(([id, label]) => (
          <button key={id} type="button" role="radio" aria-checked={mode === id} disabled={!project || busy} onClick={() => void run(() => onChangeMode(id))} className={["flex-1 rounded-sm px-3 py-2 font-medium disabled:opacity-40", mode === id ? "bg-ink text-paper" : "text-slate hover:text-ink"].join(" ")}>
            {label}
          </button>
        ))}
      </div>
      {mode === "api_key" && (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await onSaveKey(value);
              setValue("");
            });
          }}
        >
          <label htmlFor="project-api-key" className="text-xs font-medium text-slate">
            API key (vai para o Keychain do macOS; nunca para o banco nem para o backup)
          </label>
          <div className="flex flex-wrap gap-2">
            <input id="project-api-key" type="password" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} placeholder={hasKey ? "•••••••• (já guardada; cole para trocar)" : "sk-ant-…"} className="min-w-[240px] flex-1 rounded-sm border hairline-strong bg-surface px-3 py-2 font-mono text-xs" />
            <button type="submit" disabled={busy || !value.trim()} className="rounded-full bg-ink px-3.5 py-2 text-xs font-semibold text-paper disabled:opacity-50">
              {hasKey ? "Trocar chave" : "Guardar no Keychain"}
            </button>
            {hasKey && (
              <button type="button" disabled={busy} onClick={() => void run(onClearKey)} className="rounded-sm border hairline-strong bg-surface px-3 py-2 text-xs font-medium hover:border-brand hover:text-brand-hover">
                Remover do Keychain
              </button>
            )}
          </div>
          <div className={["flex items-center gap-2 text-xs", hasKey ? "text-success-ink" : "text-warning-ink"].join(" ")} data-testid="auth-key-status">
            <span className={["size-2 rounded-full", hasKey ? "bg-success" : "bg-warning"].join(" ")} />
            {hasKey === null ? "Verificando o Keychain…" : hasKey ? `Chave guardada no Keychain · conta octopus/${project?.id ?? ""}` : "Nenhuma chave no Keychain: os runs deste projeto vão falhar até você informar uma."}
          </div>
        </form>
      )}
      {mode === "subscription" && <p className="m-0 text-xs text-slate">Usa a sessão do Claude Code já autenticada nesta máquina. Nenhum segredo é guardado pelo Octopus.</p>}
      {error && (
        <span role="alert" className="text-xs text-brand-hover">
          {error}
        </span>
      )}
    </section>
  );
}
