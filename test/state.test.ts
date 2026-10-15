import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type State } from "../src/schemas.js";
import {
  earliestReset,
  isCoolingDown,
  loadConfig,
  loadState,
  pickNext,
  recordLimit,
  saveConfig,
  saveState,
} from "../src/state.js";

const NOW = new Date("2026-10-15T18:00:00Z");
const ALL = new Set(["claude", "codex", "cursor", "antigravity", "qwen"] as const);

beforeEach(() => {
  process.env.NOWALL_HOME = mkdtempSync(join(tmpdir(), "nowall-home-"));
});

describe("recordLimit / cooldown", () => {
  it("uses the parsed reset time", () => {
    const s = recordLimit(
      { v: 1, agents: {} },
      "claude",
      { kind: "quota", window: "session", message: "m", resetsAt: "2026-10-15T21:20:00.000Z" },
      NOW,
      300,
    );
    expect(s.agents.claude?.cooldownUntil).toBe("2026-10-15T21:20:00.000Z");
    expect(isCoolingDown(s, "claude", NOW)).toBe(true);
    expect(isCoolingDown(s, "claude", new Date("2026-10-15T21:21:00Z"))).toBe(false);
  });

  it("falls back to the default cooldown without a reset time", () => {
    const s = recordLimit(
      { v: 1, agents: {} },
      "cursor",
      { kind: "quota", window: "unknown", message: "m" },
      NOW,
      60,
    );
    expect(s.agents.cursor?.cooldownUntil).toBe("2026-10-15T19:00:00.000Z");
  });
});

describe("pickNext", () => {
  const cooled: State = {
    v: 1,
    agents: { claude: { cooldownUntil: "2026-10-15T21:00:00Z" } },
  };

  it("follows configured order, skipping cooling agents", () => {
    expect(pickNext(DEFAULT_CONFIG, cooled, ALL, [], NOW)).toBe("codex");
  });

  it("skips excluded and unavailable agents", () => {
    expect(pickNext(DEFAULT_CONFIG, cooled, new Set(["claude", "cursor"]), [], NOW)).toBe("cursor");
    expect(pickNext(DEFAULT_CONFIG, cooled, ALL, ["codex"], NOW)).toBe("cursor");
  });

  it("never picks the fallback unless enabled", () => {
    const only = new Set(["qwen"] as const);
    expect(pickNext(DEFAULT_CONFIG, { v: 1, agents: {} }, only, [], NOW)).toBeNull();
    const cfg = {
      ...DEFAULT_CONFIG,
      enabled: { ...DEFAULT_CONFIG.enabled, qwen: true },
      fallback: { enabled: true, chinaConsent: false },
    };
    expect(pickNext(cfg, { v: 1, agents: {} }, only, [], NOW)).toBe("qwen");
  });

  it("returns null when everyone is cooling down", () => {
    const s: State = { v: 1, agents: {} };
    for (const id of ["claude", "codex", "cursor", "antigravity"] as const) {
      s.agents[id] = { cooldownUntil: "2026-10-16T00:00:00Z" };
    }
    s.agents.codex = { cooldownUntil: "2026-10-15T19:00:00Z" };
    expect(pickNext(DEFAULT_CONFIG, s, ALL, [], NOW)).toBeNull();
    expect(earliestReset(s, NOW)).toEqual({ agent: "codex", at: "2026-10-15T19:00:00Z" });
  });
});

describe("persistence", () => {
  it("round-trips state and merges config with defaults", () => {
    saveState({ v: 1, agents: { codex: { cooldownUntil: "2026-10-15T19:00:00Z" } } });
    expect(loadState().agents.codex?.cooldownUntil).toBe("2026-10-15T19:00:00Z");
    saveConfig({
      ...DEFAULT_CONFIG,
      order: ["cursor", "claude"],
      stop: { maxTurns: 5, maxMinutes: 10, noDiffTurns: 2 },
    });
    const c = loadConfig();
    expect(c.order).toEqual(["cursor", "claude"]);
    expect(c.stop.maxTurns).toBe(5);
    expect(c.fallback.enabled).toBe(false);
  });

  it("returns empty state when file is missing or corrupt", () => {
    expect(loadState()).toEqual({ v: 1, agents: {} });
  });
});
