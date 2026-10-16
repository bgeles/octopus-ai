import { SessionSummarySchema } from "@octopus/protocol";
import { describe, expect, it } from "vitest";
import { toSessionSummary } from "./sessions.js";

describe("toSessionSummary", () => {
  it("prefere o título customizado, depois o resumo, depois o primeiro prompt", () => {
    expect(toSessionSummary({ sessionId: "s", customTitle: "Meu título", summary: "Resumo", firstPrompt: "oi" }, "/p").title).toBe("Meu título");
    expect(toSessionSummary({ sessionId: "s", summary: "Resumo", firstPrompt: "oi" }, "/p").title).toBe("Resumo");
    expect(toSessionSummary({ sessionId: "s", customTitle: "  ", firstPrompt: "oi" }, "/p").title).toBe("oi");
    expect(toSessionSummary({ sessionId: "s" }, "/p").title).toBeNull();
  });

  it("converte tag única em lista e timestamps em ISO, com fallback de cwd", () => {
    const summary = toSessionSummary({ sessionId: "s", tag: "migração", createdAt: 1_760_000_000_000, lastModified: 1_760_000_100_000 }, "/proj");
    expect(summary).toEqual({
      sessionId: "s",
      cwd: "/proj",
      title: null,
      tags: ["migração"],
      createdAt: "2025-10-09T08:53:20.000Z",
      lastUsedAt: "2025-10-09T08:55:00.000Z",
    });
    expect(() => SessionSummarySchema.parse(summary)).not.toThrow();
  });

  it("ignora timestamps inválidos", () => {
    const summary = toSessionSummary({ sessionId: "s", createdAt: Number.NaN }, "/p");
    expect(summary.createdAt).toBeNull();
    expect(summary.lastUsedAt).toBeNull();
  });
});
