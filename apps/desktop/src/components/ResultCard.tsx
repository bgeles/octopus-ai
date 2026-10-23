import { useState } from "react";
import { copyText, renderMarkdown } from "../lib/markdown";
import type { RunResultSummary } from "../state/runReducer";
import { formatUsd } from "./RunSidebar";

/** Fecho de cada run: o texto final do agente, com custo e turnos, para não ficar escondido no transcript. */
export function ResultCard({ result }: { result: RunResultSummary }) {
  const [copied, setCopied] = useState(false);
  const text = result.resultText?.trim() ?? "";
  if (!text && !result.isError) return null;
  const meta = [result.isError ? "terminou com erro" : "concluído", result.numTurns != null ? `${result.numTurns} ${result.numTurns === 1 ? "turno" : "turnos"}` : null, result.costUsd != null ? formatUsd(result.costUsd) : null].filter(Boolean).join(" · ");
  return (
    <section aria-label="Resultado do run" className={["flex flex-col gap-2 rounded-xl border-l-[3px] bg-paper px-4 py-3.5", result.isError ? "border-brand" : "border-success"].join(" ")} data-testid="run-result">
      <div className="flex items-center gap-2.5">
        <span className={["eyebrow", result.isError ? "text-brand" : "text-success-ink"].join(" ")}>Resultado</span>
        <span className="text-xs text-slate">{meta}</span>
        {text && (
          <button
            type="button"
            onClick={() => void copyText(text).then((ok) => ok && (setCopied(true), setTimeout(() => setCopied(false), 1500)))}
            className="ml-auto rounded-md border hairline-strong bg-surface px-2.5 py-1 text-xs font-medium hover:border-ink"
          >
            {copied ? "Copiado" : "Copiar"}
          </button>
        )}
      </div>
      {text ? <div className="flex flex-col gap-1 text-[14px] leading-relaxed">{renderMarkdown(text)}</div> : <p className="m-0 text-[13px] text-slate">O agente terminou sem texto final.</p>}
    </section>
  );
}
