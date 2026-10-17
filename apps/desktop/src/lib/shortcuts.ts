import type { View } from "../components/Shell";

/** Ordem do ⌘1 … ⌘9 (igual à navegação lateral, com Configurações por último). */
export const SHORTCUT_VIEWS: View[] = ["run", "sessions", "approvals", "agents", "board", "memory", "harness", "security", "settings"];

export type ShortcutAction = { kind: "view"; view: View } | { kind: "interrupt" } | { kind: "new-prompt" } | null;

/** Traduz um evento de teclado em ação do app (⌘ no macOS, Ctrl nos demais). */
export function shortcutFor(e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">): ShortcutAction {
  const mod = e.metaKey || e.ctrlKey;
  if (!mod || e.altKey || e.shiftKey) return null;
  if (/^[1-9]$/.test(e.key)) return { kind: "view", view: SHORTCUT_VIEWS[Number(e.key) - 1]! };
  if (e.key === ".") return { kind: "interrupt" };
  if (e.key.toLowerCase() === "n") return { kind: "new-prompt" };
  return null;
}

export const SHORTCUT_HELP: { keys: string; description: string }[] = [
  { keys: "⌘1 … ⌘9", description: "Run ao vivo, Sessões, Aprovações, Time, Board, Memória, Harness, Segurança, Configurações" },
  { keys: "⌘↵", description: "Enviar o pedido no composer" },
  { keys: "⌘.", description: "Interromper o run em andamento" },
  { keys: "⌘N", description: "Novo pedido (abre o Run ao vivo e foca o composer)" },
];
