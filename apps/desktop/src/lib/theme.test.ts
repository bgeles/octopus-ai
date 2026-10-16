import { beforeEach, describe, expect, it } from "vitest";
import { THEME_STORAGE_KEY, applyTheme, readThemePreference, saveThemePreference } from "./theme";

describe("tema Grafite", () => {
  beforeEach(() => {
    window.localStorage.clear();
    delete document.documentElement.dataset.theme;
  });

  it("sem preferência salva, segue o sistema", () => {
    expect(readThemePreference()).toBe("system");
  });

  it("ignora valores inválidos no armazenamento", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "neon");
    expect(readThemePreference()).toBe("system");
  });

  it("aplica data-theme para claro/escuro e remove para sistema", () => {
    applyTheme("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    applyTheme("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    applyTheme("system");
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it("persiste a preferência e a lê de volta", () => {
    saveThemePreference("dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(readThemePreference()).toBe("dark");
  });

  it("tolera armazenamento que lança", () => {
    const broken = {
      getItem: () => {
        throw new Error("bloqueado");
      },
      setItem: () => {
        throw new Error("bloqueado");
      },
    };
    expect(readThemePreference(broken)).toBe("system");
    expect(() => saveThemePreference("light", broken)).not.toThrow();
  });
});
