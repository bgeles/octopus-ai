/**
 * Transporte entre a UI e o core. A implementação real usa `invoke`/`listen` do Tauri;
 * a de mock roda no navegador puro (vitest, Playwright, `vite` sem Tauri) reproduzindo fixtures.
 */
import type { CommandName, Commands, EventName, Events } from "./types";

export type Unlisten = () => void;

export interface Transport {
  invoke<C extends CommandName>(command: C, args: Commands[C]["args"]): Promise<Commands[C]["result"]>;
  listen<E extends EventName>(event: E, handler: (payload: Events[E]) => void): Promise<Unlisten>;
}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
    __OCTOPUS_TRANSPORT__?: Transport;
  }
}

export function isTauri(): boolean {
  return typeof window !== "undefined" && window.__TAURI_INTERNALS__ !== undefined;
}

export async function createTauriTransport(): Promise<Transport> {
  const [{ invoke }, { listen }] = await Promise.all([import("@tauri-apps/api/core"), import("@tauri-apps/api/event")]);
  return {
    invoke: (command, args) => invoke(command, args as Record<string, unknown>),
    listen: async (event, handler) => listen(event, (e) => handler(e.payload as never)),
  };
}

/**
 * Escolhe o transporte: um injetado em `window` (testes), o Tauri quando disponível,
 * ou o mock quando rodando só no navegador (`vite dev` fora do Tauri, Playwright).
 */
export async function resolveTransport(): Promise<Transport> {
  if (typeof window !== "undefined" && window.__OCTOPUS_TRANSPORT__) return window.__OCTOPUS_TRANSPORT__;
  if (isTauri()) return createTauriTransport();
  const { createMockTransport } = await import("./mockTransport");
  return createMockTransport();
}
