import { useEffect, useState } from "react";
import { isTauri } from "../lib/transport";
import { THEME_LABELS, type ThemePreference } from "../lib/theme";
import type { AppSettings, AuthMode, BackupSnapshot, EnvironmentCheck, ImportMode, ImportPreview } from "../lib/types";
import { EnvironmentChecks } from "./EnvironmentChecks";
import { ImportPreviewPanel } from "./ImportPreviewPanel";
import { formatRelative } from "./SessionsView";

type SettingsViewProps = {
  settings: AppSettings;
  environment: EnvironmentCheck | null;
  checking: boolean;
  onRecheck: () => void;
  theme: ThemePreference;
  onThemeChange: (theme: ThemePreference) => void;
  onSetSetting: (key: string, value: unknown) => Promise<void>;
  snapshots: BackupSnapshot[] | null;
  onRefreshSnapshots: () => void;
  onExport: (destination: string | null) => Promise<void>;
  onPreviewFile: (path: string) => Promise<ImportPreview>;
  onImportFile: (path: string, mode: ImportMode) => Promise<void>;
  onPreviewSnapshot: (id: string) => Promise<ImportPreview>;
  onRestoreSnapshot: (id: string, mode: ImportMode) => Promise<void>;
  onRevealSnapshot: (id: string) => Promise<void>;
  onRedoOnboarding: () => Promise<void>;
  runtimeLabel: string;
};

type PreviewTarget = { kind: "snapshot"; id: string } | { kind: "file"; path: string };

export function SettingsView(props: SettingsViewProps) {
  const { settings, environment, checking, onRecheck, theme, onThemeChange, onSetSetting, snapshots, onRefreshSnapshots, runtimeLabel } = props;
  const [importPath, setImportPath] = useState("");
  const [preview, setPreview] = useState<{ target: PreviewTarget; data: ImportPreview } | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const defaultAuthMode = (settings.defaultAuthMode as AuthMode | undefined) ?? "subscription";

  useEffect(() => {
    if (snapshots === null) onRefreshSnapshots();
    if (!environment && !checking) onRecheck();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = async (action: () => Promise<void>, success?: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      if (success) setNotice(success);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const exportNow = async () => {
    let destination: string | null = null;
    if (isTauri()) {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const chosen = await save({ title: "Exportar configurações", defaultPath: `octopus-config-${new Date().toISOString().slice(0, 10)}.json`, filters: [{ name: "Configurações do Octopus", extensions: ["json"] }] });
      if (!chosen) return;
      destination = chosen;
    }
    await run(() => props.onExport(destination), destination ? `Configurações exportadas para ${destination}` : "Cópia manual criada nas cópias locais");
  };

  const chooseImportFile = async () => {
    if (isTauri()) {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const chosen = await open({ multiple: false, title: "Importar configurações", filters: [{ name: "Configurações do Octopus", extensions: ["json"] }] });
      if (typeof chosen !== "string") return;
      setImportPath(chosen);
      await previewFile(chosen);
    } else if (importPath.trim()) {
      await previewFile(importPath.trim());
    }
  };

  const previewFile = (path: string) => run(async () => setPreview({ target: { kind: "file", path }, data: await props.onPreviewFile(path) }));
  const previewSnapshot = (id: string) => run(async () => setPreview({ target: { kind: "snapshot", id }, data: await props.onPreviewSnapshot(id) }));
  const confirmPreview = (mode: ImportMode) => {
    if (!preview) return;
    const target = preview.target;
    void run(async () => {
      if (target.kind === "file") await props.onImportFile(target.path, mode);
      else await props.onRestoreSnapshot(target.id, mode);
      setPreview(null);
    }, "Configurações restauradas");
  };

  return (
    <div className="flex flex-col gap-5 overflow-y-auto p-6" data-testid="settings-view">
      <div className="flex items-center gap-4">
        <div>
          <div className="eyebrow text-brand">Esta máquina</div>
          <h1 className="m-0 font-display text-xl font-bold tracking-tight">Configurações</h1>
        </div>
        <button type="button" onClick={() => void run(props.onRedoOnboarding)} className="ml-auto rounded-md border hairline-strong bg-surface px-3 py-1.5 text-[13px] font-medium">
          Refazer onboarding
        </button>
      </div>

      {notice && (
        <div role="status" className="rounded-md bg-success-soft px-3 py-2 text-[13px] text-success-ink">
          {notice}
        </div>
      )}
      {error && (
        <div role="alert" className="rounded-md bg-brand-soft px-3 py-2 text-[13px] text-brand-hover">
          {error}
        </div>
      )}

      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(440px,100%),1fr))] gap-5">
        <section aria-label="Ambiente" className="flex flex-col gap-3 rounded-xl border hairline bg-surface p-5">
          <h2 className="m-0 font-display text-sm font-semibold">Ambiente</h2>
          <EnvironmentChecks check={environment} checking={checking} onRecheck={onRecheck} compact />
        </section>

        <section aria-label="Preferências" className="flex flex-col gap-4 rounded-xl border hairline bg-surface p-5">
          <h2 className="m-0 font-display text-sm font-semibold">Preferências</h2>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-slate">Autenticação padrão para projetos novos</span>
            <div role="radiogroup" aria-label="Autenticação padrão" className="flex rounded-md border hairline-strong p-0.5 text-[13px]">
              {(["subscription", "api_key"] as AuthMode[]).map((mode) => (
                <button key={mode} type="button" role="radio" aria-checked={defaultAuthMode === mode} onClick={() => void onSetSetting("defaultAuthMode", mode)} className={["flex-1 rounded-sm px-3 py-2 font-medium", defaultAuthMode === mode ? "bg-ink text-paper" : "text-slate hover:text-ink"].join(" ")}>
                  {mode === "subscription" ? "Login do Claude Code" : "API key"}
                </button>
              ))}
            </div>
            <span className="text-xs text-slate">O login do claude.ai vale só para uso pessoal.</span>
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-slate">Tema</span>
            <div role="radiogroup" aria-label="Tema" className="flex rounded-md border hairline-strong p-0.5 text-[13px]">
              {(Object.keys(THEME_LABELS) as ThemePreference[]).map((option) => (
                <button key={option} type="button" role="radio" aria-checked={theme === option} onClick={() => onThemeChange(option)} className={["flex-1 rounded-sm px-3 py-2 font-medium", theme === option ? "bg-ink text-paper" : "text-slate hover:text-ink"].join(" ")}>
                  {THEME_LABELS[option]}
                </button>
              ))}
            </div>
          </div>
          <div className="flex justify-between gap-3 border-t hairline pt-3 text-[13px]">
            <span className="text-slate">Runtime</span>
            <span className="font-mono text-xs">{runtimeLabel}</span>
          </div>
        </section>

        <section aria-label="Backup de configurações" className="col-span-full flex flex-col gap-4 rounded-xl border hairline bg-surface p-5">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex flex-col gap-0.5">
              <h2 className="m-0 font-display text-sm font-semibold">Backup de configurações</h2>
              <span className="text-xs text-slate">Projetos, time, perfis, workflows, MCPs e preferências. Sem runs, aprovações, chaves ou memória. Só nesta máquina, por enquanto.</span>
            </div>
            <div className="ml-auto flex flex-wrap gap-2">
              <button type="button" disabled={busy} onClick={() => void exportNow()} className="rounded-full bg-brand px-3.5 py-2 text-[13px] font-semibold text-white hover:bg-brand-hover disabled:opacity-50">
                Exportar agora…
              </button>
              {isTauri() ? (
                <button type="button" disabled={busy} onClick={() => void chooseImportFile()} className="rounded-md border hairline-strong bg-surface px-3.5 py-2 text-[13px] font-medium disabled:opacity-50">
                  Importar arquivo…
                </button>
              ) : (
                <>
                  <label className="sr-only" htmlFor="import-path">
                    Arquivo de configurações
                  </label>
                  <input id="import-path" value={importPath} onChange={(e) => setImportPath(e.target.value)} placeholder="/caminho/octopus-config.json" className="w-64 rounded-sm border hairline-strong bg-surface px-2.5 py-1.5 font-mono text-xs" />
                  <button type="button" disabled={busy || !importPath.trim()} onClick={() => void chooseImportFile()} className="rounded-md border hairline-strong bg-surface px-3.5 py-2 text-[13px] font-medium disabled:opacity-50">
                    Importar arquivo
                  </button>
                </>
              )}
            </div>
          </div>

          <div className="flex flex-wrap gap-4">
            <div className="flex min-w-0 flex-1 basis-[420px] flex-col gap-1.5">
              <div className="flex items-baseline gap-2.5">
                <h3 className="m-0 text-[13px] font-semibold">Cópias locais</h3>
                <span className="text-xs text-slate">a cada mudança · últimas 20 automáticas</span>
                <button type="button" onClick={onRefreshSnapshots} className="ml-auto text-xs font-medium text-slate hover:text-ink">
                  Atualizar
                </button>
              </div>
              {snapshots === null && <p className="m-0 text-[13px] text-slate">Carregando…</p>}
              {snapshots && snapshots.length === 0 && <p className="m-0 text-[13px] text-slate">Nenhuma cópia ainda. A primeira é criada na próxima mudança de configuração ou ao exportar.</p>}
              <ul className="m-0 flex list-none flex-col p-0">
                {(snapshots ?? []).map((s) => (
                  <li key={s.id} className="grid grid-cols-[9rem_8rem_minmax(0,1fr)_auto] items-center gap-3 border-b hairline py-2 text-[13px] last:border-b-0" data-testid="snapshot-row" data-reason={s.reason}>
                    <span className="font-mono text-xs" title={s.createdAt}>
                      {formatRelative(s.createdAt)}
                    </span>
                    <span className={["justify-self-start rounded-full px-2 py-0.5 text-[11px] font-semibold", reasonTone(s.reason)].join(" ")}>{reasonLabel(s.reason)}</span>
                    <span className="truncate text-xs text-slate" title={s.path}>
                      {s.path.split("/").pop()} · {formatBytes(s.sizeBytes)}
                    </span>
                    <span className="flex gap-1.5">
                      <button type="button" disabled={busy} onClick={() => void previewSnapshot(s.id)} className="rounded-sm border hairline-strong bg-surface px-2.5 py-1 text-xs font-medium disabled:opacity-50">
                        Restaurar
                      </button>
                      {isTauri() && (
                        <button type="button" onClick={() => void props.onRevealSnapshot(s.id)} className="rounded-sm border hairline-strong bg-surface px-2.5 py-1 text-xs font-medium">
                          Revelar
                        </button>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
            {preview && (
              <div className="flex-1 basis-[380px]">
                <ImportPreviewPanel preview={preview.data} busy={busy} onConfirm={confirmPreview} onCancel={() => setPreview(null)} title={preview.target.kind === "file" ? "Importar" : "Restaurar"} />
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function reasonLabel(reason: BackupSnapshot["reason"]): string {
  return reason === "manual" ? "exportada" : reason === "pre-restore" ? "antes de restaurar" : "automática";
}

function reasonTone(reason: BackupSnapshot["reason"]): string {
  return reason === "manual" ? "bg-success-soft text-success-ink" : reason === "pre-restore" ? "bg-warning-soft text-warning-ink" : "bg-paper text-slate";
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
