import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { hydrateInBackground, isEvicted } from "../src/fsafe.js";
import { handleHook, sessionOrigin } from "../src/hooks.js";
import { desktopSessionId, openSession } from "../src/open.js";
import { takeoverBlocked } from "../src/pause.js";
import { DEFAULT_CONFIG } from "../src/schemas.js";
import { readJournal } from "../src/session.js";
import { saveConfig } from "../src/state.js";
import { type SessionStatus, readStatus } from "../src/status.js";
import { parsePauseUntil, resolveTarget } from "../src/switch.js";
import { tempRepo } from "./helpers.js";

const NOW = new Date("2026-11-07T12:00:00.000Z");
const ID = "68e3b711-53b7-4538-a4cb-cc72cf4fb9c1";
const SID = `c_${ID}`;

beforeEach(() => {
  process.env.NOWALL_HOME = mkdtempSync(join(tmpdir(), "nowall-flow-"));
  saveConfig({ ...DEFAULT_CONFIG, scope: "global" });
});

const desktopEnv = { CLAUDE_CODE_ENTRYPOINT: "claude-desktop" };
const hook = (name: string, cwd: string, extra: object = {}, env: NodeJS.ProcessEnv = desktopEnv) =>
  handleHook(name, "claude", { session_id: ID, cwd, ...extra }, env, NOW);

function status(over: Partial<SessionStatus>): SessionStatus {
  return {
    v: 1,
    sid: SID,
    repo: "/work/app",
    repoName: "app",
    phase: "your-turn",
    agent: "claude",
    startedAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...over,
  };
}

describe("every session reaches the notch", () => {
  it("a chat outside any git repo still gets a status, and no journal or snapshot", () => {
    const dir = mkdtempSync(join(tmpdir(), "nowall-scratch-"));
    hook("session-start", dir);
    hook("prompt", dir, { prompt: "edit my reel" });
    const s = readStatus(SID);
    expect(s?.phase).toBe("working");
    expect(s?.noRepo).toBe(true);
    expect(existsSync(join(dir, ".handoff"))).toBe(false);
  });

  it("a limit outside a repo says why nothing takes over", () => {
    const dir = mkdtempSync(join(tmpdir(), "nowall-scratch-"));
    hook("stop-failure", dir);
    const s = readStatus(SID);
    expect(s?.phase).toBe("stopped");
    expect(s?.detail).toContain("Not a git repo");
  });

  it("two chats in one repo get one status each", () => {
    const repo = tempRepo();
    handleHook("prompt", "claude", { session_id: "aaaa", cwd: repo, prompt: "one" }, {}, NOW);
    handleHook("prompt", "claude", { session_id: "bbbb", cwd: repo, prompt: "two" }, {}, NOW);
    expect(readStatus("c_aaaa")?.detail).toBe("one");
    expect(readStatus("c_bbbb")?.detail).toBe("two");
  });

  it("status is written even when the journal can't be", () => {
    const repo = tempRepo();
    // .handoff/journal.jsonl as a directory: appending fails the way an I/O error would.
    mkdirSync(join(repo, ".handoff", "journal.jsonl"), { recursive: true });
    expect(() => hook("prompt", repo, { prompt: "keep going" })).not.toThrow();
    expect(readStatus(SID)?.phase).toBe("working");
  });

  it("a chat that closes after finishing keeps its check mark", () => {
    const repo = tempRepo();
    hook("prompt", repo, { prompt: "go" });
    hook("stop", repo);
    hook("session-end", repo);
    expect(readStatus(SID)?.phase).toBe("your-turn");
  });

  it("a chat that closes mid-work reads as closed", () => {
    const repo = tempRepo();
    hook("prompt", repo, { prompt: "go" });
    hook("session-end", repo);
    expect(readStatus(SID)?.phase).toBe("ended");
  });

  it("a paused nowall or a repo turned off doesn't take over", () => {
    const repo = tempRepo();
    saveConfig({
      ...DEFAULT_CONFIG,
      scope: "global",
      pausedUntil: new Date(NOW.getTime() + 3600_000).toISOString(),
    });
    expect(takeoverBlocked(repo, NOW)).toContain("paused");
    hook("stop-failure", repo);
    expect(readStatus(SID)?.phase).toBe("stopped");
  });
});

describe("where a session lives", () => {
  it("recognises the desktop app, a terminal and the Cursor IDE", () => {
    expect(sessionOrigin("claude", desktopEnv, () => undefined).kind).toBe("claude-desktop");
    expect(
      sessionOrigin("claude", { TERM_PROGRAM: "iTerm.app" }, () => "/dev/ttys004"),
    ).toMatchObject({ kind: "terminal", term: "iTerm.app", tty: "/dev/ttys004" });
    expect(sessionOrigin("cursor", {}, () => undefined).kind).toBe("cursor-ide");
  });

  it("the hook records it once, on first contact", () => {
    const repo = tempRepo();
    hook("prompt", repo, { prompt: "go" });
    expect(readStatus(SID)?.origin?.kind).toBe("claude-desktop");
  });
});

describe("nowall open", () => {
  function fakeApp(home: string, sessionId: string, cliId: string): void {
    const dir = join(home, "Library/Application Support/Claude/claude-code-sessions/a/b");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${sessionId}.json`),
      JSON.stringify({ sessionId, cliSessionId: cliId, title: "Reel" }),
    );
  }
  const LOCAL = "local_7144729a-9cab-42ad-9d48-cea9a5de30ad";
  const calls = () => {
    const seen: string[][] = [];
    const launch = (c: string, a: string[]) => {
      seen.push([c, ...a]);
      return true;
    };
    return { seen, launch };
  };

  it("finds the desktop chat id from the CLI session id", () => {
    const home = mkdtempSync(join(tmpdir(), "nowall-home-"));
    fakeApp(home, LOCAL, ID);
    expect(desktopSessionId(ID, home)).toBe(LOCAL);
    expect(desktopSessionId("00000000-0000-0000-0000-000000000000", home)).toBeNull();
    expect(desktopSessionId("../../etc/passwd", home)).toBeNull();
  });

  it("opens a desktop chat by deep link", () => {
    const home = mkdtempSync(join(tmpdir(), "nowall-home-"));
    fakeApp(home, LOCAL, ID);
    const { seen, launch } = calls();
    openSession(status({ origin: { kind: "claude-desktop" } }), launch, home);
    expect(seen).toEqual([["open", `claude://claude.ai/epitaxy/${LOCAL}`]]);
  });

  it("selects the exact Terminal tab, passing the tty as an argument", () => {
    const { seen, launch } = calls();
    const s = status({ origin: { kind: "terminal", term: "Apple_Terminal", tty: "/dev/ttys012" } });
    expect(openSession(s, launch, tmpdir())).toContain("Terminal tab");
    expect(seen[0]?.[0]).toBe("osascript");
    expect(seen[0]?.at(-1)).toBe("/dev/ttys012");
  });

  it("refuses a hostile tty or bundle id from a status file", () => {
    const { seen, launch } = calls();
    const s = status({
      origin: {
        kind: "terminal",
        term: "Apple_Terminal",
        tty: '"; do shell script "x',
        bundle: "a b;rm",
      },
    });
    openSession(s, launch, tmpdir());
    expect(seen.flat().join(" ")).not.toContain("do shell script");
    expect(seen.flat().join(" ")).not.toContain("a b;rm");
  });

  it("falls through when the preferred way fails", () => {
    const seen: string[][] = [];
    const launch = (c: string, a: string[]) => {
      seen.push([c, ...a]);
      return c === "open" && a[0] === "-b";
    };
    const s = status({ origin: { kind: "terminal", term: "Apple_Terminal", tty: "/dev/ttys1" } });
    expect(openSession(s, launch, tmpdir())).toBe("its terminal");
    expect(seen.at(-1)).toEqual(["open", "-b", "com.apple.Terminal"]);
  });

  it("a Cursor IDE chat opens its workspace", () => {
    const { seen, launch } = calls();
    openSession(status({ agent: "cursor", origin: { kind: "cursor-ide" } }), launch, tmpdir());
    expect(seen[0]).toEqual(["open", "-a", "Cursor", "/work/app"]);
  });

  it("a takeover opens its live log, with the path quoted", () => {
    const { seen, launch } = calls();
    const s = status({ repo: "/work/it's here", origin: { kind: "takeover" }, phase: "working" });
    expect(openSession(s, launch, tmpdir())).toContain("log");
    expect(seen[0]?.at(-1)).toContain("nowall logs -f");
    expect(seen[0]?.at(-1)).toContain("'/work/it'\\''s here'");
  });
});

describe("nowall switch and pause", () => {
  it("reads durations and rejects nonsense", () => {
    expect(parsePauseUntil("30m", NOW)?.getTime()).toBe(NOW.getTime() + 1800_000);
    expect(parsePauseUntil("2h", NOW)?.getTime()).toBe(NOW.getTime() + 7200_000);
    expect(parsePauseUntil(undefined, NOW)?.getTime()).toBe(NOW.getTime() + 86_400_000);
    expect(parsePauseUntil("soon", NOW)).toBeNull();
    expect(parsePauseUntil("0m", NOW)).toBeNull();
  });

  it("finds the newest live session and says so when there is none", () => {
    expect(resolveTarget({ latest: true }, NOW)).toContain("no live session");
    const repo = tempRepo();
    hook("prompt", repo, { prompt: "go" });
    const t = resolveTarget({ latest: true }, NOW);
    expect(typeof t === "string" ? t : t.sid).toBe(SID);
  });
});

describe("evicted files", () => {
  it("an ordinary file isn't evicted, and hydrating a missing path doesn't throw", () => {
    const p = join(mkdtempSync(join(tmpdir(), "nowall-ev-")), "x");
    writeFileSync(p, "hello");
    expect(isEvicted(p)).toBe(false);
    expect(isEvicted(`${p}-missing`)).toBe(false);
    expect(() => hydrateInBackground(`${p}-missing`)).not.toThrow();
  });

  it("journal lines still land normally", () => {
    const repo = tempRepo();
    hook("prompt", repo, { prompt: "remember me" });
    expect(readJournal(repo).map((l) => l.text)).toContain("remember me");
  });
});

describe("the notch app", () => {
  const app = "notch/build/NowallNotch.app/Contents/MacOS/NowallNotch";

  it.skipIf(process.platform !== "darwin")(
    "adding a Cursor account saves it, and a pasted key never shows on screen",
    () => {
      const home = mkdtempSync(join(tmpdir(), "nowall-addkey-"));
      const bin = mkdtempSync(join(tmpdir(), "nowall-addkey-bin-"));
      writeFileSync(
        join(bin, "cursor-agent"),
        `#!/bin/sh\ncase "$1" in --version) echo fake;; *) echo '{"loggedIn":true}';; esac\n`,
        { mode: 0o755 },
      );
      const key = "fake-key-for-a-test";
      const typescript = join(home, "typescript");
      // `script` gives the CLI a real terminal: that's where the prompt used to crash. The paste
      // waits for the prompt, since a terminal echoes anything typed before the prompt starts.
      const paste = `until grep -q "Paste the API key" "$T" 2>/dev/null; do sleep 0.1; done; sleep 0.5; printf '%s\\n' "$KEY"; sleep 1`;
      const r = spawnSync(
        "sh",
        [
          "-c",
          `(${paste}) | script -qF "$T" "$NODE" dist/cli.js account add cursor team --api-key`,
        ],
        {
          encoding: "utf8",
          timeout: 25_000,
          env: {
            ...process.env,
            NOWALL_HOME: home,
            NOWALL_SECRET_STORE: "file",
            PATH: `${bin}:${process.env.PATH ?? ""}`,
            T: typescript,
            KEY: key,
            NODE: process.execPath,
          },
        },
      );
      const out = r.stdout;
      expect(out).toContain("Added Cursor (team)");
      expect(out).not.toContain(key);
      expect(readFileSync(join(home, "config.json"), "utf8")).toContain("cursor:team");
      expect(readFileSync(join(home, "secrets", "cursor_team"), "utf8")).toBe(key);
    },
    30_000,
  );

  it.skipIf(process.platform !== "darwin" || !existsSync(app))("bubble rules hold", () => {
    expect(spawnSync(app, ["--selftest"], { encoding: "utf8" }).status).toBe(0);
  });

  it.skipIf(process.platform !== "darwin" || !existsSync(app))(
    "double-clicks open the card from anywhere on it, circles and bubbles included",
    () => {
      const home = mkdtempSync(join(tmpdir(), "nowall-clicks-"));
      mkdirSync(join(home, "status"));
      const at = new Date().toISOString();
      writeFileSync(
        join(home, "status", "c_1.json"),
        JSON.stringify({
          v: 1,
          sid: "c_1",
          repo: "/w/api",
          repoName: "api",
          phase: "working",
          agent: "claude",
          startedAt: at,
          updatedAt: at,
        }),
      );
      writeFileSync(
        join(home, "status", "c_2.json"),
        JSON.stringify({
          v: 1,
          sid: "c_2",
          repo: "/w/web",
          repoName: "web",
          phase: "working",
          agent: "cursor",
          origin: { kind: "takeover" },
          startedAt: at,
          updatedAt: at,
        }),
      );
      const agent = (id: string, name: string) => ({
        id,
        name,
        installed: true,
        signedIn: true,
        enabled: true,
        loginHint: "x",
        installHint: "x",
      });
      writeFileSync(
        join(home, "agents.json"),
        JSON.stringify({
          v: 1,
          updatedAt: at,
          agents: [agent("claude", "Claude Code"), agent("cursor", "Cursor")],
        }),
      );
      const r = spawnSync(app, ["--click-test", "--home", home], {
        encoding: "utf8",
        timeout: 25_000,
      });
      expect(r.stderr).not.toContain("failed");
      expect(r.status).toBe(0);
    },
    30_000,
  );

  it.skipIf(process.platform !== "darwin" || !existsSync(app))(
    "Terminal buttons find nowall in a clean shell, where nvm isn't loaded",
    () => {
      const home = mkdtempSync(join(tmpdir(), "nowall-term-"));
      const made = spawnSync(
        app,
        [
          "--terminal-script",
          "nowall --version",
          "--node",
          process.execPath,
          "--cli",
          join(process.cwd(), "dist/cli.js"),
          "--home",
          home,
        ],
        { encoding: "utf8" },
      );
      const script = join(home, "t.command");
      writeFileSync(script, made.stdout);
      const r = spawnSync("/bin/zsh", [script], {
        encoding: "utf8",
        env: { HOME: home, TERM: "xterm", PATH: "/usr/bin:/bin" },
        input: "",
      });
      expect(r.stdout).toContain(JSON.parse(readFileSync("package.json", "utf8")).version);
      expect(r.stderr).not.toContain("command not found");
      expect(r.status).toBe(0);
      expect(existsSync(script)).toBe(false);
    },
  );

  it("asking how a command works never runs it", () => {
    const home = mkdtempSync(join(tmpdir(), "nowall-help-"));
    const env = { ...process.env, NOWALL_HOME: home };
    for (const args of [
      ["switch", "--latest", "--help"],
      ["cancel", "--help"],
      ["open", "--help"],
      ["pause", "-h"],
      ["resume", "--help"],
      ["off", "--help"],
      ["on", "--help"],
    ]) {
      const r = spawnSync("node", ["dist/cli.js", ...args], { encoding: "utf8", env });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(`usage: nowall ${args[0]}`);
    }
    expect(existsSync(join(home, "config.json"))).toBe(false);
  });

  it("the CLI knows every command the notch calls", () => {
    const help = readFileSync("src/cli.ts", "utf8");
    for (const c of ["switch", "open"]) expect(help).toContain(`case "${c}":`);
    expect(readFileSync("notch/NowallNotch.swift", "utf8")).toContain('"switch", "--sid"');
  });
});
