/**
 * Onde está o Claude Code nativo que o SDK executa. No app distribuído o sidecar é um binário
 * único (Node SEA) e o `claude` vem ao lado dele em `Contents/MacOS`; aí o SDK não consegue
 * localizar o pacote opcional da plataforma sozinho, então passamos `pathToClaudeCodeExecutable`.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export type ClaudePathDeps = {
  env: Record<string, string | undefined>;
  execPath: string;
  isSea: boolean;
  exists: (path: string) => boolean;
};

/** `null` = deixa o SDK achar o binário do pacote opcional (desenvolvimento, `node dist/main.js`). */
export function resolveClaudePath(deps: ClaudePathDeps): string | null {
  const explicit = deps.env.OCTOPUS_CLAUDE_PATH?.trim();
  if (explicit) return explicit;
  if (!deps.isSea) return null;
  const sibling = join(dirname(deps.execPath), "claude");
  return deps.exists(sibling) ? sibling : null;
}

/** Síncrono de propósito: o binário único é CommonJS e não aceita `await` no topo do módulo. */
export function defaultClaudePathDeps(req: (id: string) => unknown): ClaudePathDeps {
  let isSea = false;
  try {
    isSea = (req("node:sea") as { isSea(): boolean }).isSea();
  } catch {
    // Node sem o módulo `node:sea`: não é um binário único.
  }
  return { env: process.env, execPath: process.execPath, isSea, exists: existsSync };
}
