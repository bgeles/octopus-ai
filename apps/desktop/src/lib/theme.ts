/**
 * Preferência de tema (Grafite claro/escuro). "system" segue `prefers-color-scheme`;
 * "light"/"dark" forçam via `data-theme` no <html>, que o CSS em index.css respeita.
 */
import { useCallback, useEffect, useState } from "react";

export type ThemePreference = "system" | "light" | "dark";

export const THEME_STORAGE_KEY = "octopus.theme";

export const THEME_LABELS: Record<ThemePreference, string> = {
  system: "Sistema",
  light: "Claro",
  dark: "Escuro",
};

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

export function readThemePreference(storage: Pick<Storage, "getItem"> | null = safeStorage()): ThemePreference {
  try {
    const stored = storage?.getItem(THEME_STORAGE_KEY);
    return isThemePreference(stored) ? stored : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(preference: ThemePreference, root: HTMLElement | null = typeof document !== "undefined" ? document.documentElement : null): void {
  if (!root) return;
  if (preference === "system") delete root.dataset.theme;
  else root.dataset.theme = preference;
}

export function saveThemePreference(preference: ThemePreference, storage: Pick<Storage, "setItem"> | null = safeStorage()): void {
  try {
    storage?.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Armazenamento indisponível (modo privado, etc.): a preferência vale só para a sessão.
  }
}

export function useTheme(): [ThemePreference, (next: ThemePreference) => void] {
  const [preference, setPreference] = useState<ThemePreference>(() => readThemePreference());
  useEffect(() => {
    applyTheme(preference);
  }, [preference]);
  const update = useCallback((next: ThemePreference) => {
    saveThemePreference(next);
    setPreference(next);
  }, []);
  return [preference, update];
}

function safeStorage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}
