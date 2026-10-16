import { collapseUnchanged, diffStats, lineDiff, type DiffLine } from "../lib/diff";

type DiffViewProps = {
  before: string;
  after: string;
  /** Linhas iguais mantidas ao redor de cada mudança. */
  context?: number;
};

export function DiffView({ before, after, context = 3 }: DiffViewProps) {
  const lines = lineDiff(before, after);
  const stats = diffStats(lines);
  const shown = collapseUnchanged(lines, context);
  return (
    <div className="overflow-hidden rounded-md border hairline" data-testid="diff">
      <div className="flex items-center gap-3 border-b hairline bg-paper px-3 py-1.5 font-mono text-[11px]">
        <span className="font-semibold text-success-ink" data-testid="diff-added">
          +{stats.added}
        </span>
        <span className="font-semibold text-brand-hover" data-testid="diff-removed">
          −{stats.removed}
        </span>
        <span className="text-slate">{lines.length === 0 ? "sem conteúdo" : `${lines.length} linhas`}</span>
      </div>
      <div className="max-h-72 overflow-auto">
        {shown.map((line, index) => (
          <DiffRow key={index} line={line} />
        ))}
      </div>
    </div>
  );
}

function DiffRow({ line }: { line: DiffLine }) {
  if (line.kind === "skip") {
    return (
      <div className="border-y border-dashed hairline bg-paper px-3 py-0.5 font-mono text-[11px] text-slate" data-testid="diff-skip">
        ··· {line.count} {line.count === 1 ? "linha igual" : "linhas iguais"}
      </div>
    );
  }
  const tone = line.kind === "added" ? "bg-success-soft text-success-ink" : line.kind === "removed" ? "bg-brand-soft text-brand-hover" : "text-ink";
  const sign = line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " ";
  return (
    <div className={["grid grid-cols-[2.5rem_2.5rem_1.25rem_minmax(0,1fr)] font-mono text-xs leading-6", tone].join(" ")} data-testid="diff-line" data-kind={line.kind}>
      <span className="pr-2 text-right text-slate">{line.oldLine ?? ""}</span>
      <span className="pr-2 text-right text-slate">{line.newLine ?? ""}</span>
      <span className="text-center font-semibold">{sign}</span>
      <span className={["truncate pr-3 whitespace-pre", line.kind === "removed" ? "line-through decoration-brand/50" : ""].join(" ")}>{line.text}</span>
    </div>
  );
}
