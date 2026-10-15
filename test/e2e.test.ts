import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { sh, tempRepo } from "./helpers.js";

const ROOT = resolve(__dirname, "..");
const CLI = join(ROOT, "dist", "cli.js");
const FAKE = join(ROOT, "scripts", "fake-agent.mjs");

beforeAll(() => {
  execFileSync("npx", ["tsc", "-p", "tsconfig.build.json"], { cwd: ROOT });
}, 60_000);

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
  for (const name of ["claude", "codex", "cursor-agent"]) {
    const shim = join(bin, name);
    const agent = name === "cursor-agent" ? "cursor" : name;
    // --version / status calls from detect() must succeed quickly.
    writeFileSync(
      shim,
      `#!/bin/sh
case "$1" in
  --version) echo "fake-${agent} 0.0.0"; exit 0;;
  login) exit 0;;
  status) echo '{"isAuthenticated":true}'; exit 0;;
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
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    NOWALL_HOME: home,
    FAKE_PLAN: planPath,
    FAKE_NOWALL: `"${process.execPath}" "${CLI}"`,
    TZ: "America/Toronto",
  };
  delete env.NOWALL_SID;
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

function calls(w: World): { name: string; n: number; args: string[] }[] {
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
    const refs = sh(w.repo, "git", [
      "for-each-ref",
      "--format=%(refname)",
      "refs/heads/nowall/",
    ]).split("\n");
    expect(refs).toHaveLength(3);

    // Claude is cooling down until its parsed reset.
    const state = JSON.parse(readFileSync(join(w.env.NOWALL_HOME as string, "state.json"), "utf8"));
    expect(state.agents.claude.lastLimit.window).toBe("session");
    expect(state.agents.claude.cooldownUntil).toMatch(/T03:59:00\.000Z$/);

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

  it("pauses with the earliest reset when every agent is limited", () => {
    const w = world(
      {
        claude: [CLAUDE_LIMITED],
        codex: [{ limit: "You've hit your usage limit. Try again in 1 hour." }],
      },
      { order: ["claude", "codex"] },
    );
    const r = run(w);
    expect(r.stdout).toContain("every agent is at its limit; Codex resets");
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
