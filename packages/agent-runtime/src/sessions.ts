/**
 * Mapeia metadados de sessão do Agent SDK para o `SessionSummary` do protocolo.
 * Função pura, sem dependência do SDK em runtime, para ser testável com fixtures.
 */
import type { SessionSummary } from "@octopus/protocol";

/** Forma mínima do `SDKSessionInfo` que o mapeador usa. */
export type SdkSessionInfoLike = {
  sessionId: string;
  summary?: string;
  customTitle?: string;
  firstPrompt?: string;
  cwd?: string;
  tag?: string;
  createdAt?: number;
  lastModified?: number;
};

export function toSessionSummary(info: SdkSessionInfoLike, fallbackCwd: string): SessionSummary {
  return {
    sessionId: info.sessionId,
    cwd: info.cwd ?? fallbackCwd,
    title: firstNonEmpty(info.customTitle, info.summary, info.firstPrompt),
    tags: info.tag ? [info.tag] : [],
    createdAt: toIso(info.createdAt),
    lastUsedAt: toIso(info.lastModified),
  };
}

function firstNonEmpty(...values: Array<string | undefined>): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return null;
}

function toIso(ms: number | undefined): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return null;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
