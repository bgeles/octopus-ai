import { FolderOpen } from "lucide-react";
import { useEffect, useState } from "react";
import { isTauri } from "../lib/transport";
import { THEME_LABELS, type ThemePreference } from "../lib/theme";
import type { AuthMode, EnvironmentCheck, ImportMode, ImportPreview } from "../lib/types";
import { EnvironmentChecks } from "./EnvironmentChecks";
import { ImportPreviewPanel } from "./ImportPreviewPanel";

export type OnboardingResult = {
  defaultAuthMode: AuthMode;
  theme: ThemePreference;
  project: { name: string; path: string } | null;
};

type OnboardingViewProps = {
  environment: EnvironmentCheck | null;
  checking: boolean;
  onRecheck: () => void;
  theme: ThemePreference;
  onThemeChange: (theme: ThemePreference) => void;
  onPreviewImport: (path: string) => Promise<ImportPreview>;
  onImport: (path: string, mode: ImportMode) => Promise<void>;
  onFinish: (result: OnboardingResult) => Promise<void>;
};

const STEPS = ["Ambiente", "Autenticação", "Primeiro projeto", "Tema"] as const;

export function OnboardingView({ environment, checking, onRecheck, theme, onThemeChange, onPreviewImport, onImport, onFinish }: OnboardingViewProps) {
  const [step, setStep] = useState(0);
  const [authMode, setAuthMode] = useState<AuthMode>("subscription");
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [importPath, setImportPath] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [imported, setImported] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!environment && !checking) onRecheck();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pickFolder = async () => {
    if (!isTauri()) return;
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({ directory: true, multiple: false, title: "Escolha a pasta do projeto" });
    if (typeof selected === "string") {
      setPath(selected);
      if (!name) setName(selected.split("/").filter(Boolean).pop() ?? "");
    }
  };

  const pickImportFile = async () => {
    if (!isTauri()) return;
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({ multiple: false, title: "Escolha o arquivo de configurações", filters: [{ name: "Configurações do Octopus", extensions: ["json"] }] });
    if (typeof selected === "string") {
      setImportPath(selected);
      await loadPreview(selected);
    }
  };

  const loadPreview = async (p: string) => {
    setError(null);
    try {
      setPreview(await onPreviewImport(p));
    } catch (e) {
      setPreview(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const doImport = async (mode: ImportMode) => {
    setError(null);
    setSaving(true);
    try {
      await onImport(importPath, mode);
      setImported(true);
      setPreview(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const finish = async () => {
    setError(null);
    const hasProject = name.trim().length > 0 || path.trim().length > 0;
    if (hasProject && (!name.trim() || !path.trim())) {
      setError("Informe nome e pasta do projeto, ou deixe os dois vazios para criar depois.");
      setStep(2);
      return;
    }
    setSaving(true);
    try {
      await onFinish({ defaultAuthMode: authMode, theme, project: hasProject ? { name: name.trim(), path: path.trim() } : null });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const envOk = environment ? environment.node.ok && environment.sidecar.ok : false;

  return (
    <div className="flex min-h-full flex-col items-center gap-8 overflow-y-auto bg-paper px-6 py-12" data-testid="onboarding">
      <header className="flex items-center gap-3">
        <div className="flex size-9 items-center justify-center rounded-lg bg-brand text-white">
          <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="9" r="5" />
            <path d="M7 13c-1 3-3 5-4 6" />
            <path d="M17 13c1 3 3 5 4 6" />
            <path d="M10 14c-.5 3-1 5-1 6" />
            <path d="M14 14c.5 3 1 5 1 6" />
          </svg>
        </div>
        <div className="flex flex-col">
          <span className="font-display text-lg font-bold tracking-tight">Octopus AI</span>
          <span className="text-xs text-slate">Configuração inicial · leva menos de um minuto</span>
        </div>
      </header>

      <div className="flex w-full max-w-[1040px] flex-wrap items-start gap-6">
        <nav aria-label="Passos" className="flex w-[220px] shrink-0 flex-col gap-4 rounded-xl border hairline bg-surface p-5">
          <span className="eyebrow text-brand">Passos</span>
          <ol className="m-0 flex list-none flex-col gap-3.5 p-0">
            {STEPS.map((label, index) => {
              const state = index === step ? "current" : index < step ? "done" : "todo";
              return (
                <li key={label} className={["flex items-center gap-2.5 text-[13px]", state === "todo" ? "text-slate" : "font-medium text-ink"].join(" ")} aria-current={state === "current" ? "step" : undefined}>
                  <span
                    className={[
                      "flex size-6 items-center justify-center rounded-full text-xs font-bold",
                      state === "current" ? "bg-brand text-white" : state === "done" ? "bg-ink text-paper" : "border hairline-strong text-slate",
                    ].join(" ")}
                  >
                    {index + 1}
                  </span>
                  <button type="button" onClick={() => index < step && setStep(index)} className="text-left" disabled={index > step}>
                    {label}
                  </button>
                </li>
              );
            })}
          </ol>
          <p className="m-0 text-xs text-slate">Você pode refazer isto depois em Configurações → Refazer onboarding.</p>
        </nav>

        <section aria-label={`Passo ${step + 1}: ${STEPS[step]}`} className="flex min-w-0 flex-1 basis-[520px] flex-col gap-4 rounded-xl border hairline bg-surface p-7">
          <div className="flex flex-col gap-1">
            <span className="eyebrow text-slate">Passo {step + 1} de 4</span>
            <h1 className="m-0 font-display text-2xl font-bold tracking-tight">
              {step === 0 && "O que o Octopus precisa nesta máquina"}
              {step === 1 && "Como o agente vai se autenticar"}
              {step === 2 && "Seu primeiro projeto"}
              {step === 3 && "Escolha o tema"}
            </h1>
            <p className="m-0 text-sm text-slate">
              {step === 0 && "Três checagens, feitas agora e sempre que algo faltar. Nada sai do seu computador."}
              {step === 1 && "Vale como padrão para projetos novos; cada projeto pode mudar depois."}
              {step === 2 && "Um projeto aponta para uma pasta. Ou importe um backup de configurações."}
              {step === 3 && "Grafite claro, escuro ou seguindo o sistema."}
            </p>
          </div>

          {step === 0 && (
            <>
              <EnvironmentChecks check={environment} checking={checking} onRecheck={onRecheck} />
              {environment && !environment.claudeAuth.ok && (
                <div className="rounded-md border hairline bg-paper px-3.5 py-3 text-[13px]" role="note">
                  Para autenticar, rode <code className="font-mono text-xs">claude</code> no Terminal e faça login, ou use uma API key no próximo passo. O login do claude.ai vale só para uso pessoal; para distribuir o app a terceiros, use API key.
                </div>
              )}
            </>
          )}

          {step === 1 && (
            <div className="flex flex-col gap-2.5" role="radiogroup" aria-label="Autenticação padrão">
              <AuthOption value="subscription" current={authMode} onChange={setAuthMode} title="Login do Claude Code" description="usa a assinatura já autenticada nesta máquina (uso pessoal)" />
              <AuthOption value="api_key" current={authMode} onChange={setAuthMode} title="API key" description="a chave fica no Keychain (Fase 3); por enquanto só o modo" />
            </div>
          )}

          {step === 2 && (
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-3">
                <label className="flex flex-col gap-1 text-[13px] font-medium text-slate">
                  Nome
                  <input value={name} onChange={(e) => setName(e.target.value)} placeholder="chat-core" className="rounded-sm border hairline-strong bg-surface px-3 py-2 text-sm text-ink" />
                </label>
                <label className="flex flex-col gap-1 text-[13px] font-medium text-slate">
                  Pasta
                  <div className="flex gap-2">
                    <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="/Users/voce/projetos/chat-core" className="min-w-0 flex-1 rounded-sm border hairline-strong bg-surface px-3 py-2 font-mono text-[13px] text-ink" />
                    <button type="button" onClick={() => void pickFolder()} className="inline-flex items-center gap-1.5 rounded-md border hairline-strong px-3 py-2 text-[13px] font-medium text-ink hover:border-ink">
                      <FolderOpen size={14} aria-hidden /> Escolher
                    </button>
                  </div>
                </label>
              </div>
              <div className="flex flex-col gap-2 border-t hairline pt-4">
                <span className="text-[13px] font-medium text-slate">Ou importar um backup de configurações</span>
                {imported ? (
                  <p className="m-0 rounded-md bg-success-soft px-3 py-2 text-[13px] text-success-ink" role="status">
                    Backup importado. Os projetos e preferências já estão aqui.
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    <label className="sr-only" htmlFor="onboarding-import-path">
                      Arquivo de configurações
                    </label>
                    <input
                      id="onboarding-import-path"
                      value={importPath}
                      onChange={(e) => setImportPath(e.target.value)}
                      placeholder="/caminho/octopus-config-2026-10-16.json"
                      className="min-w-0 flex-1 basis-64 rounded-sm border hairline-strong bg-surface px-3 py-2 font-mono text-[13px] text-ink"
                    />
                    {isTauri() ? (
                      <button type="button" onClick={() => void pickImportFile()} className="rounded-md border hairline-strong px-3 py-2 text-[13px] font-medium">
                        Escolher arquivo…
                      </button>
                    ) : (
                      <button type="button" disabled={!importPath.trim()} onClick={() => void loadPreview(importPath.trim())} className="rounded-md border hairline-strong px-3 py-2 text-[13px] font-medium disabled:opacity-50">
                        Ver prévia
                      </button>
                    )}
                  </div>
                )}
                {preview && <ImportPreviewPanel preview={preview} busy={saving} onConfirm={(mode) => void doImport(mode)} onCancel={() => setPreview(null)} />}
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="flex flex-col gap-4">
              <div role="radiogroup" aria-label="Tema" className="flex rounded-md border hairline-strong p-0.5 text-[13px]">
                {(Object.keys(THEME_LABELS) as ThemePreference[]).map((option) => (
                  <button
                    key={option}
                    type="button"
                    role="radio"
                    aria-checked={theme === option}
                    onClick={() => onThemeChange(option)}
                    className={["flex-1 rounded-sm px-3 py-2 font-medium", theme === option ? "bg-ink text-paper" : "text-slate hover:text-ink"].join(" ")}
                  >
                    {THEME_LABELS[option]}
                  </button>
                ))}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="flex h-16 items-end rounded-md border hairline bg-[#FAFAF9] p-2">
                  <span className="h-1.5 w-2/5 rounded-full bg-[#E4002B]" />
                </div>
                <div className="flex h-16 items-end rounded-md border border-[#2A2A2D] bg-[#0B0B0C] p-2">
                  <span className="h-1.5 w-2/5 rounded-full bg-[#FF3355]" />
                </div>
              </div>
            </div>
          )}

          {error && (
            <div role="alert" className="rounded-md bg-brand-soft px-3 py-2 text-[13px] text-brand-hover">
              {error}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3 border-t hairline pt-4">
            {step > 0 && (
              <button type="button" onClick={() => setStep(step - 1)} className="rounded-md border hairline-strong bg-surface px-3.5 py-2 text-[13px] font-medium">
                Voltar
              </button>
            )}
            {step === 0 && !envOk && environment && <span className="text-xs text-warning-ink">Node e runtime são obrigatórios para continuar.</span>}
            {step < 3 ? (
              <button type="button" onClick={() => setStep(step + 1)} disabled={step === 0 && !envOk} className="ml-auto rounded-full bg-brand px-4.5 py-2.5 text-[13px] font-semibold text-white hover:bg-brand-hover disabled:opacity-50">
                Continuar
              </button>
            ) : (
              <button type="button" onClick={() => void finish()} disabled={saving} className="ml-auto rounded-full bg-brand px-4.5 py-2.5 text-[13px] font-semibold text-white hover:bg-brand-hover disabled:opacity-50">
                {saving ? "Salvando…" : "Concluir e abrir o Octopus"}
              </button>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function AuthOption({ value, current, onChange, title, description }: { value: AuthMode; current: AuthMode; onChange: (v: AuthMode) => void; title: string; description: string }) {
  const selected = value === current;
  return (
    <label className={["flex cursor-pointer items-start gap-3 rounded-md border px-3.5 py-3 text-[13px]", selected ? "border-ink" : "hairline"].join(" ")}>
      <input type="radio" name="auth-mode" value={value} checked={selected} onChange={() => onChange(value)} className="mt-0.5" />
      <span className="flex flex-col">
        <strong>{title}</strong>
        <span className="text-slate">{description}</span>
      </span>
    </label>
  );
}
