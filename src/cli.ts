#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { ADAPTERS, resolveBinary } from "./adapters/index.js";
import { defaultRunner } from "./adapters/types.js";
import { refreshAgents } from "./agents.js";
import { runDemo } from "./demo.js";
import { checkpoint, listCheckpoints, repoRoot, restore } from "./git.js";
import { handleHook, trustedRoot } from "./hooks.js";
import { runInit, runUninstall } from "./init.js";
import { agentName } from "./prompt.js";
import { AGENT_IDS, type AgentId, isAgentId } from "./schemas.js";
import {
  acquireLock,
  appendJournal,
  handoffProblem,
  isInitialized,
  loadSession,
  saveSession,
} from "./session.js";
import { runLogs, runSetup, runStatusline, runTeardown, startNotch, stopNotch } from "./setup.js";
import { isTrustedRepo, loadConfig, loadState } from "./state.js";
import { writeSummary } from "./summary.js";
import { type Deps, failover, fmtTime, runInteractive, startSession } from "./supervisor.js";

const VERSION = "0.1.0";

const HELP = `nowall ${VERSION}: when your coding agent hits its usage limit, the work keeps going.

Usage:
  nowall setup                turn nowall on for every project, find your agents, start the notch
  nowall init                 set up just this repo instead (hooks, consent, optional shell alias)
  nowall run <agent> [args]   run an agent under nowall (the shell alias does this for you)
  nowall status               agents, sign-in, cooldowns, last session
  nowall undo [step]          list checkpoints, or restore files to one
  nowall demo                 watch a simulated failover (no real agents, no usage)
  nowall logs [-f]            what a background takeover did (or is doing) in this repo
  nowall agents               which agents nowall found, sign-in, cooldowns, usage
  nowall notch [stop]         start or stop the macOS notch
  nowall note --task "..." [--status done|todo] | --decision "..."
  nowall uninstall [--global]  remove this repo's hooks (or, with --global, everything setup added)
`;

/** Agent invocations that are not interactive work sessions: pass straight through. */
const PASSTHROUGH_FLAGS = new Set([
  "-p",
  "--print",
  "-v",
  "--version",
  "-h",
  "--help",
  "-c",
  "--continue",
  "-r",
  "--resume",
]);
const CLAUDE_SUBCOMMANDS = new Set([
  "mcp",
  "config",
  "update",
  "doctor",
  "install",
  "setup-token",
  "plugin",
  "auth",
  "agents",
  "migrate-installer",
]);

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function availableBinaries(): Promise<Deps["binaries"]> {
  const config = loadConfig();
  const out: Deps["binaries"] = {};
  await Promise.all(
    AGENT_IDS.filter((id) => config.enabled[id]).map(async (id) => {
      const bin = resolveBinary(ADAPTERS[id].binary, process.argv[1]);
      if (!bin) return;
      const d = await ADAPTERS[id].detect(defaultRunner, bin);
      if (d.installed && d.signedIn !== false) out[id] = bin;
    }),
  );
  return out;
}

async function cmdRun(argv: string[]): Promise<number> {
  const agentArg = argv[0];
  if (!isAgentId(agentArg)) {
    process.stderr.write(`nowall run: unknown agent "${agentArg ?? ""}"\n`);
    return 2;
  }
  const agent: AgentId = agentArg;
  const args = argv.slice(1)[0] === "--" ? argv.slice(2) : argv.slice(1);
  const bin = resolveBinary(ADAPTERS[agent].binary, process.argv[1]);
  if (!bin) {
    process.stderr.write(
      `${agentName(agent)} is not installed. Install: ${ADAPTERS[agent].installHint}\n`,
    );
    return 127;
  }
  const root = repoRoot(process.cwd());
  const problem = root && isInitialized(root) ? handoffProblem(root) : null;
  if (problem) process.stderr.write(`nowall: not protecting this session: ${problem}.\n`);
  const passthrough =
    !root ||
    !isInitialized(root) ||
    !isTrustedRepo(root) ||
    problem !== null ||
    process.env.NOWALL_SID !== undefined ||
    process.env.NOWALL_DISABLE === "1" ||
    args.some((a) => PASSTHROUGH_FLAGS.has(a)) ||
    (agent === "claude" && CLAUDE_SUBCOMMANDS.has(args[0] ?? ""));
  if (passthrough || !root) {
    return spawnSync(bin, args, { stdio: "inherit" }).status ?? 1;
  }
  if (!acquireLock(root)) {
    process.stderr.write(
      "nowall: another nowall session is active in this repo; running without failover.\n",
    );
    return spawnSync(bin, args, { stdio: "inherit" }).status ?? 1;
  }

  const deps: Deps = {
    root,
    adapters: ADAPTERS,
    binaries: {},
    config: loadConfig(),
    now: () => new Date(),
    out: (s) => process.stdout.write(s),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
  const session = startSession(root, agent, deps.now());
  const { limit, exitCode } = await runInteractive(deps, session, agent, bin, args);

  if (!limit) {
    const seg = session.segments.at(-1);
    if (seg) {
      seg.endedAt = deps.now().toISOString();
      seg.endReason = "exit";
    }
    session.finished = { at: deps.now().toISOString(), reason: "complete" };
    saveSession(root, session);
    return exitCode;
  }

  deps.binaries = await availableBinaries();
  const hit = { kind: "quota" as const, window: limit.window, message: limit.message };
  await failover(deps, session, agent, limit.resetsAt ? { ...hit, resetsAt: limit.resetsAt } : hit);
  process.stdout.write(`\n${writeSummary(root, loadSession(root) ?? session)}\n`);
  return 0;
}

/** Continues a session whose agent nowall didn't launch (opened in a new Terminal by the hook). */
async function cmdTakeover(argv: string[]): Promise<number> {
  const root = trustedRoot(process.cwd());
  const from = flag(argv, "--from");
  const session = root ? loadSession(root) : null;
  if (
    !root ||
    !isAgentId(from) ||
    !session ||
    session.sid !== flag(argv, "--sid") ||
    session.finished
  ) {
    process.stderr.write("nowall takeover: nothing to take over here.\n");
    return 1;
  }
  if (!acquireLock(root)) {
    process.stderr.write(
      "nowall takeover: another nowall session is already running in this repo.\n",
    );
    return 1;
  }
  const last = loadState().agents[from]?.lastLimit;
  const limit = {
    kind: "quota" as const,
    window: last?.window ?? ("unknown" as const),
    message: last?.message ?? "usage limit reached",
  };
  const deps: Deps = {
    root,
    adapters: ADAPTERS,
    binaries: await availableBinaries(),
    config: loadConfig(),
    now: () => new Date(),
    out: (s) => process.stdout.write(s),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
  process.stdout.write(
    `${agentName(from)} hit its usage limit in ${root}.\nnowall is continuing the work here. Leave the ${agentName(from)} session paused until this finishes.\n`,
  );
  await failover(
    deps,
    session,
    from,
    last?.resetsAt ? { ...limit, resetsAt: last.resetsAt } : limit,
  );
  process.stdout.write(`\n${writeSummary(root, loadSession(root) ?? session)}\n`);
  return 0;
}

async function cmdHook(argv: string[]): Promise<number> {
  const name = argv[0] ?? "";
  const agent = flag(argv, "--agent");
  let input: Record<string, unknown> = {};
  try {
    const raw = readFileSync(0, "utf8");
    input = raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    // no/invalid stdin: still exit 0 so the agent is never disrupted
  }
  try {
    const out = handleHook(
      name,
      isAgentId(agent) ? agent : "claude",
      input,
      process.env,
      new Date(),
    );
    if (out) process.stdout.write(out);
  } catch {
    // hooks must never break the agent
  }
  return 0;
}

function cmdNote(argv: string[]): number {
  const root = repoRoot(process.cwd());
  if (!root || !isInitialized(root)) return 0;
  const agent = isAgentId(process.env.NOWALL_AGENT) ? process.env.NOWALL_AGENT : "claude";
  const sid = process.env.NOWALL_SID ?? loadSession(root)?.sid ?? "manual";
  const task = flag(argv, "--task");
  const decision = flag(argv, "--decision");
  const status = flag(argv, "--status");
  if (task) {
    appendJournal(root, {
      sid,
      agent,
      kind: "task",
      text: task,
      status: status === "todo" || status === "wip" ? status : "done",
    });
  }
  if (decision) appendJournal(root, { sid, agent, kind: "decision", text: decision });
  if (!task && !decision) {
    process.stderr.write('usage: nowall note --task "..." | --decision "..."\n');
    return 2;
  }
  return 0;
}

async function cmdStatus(): Promise<number> {
  const state = loadState();
  const now = new Date();
  process.stdout.write("Agents:\n");
  for (const id of AGENT_IDS) {
    const a = ADAPTERS[id];
    const bin = resolveBinary(a.binary, process.argv[1]);
    const d = bin ? await a.detect(defaultRunner, bin) : { installed: false, signedIn: false };
    const until = state.agents[id]?.cooldownUntil;
    const cooling =
      until && Date.parse(until) > now.getTime() ? `cooling down until ${fmtTime(until)}` : "";
    const signed =
      d.signedIn === "unknown" ? "" : d.signedIn ? "signed in" : `not signed in (${a.loginHint})`;
    const info = d.installed
      ? [signed, cooling, a.maturity === "beta" ? "beta" : ""].filter(Boolean).join(", ")
      : `not installed (${a.installHint})`;
    process.stdout.write(`  ${a.displayName.padEnd(12)} ${info}\n`);
  }
  const root = repoRoot(process.cwd());
  const s = root ? loadSession(root) : null;
  if (root && s) {
    process.stdout.write(`\nLast session ${s.sid} (${s.finished?.reason ?? "running"}):\n`);
    s.segments.forEach((seg, i) =>
      process.stdout.write(
        `  ${i + 1}. ${agentName(seg.agent)} ${seg.endReason ? `(${seg.endReason})` : ""}\n`,
      ),
    );
    process.stdout.write("Checkpoints (nowall undo <n>):\n");
    for (const c of listCheckpoints(root, s.sid)) {
      process.stdout.write(`  ${c.ref.split("/").pop()}  ${c.subject}\n`);
    }
  }
  return 0;
}

function cmdUndo(argv: string[]): number {
  const root = repoRoot(process.cwd());
  const s = root ? loadSession(root) : null;
  if (!root || !s) {
    process.stderr.write("nowall undo: no nowall session in this repo\n");
    return 1;
  }
  const cps = listCheckpoints(root, s.sid);
  const n = argv[0];
  const target = cps.find((c) => c.ref.endsWith(`/${n}`));
  if (n === undefined || !target) {
    for (const c of cps) process.stdout.write(`  ${c.ref.split("/").pop()}  ${c.subject}\n`);
    process.stdout.write("Restore with: nowall undo <n>\n");
    return n === undefined ? 0 : 1;
  }
  const safety = checkpoint(root, s.sid, s.checkpoints, `before undo to ${n}`);
  s.checkpoints += 1;
  saveSession(root, s);
  restore(root, target.commit);
  process.stdout.write(
    `Restored files to checkpoint ${n}. Your previous state is saved as ${safety.ref}.\n`,
  );
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "run":
      return cmdRun(rest);
    case "hook":
      return cmdHook(rest);
    case "note":
      return cmdNote(rest);
    case "status":
      return cmdStatus();
    case "undo":
      return cmdUndo(rest);
    case "init":
      return runInit(rest);
    case "takeover":
      return cmdTakeover(rest);
    case "demo":
      return runDemo();
    case "uninstall":
      return rest.includes("--global") ? runTeardown() : runUninstall();
    case "setup":
      return runSetup(rest);
    case "agents": {
      const snap = await refreshAgents();
      if (rest.includes("--write")) return 0;
      process.stdout.write(`${JSON.stringify(snap, null, 2)}\n`);
      return 0;
    }
    case "statusline": {
      let raw = "";
      try {
        raw = readFileSync(0, "utf8");
      } catch {
        // no input
      }
      return runStatusline(raw);
    }
    case "logs": {
      const root = repoRoot(process.cwd());
      if (!root) {
        process.stderr.write("nowall logs: run this inside a git repository.\n");
        return 1;
      }
      return runLogs(root, rest.includes("-f") || rest.includes("--follow"));
    }
    case "notch":
      if (rest[0] === "stop") {
        stopNotch();
        process.stdout.write("Notch stopped.\n");
        return 0;
      }
      process.stdout.write(`${startNotch()}\n`);
      return 0;
    case "-v":
    case "--version":
      process.stdout.write(`${VERSION}\n`);
      return 0;
    default:
      process.stdout.write(HELP);
      return cmd === undefined || cmd === "help" || cmd === "--help" || cmd === "-h" ? 0 : 2;
  }
}

/** Exit only after stdout/stderr are flushed; process.exit() alone truncates piped output. */
function exitAfterFlush(code: number): void {
  let pending = 2;
  const done = () => {
    pending -= 1;
    if (pending === 0) process.exit(code);
  };
  process.stdout.write("", done);
  process.stderr.write("", done);
}

main(process.argv.slice(2)).then(exitAfterFlush, (err: unknown) => {
  process.stderr.write(`nowall: ${err instanceof Error ? err.message : String(err)}\n`);
  exitAfterFlush(1);
});
