import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
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
