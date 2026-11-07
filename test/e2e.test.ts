import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { sh, tempRepo } from "./helpers.js";

const ROOT = resolve(__dirname, "..");
const CLI = join(ROOT, "dist", "cli.js");
const FAKE = join(ROOT, "scripts", "fake-agent.mjs");

interface World {
  repo: string;
  plan: string;
  env: NodeJS.ProcessEnv;
}

function world(plan: Record<string, unknown[]>, config?: Record<string, unknown>): World {
  const repo = tempRepo();
  const scratch = mkdtempSync(join(tmpdir(), "nowall-e2e-"));
  const bin = join(scratch, "bin");
  mkdirSync(bin);
  for (const name of ["claude", "codex", "cursor-agent", "agy", "qwen"]) {
    const shim = join(bin, name);
    const agent = { "cursor-agent": "cursor", agy: "antigravity" }[name] ?? name;
    // --version / status calls from detect() must succeed quickly.
    writeFileSync(
      shim,
      `#!/bin/sh
case "$1" in
  --version) echo "fake-${agent} 0.0.0"; exit 0;;
  login) exit 0;;
  status) echo '{"isAuthenticated":true}'; exit 0;;
  auth) echo "{\\"loggedIn\\":true,\\"configDirectory\\":\\"\${CLAUDE_CONFIG_DIR:-default}\\"}"; exit 0;;
esac
exec "${process.execPath}" "${FAKE}" ${agent} "$@"
`,
    );
    chmodSync(shim, 0o755);
  }
  const home = join(scratch, "home");
  mkdirSync(home);
  if (config) writeFileSync(join(home, "config.json"), JSON.stringify({ v: 1, ...config }));
  const planPath = join(scratch, "plan.json");
  writeFileSync(planPath, JSON.stringify(plan));
  const { NOWALL_SID: _ignored, ...parentEnv } = process.env;
  const env: NodeJS.ProcessEnv = {
    ...parentEnv,
    PATH: `${bin}:${process.env.PATH}`,
    NOWALL_HOME: home,
    FAKE_PLAN: planPath,
    FAKE_NOWALL: `"${process.execPath}" "${CLI}"`,
    TZ: "America/Toronto",
  };
  const init = spawnSync(process.execPath, [CLI, "init", "--yes"], {
    cwd: repo,
    env,
    encoding: "utf8",
  });
  expect(init.status, init.stderr).toBe(0);
  return { repo, plan: planPath, env };
}

function run(w: World): { stdout: string; stderr: string; status: number | null } {
  const r = spawnSync(process.execPath, [CLI, "run", "claude"], {
    cwd: w.repo,
    env: w.env,
    encoding: "utf8",
    timeout: 60_000,
  });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}

function calls(
  w: World,
): { name: string; n: number; args: string[]; account: Record<string, unknown> }[] {
  const p = `${w.plan}.calls.jsonl`;
  return existsSync(p)
    ? readFileSync(p, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l))
    : [];
}

const done = (titles: string[]) => ({
  v: 1,
  updatedAt: "2026-10-15T00:00:00Z",
  updatedBy: "x",
  tasks: titles.map((title, i) => ({ id: String(i + 1), title, status: "done" })),
});

const CLAUDE_LIMITED = {
  prompt: "Add a /health endpoint with tests",
  files: { "src/health.ts": "export const health = () => 'ok';\n" },
  notes: [
    ["--task", "health route"],
    ["--task", "health tests", "--status", "todo"],
  ],
  limit: "You've hit your session limit · resets 11:59pm (America/Toronto)",
};

describe("end-to-end failover with fake agents", { timeout: 60_000 }, () => {
  it("init installs hooks and git-excludes its files", () => {
    const w = world({});
    const settings = JSON.parse(readFileSync(join(w.repo, ".claude/settings.local.json"), "utf8"));
    expect(settings.hooks.StopFailure[0].matcher).toBe("rate_limit");
    expect(sh(w.repo, "git", ["status", "--porcelain"])).toBe("");
  });

  it("Claude hits its limit → Codex finishes with context → one summary", () => {
    const w = world({
      claude: [CLAUDE_LIMITED],
      codex: [
        {
          text: "Verified the route; writing the tests.",
          files: { "test/health.test.ts": "// tests\n" },
          tasks: done(["health route", "health tests"]),
        },
      ],
    });
    const headBefore = sh(w.repo, "git", ["rev-parse", "HEAD"]);
    const r = run(w);
    expect(r.status, r.stderr).toBe(0);

    expect(r.stdout).toContain(
      "Your task is done. The last part was built by Codex because Claude Code hit its session limit",
    );
    expect(r.stdout).toContain("Verified the route; writing the tests.");
    expect(r.stdout).toContain("codex resume codex-thread-0");

    // Codex got the reconciled context.
    const codexCall = calls(w).find((c) => c.name === "codex");
    const prompt = codexCall?.args.at(-1) ?? "";
    expect(prompt).toContain("Add a /health endpoint with tests");
    expect(prompt).toContain("- health route");
    expect(prompt).toContain("- health tests");
    expect(prompt).toContain("src/health.ts");
    expect(codexCall?.args).toEqual(expect.arrayContaining(["--sandbox", "workspace-write"]));

    // Both agents' work is on disk; the user's branch never moved.
    expect(existsSync(join(w.repo, "src/health.ts"))).toBe(true);
    expect(existsSync(join(w.repo, "test/health.test.ts"))).toBe(true);
    expect(sh(w.repo, "git", ["rev-parse", "HEAD"])).toBe(headBefore);
    expect(sh(w.repo, "git", ["branch", "--show-current"])).toBe("main");

    // Checkpoints exist: start, handoff, end.
    const refs = sh(w.repo, "git", ["for-each-ref", "--format=%(refname)", "refs/nowall/"]).split(
      "\n",
    );
    expect(refs).toHaveLength(3);

    // Claude is cooling down until its parsed reset.
    const state = JSON.parse(readFileSync(join(w.env.NOWALL_HOME as string, "state.json"), "utf8"));
    expect(state.agents.claude.lastLimit.window).toBe("session");
    // 11:59pm Toronto is 03:59Z during DST and 04:59Z otherwise.
    expect(state.agents.claude.cooldownUntil).toMatch(/T0[34]:59:00\.000Z$/);

    // Journal has mechanical + model-written lines, and the limit.
    const journal = readFileSync(join(w.repo, ".handoff/journal.jsonl"), "utf8");
    for (const kind of ['"goal"', '"edit"', '"task"', '"limit"', '"handoff"'])
      expect(journal).toContain(kind);
  });

  it("chains Claude → Codex → Cursor when Codex also hits its limit", () => {
    const w = world({
      claude: [CLAUDE_LIMITED],
      codex: [
        {
          files: { "src/part2.ts": "// 2\n" },
          limit: "You've hit your usage limit. Try again in 3 hours.",
        },
      ],
      cursor: [{ text: "All done.", files: { "src/part3.ts": "// 3\n" }, tasks: done(["a", "b"]) }],
    });
    const r = run(w);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(
      "The last part was built by Cursor because Codex hit its usage limit",
    );
    expect(r.stdout).toMatch(/1\. Claude Code: .*hit session limit/);
    expect(r.stdout).toMatch(/2\. Codex: .*hit usage limit/);
    expect(r.stdout).toMatch(/3\. Cursor: .*finished/);
    const cursorPrompt = calls(w).find((c) => c.name === "cursor")?.args[1] ?? "";
    expect(cursorPrompt).toContain("Codex was working on it");
    expect(cursorPrompt).toContain("src/part2.ts");
  });

  it("chains Claude → Antigravity → Qwen (own-key fallback) when enabled", () => {
    const w = world(
      {
        claude: [CLAUDE_LIMITED],
        antigravity: [
          {
            files: { "src/part2.ts": "// 2\n" },
            limit: "You have reached your usage limit for this model. Try again later.",
          },
        ],
        qwen: [{ text: "All done.", files: { "src/part3.ts": "// 3\n" }, tasks: done(["a", "b"]) }],
      },
      {
        order: ["claude", "antigravity", "qwen"],
        enabled: { claude: true, antigravity: true, qwen: true },
        fallback: { enabled: true, chinaConsent: true },
      },
    );
    const r = run(w);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(
      "The last part was built by Qwen Code because Antigravity hit its usage limit",
    );
    expect(r.stdout).toMatch(/1\. Claude Code: .*hit session limit/);
    expect(r.stdout).toMatch(/2\. Antigravity: .*hit usage limit/);
    expect(r.stdout).toMatch(/3\. Qwen Code: .*finished/);
    const c = calls(w);
    expect(c.find((x) => x.name === "antigravity")?.args.slice(0, 1)).toEqual(["-p"]);
    const qwen = c.find((x) => x.name === "qwen");
    expect(qwen?.args.join(" ")).toContain("--approval-mode auto-edit");
    expect(qwen?.args[1]).toContain("Antigravity was working on it");
  });

  it("falls through a second Claude account and a keyed Cursor account", () => {
    const w = world(
      {
        claude: [
          CLAUDE_LIMITED,
          {
            files: { "src/part2.ts": "// 2\n" },
            limit: "You've hit your session limit · resets 10pm (America/Toronto)",
          },
        ],
        cursor: [
          { text: "All done.", files: { "src/part3.ts": "// 3\n" }, tasks: done(["a", "b"]) },
        ],
      },
      {
        order: ["claude", "claude:work", "cursor:b"],
        accounts: [
          { id: "claude:work", agent: "claude", label: "work", env: { CLAUDE_CONFIG_DIR: "" } },
          {
            id: "cursor:b",
            agent: "cursor",
            label: "b",
            secret: { env: "CURSOR_API_KEY", store: "file" },
          },
        ],
      },
    );
    // Point the work profile at a real directory and store the Cursor key the way `account add` does.
    const home = w.env.NOWALL_HOME as string;
    const profile = join(home, "profiles", "claude-work");
    mkdirSync(profile, { recursive: true });
    const cfg = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    cfg.accounts[0].env.CLAUDE_CONFIG_DIR = profile;
    writeFileSync(join(home, "config.json"), JSON.stringify(cfg));
    mkdirSync(join(home, "secrets"));
    writeFileSync(join(home, "secrets", "cursor_b"), "key_SECRET\n");

    const r = run(w);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(
      "The last part was built by Cursor (b) because Claude Code (work) hit its session limit",
    );
    expect(r.stdout).toMatch(/1\. Claude Code: .*hit session limit/);
    expect(r.stdout).toMatch(/2\. Claude Code \(work\): .*hit session limit/);
    expect(r.stdout).toMatch(/3\. Cursor \(b\): .*finished/);

    // Each account was selected through the agent's own environment, never by nowall touching logins.
    const c = calls(w);
    const claude = c.filter((x) => x.name === "claude");
    expect(claude[0]?.account.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(claude.at(-1)?.account.CLAUDE_CONFIG_DIR).toBe(profile);
    expect(c.find((x) => x.name === "cursor")?.account.CURSOR_API_KEY).toBe(true);
    expect(r.stdout).not.toContain("key_SECRET");

    // Cooldowns are per account.
    const state = JSON.parse(readFileSync(join(home, "state.json"), "utf8"));
    expect(state.agents.claude.cooldownUntil).toBeTruthy();
    expect(state.agents["claude:work"].cooldownUntil).toBeTruthy();
    expect(state.agents["cursor:b"]).toBeUndefined();
  });

  it("reprompts the same agent session until tasks are done", () => {
    const w = world({
      claude: [CLAUDE_LIMITED],
      codex: [
        {
          files: { "a.ts": "1" },
          tasks: { ...done(["a"]), tasks: [{ id: "1", title: "a", status: "todo" }] },
        },
        { files: { "a.ts": "2" }, tasks: done(["a"]) },
      ],
    });
    const r = run(w);
    expect(r.stdout).toContain("Your task is done.");
    const codexCalls = calls(w).filter((c) => c.name === "codex");
    expect(codexCalls).toHaveLength(2);
    expect(codexCalls[1]?.args.slice(0, 3)).toEqual(["exec", "resume", "codex-thread-0"]);
    expect(codexCalls[1]?.args.at(-1)).toContain("[1] a");
  });

  it("skips an account that runs out of usage, whatever its place in the order", () => {
    const w = world(
      {
        claude: [CLAUDE_LIMITED],
        cursor: [
          { limit: "You've hit your usage limit" },
          { text: "All done.", files: { "src/z.ts": "// z\n" }, tasks: done(["a"]) },
        ],
      },
      {
        order: ["claude", "cursor:second", "cursor"],
        accounts: [
          {
            id: "cursor:second",
            agent: "cursor",
            label: "second",
            env: { AGENT_CLI_CREDENTIAL_STORE: "file", HOME: "PROFILE" },
          },
        ],
      },
    );
    const home = w.env.NOWALL_HOME as string;
    const profile = join(home, "profiles", "cursor-second");
    mkdirSync(profile, { recursive: true });
    const cfg = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    cfg.accounts[0].env.HOME = profile;
    writeFileSync(join(home, "config.json"), JSON.stringify(cfg));

    const r = run(w);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/Cursor \(second\): .*hit /);
    expect(r.stdout).toContain("The last part was built by Cursor because Cursor (second) hit");
    expect(calls(w).filter((c) => c.name === "cursor")).toHaveLength(2);

    // Only the account that ran out cools down, so the next takeover skips it too.
    const state = JSON.parse(readFileSync(join(home, "state.json"), "utf8"));
    expect(state.agents["cursor:second"]?.cooldownUntil).toBeTruthy();
    expect(state.agents.cursor?.cooldownUntil).toBeUndefined();
  });

  it("moves on from an account that keeps failing in words it doesn't know", () => {
    const w = world(
      {
        claude: [CLAUDE_LIMITED],
        codex: [{ limit: "Something new went wrong" }, { limit: "Something new went wrong" }],
        cursor: [{ text: "All done.", files: { "src/y.ts": "// y\n" }, tasks: done(["a"]) }],
      },
      { order: ["claude", "codex", "cursor"] },
    );
    const r = run(w);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("Codex keeps failing. Trying the next account.");
    expect(r.stdout).toContain("Your task is done.");
    expect(r.stdout).toMatch(/Codex: .*hit repeated errors/);
    const state = JSON.parse(readFileSync(join(w.env.NOWALL_HOME as string, "state.json"), "utf8"));
    // Short, because this may not be a limit at all.
    const until = Date.parse(state.agents.codex.cooldownUntil);
    expect(until - Date.now()).toBeLessThan(16 * 60_000);
  });

  it("stops with an error when no other account is free", () => {
    const w = world(
      {
        claude: [CLAUDE_LIMITED],
        codex: [{ limit: "Something new went wrong" }, { limit: "Something new went wrong" }],
      },
      { order: ["claude", "codex"] },
    );
    expect(run(w).stdout).toContain("Stopped: the agent kept failing.");
  });

  it("skips an account whose profile folder is gone", () => {
    const w = world(
      {
        claude: [CLAUDE_LIMITED],
        cursor: [{ text: "All done.", files: { "src/x.ts": "// x\n" }, tasks: done(["a"]) }],
      },
      {
        order: ["claude", "cursor:gone", "cursor"],
        accounts: [
          {
            id: "cursor:gone",
            agent: "cursor",
            label: "gone",
            env: { HOME: "/nonexistent/nowall-profile", AGENT_CLI_CREDENTIAL_STORE: "file" },
          },
        ],
      },
    );
    const r = run(w);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("built by Cursor because Claude Code hit");
    expect(r.stdout).not.toContain("Cursor (gone)");
  });

  it("stops when the agent stops making changes (no runaway loop)", () => {
    const w = world(
      {
        claude: [CLAUDE_LIMITED],
        codex: [{ text: "thinking" }, { text: "still thinking" }, { text: "hmm" }],
      },
      { stop: { maxTurns: 10, maxMinutes: 5, noDiffTurns: 2 } },
    );
    const r = run(w);
    expect(r.stdout).toContain("Stopped: the agent stopped making changes.");
    expect(calls(w).filter((c) => c.name === "codex")).toHaveLength(2);
  });

  it("stops a turn when asked to, and keeps what was done", async () => {
    const w = world({ claude: [CLAUDE_LIMITED], codex: [{ sleepMs: 60_000 }] });
    const child = spawn(process.execPath, [CLI, "run", "claude"], { cwd: w.repo, env: w.env });
    let out = "";
    child.stdout.on("data", (d) => {
      out += d;
    });
    const started = Date.now();
    while (!out.includes("continuing in Codex") && Date.now() - started < 20_000) {
      await new Promise((r) => setTimeout(r, 100));
    }
    await new Promise((r) => setTimeout(r, 500));
    child.kill("SIGINT");
    await new Promise((r) => child.on("close", r));
    expect(out).toContain("Stopped by you.");
    expect(out).toContain("(stopped by you)");
    expect(out).not.toContain("(finished)");
    expect(Date.now() - started).toBeLessThan(40_000);
  });

  it("stops a turn that runs past the time limit", () => {
    const w = world(
      { claude: [CLAUDE_LIMITED], codex: [{ sleepMs: 60_000 }] },
      { stop: { maxTurns: 10, maxMinutes: 0.05, noDiffTurns: 2 } },
    );
    const started = Date.now();
    const r = run(w);
    expect(r.stdout).toContain("Stopped: reached the time limit.");
    expect(Date.now() - started).toBeLessThan(40_000);
  });

  it("pauses with the earliest reset when every agent is limited", () => {
    const w = world(
      {
        claude: [CLAUDE_LIMITED],
        codex: [{ limit: "You've hit your usage limit. Try again in 1 hour." }],
      },
      { order: ["claude", "codex"] },
    );
    const r = run(w);
    expect(r.stdout).toContain("every account is at its limit; Codex resets");
    expect(r.stdout).toContain("Paused: every available agent is at its usage limit.");
  });

  it("passes straight through when there is no limit", () => {
    const w = world({ claude: [{ files: { "x.ts": "x" } }] });
    const r = run(w);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain("Your task is done");
    expect(calls(w).map((c) => c.name)).toEqual(["claude"]);
  });

  it("undo restores files to a checkpoint", () => {
    const w = world({
      claude: [CLAUDE_LIMITED],
      codex: [{ files: { "src/health.ts": "BROKEN\n" }, tasks: done(["x"]) }],
    });
    run(w);
    const r = spawnSync(process.execPath, [CLI, "undo", "1"], {
      cwd: w.repo,
      env: w.env,
      encoding: "utf8",
    });
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(join(w.repo, "src/health.ts"), "utf8")).toBe(
      "export const health = () => 'ok';\n",
    );
  });
});

describe("end-to-end: resilience and other journeys", { timeout: 90_000 }, () => {
  it("skips an agent that isn't signed in and tells the user how to fix it", () => {
    const w = world({
      claude: [CLAUDE_LIMITED],
      codex: [{ auth: "Authentication required. Please run 'codex login' first." }],
      cursor: [{ files: { "test/health.test.ts": "// t\n" }, tasks: done(["a"]) }],
    });
    const r = run(w);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(
      "The last part was built by Cursor because Claude Code hit its session limit",
    );
    expect(r.stdout).toMatch(/2\. Codex: .*not signed in, skipped/);
    expect(r.stdout).toContain("Action needed: Codex isn't signed in. Run: codex login");
    const state = JSON.parse(readFileSync(join(w.env.NOWALL_HOME as string, "state.json"), "utf8"));
    expect(state.agents.codex).toBeUndefined(); // an auth problem is not a usage limit
  });

  it("a stale tasks.json from an earlier session can't end a new one early", () => {
    const w = world({
      claude: [CLAUDE_LIMITED],
      codex: [{ files: { "a.ts": "1" } }, { files: { "a.ts": "2" }, tasks: done(["x"]) }],
    });
    writeFileSync(join(w.repo, ".handoff", "tasks.json"), JSON.stringify(done(["old task"])));
    const r = run(w);
    expect(r.stdout).toContain("Your task is done.");
    expect(calls(w).filter((c) => c.name === "codex")).toHaveLength(2);
  });

  it("a second concurrent session in the same repo runs without failover", () => {
    const w = world({ claude: [{ files: { "x.ts": "x" } }] });
    writeFileSync(join(w.repo, ".handoff", "active.lock"), String(process.pid)); // a live pid
    const r = run(w);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("another nowall session is active");
  });

  it("does nothing special in a repo this user never initialized", () => {
    const w = world({ claude: [{ files: { "x.ts": "x" } }] });
    writeFileSync(join(w.env.NOWALL_HOME as string, "repos.json"), "[]");
    const r = run(w);
    expect(r.status).toBe(0);
    expect(existsSync(join(w.repo, ".handoff", "session.json"))).toBe(false);
  });

  it("Claude desktop app (no nowall run): the limit hook takes over in the background", async () => {
    const w = world(
      {
        claude: [CLAUDE_LIMITED],
        cursor: [
          { text: "finishing", files: { "test/h.test.ts": "// t\n" }, tasks: done(["a", "b"]) },
        ],
      },
      { order: ["claude", "cursor"] },
    );
    // Launch "Claude" directly, the way the desktop app would, not through nowall.
    const claude = spawn(join(dirname(w.plan), "bin", "claude"), [], {
      cwd: w.repo,
      env: w.env,
      stdio: "ignore",
    });
    const sessionFile = join(w.repo, ".handoff", "session.json");
    const deadline = Date.now() + 60_000;
    let session: { finished?: { reason: string }; segments: { agent: string }[] } | null = null;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 300));
      try {
        session = JSON.parse(readFileSync(sessionFile, "utf8"));
      } catch {
        continue;
      }
      const hasSummary = readdirSync(join(w.repo, ".handoff")).some((f) =>
        f.startsWith("summary-"),
      );
      if (session?.finished && hasSummary) break;
    }
    claude.kill("SIGTERM");
    expect(session?.finished?.reason).toBe("complete");
    expect(session?.segments.map((s) => s.agent)).toEqual(["claude", "cursor"]);
    const summary = readFileSync(
      join(
        w.repo,
        ".handoff",
        readdirSync(join(w.repo, ".handoff")).find((f) => f.startsWith("summary-")) ?? "",
      ),
      "utf8",
    );
    expect(summary).toContain(
      "The last part was built by Cursor because Claude Code hit its session limit",
    );
    expect(existsSync(join(w.repo, "test/h.test.ts"))).toBe(true);
  });

  it("nowall demo runs a full simulated failover", () => {
    const r = spawnSync(process.execPath, [CLI, "demo"], {
      encoding: "utf8",
      env: { ...process.env, NOWALL_SID: "" },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(
      "The last part was built by Cursor because Claude Code hit its session limit",
    );
  });
});
