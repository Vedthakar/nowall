import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addAccount } from "../src/accounts.js";
import { ADAPTERS } from "../src/adapters/index.js";
import { checkpoint } from "../src/git.js";
import { installAlias, removeRepoHooks, runUninstall } from "../src/init.js";
import { notchLabel } from "../src/setup.js";
import { trustRepo } from "../src/state.js";
import { updateStatus } from "../src/status.js";
import {
  REINSTALL_LINE,
  nowallRefs,
  restoreStatusLine,
  runUninstallGlobal,
  shellWords,
  stripNowallHooks,
  wrappedStatusCommand,
} from "../src/uninstall.js";
import { sh, tempRepo } from "./helpers.js";

// Everything runs in a throwaway HOME + NOWALL_HOME. NOWALL_NO_LAUNCHD=1 (vitest.config) and
// NOWALL_SECRET_STORE=file keep launchctl, pkill and the real Keychain out of it; fake binaries
// on PATH record any call that slips through.

const USER_STOP = { hooks: [{ type: "command", command: "say done" }] };
const USER_CURSOR = { command: "echo cursor-user-hook" };
const USER_STATUS = "/Users/me/bin/status.sh --flag 'x'";

interface Sandbox {
  scratch: string;
  home: string;
  data: string;
  bin: string;
  log: string;
  repos: string[];
  out: string[];
  run: (argv: string[], ask?: (q: string) => Promise<string>) => Promise<number>;
  calls: () => string[];
}

let saved: NodeJS.ProcessEnv;

beforeEach(() => {
  saved = { ...process.env };
});

afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

/** Shell quoting like src/fsafe shq, so the chained status line matches what setup writes. */
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

function fakeBin(dir: string, name: string, body: string): void {
  writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(dir, name), 0o755);
}

function plant(
  opts: { chained?: boolean; keychainAccount?: boolean; npmInstalled?: boolean } = {},
): Sandbox {
  const scratch = mkdtempSync(join(tmpdir(), "nowall-un-"));
  const home = join(scratch, "home");
  const data = join(home, ".config", "nowall");
  const bin = join(scratch, "bin");
  const log = join(scratch, "calls.log");
  for (const d of [home, data, bin, join(home, "Library", "LaunchAgents")]) {
    mkdirSync(d, { recursive: true });
  }
  process.env.HOME = home;
  process.env.NOWALL_HOME = data;
  process.env.NOWALL_SECRET_STORE = "file";
  process.env.SHELL = "/bin/zsh";
  process.env.FAKE_LOG = log;
  process.env.FAKE_NPM_INSTALLED = opts.npmInstalled ? "1" : "";
  process.env.PATH = `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`;

  // Anything we must never touch from a sandbox records itself instead.
  for (const name of ["launchctl", "pkill", "pgrep"]) {
    fakeBin(bin, name, `echo "${name} $*" >> "$FAKE_LOG"; exit 1`);
  }
  fakeBin(
    bin,
    "security",
    [
      'echo "security $*" >> "$FAKE_LOG"',
      'deleted="$FAKE_LOG.deleted"; touch "$deleted"',
      'case "$1" in',
      "  delete-generic-password)",
      '    acct=""; while [ $# -gt 0 ]; do [ "$1" = "-a" ] && acct="$2"; shift; done',
      '    echo "$acct" >> "$deleted"; exit 0;;',
      "  find-generic-password)",
      "    for a in cursor:team cursor:old; do",
      '      grep -qx "$a" "$deleted" || { printf \'attributes:\\n    "acct"<blob>="%s"\\n    "svce"<blob>="nowall"\\n\' "$a"; exit 0; }',
      "    done",
      '    echo "could not be found" >&2; exit 44;;',
      "esac",
    ].join("\n"),
  );
  fakeBin(
    bin,
    "npm",
    [
      'echo "npm $*" >> "$FAKE_LOG"',
      'if [ "$1" = "ls" ]; then',
      '  if [ -n "$FAKE_NPM_INSTALLED" ]; then echo \'{"dependencies":{"nowall":{"version":"0.1.0"}}}\'; else echo \'{}\'; fi',
      "fi",
      "exit 0",
    ].join("\n"),
  );

  // User-level hook files: the user's own entries first, then ours on top (exactly like setup).
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(home, ".codex"), { recursive: true });
  mkdirSync(join(home, ".cursor"), { recursive: true });
  writeFileSync(
    join(home, ".claude", "settings.json"),
    JSON.stringify({
      model: "opus",
      permissions: { allow: ["Bash(ls)"] },
      hooks: { Stop: [USER_STOP] },
    }),
  );
  writeFileSync(
    join(home, ".codex", "hooks.json"),
    JSON.stringify({
      hooks: { PostToolUse: [{ hooks: [{ type: "command", command: "echo codex-user" }] }] },
    }),
  );
  writeFileSync(
    join(home, ".cursor", "hooks.json"),
    JSON.stringify({ version: 1, hooks: { afterFileEdit: [USER_CURSOR] } }),
  );
  for (const id of ["claude", "codex", "cursor"] as const) {
    ADAPTERS[id].installUserHooks?.(home, "nowall");
  }
  if (opts.chained) {
    const p = join(home, ".claude", "settings.json");
    const doc = JSON.parse(readFileSync(p, "utf8"));
    doc.statusLine = {
      type: "command",
      command: `NOWALL_HOOK=1 nowall statusline --then ${shq(USER_STATUS)}`,
      padding: 2,
    };
    writeFileSync(p, JSON.stringify(doc, null, 2));
  }
  // A CLAUDE.md block (defensive: nothing writes it today) and the shell alias.
  writeFileSync(
    join(home, ".claude", "CLAUDE.md"),
    "# mine\n<!-- nowall:start -->\nlog tasks with nowall note\n<!-- nowall:end -->\nkeep me\n",
  );
  writeFileSync(join(home, ".zshrc"), "export EDITOR=vim\n");
  installAlias(join(home, ".zshrc"));

  // LaunchAgents: ours (this home's label) and one for a different home that must survive.
  const plist = (label: string, dataHome: string) =>
    `<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>/x/NowallNotch</string><string>--home</string><string>${dataHome}</string></array></dict></plist>\n`;
  writeFileSync(
    join(home, "Library", "LaunchAgents", `${notchLabel()}.plist`),
    plist(notchLabel(), data),
  );
  writeFileSync(
    join(home, "Library", "LaunchAgents", "dev.nowall.notch.plist"),
    plist("dev.nowall.notch", "/Users/someone-else/.config/nowall"),
  );

  // Data: config, accounts (profile + file-store secret), status files.
  writeFileSync(
    join(data, "config.json"),
    JSON.stringify({ v: 1, order: ["claude", "cursor"], scope: "global" }),
  );
  addAccount("claude", "work");
  addAccount("cursor", "team", { apiKey: "fake-low-entropy-key" });
  if (opts.keychainAccount) {
    const c = JSON.parse(readFileSync(join(data, "config.json"), "utf8"));
    for (const a of c.accounts)
      if (a.id === "cursor:team") a.secret = { env: "CURSOR_API_KEY", store: "keychain" };
    writeFileSync(join(data, "config.json"), JSON.stringify(c));
  }

  // Two repos with nowall data: one trusted (nowall init), one only seen through a status file.
  const repos = [tempRepo(), tempRepo()];
  for (const [i, root] of repos.entries()) {
    mkdirSync(join(root, ".handoff"));
    writeFileSync(join(root, ".handoff", "journal.jsonl"), "{}\n");
    mkdirSync(join(root, ".git", "info"), { recursive: true });
    writeFileSync(
      join(root, ".git", "info", "exclude"),
      "# mine\n*.log\n.handoff/\n.claude/settings.local.json\n",
    );
    checkpoint(root, `s_${i}`, 0, "snap");
    ADAPTERS.claude.installHooks?.(root, "nowall");
    if (i === 0) trustRepo(root);
    else updateStatus(`s_${i}`, root, { agent: "claude", phase: "working", repoName: "r" });
  }

  const out: string[] = [];
  const run = (argv: string[], ask: (q: string) => Promise<string> = async () => "") =>
    runUninstallGlobal(argv, { out: (s) => out.push(s), err: (s) => out.push(s), ask });
  const calls = () =>
    existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : [];
  return { scratch, home, data, bin, log, repos, out, run, calls };
}

const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));

/** Hash of every file under `dirs` (path, mode, content): proves a dry run changed nothing. */
function fingerprint(dirs: string[]): string {
  const h = createHash("sha1");
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      if (name === "calls.log") continue; // the fake tools' own log, not nowall's doing
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else h.update(`${p}\n${st.mode}\n`).update(readFileSync(p));
    }
  };
  for (const d of dirs) walk(d);
  return h.digest("hex");
}

describe("uninstall --global: hooks and dotfiles", () => {
  it("removes every nowall hook and the status-line tap, keeping the user's entries as they were", async () => {
    const s = plant();
    const before = read(join(s.home, ".claude", "settings.json"));
    expect(before.statusLine.command).toContain("statusline");
    expect(before.hooks.Stop).toHaveLength(2);

    expect(await s.run([])).toBe(0);

    const claude = read(join(s.home, ".claude", "settings.json"));
    expect(claude.model).toBe("opus");
    expect(claude.permissions).toEqual({ allow: ["Bash(ls)"] });
    expect(claude.hooks).toEqual({ Stop: [USER_STOP] });
    expect(claude.statusLine).toBeUndefined();
    expect(readFileSync(join(s.home, ".claude", "settings.json"), "utf8")).not.toMatch(
      /nowall|NOWALL/,
    );

    const codex = read(join(s.home, ".codex", "hooks.json"));
    expect(JSON.stringify(codex)).not.toContain("NOWALL_HOOK");
    expect(codex.hooks.PostToolUse).toEqual([
      { hooks: [{ type: "command", command: "echo codex-user" }] },
    ]);

    const cursor = read(join(s.home, ".cursor", "hooks.json"));
    expect(cursor).toEqual({ version: 1, hooks: { afterFileEdit: [USER_CURSOR] } });

    expect(readFileSync(join(s.home, ".zshrc"), "utf8")).toBe("export EDITOR=vim\n");
    expect(readFileSync(join(s.home, ".claude", "CLAUDE.md"), "utf8")).toBe("# mine\nkeep me\n");
    expect(s.calls()).toEqual(["npm ls -g nowall --depth=0 --json"]); // no launchctl, pkill, security
  });

  it("restores a chained status line to the user's original command", async () => {
    const s = plant({ chained: true });
    expect(await s.run([])).toBe(0);
    const claude = read(join(s.home, ".claude", "settings.json"));
    expect(claude.statusLine).toEqual({ type: "command", command: USER_STATUS, padding: 2 });
  });

  it("leaves a hooks file without any nowall entry byte for byte, even if oddly formatted", async () => {
    const s = plant();
    const odd = '{\n\t"hooks" :   {"Stop":[{"hooks":[{"type":"command","command":"say hi"}]}]}  }';
    writeFileSync(join(s.home, ".codex", "hooks.json"), odd);
    expect(await s.run([])).toBe(0);
    expect(readFileSync(join(s.home, ".codex", "hooks.json"), "utf8")).toBe(odd);
  });

  it("never rewrites a hooks file it cannot parse", async () => {
    const s = plant();
    const broken = '{"hooks": NOWALL_HOOK=1 nowall hook stop';
    writeFileSync(join(s.home, ".cursor", "hooks.json"), broken);
    expect(await s.run([])).toBe(0);
    expect(readFileSync(join(s.home, ".cursor", "hooks.json"), "utf8")).toBe(broken);
    expect(s.out.join("")).toContain("not valid JSON");
  });

  it("drops a file we cannot handle from the report as LEFT so the user sees it", async () => {
    const s = plant();
    writeFileSync(join(s.home, ".cursor", "hooks.json"), '{"hooks": NOWALL_HOOK=1');
    await s.run([]);
    expect(s.out.join("")).toMatch(/LEFT ~\/\.cursor\/hooks\.json: still mentions nowall/);
  });
});

describe("uninstall --global: notch", () => {
  it("deletes only this home's LaunchAgent and never calls launchctl or pkill in a sandbox", async () => {
    const s = plant();
    const agents = join(s.home, "Library", "LaunchAgents");
    expect(await s.run([])).toBe(0);
    expect(existsSync(join(agents, `${notchLabel()}.plist`))).toBe(false);
    expect(existsSync(join(agents, "dev.nowall.notch.plist"))).toBe(true);
    expect(s.calls().some((c) => /^(launchctl|pkill|pgrep)/.test(c))).toBe(false);
    expect(notchLabel()).not.toBe("dev.nowall.notch");
  });
});

describe("uninstall --global: data", () => {
  it("keeps ~/.config/nowall by default and says how to purge; sets scope back to repo", async () => {
    const s = plant();
    expect(await s.run([])).toBe(0);
    expect(existsSync(join(s.data, "profiles", "claude-work"))).toBe(true);
    expect(existsSync(join(s.data, "secrets", "cursor_team"))).toBe(true);
    expect(read(join(s.data, "config.json")).scope).toBe("repo");
    expect(read(join(s.data, "config.json")).accounts).toHaveLength(2);
    const text = s.out.join("");
    expect(text).toContain("Kept ~/.config/nowall");
    expect(text).toContain("nowall uninstall --global --purge");
    expect(text).toMatch(/kept ~\/\.config\/nowall: .*1 profile, 1 secret file/);
  });

  it("--yes alone keeps data (safe default); --keep-data keeps it without asking", async () => {
    const s = plant();
    let asked = 0;
    expect(
      await s.run(["--yes"], async () => {
        asked++;
        return "y";
      }),
    ).toBe(0);
    expect(asked).toBe(0);
    expect(existsSync(s.data)).toBe(true);
    expect(
      await s.run(["--keep-data"], async () => {
        asked++;
        return "y";
      }),
    ).toBe(0);
    expect(asked).toBe(0);
    expect(existsSync(join(s.data, "profiles", "claude-work"))).toBe(true);
  });

  it("--purge asks, listing what goes; a non-answer keeps everything", async () => {
    const s = plant();
    const questions: string[] = [];
    expect(
      await s.run(["--purge"], async (q) => {
        questions.push(q);
        return "";
      }),
    ).toBe(0);
    expect(questions).toHaveLength(1);
    expect(questions[0]).toContain("1 profile with their logins (claude-work)");
    expect(questions[0]).toContain("1 secret file");
    expect(existsSync(s.data)).toBe(true);
    expect(s.out.join("")).toContain("--purge --yes");
  });

  it("--purge answered y, or --purge --yes, removes the config folder entirely", async () => {
    const s = plant();
    expect(await s.run(["--purge"], async () => "y")).toBe(0);
    expect(existsSync(s.data)).toBe(false);
    expect(s.out.join("")).toContain("ok   ~/.config/nowall: removed");

    const t = plant();
    expect(await t.run(["--purge", "--yes"])).toBe(0);
    expect(existsSync(t.data)).toBe(false);
    // The dotfiles and repos are untouched beyond our own entries.
    expect(read(join(t.home, ".claude", "settings.json")).model).toBe("opus");
    expect(existsSync(join(t.repos[0] as string, ".handoff"))).toBe(true);
  });

  it("--purge with --keep-data is refused", async () => {
    const s = plant();
    expect(await s.run(["--purge", "--keep-data"])).toBe(2);
    expect(existsSync(join(s.home, "Library", "LaunchAgents", `${notchLabel()}.plist`))).toBe(true);
  });

  it.runIf(process.platform === "darwin")(
    "--purge deletes each account's Keychain item by id and sweeps leftovers (fake security)",
    async () => {
      const s = plant({ keychainAccount: true });
      Reflect.deleteProperty(process.env, "NOWALL_SECRET_STORE"); // keychain mode; `security` is the fake on PATH
      expect(await s.run(["--purge", "--yes"])).toBe(0);
      const sec = s.calls().filter((c) => c.startsWith("security"));
      expect(sec).toContain("security delete-generic-password -s nowall -a cursor:team");
      expect(sec).toContain("security delete-generic-password -s nowall -a cursor:old");
      expect(sec.some((c) => /delete-generic-password -s nowall$/.test(c))).toBe(false); // never wholesale
      expect(s.out.join("")).toContain("Keychain (service nowall): empty");
    },
  );

  it("without a Keychain in play, the report says it was not checked and nothing calls security", async () => {
    const s = plant();
    expect(await s.run(["--purge", "--yes"])).toBe(0);
    expect(s.calls().some((c) => c.startsWith("security"))).toBe(false);
    expect(s.out.join("")).toContain("Keychain: not checked (NOWALL_SECRET_STORE=file)");
  });
});

describe("uninstall --global: repos", () => {
  it("lists repos with nowall data and keeps them by default", async () => {
    const s = plant();
    expect(await s.run([])).toBe(0);
    const text = s.out.join("");
    for (const r of s.repos) {
      expect(text).toContain(r);
      expect(existsSync(join(r, ".handoff", "journal.jsonl"))).toBe(true);
      expect(nowallRefs(r)).toHaveLength(1);
    }
    expect(text).toContain("nowall uninstall --global --repos");
  });

  it("--repos removes .handoff/, refs/nowall/*, our excludes and per-repo hooks, nothing else", async () => {
    const s = plant();
    expect(await s.run(["--repos"])).toBe(0);
    for (const r of s.repos) {
      expect(existsSync(join(r, ".handoff"))).toBe(false);
      expect(nowallRefs(r)).toEqual([]);
      expect(readFileSync(join(r, ".git", "info", "exclude"), "utf8")).toBe("# mine\n*.log\n");
      expect(readFileSync(join(r, "README.md"), "utf8")).toBe("# demo\n");
      expect(sh(r, "git", ["status", "--porcelain"])).toBe("");
      expect(existsSync(join(r, ".claude"))).toBe(false); // it held only our hooks
    }
  });
});

describe("uninstall --global: repos with the user's own settings", () => {
  it("keeps the user's keys in settings.local.json and keeps that file hidden from git", async () => {
    const s = plant();
    const r = s.repos[0] as string;
    const file = join(r, ".claude", "settings.local.json");
    writeFileSync(file, JSON.stringify({ ...read(file), permissions: { allow: ["Bash(ls)"] } }));
    expect(await s.run(["--repos"])).toBe(0);
    expect(read(file).permissions).toEqual({ allow: ["Bash(ls)"] });
    expect(readFileSync(file, "utf8")).not.toContain("nowall");
    expect(sh(r, "git", ["status", "--porcelain"])).toBe("");
  });
});

describe("uninstall --global: npm", () => {
  it("prints the npm uninstall command when installed via npm and --npm is not given", async () => {
    const s = plant({ npmInstalled: true });
    expect(await s.run([])).toBe(0);
    expect(s.out.join("")).toContain("Last step: npm uninstall -g nowall");
    expect(s.calls().filter((c) => c.startsWith("npm"))).toEqual([
      "npm ls -g nowall --depth=0 --json",
    ]);
  });

  it("--npm schedules `npm uninstall -g nowall` through the fake npm on PATH", async () => {
    const s = plant({ npmInstalled: true });
    expect(await s.run(["--npm"])).toBe(0);
    expect(s.out.join("")).toContain("npm uninstall -g nowall runs as soon as this command exits");
    const end = Date.now() + 8000;
    while (Date.now() < end && !s.calls().includes("npm uninstall -g nowall")) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(s.calls()).toContain("npm uninstall -g nowall");
  });

  it("says so when nowall is not an npm global package", async () => {
    const s = plant();
    expect(await s.run(["--npm"])).toBe(0);
    expect(s.out.join("")).toContain("npm package: not installed globally");
    expect(s.calls()).not.toContain("npm uninstall -g nowall");
  });
});

describe("uninstall --global: dry run, idempotency, report", () => {
  it("--dry-run prints every action and changes nothing", async () => {
    const s = plant({ chained: true, npmInstalled: true });
    const before = fingerprint([s.home, ...s.repos]);
    expect(await s.run(["--dry-run", "--purge", "--yes", "--repos", "--npm"])).toBe(0);
    expect(fingerprint([s.home, ...s.repos])).toBe(before);
    const text = s.out.join("");
    expect(text).toContain("Dry run");
    expect(text).toMatch(/would: remove nowall hooks from ~\/\.claude\/settings\.json/);
    expect(text).toMatch(/would: remove the nowall alias block/);
    expect(text).toMatch(/would: unload and delete ~\/Library\/LaunchAgents\//);
    expect(text).toMatch(/would: remove .*\/\.handoff\//);
    expect(text).toMatch(/would: delete 1 checkpoint ref/);
    expect(text).toMatch(
      /would: remove ~\/\.config\/nowall \(config, state, 1 profile, 1 secret file\)/,
    );
    expect(text).toMatch(/would: run npm uninstall -g nowall/);
    expect(s.calls()).toEqual(["npm ls -g nowall --depth=0 --json"]);
  });

  it("running twice is fine and the second run has nothing left to do", async () => {
    const s = plant();
    expect(await s.run(["--repos", "--purge", "--yes"])).toBe(0);
    const after = fingerprint([s.scratch]);
    s.out.length = 0;
    expect(await s.run(["--repos", "--purge", "--yes"])).toBe(0);
    expect(fingerprint([s.scratch])).toBe(after);
    expect(s.out.join("")).not.toContain("remove nowall hooks");
    expect(existsSync(s.data)).toBe(false); // purge did not recreate the folder
  });

  it("ends with a verification report and the reinstall line", async () => {
    const s = plant();
    await s.run(["--purge", "--yes"]);
    const text = s.out.join("");
    expect(text).toContain("ok   ~/.claude/settings.json: no nowall hooks");
    expect(text).toContain("ok   ~/.codex/hooks.json: no nowall hooks");
    expect(text).toContain("ok   ~/.cursor/hooks.json: no nowall hooks");
    expect(text).toContain("ok   shell alias block: none");
    expect(text).toContain("ok   LaunchAgent plist: none");
    expect(text).toContain(`launchd ${notchLabel()}: not checked (NOWALL_NO_LAUNCHD)`);
    expect(text).toContain("ok   ~/.config/nowall: removed");
    expect(text).toContain("ok   npm package: not installed globally");
    expect(text).toContain(`Reinstall any time with: ${REINSTALL_LINE}`);
    expect(text).not.toContain("fake-low-entropy-key");
  });
});

describe("status-line and shell parsing helpers", () => {
  it("splits shell words like sh, including shq quoting", () => {
    expect(shellWords(`a 'b c' "d \\"e\\"" f\\ g`)).toEqual(["a", "b c", 'd "e"', "f g"]);
    expect(shellWords(`--then ${shq(USER_STATUS)}`)).toEqual(["--then", USER_STATUS]);
    expect(wrappedStatusCommand(`NOWALL_HOOK=1 nowall statusline --then ${shq(USER_STATUS)}`)).toBe(
      USER_STATUS,
    );
    expect(wrappedStatusCommand("NOWALL_HOOK=1 nowall statusline --then ~/bin/st --fancy")).toBe(
      "~/bin/st --fancy",
    );
    expect(wrappedStatusCommand("NOWALL_HOOK=1 nowall statusline")).toBeNull();
    expect(wrappedStatusCommand("NOWALL_HOOK=1 nowall statusline --then")).toBeNull();
  });

  it("restores or drops a status line, and ignores the user's own", () => {
    const mine = { type: "command", command: "~/bin/st" };
    expect(restoreStatusLine(mine)).toBe(mine);
    expect(
      restoreStatusLine({ type: "command", command: "NOWALL_HOOK=1 nowall statusline" }),
    ).toBeUndefined();
    expect(
      restoreStatusLine({ type: "command", command: "/usr/local/bin/nowall statusline" }),
    ).toBeUndefined();
    expect(
      restoreStatusLine({
        type: "command",
        command: `NOWALL_HOOK=1 nowall statusline --then ${shq("~/bin/st")}`,
      }),
    ).toEqual({ type: "command", command: "~/bin/st" });
  });

  it("stripNowallHooks keeps unknown keys and non-array hook values untouched", () => {
    const doc = {
      model: "opus",
      hooks: {
        Stop: [
          USER_STOP,
          { hooks: [{ type: "command", command: "NOWALL_HOOK=1 nowall hook stop" }] },
        ],
        SubagentStart: [
          { hooks: [{ type: "command", command: "NOWALL_HOOK=1 nowall hook subagent-start" }] },
        ],
        weird: "not-a-list",
      },
    };
    expect(stripNowallHooks(doc)).toEqual({
      model: "opus",
      hooks: { Stop: [USER_STOP], weird: "not-a-list" },
    });
    expect(
      stripNowallHooks({ hooks: { Stop: [{ hooks: [{ command: "nowall hook stop" }] }] }, a: 1 }),
    ).toEqual({
      a: 1,
    });
  });
});

describe("per-repo uninstall", () => {
  it("removes .handoff/off and every nowall hook in the Cursor file, including subagent events", async () => {
    const s = plant();
    const root = s.repos[0] as string;
    writeFileSync(join(root, ".handoff", "off"), "");
    mkdirSync(join(root, ".cursor"), { recursive: true });
    writeFileSync(
      join(root, ".cursor", "hooks.json"),
      JSON.stringify({
        version: 1,
        hooks: {
          afterFileEdit: [
            USER_CURSOR,
            { command: "NOWALL_HOOK=1 nowall hook post-tool --agent cursor" },
          ],
          subagentStart: [{ command: "NOWALL_HOOK=1 nowall hook subagent-start --agent cursor" }],
          subagentStop: [{ command: "NOWALL_HOOK=1 nowall hook subagent-stop --agent cursor" }],
        },
      }),
    );
    expect(await runUninstall(root)).toBe(0);
    expect(existsSync(join(root, ".handoff", "off"))).toBe(false);
    expect(existsSync(join(root, ".handoff", "journal.jsonl"))).toBe(true); // data kept
    expect(read(join(root, ".cursor", "hooks.json"))).toEqual({
      version: 1,
      hooks: { afterFileEdit: [USER_CURSOR] },
    });
    expect(existsSync(join(root, ".claude", "settings.local.json"))).toBe(false); // only our hooks
    expect(read(join(s.data, "repos.json"))).toEqual([]);
    expect(readFileSync(join(s.home, ".zshrc"), "utf8")).toBe("export EDITOR=vim\n");
    expect(removeRepoHooks(root)).toEqual([]); // nothing left to change
  });
});
