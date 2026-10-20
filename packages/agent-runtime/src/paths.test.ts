import { describe, expect, it } from "vitest";
import { resolveClaudePath } from "./paths.js";

const base = { env: {}, execPath: "/Applications/Octopus AI.app/Contents/MacOS/agent-runtime", isSea: true, exists: () => true };

describe("resolveClaudePath", () => {
  it("no binário único usa o claude ao lado do sidecar", () => {
    expect(resolveClaudePath(base)).toBe("/Applications/Octopus AI.app/Contents/MacOS/claude");
    expect(resolveClaudePath({ ...base, exists: () => false })).toBeNull();
  });

  it("fora do binário único deixa o SDK resolver; OCTOPUS_CLAUDE_PATH vence sempre", () => {
    expect(resolveClaudePath({ ...base, isSea: false })).toBeNull();
    expect(resolveClaudePath({ ...base, isSea: false, env: { OCTOPUS_CLAUDE_PATH: "/opt/claude" } })).toBe("/opt/claude");
  });
});
