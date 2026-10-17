import { useEffect, useState } from "react";
import { SHORTCUT_HELP } from "../lib/shortcuts";
import { isTauri } from "../lib/transport";
import { THEME_LABELS, type ThemePreference } from "../lib/theme";
import { UPDATES_ENDPOINT_SETTING, type AppSettings, type AuthMode, type BackupSnapshot, type EnvironmentCheck, type ImportMode, type ImportPreview, type UpdateInfo } from "../lib/types";
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
  onCheckUpdate: () => Promise<UpdateInfo>;
  onInstallUpdate: () => Promise<void>;
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

        <section aria-label="Notificações e menu bar" className="flex flex-col gap-3 rounded-xl border hairline bg-surface p-5" data-testid="notification-prefs">
          <h2 className="m-0 font-display text-sm font-semibold">Notificações e menu bar</h2>
          <span className="text-xs text-slate">O ícone na menu bar mostra os runs ativos e um ponto quando algo espera você. Fechar a janela não encerra os runs: o Octopus continua na menu bar (Sair pelo menu do ícone).</span>
          {NOTIFICATION_PREFS.map((pref) => {
            const on = typeof settings[pref.key] === "boolean" ? (settings[pref.key] as boolean) : pref.default;
            return (
              <label key={pref.key} className="flex items-center gap-3 border-b hairline py-2 text-[13px] last:border-b-0">
                <button type="button" role="switch" aria-checked={on} aria-label={pref.title} onClick={() => void onSetSetting(pref.key, !on)} className={["relative inline-block h-[18px] w-[30px] shrink-0 rounded-full", on ? "bg-ink" : "bg-mist"].join(" ")}>
                  <span className={["absolute top-0.5 size-3.5 rounded-full bg-surface", on ? "right-0.5" : "left-0.5"].join(" ")} />
                </button>
                <span className="flex flex-col">
                  <span className="font-semibold">{pref.title}</span>
                  <span className="text-xs text-slate">{pref.description}</span>
                </span>
              </label>
            );
          })}
          <span className="text-xs text-slate">As notificações só aparecem com a janela do Octopus fora de foco.</span>
        </section>

        <section aria-label="Atalhos de teclado" className="flex flex-col gap-2 rounded-xl border hairline bg-surface p-5" data-testid="shortcuts">
          <h2 className="m-0 font-display text-sm font-semibold">Atalhos de teclado</h2>
          <dl className="m-0 grid grid-cols-[110px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[13px]">
            {SHORTCUT_HELP.map((h) => (
              <div key={h.keys} className="contents">
                <dt className="font-mono text-xs">{h.keys}</dt>
                <dd className="m-0 text-slate">{h.description}</dd>
              </div>
            ))}
          </dl>
        </section>

        <UpdatesSection settings={settings} onSetSetting={onSetSetting} onCheck={props.onCheckUpdate} onInstall={props.onInstallUpdate} />

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

export const NOTIFICATION_PREFS: { key: string; title: string; description: string; default: boolean }[] = [
  { key: "notifications.approvals", title: "Aprovação pendente", description: "Um agente pediu para usar uma ferramenta e está esperando você", default: true },
  { key: "notifications.tasks", title: "Task aguardando você", description: "O agente pediu revisão ou ficou bloqueado numa task do board", default: true },
  { key: "notifications.runs", title: "Run concluído ou falhou", description: "Avisa ao fim de cada run", default: false },
];

function UpdatesSection({ settings, onSetSetting, onCheck, onInstall }: { settings: AppSettings; onSetSetting: (key: string, value: unknown) => Promise<void>; onCheck: () => Promise<UpdateInfo>; onInstall: () => Promise<void> }) {
  const saved = typeof settings[UPDATES_ENDPOINT_SETTING] === "string" ? (settings[UPDATES_ENDPOINT_SETTING] as string) : "";
  const [endpoint, setEndpoint] = useState(saved);
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"check" | "install" | null>(null);
  useEffect(() => setEndpoint(saved), [saved]);
  const check = async () => {
    setError(null);
    setBusy("check");
    try {
      const value = endpoint.trim();
      if (value !== saved) {
        if (value && !/^https:\/\//.test(value) && !/^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(value)) throw new Error("Use https:// (http só em localhost)");
        await onSetSetting(UPDATES_ENDPOINT_SETTING, value || null);
      }
      setInfo(await onCheck());
    } catch (e) {
      setInfo(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <section aria-label="Atualizações" className="flex flex-col gap-3 rounded-xl border hairline bg-surface p-5" data-testid="updates">
      <h2 className="m-0 font-display text-sm font-semibold">Atualizações</h2>
      <label className="flex flex-col gap-1 text-xs font-medium text-slate">
        Endereço do manifesto de atualização (latest.json)
        <input aria-label="Endereço do manifesto de atualização" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="https://releases.empresa.com/octopus/latest.json" className="rounded-sm border hairline-strong bg-surface px-2.5 py-1.5 font-mono text-xs text-ink" />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" disabled={busy !== null} onClick={() => void check()} className="rounded-full bg-ink px-3.5 py-2 text-[13px] font-semibold text-paper disabled:opacity-50">
          {busy === "check" ? "Verificando…" : "Verificar agora"}
        </button>
        <span className="text-xs text-slate" data-testid="update-status">
          {info === null
            ? "Sem endereço configurado, o app nunca procura atualizações."
            : !info.configured
              ? `Versão ${info.currentVersion} · atualizações não configuradas`
              : info.available
                ? `Versão ${info.version} disponível (instalada: ${info.currentVersion})${info.notes ? ` · ${info.notes}` : ""}`
                : `Você está na versão mais recente (${info.currentVersion}).`}
        </span>
        {info?.available && (
          <button
            type="button"
            disabled={busy !== null}
            onClick={async () => {
              setBusy("install");
              setError(null);
              try {
                await onInstall();
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              } finally {
                setBusy(null);
              }
            }}
            className="ml-auto rounded-full bg-brand px-3.5 py-2 text-[13px] font-semibold text-white hover:bg-brand-hover disabled:opacity-50"
          >
            {busy === "install" ? "Instalando…" : "Instalar e reiniciar"}
          </button>
        )}
      </div>
      {error && (
        <span role="alert" className="text-xs text-brand-hover">
          {error}
        </span>
      )}
      <span className="text-xs text-slate">Os pacotes são verificados com a chave pública embutida no app antes de instalar.</span>
    </section>
  );
}
