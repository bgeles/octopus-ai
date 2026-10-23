import type { ReactNode } from "react";

/**
 * Renderização mínima de markdown (títulos, listas, negrito e código inline) para textos
 * escritos pelos agentes: páginas da memória, handoffs e resultados de tasks e runs.
 * Sem HTML cru: tudo vira texto, então não há superfície de injeção.
 */
export function renderMarkdown(md: string): ReactNode[] {
  const out: ReactNode[] = [];
  const lines = md.split("\n");
  let list: string[] = [];
  const flushList = () => {
    if (list.length === 0) return;
    out.push(
      <ul key={`ul_${out.length}`} className="m-0 flex list-disc flex-col gap-0.5 pl-5">
        {list.map((item, i) => (
          <li key={i}>{inline(item)}</li>
        ))}
      </ul>,
    );
    list = [];
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^\s*[-*]\s+/.test(line)) {
      list.push(line.replace(/^\s*[-*]\s+/, ""));
      continue;
    }
    flushList();
    if (!line.trim()) continue;
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      const cls = level <= 2 ? "m-0 mt-2 font-display text-[15px] font-semibold" : "m-0 mt-1 text-[13px] font-semibold";
      out.push(
        <p key={`h_${out.length}`} role="heading" aria-level={Math.min(6, level + 2)} className={cls}>
          {inline(heading[2]!)}
        </p>,
      );
      continue;
    }
    out.push(
      <p key={`p_${out.length}`} className="m-0">
        {inline(line)}
      </p>,
    );
  }
  flushList();
  return out;
}

function inline(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const token = m[0];
    if (token.startsWith("**")) parts.push(<strong key={m.index}>{token.slice(2, -2)}</strong>);
    else parts.push(<code key={m.index} className="rounded-sm bg-paper px-1 font-mono text-xs">{token.slice(1, -1)}</code>);
    last = m.index + token.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

/** Copia texto para a área de transferência; devolve false onde a API não existe (testes, webview antiga). */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator === "undefined" || !navigator.clipboard) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
