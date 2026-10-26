import { Compass } from "lucide-react";
import type { Project } from "../lib/types";

type MissionLineProps = {
  project: Project | null;
  onEdit: () => void;
  /** Versão curta para o Início. */
  compact?: boolean;
};

/** Linha de missão do projeto: o "porquê" que entra no prompt de todo run de task e de todo membro. */
export function MissionLine({ project, onEdit, compact = false }: MissionLineProps) {
  const mission = project?.mission?.trim() || null;
  return (
    <div className={["flex min-w-0 flex-wrap items-center gap-2 text-[13px]", compact ? "" : "rounded-lg border hairline bg-surface px-3.5 py-2"].join(" ")} data-testid="project-mission" data-defined={mission ? "true" : "false"}>
      <Compass size={14} aria-hidden className={mission ? "text-brand" : "text-slate"} />
      {mission ? (
        <span className="min-w-0 flex-1">
          <span className="font-semibold">Missão:</span> <span className="text-ink">{mission}</span>
        </span>
      ) : (
        <span className="min-w-0 flex-1 text-slate">Sem missão definida. A missão entra no prompt de todo run como o porquê do trabalho.</span>
      )}
      <button type="button" onClick={onEdit} className="text-xs font-semibold text-brand hover:text-brand-hover">
        {mission ? "Editar missão" : "Definir missão"}
      </button>
    </div>
  );
}
