import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  accountEnv,
  accountFromEnv,
  accountName,
  addAccount,
  allAccounts,
  removeAccount,
  setOrder,
} from "../src/accounts.js";
import { DEFAULT_CONFIG, type State, accountAgent, accountLabel } from "../src/schemas.js";
import { earliestReset, isCoolingDown, loadConfig, pickNext, recordLimit } from "../src/state.js";

const NOW = new Date("2026-10-15T18:00:00Z");

beforeEach(() => {
  process.env.NOWALL_HOME = mkdtempSync(join(tmpdir(), "nowall-home-"));
  process.env.NOWALL_SECRET_STORE = "file";
});

describe("account ids", () => {
  it("splits agent and label", () => {
    expect(accountAgent("claude")).toBe("claude");
    expect(accountAgent("claude:work")).toBe("claude");
    expect(accountAgent("nope:work")).toBeNull();
    expect(accountLabel("claude")).toBe("");
    expect(accountLabel("claude:work")).toBe("work");
    expect(accountName("claude")).toBe("Claude Code");
    expect(accountName("cursor:team")).toBe("Cursor (team)");
  });
});

describe("adding accounts", () => {
  it("creates an isolated profile for Claude and slots it after the default account", () => {
    const a = addAccount("claude", "work");
    expect(a.id).toBe("claude:work");
    const dir = a.env?.CLAUDE_CONFIG_DIR as string;
    expect(existsSync(dir)).toBe(true);
    expect(statSync(dir).mode & 0o777).toBe(0o700);

    const c = loadConfig();
    expect(c.order).toEqual(["claude", "claude:work", ...DEFAULT_CONFIG.order.slice(1)]);
    expect(accountEnv(c, "claude:work")).toEqual({ CLAUDE_CONFIG_DIR: dir });
    expect(accountEnv(c, "claude")).toEqual({});

    // Hooks attribute a limit to the account whose env is set.
    expect(accountFromEnv("claude", { CLAUDE_CONFIG_DIR: dir })).toBe("claude:work");
    expect(accountFromEnv("claude", {})).toBe("claude");
    expect(accountFromEnv("codex", { CLAUDE_CONFIG_DIR: dir })).toBe("codex");
  });

  it("keeps a Cursor API key out of config.json and only hands it to the agent env", () => {
    const a = addAccount("cursor", "b", { apiKey: "fake-cursor-key" });
    expect(a.secret).toEqual({ env: "CURSOR_API_KEY", store: "file" });
    const raw = readFileSync(join(process.env.NOWALL_HOME as string, "config.json"), "utf8");
    expect(raw).not.toContain("fake-cursor-key");
    const file = join(process.env.NOWALL_HOME as string, "secrets", "cursor_b");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(accountEnv(loadConfig(), "cursor:b")).toEqual({ CURSOR_API_KEY: "fake-cursor-key" });

    removeAccount("cursor:b");
    expect(existsSync(file)).toBe(false);
    expect(loadConfig().order).not.toContain("cursor:b");
    expect(loadConfig().accounts).toBeUndefined();
  });

  it("rejects bad labels, duplicates, missing keys and unsupported agents", () => {
    expect(() => addAccount("claude", "bad label")).toThrow(/label/);
    addAccount("claude", "work");
    expect(() => addAccount("claude", "work")).toThrow(/already exists/);
    expect(() => addAccount("cursor", "b")).toThrow(/API key/);
    expect(() => addAccount("antigravity", "x")).toThrow(/does not support/);
  });
});

describe("order", () => {
  it("lists every account, ordered ones first", () => {
    addAccount("codex", "alt");
    setOrder(["codex:alt", "claude"]);
    const ids = allAccounts(loadConfig()).map((a) => a.id);
    expect(ids.slice(0, 2)).toEqual(["codex:alt", "claude"]);
    expect(ids).toHaveLength(6);
    expect(() => setOrder(["claude", "ghost:1"])).toThrow(/unknown account/);
    expect(setOrder(["claude", "claude", "cursor"]).order).toEqual(["claude", "cursor"]);
  });

  it("drops unknown ids from a hand-edited config", () => {
    setOrder(["claude", "cursor"]);
    const path = join(process.env.NOWALL_HOME as string, "config.json");
    const c = JSON.parse(readFileSync(path, "utf8"));
    c.order = ["claude:gone", "cursor", "claude", "cursor"];
    writeFileSync(path, JSON.stringify(c));
    expect(loadConfig().order).toEqual(["cursor", "claude"]);
  });
});

describe("failover over accounts", () => {
  it("cools down one account at a time and picks the next in order", () => {
    addAccount("claude", "work");
    const config = loadConfig();
    const available = new Set(config.order);
    let s: State = { v: 1, agents: {} };
    s = recordLimit(
      s,
      "claude",
      { kind: "quota", window: "session", message: "m", resetsAt: "2026-10-15T21:00:00.000Z" },
      NOW,
      300,
    );
    expect(isCoolingDown(s, "claude", NOW)).toBe(true);
    expect(isCoolingDown(s, "claude:work", NOW)).toBe(false);
    expect(pickNext(config, s, available, [], NOW)).toBe("claude:work");

    s = recordLimit(
      s,
      "claude:work",
      { kind: "quota", window: "session", message: "m", resetsAt: "2026-10-15T19:00:00.000Z" },
      NOW,
      300,
    );
    expect(pickNext(config, s, available, [], NOW)).toBe("codex");
    expect(earliestReset(s, NOW)).toEqual({
      account: "claude:work",
      agent: "claude",
      at: "2026-10-15T19:00:00.000Z",
    });

    // A disabled agent takes all of its accounts out of the running.
    const off = { ...config, enabled: { ...DEFAULT_CONFIG.enabled, claude: false } };
    expect(pickNext(off, { v: 1, agents: {} }, available, [], NOW)).toBe("codex");
  });
});
