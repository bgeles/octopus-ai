import { describe, expect, it } from "vitest";
import { collapseUnchanged, diffStats, lineDiff, splitLines } from "./diff";

const kinds = (before: string, after: string) => lineDiff(before, after).map((l) => (l.kind === "skip" ? `skip:${l.count}` : `${l.kind}:${l.text}`));

describe("lineDiff", () => {
  it("textos iguais produzem só linhas equal", () => {
    expect(kinds("a\nb\n", "a\nb")).toEqual(["equal:a", "equal:b"]);
  });

  it("detecta inserção, remoção e substituição mantendo as linhas comuns", () => {
    expect(kinds("a\nb\nc", "a\nx\nb\nc")).toEqual(["equal:a", "added:x", "equal:b", "equal:c"]);
    expect(kinds("a\nb\nc", "a\nc")).toEqual(["equal:a", "removed:b", "equal:c"]);
    expect(kinds("a\nb\nc", "a\nB\nc")).toEqual(["equal:a", "removed:b", "added:B", "equal:c"]);
  });

  it("arquivo novo é tudo adicionado; arquivo apagado é tudo removido", () => {
    expect(kinds("", "um\ndois")).toEqual(["added:um", "added:dois"]);
    expect(kinds("um\ndois", "")).toEqual(["removed:um", "removed:dois"]);
    expect(lineDiff("", "")).toEqual([]);
  });

  it("numera linhas antigas e novas", () => {
    const lines = lineDiff("a\nb", "b\nc");
    expect(lines).toEqual([
      { kind: "removed", text: "a", oldLine: 1, newLine: null },
      { kind: "equal", text: "b", oldLine: 2, newLine: 1 },
      { kind: "added", text: "c", oldLine: null, newLine: 2 },
    ]);
    expect(diffStats(lines)).toEqual({ added: 1, removed: 1 });
  });

  it("splitLines ignora a quebra final e aceita CRLF", () => {
    expect(splitLines("a\r\nb\r\n")).toEqual(["a", "b"]);
    expect(splitLines("")).toEqual([]);
  });
});

describe("collapseUnchanged", () => {
  it("resume trechos iguais longe das mudanças", () => {
    const before = Array.from({ length: 12 }, (_, i) => `l${i}`).join("\n");
    const after = before.replace("l6", "L6");
    const collapsed = collapseUnchanged(lineDiff(before, after), 2);
    expect(collapsed.map((l) => (l.kind === "skip" ? `skip:${l.count}` : `${l.kind}:${l.text}`))).toEqual([
      "skip:4",
      "equal:l4",
      "equal:l5",
      "removed:l6",
      "added:L6",
      "equal:l7",
      "equal:l8",
      "skip:3",
    ]);
  });

  it("não insere skip quando não há nada a resumir", () => {
    expect(collapseUnchanged(lineDiff("a", "b"))).toHaveLength(2);
  });
});
