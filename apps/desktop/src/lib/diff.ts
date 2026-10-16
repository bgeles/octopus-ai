/**
 * Diff por linhas (LCS) para o preview de aprovações de Write/Edit. Sem dependências.
 */
export type DiffLine =
  | { kind: "equal" | "added" | "removed"; text: string; oldLine: number | null; newLine: number | null }
  | { kind: "skip"; count: number };

export type DiffStats = { added: number; removed: number };

/** Acima deste produto de tamanhos o LCS vira "tudo removido + tudo adicionado". */
const MAX_CELLS = 4_000_000;

export function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function lineDiff(before: string, after: string): DiffLine[] {
  const a = splitLines(before);
  const b = splitLines(after);
  if (a.length * b.length > MAX_CELLS) {
    return [...a.map((text, i) => ({ kind: "removed" as const, text, oldLine: i + 1, newLine: null })), ...b.map((text, i) => ({ kind: "added" as const, text, oldLine: null, newLine: i + 1 }))];
  }

  // lcs[i][j] = tamanho do LCS de a[i..] e b[j..]
  const cols = b.length + 1;
  const lcs = new Uint32Array((a.length + 1) * cols);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * cols + j] = a[i] === b[j] ? lcs[(i + 1) * cols + j + 1]! + 1 : Math.max(lcs[(i + 1) * cols + j]!, lcs[i * cols + j + 1]!);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: "equal", text: a[i]!, oldLine: i + 1, newLine: j + 1 });
      i++;
      j++;
    } else if (lcs[(i + 1) * cols + j]! >= lcs[i * cols + j + 1]!) {
      out.push({ kind: "removed", text: a[i]!, oldLine: i + 1, newLine: null });
      i++;
    } else {
      out.push({ kind: "added", text: b[j]!, oldLine: null, newLine: j + 1 });
      j++;
    }
  }
  while (i < a.length) out.push({ kind: "removed", text: a[i]!, oldLine: ++i, newLine: null });
  while (j < b.length) out.push({ kind: "added", text: b[j]!, oldLine: null, newLine: ++j });
  return out;
}

export function diffStats(lines: DiffLine[]): DiffStats {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.kind === "added") added++;
    else if (line.kind === "removed") removed++;
  }
  return { added, removed };
}

/** Mantém `context` linhas iguais ao redor de cada mudança e resume o resto em `skip`. */
export function collapseUnchanged(lines: DiffLine[], context = 3): DiffLine[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((line, index) => {
    if (line.kind === "equal" || line.kind === "skip") return;
    for (let k = Math.max(0, index - context); k <= Math.min(lines.length - 1, index + context); k++) keep[k] = true;
  });
  const out: DiffLine[] = [];
  let skipped = 0;
  lines.forEach((line, index) => {
    if (keep[index]) {
      if (skipped > 0) out.push({ kind: "skip", count: skipped });
      skipped = 0;
      out.push(line);
    } else {
      skipped++;
    }
  });
  if (skipped > 0) out.push({ kind: "skip", count: skipped });
  return out;
}
