import type { Project, SandboxProfile } from "../lib/types";

type SandboxSectionProps = {
  project: Project | null;
  profiles: SandboxProfile[];
  onSelect: (profileId: string) => Promise<void>;
};

export function SandboxSection({ project, profiles, onSelect }: SandboxSectionProps) {
  const currentId = project?.sandboxProfileId ?? "sandbox_dev";
  const current = profiles.find((p) => p.id === currentId) ?? null;
  const s = current?.settings;
  const fs = s?.filesystem;
  const net = s?.network;
  const unsandboxed = s?.allowUnsandboxedCommands ? "permitidos" : s?.failIfUnavailable ? "não permitidos (falha se indisponível)" : "não permitidos";
  const write = fs?.allowWrite && fs.allowWrite.length > 0 ? fs.allowWrite.map((p) => p.replace("${PROJECT}", "<projeto>")).join(" · ") : fs?.denyWrite?.length ? "nenhuma (somente leitura)" : "livre";
  const network = net?.strictAllowlist
    ? net.allowedDomains?.length
      ? `allowlist estrita · ${net.allowedDomains.length} hosts`
      : "allowlist estrita · nenhum host liberado"
    : net?.allowedDomains?.length
      ? `${net.allowedDomains.length} hosts liberados`
      : "livre";
  const creds = s?.credentials?.envVars?.length ? s.credentials.envVars.map((v) => `${v.name} ${v.mode === "mask" ? "mascarada" : "negada"}${v.injectHosts?.length ? ` · injetada em ${v.injectHosts.join(", ")}` : ""}`).join(" · ") : "sem tratamento";
  return (
    <section aria-label="Sandbox do projeto" className="flex flex-col gap-3 rounded-xl border hairline bg-surface p-5" data-testid="sandbox-section" data-profile={currentId}>
      <div className="flex items-baseline gap-3">
        <h2 className="m-0 font-display text-sm font-semibold">Sandbox do projeto</h2>
        <span className="text-xs text-slate">Seatbelt do Claude Code; cobre comandos shell. Read, Edit e MCP seguem as regras de política.</span>
      </div>
      <div role="radiogroup" aria-label="Perfil de sandbox" className="flex rounded-md border hairline-strong p-0.5 text-[13px]">
        {profiles.map((p) => (
          <button key={p.id} type="button" role="radio" aria-checked={p.id === currentId} disabled={!project} onClick={() => void onSelect(p.id)} className={["flex-1 rounded-sm px-3 py-2 font-medium disabled:opacity-40", p.id === currentId ? "bg-ink text-paper" : "text-slate hover:text-ink"].join(" ")}>
            {p.name}
          </button>
        ))}
      </div>
      {current && (
        <>
          <p className="m-0 text-[13px] text-slate">{current.description}</p>
          <div className="flex flex-col text-[13px]">
            <Row label="Comandos fora do sandbox" value={unsandboxed} />
            <Row label="Escrita" value={write} />
            <Row label="Leitura negada" value={fs?.denyRead?.length ? fs.denyRead.join(" · ") : "nenhuma"} />
            <Row label="Rede" value={network} />
            <Row label="Credenciais" value={creds} />
          </div>
        </>
      )}
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3 border-b hairline py-1.5 last:border-b-0">
      <span className="text-slate">{label}</span>
      <span className="truncate text-right font-mono text-xs" title={value}>
        {value}
      </span>
    </div>
  );
}
