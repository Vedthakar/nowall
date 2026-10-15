import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { sh } from "./helpers.js";

// Every command and misuse a user can hit, run against the built CLI as a real process.
const ROOT = resolve(__dirname, "..");
const CLI = join(ROOT, "dist", "cli.js");
const FAKE = join(ROOT, "scripts", "fake-agent.mjs");

beforeAll(() => {
  execFileSync("npx", ["tsc", "-p", "tsconfig.build.json"], { cwd: ROOT });
}, 60_000);

function sandbox(opts: { agents?: string[]; repoName?: string; plan?: unknown } = {}) {
  const scratch = mkdtempSync(join(tmpdir(), "nowall-j-"));
  const bin = join(scratch, "bin");
  const home = join(scratch, "home");
  const repo = join(scratch, opts.repoName ?? "repo");
  for (const d of [bin, home, repo]) mkdirSync(d, { recursive: true });
  for (const name of opts.agents ?? ["claude", "cursor-agent"]) {
    const agent = name === "cursor-agent" ? "cursor" : name;
    writeFileSync(
      join(bin, name),
      `#!/bin/sh\ncase "$1" in --version) echo "fake ${agent}"; exit 0;; status) echo '{"isAuthenticated":true}'; exit 0;; esac\nexec "${process.execPath}" "${FAKE}" ${agent} "$@"\n`,
    );
    chmodSync(join(bin, name), 0o755);
  }
  const plan = join(scratch, "plan.json");
  writeFileSync(plan, JSON.stringify(opts.plan ?? {}));
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({ v: 1, order: ["claude", "cursor"], takeover: "off" }),
  );
  const { NOWALL_SID: _s, ...parent } = process.env;
  const env: NodeJS.ProcessEnv = {
    ...parent,
    PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin`,
    NOWALL_HOME: home,
    FAKE_PLAN: plan,
    FAKE_NOWALL: `"${process.execPath}" "${CLI}"`,
    HOME: home, // keep rc-file edits (alias) inside the sandbox
    SHELL: "/bin/zsh",
    GIT_AUTHOR_NAME: "T",
    GIT_AUTHOR_EMAIL: "t@x.invalid",
    GIT_COMMITTER_NAME: "T",
    GIT_COMMITTER_EMAIL: "t@x.invalid",
  };
  const nowall = (args: string[], cwd = repo, input?: string) =>
    spawnSync(process.execPath, [CLI, ...args], {
      cwd,
      env,
      encoding: "utf8",
      input,
      timeout: 60_000,
    });
  const gitInit = (commit = true) => {
    sh(repo, "git", ["init", "-q", "-b", "main"]);
    if (commit) {
      writeFileSync(join(repo, "README.md"), "# r\n");
      sh(repo, "git", ["add", "."]);
      execFileSync("git", ["commit", "-qm", "i"], { cwd: repo, env });
    }
  };
  return { scratch, repo, home, env, nowall, gitInit };
}

const LIMITED = {
  prompt: "do the thing",
  files: { "a.ts": "1\n" },
  limit: "You've hit your session limit · resets 11:59pm",
};
const DONE = {
  v: 1,
  updatedAt: "",
  updatedBy: "",
  tasks: [{ id: "1", title: "x", status: "done" }],
};

describe("journeys: help and misuse", () => {
  it("no args prints help and exits 0; unknown command exits 2", () => {
    const s = sandbox();
    expect(s.nowall([]).status).toBe(0);
    expect(s.nowall([]).stdout).toContain("nowall init");
    expect(s.nowall(["frobnicate"]).status).toBe(2);
    expect(s.nowall(["--version"]).stdout.trim()).toBe(
      JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version,
    );
  });

  it("init outside a git repo explains what to do", () => {
    const s = sandbox();
    const r = s.nowall(["init", "--yes"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("git init");
  });

  it("init without --yes in a non-interactive shell changes nothing and says how to proceed", () => {
    const s = sandbox();
    s.gitInit();
    const r = s.nowall(["init"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("--yes");
    expect(existsSync(join(s.repo, ".handoff"))).toBe(false);
  });

  it("run with an unknown agent, or a missing one, fails clearly", () => {
    const s = sandbox({ agents: [] });
    s.gitInit();
    expect(s.nowall(["run", "chatgpt"]).status).toBe(2);
    const r = s.nowall(["run", "claude"]);
    expect(r.status).toBe(127);
    expect(r.stderr).toContain("not installed");
  });

  it("note, undo, takeover and hook behave sensibly with nothing set up", () => {
    const s = sandbox();
    s.gitInit();
    expect(s.nowall(["note"]).status).toBe(0); // not initialized: silent no-op
    expect(s.nowall(["undo"]).stderr).toContain("no nowall session");
    expect(s.nowall(["takeover", "--sid", "c_x", "--from", "claude"]).status).toBe(1);
    const h = s.nowall(["hook", "prompt", "--agent", "claude"], s.repo, "this is not json{");
    expect(h.status).toBe(0);
    expect(h.stdout).toBe("");
  });

  it("status works outside any repo", () => {
    const s = sandbox();
    const r = s.nowall(["status"], s.scratch);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Claude Code");
  });
});

describe("journeys: setup lifecycle", () => {
  it("init is idempotent, alias installs once, uninstall removes everything but user data", () => {
    const s = sandbox();
    s.gitInit();
    mkdirSync(join(s.repo, ".claude"));
    writeFileSync(
      join(s.repo, ".claude", "settings.local.json"),
      JSON.stringify({ permissions: { allow: ["Bash(ls)"] } }),
    );
    expect(s.nowall(["init", "--yes"]).status).toBe(0);
    expect(s.nowall(["init", "--yes"]).status).toBe(0);
    const settings = JSON.parse(
      readFileSync(join(s.repo, ".claude", "settings.local.json"), "utf8"),
    );
    expect(settings.permissions.allow).toEqual(["Bash(ls)"]);
    expect(settings.hooks.StopFailure).toHaveLength(1);
    expect(sh(s.repo, "git", ["status", "--porcelain"])).toBe("");

    const u = s.nowall(["uninstall"]);
    expect(u.status).toBe(0);
    const after = JSON.parse(readFileSync(join(s.repo, ".claude", "settings.local.json"), "utf8"));
    expect(after.permissions.allow).toEqual(["Bash(ls)"]);
    expect(JSON.stringify(after)).not.toContain("nowall hook");
    const repos = JSON.parse(readFileSync(join(s.home, "repos.json"), "utf8"));
    expect(repos).not.toContain(realpathSync(s.repo));
  });

  it("refuses to set up a repo that commits .handoff/", () => {
    const s = sandbox();
    s.gitInit();
    mkdirSync(join(s.repo, ".handoff"));
    writeFileSync(join(s.repo, ".handoff", "journal.jsonl"), "{}\n");
    sh(s.repo, "git", ["add", "-f", ".handoff"]);
    execFileSync("git", ["commit", "-qm", "plant"], { cwd: s.repo, env: s.env });
    const r = s.nowall(["init", "--yes"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("commits a .handoff/");
  });
});

describe("journeys: awkward repositories", () => {
  it("path with spaces, quotes and $ works end to end", () => {
    const s = sandbox({
      repoName: `my "app" it's $HOME`,
      plan: { claude: [LIMITED], cursor: [{ files: { "b.ts": "2\n" }, tasks: DONE }] },
    });
    s.gitInit();
    expect(s.nowall(["init", "--yes"]).status).toBe(0);
    const r = s.nowall(["run", "claude"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("The last part was built by Cursor");
    expect(existsSync(join(s.repo, "b.ts"))).toBe(true);
  });

  it("repo with no commits yet", () => {
    const s = sandbox({
      plan: { claude: [LIMITED], cursor: [{ files: { "b.ts": "2\n" }, tasks: DONE }] },
    });
    s.gitInit(false);
    expect(s.nowall(["init", "--yes"]).status).toBe(0);
    const r = s.nowall(["run", "claude"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("Your task is done.");
  });

  it("running from a subdirectory uses the repo root", () => {
    const s = sandbox({
      plan: { claude: [LIMITED], cursor: [{ files: { "b.ts": "2\n" }, tasks: DONE }] },
    });
    s.gitInit();
    mkdirSync(join(s.repo, "packages", "web"), { recursive: true });
    expect(s.nowall(["init", "--yes"], join(s.repo, "packages", "web")).status).toBe(0);
    expect(existsSync(join(s.repo, ".handoff"))).toBe(true);
  });

  it("corrupt config and state files fall back to defaults", () => {
    const s = sandbox();
    s.gitInit();
    writeFileSync(join(s.home, "config.json"), "{not json");
    writeFileSync(join(s.home, "state.json"), "\u0000\u0001garbage");
    expect(s.nowall(["status"]).status).toBe(0);
    expect(s.nowall(["init", "--yes"]).status).toBe(0);
  });
});

describe("journeys: interrupting", () => {
  it("Ctrl-C while the next agent works stops cleanly with a summary and resume hint", async () => {
    const s = sandbox({
      plan: {
        claude: [LIMITED],
        cursor: [{ text: "working", files: { "b.ts": "2\n" }, sleepMs: 20_000 }],
      },
    });
    s.gitInit();
    s.nowall(["init", "--yes"]);
    const p = spawn(process.execPath, [CLI, "run", "claude"], { cwd: s.repo, env: s.env });
    let out = "";
    p.stdout.on("data", (d) => {
      out += d.toString();
    });
    await new Promise<void>((done) => {
      const t = setInterval(() => {
        if (out.includes("continuing in Cursor")) {
          clearInterval(t);
          setTimeout(() => {
            p.kill("SIGINT");
            done();
          }, 1500);
        }
      }, 100);
    });
    const code = await new Promise<number | null>((r) => p.on("close", r));
    expect(code).toBe(0);
    expect(out).toContain("Stopped by you.");
    expect(out).toContain("Keep going interactively: cursor-agent");
  });
});

describe("journeys: one-command global setup", { timeout: 90_000 }, () => {
  it("setup finds agents, installs user hooks once, keeps user settings, and teardown reverses it", () => {
    const s = sandbox();
    mkdirSync(join(s.home, ".claude"), { recursive: true });
    mkdirSync(join(s.home, ".cursor"), { recursive: true });
    // The user's settings live in a dotfiles repo and are symlinked in.
    const dotfiles = join(s.scratch, "dotfiles-settings.json");
    writeFileSync(
      dotfiles,
      JSON.stringify({
        model: "opus",
        hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] },
      }),
    );
    symlinkSync(dotfiles, join(s.home, ".claude", "settings.json"));

    const r = s.nowall(["setup", "--yes", "--no-notch"], s.scratch);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("Claude Code");
    expect(r.stdout).toContain("nowall is on.");
    s.nowall(["setup", "--yes", "--no-notch"], s.scratch); // idempotent

    expect(lstatSync(join(s.home, ".claude", "settings.json")).isSymbolicLink()).toBe(true);
    const settings = JSON.parse(readFileSync(dotfiles, "utf8"));
    expect(settings.model).toBe("opus");
    expect(JSON.stringify(settings.hooks.Stop)).toContain("say done");
    expect(settings.hooks.StopFailure).toHaveLength(1);
    expect(settings.statusLine.command).toContain("statusline");
    expect(existsSync(join(s.home, ".cursor", "hooks.json"))).toBe(true);
    expect(existsSync(join(s.home, ".codex", "hooks.json"))).toBe(false); // no Codex here: untouched
    expect(JSON.parse(readFileSync(join(s.home, "config.json"), "utf8")).scope).toBe("global");
    expect(existsSync(join(s.home, "agents.json"))).toBe(true);

    expect(s.nowall(["uninstall", "--global"], s.scratch).status).toBe(0);
    const after = JSON.parse(readFileSync(dotfiles, "utf8"));
    expect(after.model).toBe("opus");
    expect(JSON.stringify(after)).not.toContain("NOWALL_HOOK");
    expect(after.statusLine).toBeUndefined();
    expect(JSON.stringify(after.hooks.Stop)).toContain("say done");
  });

  it("after setup, a desktop-app Claude session in a never-initialized repo is taken over silently", async () => {
    const s = sandbox({
      plan: {
        claude: [LIMITED],
        cursor: [{ text: "done", files: { "b.ts": "2\n" }, tasks: DONE }],
      },
    });
    s.gitInit();
    mkdirSync(join(s.home, ".claude"), { recursive: true });
    expect(s.nowall(["setup", "--yes", "--no-notch"], s.scratch).status).toBe(0);
    // Launch "Claude" directly like the desktop app does: no nowall run, no nowall init.
    const claude = spawn(join(s.scratch, "bin", "claude"), [], {
      cwd: s.repo,
      env: s.env,
      stdio: "ignore",
    });
    const statusDir = join(s.home, "status");
    let status: { phase?: string; shares?: { agent: string }[] } = {};
    for (let i = 0; i < 200 && status.phase !== "done"; i++) {
      await new Promise((r) => setTimeout(r, 300));
      try {
        const f = readdirSync(statusDir)[0];
        if (f) status = JSON.parse(readFileSync(join(statusDir, f), "utf8"));
      } catch {
        // not yet
      }
    }
    const log = join(s.repo, ".handoff", "takeover.log");
    for (let i = 0; i < 50 && !readFileSync(log, "utf8").includes("Your task is done."); i++) {
      await new Promise((r) => setTimeout(r, 200));
    }
    claude.kill("SIGTERM");
    expect(status.phase).toBe("done");
    expect(status.shares?.map((x) => x.agent)).toEqual(["claude", "cursor"]);
    expect(existsSync(join(s.repo, "b.ts"))).toBe(true);
    expect(readFileSync(join(s.repo, ".handoff", "takeover.log"), "utf8")).toContain(
      "Your task is done.",
    );
    expect(sh(s.repo, "git", ["status", "--porcelain"])).toBe(
      "?? a.ts\n?? b.ts".replace(/\n/g, "\n"),
    );
  });

  it("statusline keeps Claude's usage and agents reports it (plus Codex usage from its logs)", () => {
    const s = sandbox({ agents: ["claude", "codex"] });
    const reset = Math.floor(Date.now() / 1000) + 3600;
    s.nowall(
      ["statusline"],
      s.scratch,
      JSON.stringify({ rate_limits: { five_hour: { used_percentage: 37.5, resets_at: reset } } }),
    );
    const day = join(s.home, ".codex", "sessions", "2026", "10", "15");
    mkdirSync(day, { recursive: true });
    writeFileSync(
      join(day, "rollout-synthetic.jsonl"),
      `${JSON.stringify({ type: "event_msg", payload: { type: "token_count", rate_limits: { primary: { used_percent: 61, window_minutes: 300, resets_at: reset } } } })}\n`,
    );
    const r = s.nowall(["agents"], s.scratch);
    const snap = JSON.parse(r.stdout);
    const claude = snap.agents.find((a: { id: string }) => a.id === "claude");
    const codex = snap.agents.find((a: { id: string }) => a.id === "codex");
    expect(claude.usage[0]).toMatchObject({ label: "5h", usedPct: 37.5 });
    expect(codex.usage[0]).toMatchObject({ label: "5h", usedPct: 61 });
  });
});
