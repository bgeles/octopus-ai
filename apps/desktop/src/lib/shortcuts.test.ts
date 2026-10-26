import { describe, expect, it } from "vitest";
import { shortcutFor } from "./shortcuts";

const k = (key: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }> = { metaKey: true }) => ({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });

describe("atalhos", () => {
  it("mapeia ⌘/Ctrl + número, ponto e N", () => {
    expect(shortcutFor(k("1"))).toEqual({ kind: "view", view: "home" });
    expect(shortcutFor(k("2"))).toEqual({ kind: "view", view: "run" });
    expect(shortcutFor(k("8"))).toEqual({ kind: "view", view: "harness" });
    expect(shortcutFor(k("9", { ctrlKey: true }))).toEqual({ kind: "view", view: "security" });
    expect(shortcutFor(k(","))).toEqual({ kind: "view", view: "settings" });
    expect(shortcutFor(k("."))).toEqual({ kind: "interrupt" });
    expect(shortcutFor(k("N"))).toEqual({ kind: "new-prompt" });
  });
  it("ignora teclas sem modificador ou com Shift/Alt", () => {
    expect(shortcutFor(k("1", {}))).toBeNull();
    expect(shortcutFor(k("1", { metaKey: true, shiftKey: true }))).toBeNull();
    expect(shortcutFor(k("0"))).toBeNull();
    expect(shortcutFor(k("x"))).toBeNull();
  });
});
