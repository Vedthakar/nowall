import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { shq } from "./fsafe.js";
import { spawnSync } from "./proc.js";
import { type SessionStatus, readStatus } from "./status.js";

/**
 * `nowall open --sid <sid>`: takes you to where a session lives. The notch calls this when you click
 * a bubble. A Claude desktop chat opens by deep link, a terminal session brings its own tab forward
 * (Terminal.app and iTerm2) or its app (everything else), and a Cursor IDE chat opens its workspace.
 * A background takeover has no chat, so it opens its live log.
 */

export type Launch = (cmd: string, args: string[]) => boolean;

const defaultLaunch: Launch = (cmd, args) =>
  spawnSync(cmd, args, { stdio: "ignore", timeout: 8000 }).status === 0;

const DESKTOP_ID_RE = /^local_[0-9a-f-]{36}$/;
const CLI_ID_RE = /^[0-9a-f-]{36}$/;
const BUNDLE_RE = /^[A-Za-z0-9.-]+$/;
const TTY_RE = /^\/dev\/ttys?\d+$/;

const TERMINAL_TAB = `on run argv
  tell application "Terminal"
    repeat with w in windows
      repeat with t in tabs of w
        if tty of t is item 1 of argv then
          set selected tab of w to t
          set index of w to 1
          activate
          return
        end if
      end repeat
    end repeat
  end tell
  error "not found"
end run`;

const ITERM_TAB = `on run argv
  tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if tty of s is item 1 of argv then
            select w
            select t
            select s
            activate
            return
          end if
        end repeat
      end repeat
    end repeat
  end tell
  error "not found"
end run`;

const TERMINAL_APPS: Record<string, string> = {
  Apple_Terminal: "com.apple.Terminal",
  "iTerm.app": "com.googlecode.iterm2",
  vscode: "com.microsoft.VSCode",
  WarpTerminal: "dev.warp.Warp-Stable",
  ghostty: "com.mitchellh.ghostty",
  WezTerm: "com.github.wez.wezterm",
  Hyper: "co.zeit.hyper",
};

function sessionsRoot(home: string): string {
  return join(home, "Library", "Application Support", "Claude", "claude-code-sessions");
}

/**
 * The desktop app's id for a Claude session. Its metadata files are large, so each one is searched
 * as text, newest first, and only the match is parsed. An archived chat isn't a place to go.
 */
export function desktopSessionId(cliId: string, home = homedir()): string | null {
  if (!CLI_ID_RE.test(cliId)) return null;
  const files: { path: string; mtime: number }[] = [];
  const walk = (dir: string, depth: number) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(dir, name);
      if (depth < 2) walk(path, depth + 1);
      else if (name.startsWith("local_") && name.endsWith(".json")) {
        try {
          files.push({ path, mtime: statSync(path).mtimeMs });
        } catch {
          // gone already
        }
      }
    }
  };
  walk(sessionsRoot(home), 0);
  files.sort((a, b) => b.mtime - a.mtime);
  for (const f of files) {
    try {
      const raw = readFileSync(f.path, "utf8");
      if (!raw.includes(cliId)) continue;
      const meta = JSON.parse(raw) as { sessionId?: unknown; cliSessionId?: unknown };
      if (meta.cliSessionId === cliId && typeof meta.sessionId === "string") {
        return DESKTOP_ID_RE.test(meta.sessionId) ? meta.sessionId : null;
      }
    } catch {
      // being rewritten; the next one may still match
    }
  }
  return null;
}

/** Opens one session's chat. Returns what was opened, or null if nothing could be. */
export function openSession(
  s: SessionStatus,
  launch: Launch = defaultLaunch,
  home = homedir(),
): string | null {
  const origin = s.origin;
  // The sid of a chat nowall didn't launch is c_<the agent's session id>.
  const cliId = s.sid.startsWith("c_") ? s.sid.slice(2) : "";

  if (origin?.kind === "takeover" || s.phase === "handing-off") {
    const script = `cd ${shq(s.repo)} && nowall logs -f`;
    const told = launch("osascript", [
      "-e",
      'on run argv\ntell application "Terminal"\ndo script (item 1 of argv)\nactivate\nend tell\nend run',
      script,
    ]);
    if (told) return "the takeover's live log";
  }

  if (s.agent === "claude" && origin?.kind !== "terminal") {
    const id = cliId ? desktopSessionId(cliId, home) : null;
    if (id && launch("open", [`claude://claude.ai/epitaxy/${id}`]))
      return "the Claude desktop chat";
  }

  if (origin?.kind === "terminal") {
    const tty = origin.tty && TTY_RE.test(origin.tty) ? origin.tty : null;
    if (tty && origin.term === "Apple_Terminal") {
      if (launch("osascript", ["-e", TERMINAL_TAB, tty])) return "its Terminal tab";
    }
    if (tty && origin.term === "iTerm.app") {
      if (launch("osascript", ["-e", ITERM_TAB, tty])) return "its iTerm2 tab";
    }
    const bundle =
      origin.bundle && BUNDLE_RE.test(origin.bundle)
        ? origin.bundle
        : origin.term
          ? TERMINAL_APPS[origin.term]
          : undefined;
    if (bundle && launch("open", ["-b", bundle])) return "its terminal";
  }

  if (s.agent === "cursor" && origin?.kind !== "terminal") {
    if (launch("open", ["-a", "Cursor", s.repo])) return "the Cursor window";
  }

  if (origin?.kind === "claude-desktop" && origin.bundle && BUNDLE_RE.test(origin.bundle)) {
    if (launch("open", ["-b", origin.bundle])) return "the Claude app";
  }
  return launch("open", ["-a", "Terminal", s.repo]) ? "a Terminal in its folder" : null;
}

export function runOpen(argv: string[], launch: Launch = defaultLaunch, home = homedir()): number {
  const i = argv.indexOf("--sid");
  const sid = i >= 0 ? argv[i + 1] : undefined;
  if (!sid) {
    process.stderr.write("usage: nowall open --sid <sid>\n");
    return 2;
  }
  const s = readStatus(sid);
  if (!s) {
    process.stderr.write(`nowall open: no session ${sid}\n`);
    return 2;
  }
  if (process.platform === "win32") {
    process.stdout.write(
      `Opening a chat isn't available on Windows yet. It's in ${s.repo}; run \`nowall logs -f\` there for a takeover's live log.\n`,
    );
    return 0;
  }
  const what = openSession(s, launch, home);
  if (!what) {
    process.stderr.write(`nowall open: couldn't open ${s.repoName}\n`);
    return 1;
  }
  process.stdout.write(`Opened ${what}.\n`);
  return 0;
}
