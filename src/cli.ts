#!/usr/bin/env node
import { readFileSync } from "node:fs";
import {
  KEY_ENV,
  accountEnv,
  accountFromEnv,
  accountName,
  addAccount,
  allAccounts,
  askHidden,
  loginArgs,
  nextLabel,
  profileFolder,
  profilePath,
  removeAccount,
  secretStoreName,
  setOrder,
  supportsExtraAccounts,
  validLabel,
} from "./accounts.js";
import { ADAPTERS, resolveBinary } from "./adapters/index.js";
import { defaultRunner } from "./adapters/types.js";
import {
  type AgentsSnapshot,
  agentsPath,
  refreshAgents,
  runAccountLogin,
  runAccountVerify,
  verifyAccounts,
} from "./agents.js";
import { runDemo } from "./demo.js";
import { readJsonSafe } from "./fsafe.js";
import { checkpoint, listCheckpoints, repoRoot, restore } from "./git.js";
import { handleHook, trustedRoot } from "./hooks.js";
import { runInit, runUninstall } from "./init.js";
import { runOpen } from "./open.js";
import { spawn, spawnSync } from "./proc.js";
import { agentName } from "./prompt.js";
import { AGENT_IDS, type AgentId, accountAgent, isAgentId } from "./schemas.js";
import {
  acquireLock,
  appendJournal,
  handoffProblem,
  isInitialized,
  loadSession,
  saveSession,
} from "./session.js";
import { notchStatus, runLogs, runSetup, runStatusline, startNotch, stopNotch } from "./setup.js";
import { isTrustedRepo, loadConfig, loadState, saveConfig } from "./state.js";
import { updateStatus } from "./status.js";
import { writeSummary } from "./summary.js";
import {
  type Deps,
  failover,
  fmtTime,
  requestCancel,
  runInteractive,
  startSession,
  watchCancelFile,
} from "./supervisor.js";
import { runCancel, runOff, runOn, runPause, runResume, runSwitch } from "./switch.js";
import { runTour } from "./tour.js";
import { runUninstallGlobal } from "./uninstall.js";

/** The installed package is the one place the version is written down. */
function packageVersion(): string {
  try {
    const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
    return (JSON.parse(raw) as { version: string }).version;
  } catch {
    return "unknown"; // hooks load this file, and must never fail over a version number
  }
}

const VERSION = packageVersion();

const HELP = `nowall ${VERSION}: when your coding agent hits its usage limit, the work keeps going.

Usage:
  nowall setup [--cli] [--yes] [--no-accounts] [--no-notch]
                              turn nowall on for every project: opens the setup window on a Mac
                              (--cli stays in the terminal), finds your agents, sets their
                              priority and the hotkey, starts the notch
  nowall tour                 what nowall does, how to read the notch, the commands
  nowall init                 set up just this repo instead (hooks, consent, optional shell alias)
  nowall run <agent> [args]   run an agent under nowall (the shell alias does this for you)
  nowall status               agents, sign-in, cooldowns, last session
  nowall undo [step]          list checkpoints, or restore files to one
  nowall demo                 watch a simulated failover (no real agents, no usage)
  nowall logs [-f]            what a background takeover did (or is doing) in this repo
  nowall agents               which agents nowall found, sign-in, cooldowns, usage
  nowall account add <agent> [label]   add a second login: opens that agent's own sign-in
  nowall account list|remove <id> [--purge]  list accounts, or forget one (--purge also deletes its login folder)
  nowall account login <id> | verify [id]    sign in again inside a profile; check every login (never prints keys)
  nowall switch [--to <id>] [--sid <sid>] [--repo <path>] [--latest]
                              hand a running session to the next account now
  nowall open --sid <sid>     bring that session's chat or terminal to the front
  nowall pause [30m|2h|1d]    no takeovers for a while (default 24 hours); nowall resume ends it
  nowall cancel [--sid <sid>] stop a takeover that's running, keeping its edits
  nowall off | on             no takeovers in this repo, or back on
  nowall order [id ...]       show or set the takeover priority (e.g. claude claude:work cursor)
  nowall notch [on|off|status] show or hide the notch or Windows tray app (off is remembered)
  nowall note --task "..." [--status done|todo] | --decision "..."
  nowall uninstall [--global]  remove this repo's hooks (or, with --global, everything setup added)
    --global [--yes] [--purge|--keep-data] [--repos] [--npm] [--dry-run]   purge: config, profiles, Keychain items
  nowall statusline [--then <cmd>]  Claude's status-line tap (installed by setup; chains your own)

Run \`nowall tour\` for the legend.
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

const QUICK_USAGE: Record<string, string> = {
  switch:
    "nowall switch [--latest] [--sid <sid>] [--repo <path>] [--to <account>]   hand a session to the next account now",
  cancel: "nowall cancel [--sid <sid>]   stop a takeover that's running, keeping its edits",
  open: "nowall open --sid <sid>   open a session's chat",
  pause: "nowall pause [30m|2h|1d|until-tomorrow]   stop every takeover (no duration: 24 hours)",
  resume: "nowall resume   end a pause",
  off: "nowall off   stop takeovers in this repo",
  on: "nowall on   allow takeovers in this repo again",
};

/** Value of `--name`, or undefined when missing / used as a bare flag (`--api-key` with no value). */
function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith("-")) return undefined;
  return v;
}

/**
 * Binaries of enabled agents, and the accounts whose login checked out (or couldn't be checked).
 * An extra account is only offered when its own profile or key is signed in.
 */
async function availableAccounts(): Promise<Pick<Deps, "binaries" | "accounts">> {
  const config = loadConfig();
  const binaries: Deps["binaries"] = {};
  const accounts = new Set<string>();
  await Promise.all(
    allAccounts(config)
      .filter((a) => config.enabled[a.agent] && config.order.includes(a.id))
      .map(async (a) => {
        const bin = resolveBinary(ADAPTERS[a.agent].binary, process.argv[1]);
        if (!bin) return;
        const env = accountEnv(config, a.id);
        const d = await ADAPTERS[a.agent].detect(
          defaultRunner,
          bin,
          a.id === a.agent ? undefined : env,
        );
        if (!d.installed || d.signedIn === false) return;
        binaries[a.agent] = bin;
        accounts.add(a.id);
      }),
  );
  return { binaries, accounts };
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

  Object.assign(deps, await availableAccounts());
  const hit = { kind: "quota" as const, window: limit.window, message: limit.message };
  const from = limit.account ?? accountFromEnv(agent, process.env);
  await failover(deps, session, from, limit.resetsAt ? { ...hit, resetsAt: limit.resetsAt } : hit);
  process.stdout.write(`\n${writeSummary(root, loadSession(root) ?? session)}\n`);
  return 0;
}

/** Continues a session whose agent nowall didn't launch (opened in a new Terminal by the hook). */
async function cmdTakeover(argv: string[]): Promise<number> {
  // `nowall cancel` can arrive between turns too, and must still end this cleanly.
  process.on("SIGINT", requestCancel);
  const root = trustedRoot(process.cwd());
  const from = flag(argv, "--from") ?? "";
  const session = root ? loadSession(root) : null;
  if (
    !root ||
    !accountAgent(from) ||
    !session ||
    session.sid !== flag(argv, "--sid") ||
    session.finished
  ) {
    process.stderr.write("nowall takeover: nothing to take over here.\n");
    return 1;
  }
  watchCancelFile(root);
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
    config: loadConfig(),
    now: () => new Date(),
    out: (s) => process.stdout.write(s),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    ...(await availableAccounts()),
  };
  // Clicking this session's bubble during a takeover opens its live log: it has no chat to go to.
  updateStatus(session.sid, root, {
    agent: accountAgent(from) ?? "claude",
    origin: { kind: "takeover" },
  });
  process.stdout.write(
    `${session.switch ? `Switching away from ${accountName(from)} as you asked` : `${accountName(from)} hit its usage limit`} in ${root}.\nnowall is continuing the work here. Leave the ${accountName(from)} session paused until this finishes.\n`,
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
  const config = loadConfig();
  const now = new Date();
  process.stdout.write("Accounts (takeover order):\n");
  for (const acc of allAccounts(config)) {
    const a = ADAPTERS[acc.agent];
    const bin = resolveBinary(a.binary, process.argv[1]);
    const env = acc.id === acc.agent ? undefined : accountEnv(config, acc.id);
    const d = bin ? await a.detect(defaultRunner, bin, env) : { installed: false, signedIn: false };
    const until = state.agents[acc.id]?.cooldownUntil;
    const cooling =
      until && Date.parse(until) > now.getTime() ? `cooling down until ${fmtTime(until)}` : "";
    const signed =
      d.signedIn === "unknown" ? "" : d.signedIn ? "signed in" : `not signed in (${a.loginHint})`;
    const off = config.order.includes(acc.id) ? "" : "off (not in order)";
    const info = d.installed
      ? [signed, cooling, off, a.maturity === "beta" ? "beta" : ""].filter(Boolean).join(", ")
      : `not installed (${a.installHint})`;
    process.stdout.write(`  ${accountName(acc.id).padEnd(22)} ${info}\n`);
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

function printAccounts(): void {
  const config = loadConfig();
  const snap = readJsonSafe<AgentsSnapshot>(agentsPath());
  process.stdout.write("Accounts, in takeover order (first is tried first):\n");
  allAccounts(config).forEach((a, i) => {
    const on = config.order.includes(a.id);
    const info = snap?.accounts?.find((x) => x.id === a.id);
    const signed =
      info?.signedIn === false ? "not signed in" : info?.signedIn === true ? "signed in" : "";
    const where = a.env ? profileFolder(a) : a.secret ? `API key (${a.secret.store})` : "";
    process.stdout.write(
      `  ${on ? `${i + 1}.` : " -"} ${a.id.padEnd(20)} ${accountName(a.id).padEnd(24)} ${[on ? "" : "off", signed, where].filter(Boolean).join("  ")}\n`,
    );
  });
  process.stdout.write(
    "\nReorder: nowall order <id> <id> ...   Add: nowall account add <claude|codex|cursor> [label]\n",
  );
}

/** `nowall account add|remove|list`: extra logins, each in its own profile or with its own key. */
/** Runs an agent's own sign-in. Being stopped midway runs `onStop` first, so nothing is left half done. */
function runLogin(
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  onStop: () => void,
): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: "inherit", env });
    const stop = () => {
      child.kill("SIGTERM");
      onStop();
      process.exit(130);
    };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    const done = (code: number | null) => {
      process.off("SIGTERM", stop);
      process.off("SIGINT", stop);
      resolve(code);
    };
    child.on("error", () => done(null));
    child.on("close", done);
  });
}

async function cmdAccount(argv: string[]): Promise<number> {
  const [sub, agentArg, rawLabel] = argv;
  const usage =
    "usage: nowall account add <claude|codex|cursor> [label] [--api-key <key>] | remove <id> | list\n";
  // `add` opens a real sign-in, so asking how it works or a flag it can't read must never start one.
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(usage);
    return 0;
  }
  if (sub === undefined || sub === "list" || sub === "ls") {
    printAccounts();
    return 0;
  }
  if (sub === "login") return runAccountLogin(argv.slice(1));
  if (sub === "verify") return runAccountVerify(argv.slice(1));
  if (sub === "remove" || sub === "rm") {
    const purge = argv.includes("--purge");
    const removed = agentArg ? removeAccount(agentArg, { purge }) : null;
    if (!removed) {
      process.stderr.write(`nowall account remove: no extra account "${agentArg ?? ""}".\n`);
      return 1;
    }
    const dir = profilePath(removed);
    process.stdout.write(
      `Removed ${accountName(removed.id)} from nowall.${
        dir
          ? purge
            ? ` Its login folder ${dir} was deleted.`
            : ` Its login stays in ${dir}; delete that folder to log it out (or re-run with --purge).`
          : ""
      }\n`,
    );
    await refreshAgents();
    return 0;
  }
  if (sub !== "add" || !isAgentId(agentArg)) {
    process.stderr.write(usage);
    return 2;
  }
  const known = new Set(["--api-key", "--no-login"]);
  const unknownFlag = argv.slice(2).find((a) => a.startsWith("-") && !known.has(a));
  if (unknownFlag && flag(argv, "--api-key") !== unknownFlag) {
    process.stderr.write(`nowall account add: unknown option "${unknownFlag}". Nothing added.\n`);
    return 2;
  }
  if (!supportsExtraAccounts(agentArg)) {
    process.stderr.write(`${agentName(agentArg)} doesn't support extra accounts yet.\n`);
    return 1;
  }
  const label = rawLabel && !rawLabel.startsWith("-") ? rawLabel : nextLabel(agentArg);
  if (!validLabel(label)) {
    process.stderr.write("Label: letters, digits, - or _, up to 24 characters (e.g. work).\n");
    return 2;
  }
  const bin = resolveBinary(ADAPTERS[agentArg].binary, process.argv[1]);
  if (!bin) {
    process.stderr.write(
      `${agentName(agentArg)} is not installed. Install: ${ADAPTERS[agentArg].installHint}\n`,
    );
    return 127;
  }
  try {
    if (KEY_ENV[agentArg] && argv.includes("--api-key")) {
      let key = flag(argv, "--api-key") ?? process.env[KEY_ENV[agentArg] as string] ?? "";
      if (!key) {
        process.stdout.write(
          `Create a key while signed in to that account at https://cursor.com/settings (API keys).\nnowall keeps it in your ${secretStoreName()} and only passes it to cursor-agent.\n`,
        );
        key = await askHidden("Paste the API key: ");
      }
      if (!key) {
        process.stderr.write(
          "No key given; nothing changed. Paste one when prompted, or pass it: nowall account add cursor <label> --api-key <key>\n",
        );
        return 1;
      }
      const account = addAccount(agentArg, label, { apiKey: key });
      process.stdout.write(`Added ${accountName(account.id)} (key in ${account.secret?.store}).\n`);
    } else {
      const account = addAccount(agentArg, label);
      if (!argv.includes("--no-login")) {
        process.stdout.write(
          `Sign in with the other ${agentName(agentArg)} account. This login is kept apart from your main one.\nIf the website signs you straight in to your usual account, log out there first.\n\n`,
        );
        // An account that didn't end up as a new, working login is taken back out, folder and all.
        const undo = () => removeAccount(account.id, { purge: true });
        const status = await runLogin(
          bin,
          loginArgs(agentArg) ?? ["login"],
          { ...process.env, ...(account.env ?? {}) },
          undo,
        );
        const fail = async (message: string, code: number): Promise<number> => {
          undo();
          await refreshAgents();
          process.stderr.write(`${message}\n`);
          return code;
        };
        if (status !== 0) return fail("Sign-in didn't finish, so nothing was added.", 1);
        const [row] = await verifyAccounts([account.id]);
        if (row?.problem?.includes("same login as")) {
          return fail(
            `That's the ${agentName(agentArg)} account you already have here, so nothing was added. To add a different one, log out on the website and try again.`,
            3,
          );
        }
        if (row?.signedIn === false) {
          return fail("That sign-in didn't take, so nothing was added.", 1);
        }
      }
      process.stdout.write(`\nAdded ${accountName(account.id)}.\n`);
    }
  } catch (err) {
    process.stderr.write(
      `nowall account add: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
  await refreshAgents(); // so the notch and `nowall agents` see it right away
  printAccounts();
  return 0;
}

/** `nowall order [id ...]`: show or set the takeover priority. */
async function cmdOrder(argv: string[]): Promise<number> {
  if (argv.length === 0) {
    printAccounts();
    return 0;
  }
  try {
    const config = setOrder(argv);
    process.stdout.write(`Takeover order: ${config.order.map(accountName).join(" → ")}\n`);
  } catch (err) {
    process.stderr.write(`nowall order: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  await refreshAgents();
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
      return rest.includes("--global") ? runUninstallGlobal(rest) : runUninstall();
    case "setup":
      return runSetup(rest);
    case "account":
    case "accounts":
      return cmdAccount(rest);
    case "order":
      return cmdOrder(rest);
    case "agents": {
      const snap = await refreshAgents(
        undefined,
        undefined,
        rest.includes("--fresh") ? { force: true } : {},
      );
      if (rest.includes("--write")) return 0;
      process.stdout.write(`${JSON.stringify(snap, null, 2)}\n`);
      return 0;
    }
    case "switch":
    case "cancel":
    case "open":
    case "pause":
    case "resume":
    case "off":
    case "on":
      // These act the moment they run, so asking how they work has to stop here.
      if (rest.includes("--help") || rest.includes("-h")) {
        process.stdout.write(`usage: ${QUICK_USAGE[cmd]}\n`);
        return 0;
      }
      if (cmd === "switch") return runSwitch(rest);
      if (cmd === "cancel") return runCancel(rest);
      if (cmd === "open") return runOpen(rest);
      if (cmd === "pause") return runPause(rest);
      if (cmd === "resume") return runResume();
      return cmd === "off" ? runOff() : runOn();
    case "statusline": {
      let raw = "";
      try {
        raw = readFileSync(0, "utf8");
      } catch {
        // no input
      }
      return runStatusline(raw, process.env, rest);
    }
    case "tour":
      return runTour(rest);
    case "logs": {
      const root = repoRoot(process.cwd());
      if (!root) {
        process.stderr.write("nowall logs: run this inside a git repository.\n");
        return 1;
      }
      return runLogs(root, rest.includes("-f") || rest.includes("--follow"));
    }
    case "notch":
      if (rest[0] === "status") {
        process.stdout.write(`${notchStatus()}\n`);
        return 0;
      }
      if (rest[0] === "stop" || rest[0] === "off") {
        stopNotch();
        const config = loadConfig();
        config.notch = false;
        saveConfig(config);
        process.stdout.write(
          "Notch is off. nowall keeps working in the background. Turn it back on with: nowall notch on\n",
        );
        return 0;
      }
      {
        const config = loadConfig();
        config.notch = true;
        saveConfig(config);
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
