#!/usr/bin/env node
// Stress tests for nowall. Run after `npm run build`: `npm run stress`.
// Prints timings and fails (exit 1) if any budget is exceeded.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "dist", "cli.js");
const { checkpoint } = await import(join(ROOT, "dist", "git.js"));
const { appendJournal, readJournal } = await import(join(ROOT, "dist", "session.js"));
const { trustRepo } = await import(join(ROOT, "dist", "state.js"));

const failures = [];
const env = {
  ...process.env,
  NOWALL_HOME: mkdtempSync(join(tmpdir(), "nowall-stress-home-")),
  GIT_AUTHOR_NAME: "S",
  GIT_AUTHOR_EMAIL: "s@x.invalid",
  GIT_COMMITTER_NAME: "S",
  GIT_COMMITTER_EMAIL: "s@x.invalid",
};
process.env.NOWALL_HOME = env.NOWALL_HOME;
Object.assign(process.env, env);

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "nowall-stress-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "x\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: dir });
  mkdirSync(join(dir, ".handoff"));
  trustRepo(dir);
  return dir;
}

async function check(name, budgetMs, fn) {
  const t = performance.now();
  const detail = await fn();
  const ms = performance.now() - t;
  const ok = ms <= budgetMs;
  if (!ok) failures.push(name);
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}: ${ms.toFixed(0)} ms (budget ${budgetMs})${detail ? `  ${detail}` : ""}`,
  );
}

// 1. Snapshot a large working tree: 20k tracked files + 5k untracked + one 50 MB file.
{
  const r = repo();
  for (let d = 0; d < 200; d++) {
    mkdirSync(join(r, "src", `m${d}`), { recursive: true });
    for (let f = 0; f < 100; f++)
      writeFileSync(join(r, "src", `m${d}`, `f${f}.ts`), `export const v${f} = ${d * f};\n`);
  }
  execFileSync("git", ["add", "."], { cwd: r });
  execFileSync("git", ["commit", "-qm", "big"], { cwd: r });
  for (let f = 0; f < 5000; f++) writeFileSync(join(r, "src", "m0", `new${f}.ts`), `// ${f}\n`);
  writeFileSync(join(r, "blob.bin"), Buffer.alloc(50 * 1024 * 1024, 7));
  await check("checkpoint 25k files + 50 MB blob", 15000, () => {
    checkpoint(r, "s_stress", 1, "stress");
  });
  await check("second checkpoint (warm)", 8000, () => {
    checkpoint(r, "s_stress", 2, "stress");
  });
}

// 2. Concurrent hook writers: 40 hook processes appending at once must not corrupt the journal.
{
  const r = repo();
  await check("40 concurrent hook processes", 20000, async () => {
    await Promise.all(
      Array.from(
        { length: 40 },
        (_, i) =>
          new Promise((resolve) => {
            const p = spawn(process.execPath, [CLI, "hook", "prompt", "--agent", "claude"], {
              cwd: r,
              env: { ...env, NOWALL_SID: "s_conc" },
            });
            p.stdin.end(
              JSON.stringify({ cwd: r, prompt: `request number ${i} ${"x".repeat(150)}` }),
            );
            p.on("close", resolve);
          }),
      ),
    );
    const lines = readFileSync(join(r, ".handoff", "journal.jsonl"), "utf8")
      .trim()
      .split("\n");
    const valid = lines.filter((l) => {
      try {
        JSON.parse(l);
        return true;
      } catch {
        return false;
      }
    });
    if (valid.length !== 40 || lines.length !== 40) failures.push("journal integrity");
    return `${valid.length}/40 valid lines`;
  });
}

// 3. Hook latency (paid on every tool call): average of 20 sequential post-tool hooks.
{
  const r = repo();
  const n = 20;
  const t = performance.now();
  for (let i = 0; i < n; i++) {
    spawnSync(process.execPath, [CLI, "hook", "post-tool", "--agent", "claude"], {
      cwd: r,
      env: { ...env, NOWALL_SID: "s_lat" },
      input: JSON.stringify({
        cwd: r,
        tool_name: "Edit",
        tool_input: { file_path: join(r, "a.ts") },
      }),
    });
  }
  const avg = (performance.now() - t) / n;
  const ok = avg < 400;
  if (!ok) failures.push("hook latency");
  console.log(`${ok ? "PASS" : "FAIL"}  average hook latency: ${avg.toFixed(0)} ms (budget 400)`);
}

// 4. Journal far past rotation size, then build hints from it.
{
  const r = repo();
  await check("append 60k journal lines (rotation at 5 MB)", 20000, () => {
    for (let i = 0; i < 60000; i++) {
      appendJournal(r, {
        sid: "s_big",
        agent: "claude",
        kind: "edit",
        text: `edit ${i} ${"y".repeat(120)}`,
        files: [`src/f${i}.ts`],
      });
    }
    return `journal ${(statSync(join(r, ".handoff", "journal.jsonl")).size / 1e6).toFixed(1)} MB after rotation`;
  });
  await check("read journal tail", 1500, () => `${readJournal(r, "s_big").length} lines read`);
}

// 5. Huge agent output through a real supervised failover (fake agent prints ~30 MB).
{
  const scratch = mkdtempSync(join(tmpdir(), "nowall-stress-out-"));
  const r = join(scratch, "repo");
  const bin = join(scratch, "bin");
  mkdirSync(r);
  mkdirSync(bin);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: r });
  writeFileSync(join(r, "README.md"), "x\n");
  execFileSync("git", ["add", "."], { cwd: r });
  execFileSync("git", ["commit", "-qm", "i"], { cwd: r, env });
  for (const [name, agent] of [
    ["claude", "claude"],
    ["cursor-agent", "cursor"],
  ]) {
    writeFileSync(
      join(bin, name),
      `#!/bin/sh\ncase "$1" in --version) echo x; exit 0;; status) echo '{"isAuthenticated":true}'; exit 0;; esac\nexec "${process.execPath}" "${join(ROOT, "scripts", "fake-agent.mjs")}" ${agent} "$@"\n`,
      { mode: 0o755 },
    );
  }
  const plan = join(scratch, "plan.json");
  writeFileSync(
    plan,
    JSON.stringify({
      claude: [
        {
          prompt: "go",
          files: { "a.ts": "1" },
          limit: "You've hit your session limit · resets 11:59pm",
        },
      ],
      cursor: [
        {
          text: `${"z".repeat(20 * 1024 * 1024)}\n${"line\n".repeat(200000)}`,
          files: { "b.ts": "2" },
          tasks: {
            v: 1,
            updatedAt: "",
            updatedBy: "",
            tasks: [{ id: "1", title: "t", status: "done" }],
          },
        },
      ],
    }),
  );
  const home = mkdtempSync(join(tmpdir(), "nowall-stress-h-"));
  writeFileSync(join(home, "config.json"), JSON.stringify({ v: 1, order: ["claude", "cursor"] }));
  const e = {
    ...env,
    PATH: `${bin}:${env.PATH}`,
    NOWALL_HOME: home,
    FAKE_PLAN: plan,
    FAKE_NOWALL: `"${process.execPath}" "${CLI}"`,
  };
  spawnSync(process.execPath, [CLI, "init", "--yes"], { cwd: r, env: e });
  await check("failover with ~21 MB of agent output", 60000, () => {
    const res = spawnSync(process.execPath, [CLI, "run", "claude"], {
      cwd: r,
      env: e,
      maxBuffer: 256 * 1024 * 1024,
    });
    const tail = res.stdout.toString().slice(-4000);
    if (!tail.includes("Your task is done")) failures.push("huge output summary");
    return `exit ${res.status}, ${(res.stdout.length / 1e6).toFixed(1)} MB streamed`;
  });
}

console.log(
  failures.length
    ? `\n${failures.length} stress check(s) failed: ${failures.join(", ")}`
    : "\nAll stress checks passed.",
);
process.exit(failures.length ? 1 : 0);
