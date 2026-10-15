import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DONE = (titles: string[]) => ({
  v: 1,
  updatedAt: new Date().toISOString(),
  updatedBy: "cursor",
  tasks: titles.map((title, i) => ({ id: String(i + 1), title, status: "done" })),
});

/**
 * `nowall demo`: a full, simulated Claude Code → Cursor failover in a throwaway repo.
 * Uses the bundled fake agent, so no real agent runs and no usage is spent.
 */
export async function runDemo(): Promise<number> {
  const here = dirname(fileURLToPath(import.meta.url));
  const cli = join(here, "cli.js");
  const fake = join(here, "..", "scripts", "fake-agent.mjs");
  const scratch = mkdtempSync(join(tmpdir(), "nowall-demo-"));
  const repo = join(scratch, "my-app");
  const bin = join(scratch, "bin");
  const home = join(scratch, "home");
  for (const d of [repo, bin, home]) mkdirSync(d, { recursive: true });

  const git = (...args: string[]) =>
    execFileSync(
      "git",
      ["-c", "user.name=nowall demo", "-c", "user.email=demo@nowall.invalid", ...args],
      {
        cwd: repo,
        stdio: "ignore",
      },
    );
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "# my-app\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");

  for (const [name, agent] of [
    ["claude", "claude"],
    ["cursor-agent", "cursor"],
  ] as const) {
    const shim = join(bin, name);
    writeFileSync(
      shim,
      `#!/bin/sh
case "$1" in
  --version) echo "simulated ${agent}"; exit 0;;
  status) echo '{"isAuthenticated":true}'; exit 0;;
esac
exec "${process.execPath}" "${fake}" ${agent} "$@"
`,
    );
    chmodSync(shim, 0o755);
  }
  writeFileSync(join(home, "config.json"), JSON.stringify({ v: 1, order: ["claude", "cursor"] }));

  const plan = join(scratch, "plan.json");
  writeFileSync(
    plan,
    JSON.stringify({
      claude: [
        {
          prompt: "Add a /health endpoint with a test",
          files: { "src/health.ts": "export const health = () => ({ ok: true });\n" },
          notes: [
            ["--task", "add /health route"],
            ["--task", "write a test for /health", "--status", "todo"],
          ],
          limit: "You've hit your session limit · resets 11:59pm",
        },
      ],
      cursor: [
        {
          text: "Checked git: /health exists in src/health.ts, the test is missing. Adding it now.",
          files: {
            "test/health.test.ts":
              "import { health } from '../src/health';\n// expect(health()).toEqual({ ok: true })\n",
          },
          tasks: DONE(["add /health route", "write a test for /health"]),
        },
      ],
    }),
  );

  const { NOWALL_SID: _ignored, ...parentEnv } = process.env;
  const env: NodeJS.ProcessEnv = {
    ...parentEnv,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    NOWALL_HOME: home,
    FAKE_PLAN: plan,
    FAKE_NOWALL: `"${process.execPath}" "${cli}"`,
    GIT_AUTHOR_NAME: "nowall demo",
    GIT_AUTHOR_EMAIL: "demo@nowall.invalid",
    GIT_COMMITTER_NAME: "nowall demo",
    GIT_COMMITTER_EMAIL: "demo@nowall.invalid",
  };

  const say = (s: string) => process.stdout.write(`\x1b[36m${s}\x1b[0m\n`);
  say("nowall demo: simulated agents, a throwaway repo, no real usage.\n");
  say('1. You\'re in Claude Code and ask: "Add a /health endpoint with a test".');
  say("   Claude writes src/health.ts, then hits its session limit before writing the test.\n");
  say("2. nowall notices, checkpoints your files, and hands the job to Cursor:\n");

  spawnSync(process.execPath, [cli, "init", "--yes"], { cwd: repo, env, stdio: "ignore" });
  const r = spawnSync(process.execPath, [cli, "run", "claude"], {
    cwd: repo,
    env,
    stdio: "inherit",
  });

  say(
    "\n3. That summary is the only thing you'd see. Try it for real: `nowall init` in your project.",
  );
  rmSync(scratch, { recursive: true, force: true });
  return r.status ?? 1;
}
