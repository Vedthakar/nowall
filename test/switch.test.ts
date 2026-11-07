import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { agentsPath } from "../src/agents.js";
import { handleHook } from "../src/hooks.js";
import { OFF_MARKER, takeoverBlocked } from "../src/pause.js";
import { AGENT_IDS, DEFAULT_CONFIG } from "../src/schemas.js";
import { type LimitSignal, handoffDir, saveSession, signalPath } from "../src/session.js";
import { saveConfig, writeJson } from "../src/state.js";
import { type SessionStatus, readStatus, statusDir, updateStatus } from "../src/status.js";
import {
  parsePauseUntil,
  resolveTarget,
  runCancel,
  runOff,
  runOn,
  runPause,
  runResume,
  runSwitch,
} from "../src/switch.js";
import { tempRepo } from "./helpers.js";

const NOW = new Date("2026-11-07T12:00:00.000Z");
const SID = "c_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

beforeEach(() => {
  process.env.NOWALL_HOME = mkdtempSync(join(tmpdir(), "nowall-sw-"));
  saveConfig({ ...DEFAULT_CONFIG, scope: "global", takeover: "background" });
});

/** Fake agent CLIs on PATH + a fresh agents.json so refreshAgents doesn't shell out. */
function installFakes(): void {
  const bin = mkdtempSync(join(tmpdir(), "nowall-bin-"));
  for (const name of ["claude", "codex", "cursor-agent", "agy", "qwen"]) {
    const path = join(bin, name);
    writeFileSync(
      path,
      `#!/bin/sh\ncase "$1" in --version) echo fake; exit 0;; status|auth) echo '{"loggedIn":true,"isAuthenticated":true}'; exit 0;; esac\nexit 0\n`,
    );
    chmodSync(path, 0o755);
  }
  process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
  const checkedAt = NOW.toISOString();
  writeJson(agentsPath(), {
    v: 1,
    updatedAt: checkedAt,
    agents: AGENT_IDS.map((id) => ({
      id,
      name: id,
      installed: true,
      signedIn: true,
      checkedAt,
      enabled: true,
      loginHint: "",
      installHint: "",
    })),
    accounts: AGENT_IDS.map((id) => ({
      id,
      agent: id,
      name: id,
      label: "",
      signedIn: true,
      checkedAt,
      active: true,
    })),
  });
}

function liveStatus(repo: string, over: Partial<SessionStatus> = {}): void {
  mkdirSync(statusDir(), { recursive: true });
  updateStatus(SID, repo, {
    agent: "claude",
    phase: "working",
    detail: "editing",
    ...over,
  });
  // updateStatus stamps updatedAt as Date(); pin it so resolveTarget's age filter stays happy.
  const file = join(statusDir(), `${SID}.json`);
  const s = JSON.parse(readFileSync(file, "utf8")) as SessionStatus;
  s.updatedAt = NOW.toISOString();
  s.startedAt = NOW.toISOString();
  writeFileSync(file, `${JSON.stringify(s, null, 2)}\n`);
}

function seedSession(repo: string): void {
  mkdirSync(handoffDir(repo), { recursive: true });
  saveSession(repo, {
    v: 1,
    sid: SID,
    startedAt: NOW.toISOString(),
    baseCommit: "0".repeat(40),
    checkpoints: 1,
    segments: [{ agent: "claude", mode: "interactive", startedAt: NOW.toISOString() }],
  });
}

describe("parsePauseUntil", () => {
  it("reads durations and rejects nonsense", () => {
    expect(parsePauseUntil("30m", NOW)?.getTime()).toBe(NOW.getTime() + 1_800_000);
    expect(parsePauseUntil("2h", NOW)?.getTime()).toBe(NOW.getTime() + 7_200_000);
    expect(parsePauseUntil("1d", NOW)?.getTime()).toBe(NOW.getTime() + 86_400_000);
    expect(parsePauseUntil(undefined, NOW)?.getTime()).toBe(NOW.getTime() + 86_400_000);
    expect(parsePauseUntil("soon", NOW)).toBeNull();
    expect(parsePauseUntil("0m", NOW)).toBeNull();
  });
});

describe("pause / resume / off / on", () => {
  it("pause stops takeovers; resume clears it", () => {
    const repo = tempRepo();
    expect(runPause(["30m"], NOW)).toBe(0);
    expect(takeoverBlocked(repo, NOW)).toContain("paused");
    expect(runResume(NOW)).toBe(0);
    expect(takeoverBlocked(repo, NOW)).toBeNull();
  });

  it("off/on is per repo", () => {
    const repo = tempRepo();
    expect(runOff(repo)).toBe(0);
    expect(takeoverBlocked(repo, NOW)).toContain("off");
    expect(readFileSync(join(handoffDir(repo), OFF_MARKER), "utf8")).toContain("off");
    expect(runOn(repo)).toBe(0);
    expect(takeoverBlocked(repo, NOW)).toBeNull();
  });

  it("pause stops hooks from taking over; status still updates", () => {
    const repo = tempRepo();
    saveConfig({
      ...DEFAULT_CONFIG,
      scope: "global",
      pausedUntil: new Date(NOW.getTime() + 3_600_000).toISOString(),
    });
    handleHook("stop-failure", "claude", { session_id: SID.slice(2), cwd: repo }, {}, NOW);
    const s = readStatus(SID);
    expect(s?.phase).toBe("stopped");
    expect(s?.detail).toContain("paused");
  });
});

describe("resolveTarget", () => {
  it("says so when nothing is live", () => {
    expect(resolveTarget({ latest: true }, NOW)).toContain("no live session");
  });

  it("finds the newest live session with --latest", () => {
    const repo = tempRepo();
    liveStatus(repo);
    const t = resolveTarget({ latest: true }, NOW);
    expect(typeof t === "string" ? t : t.sid).toBe(SID);
  });
});

describe("runCancel", () => {
  it("with no takeover running exits 2", () => {
    expect(runCancel([], new Date())).toBe(2);
  });

  it("never signals a process that isn't that session's takeover", () => {
    const repo = tempRepo();
    const now = new Date();
    updateStatus(SID, repo, { agent: "cursor", phase: "working", origin: { kind: "takeover" } });
    // A live process holds the lock, but it's this test runner, not a takeover.
    mkdirSync(handoffDir(repo), { recursive: true });
    writeFileSync(join(handoffDir(repo), "active.lock"), `${process.pid}\n`);
    expect(runCancel(["--sid", SID], now, 0)).toBe(2);
  });
});

describe("runSwitch", () => {
  it("with nothing live exits 2", async () => {
    installFakes();
    expect(await runSwitch(["--latest"], NOW)).toBe(2);
  });

  it("never hands off on an argument it can't read", async () => {
    installFakes();
    const repo = tempRepo();
    seedSession(repo);
    for (const extra of ["--help", "-h", "--dry-run", "latest"]) {
      expect(await runSwitch(["--sid", SID, "--repo", repo, extra], NOW)).toBe(2);
    }
    expect(readStatus(SID)?.phase).not.toBe("handing-off");
  });

  it("under a live nowall run lock writes a manual signal without a cooldown", async () => {
    installFakes();
    const repo = tempRepo();
    seedSession(repo);
    // Another live process holds the lock (pid 1 is always alive on Unix).
    writeFileSync(join(handoffDir(repo), "active.lock"), "1\n");
    liveStatus(repo);

    expect(await runSwitch(["--sid", SID, "--repo", repo], NOW)).toBe(0);

    const signal = JSON.parse(readFileSync(signalPath(repo, SID), "utf8")) as LimitSignal;
    expect(signal.kind).toBe("manual");
    expect(signal.message).toBe("switched by you");
    expect(signal.agent).toBe("claude");
    expect(signal.to).toBeUndefined();

    expect(readStatus(SID)?.phase).toBe("handing-off");
    expect(readStatus(SID)?.detail).toContain("Switching");
  });

  it("switch --to prefers that account on the signal", async () => {
    installFakes();
    const repo = tempRepo();
    seedSession(repo);
    writeFileSync(join(handoffDir(repo), "active.lock"), "1\n");
    liveStatus(repo);

    expect(await runSwitch(["--sid", SID, "--repo", repo, "--to", "cursor"], NOW)).toBe(0);
    const signal = JSON.parse(readFileSync(signalPath(repo, SID), "utf8")) as LimitSignal;
    expect(signal.to).toBe("cursor");
  });

  it("refuses an unknown --to", async () => {
    installFakes();
    const repo = tempRepo();
    seedSession(repo);
    liveStatus(repo);
    expect(await runSwitch(["--sid", SID, "--repo", repo, "--to", "nope"], NOW)).toBe(2);
  });

  it("from a desktop-style session records the switch and starts a background takeover", async () => {
    installFakes();
    const repo = tempRepo();
    mkdirSync(handoffDir(repo), { recursive: true });
    liveStatus(repo, { origin: { kind: "claude-desktop" } });

    // launchTakeover spawns a detached child; with no dist/cli.js next to the loaded hooks
    // module it fails immediately. We only assert the session bookkeeping here.
    expect(await runSwitch(["--sid", SID, "--repo", repo], NOW)).toBe(0);
    const session = JSON.parse(readFileSync(join(handoffDir(repo), "session.json"), "utf8")) as {
      switch?: { from: string };
      sid: string;
    };
    expect(session.sid).toBe(SID);
    expect(session.switch?.from).toBe("claude");
    expect(readStatus(SID)?.phase).toBe("handing-off");
  });

  it("honours pause and per-repo off", async () => {
    installFakes();
    const repo = tempRepo();
    seedSession(repo);
    liveStatus(repo);
    saveConfig({
      ...DEFAULT_CONFIG,
      scope: "global",
      pausedUntil: new Date(NOW.getTime() + 3_600_000).toISOString(),
    });
    expect(await runSwitch(["--sid", SID, "--repo", repo], NOW)).toBe(2);

    saveConfig({ ...DEFAULT_CONFIG, scope: "global" });
    writeFileSync(join(handoffDir(repo), OFF_MARKER), "off\n");
    expect(await runSwitch(["--sid", SID, "--repo", repo], NOW)).toBe(2);
  });
});
