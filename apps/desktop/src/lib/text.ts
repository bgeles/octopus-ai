/** Primeira linha "falável" de um markdown (sem títulos vazios, marcadores ou "Entrega"). */
export function firstLine(md: string | null | undefined): string | null {
  if (!md) return null;
  const line = md
    .split("\n")
    .map((l) => l.replace(/^#+\s*/, "").replace(/^[-*]\s+/, "").replace(/[`*]/g, "").trim())
    .find((l) => l && !/^entrega$/i.test(l));
  return line ?? null;
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
