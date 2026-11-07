import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { accountName, findAccount } from "./accounts.js";
import { ADAPTERS, resolveBinary } from "./adapters/index.js";
import { refreshAgents } from "./agents.js";
import { readJsonSafe, writeAtomic } from "./fsafe.js";
import { excludeLocally, repoRoot } from "./git.js";
import { ensureExternalSession, launchTakeover, trustedRoot } from "./hooks.js";
import { OFF_MARKER, pausedUntil, takeoverBlocked } from "./pause.js";
import { commandLineOf, isWindows } from "./proc.js";
import { type AccountId, type AgentId, type Config, accountAgent } from "./schemas.js";
import {
  type LimitSignal,
  type Session,
  cancelPath,
  handoffDir,
  handoffProblem,
  isLocked,
  loadSession,
  lockHolder,
  saveSession,
  signalPath,
} from "./session.js";
import { earliestReset, loadConfig, loadState, pickNext, saveConfig, writeJson } from "./state.js";
import { type SessionStatus, statusDir, updateStatus } from "./status.js";
import { fmtTime } from "./supervisor.js";

/**
 * `nowall switch`: hand a live session to the next account on request, without waiting for a
 * limit. `nowall pause` / `resume` stop and restart every takeover; `nowall off` / `on` do the
 * same for one repository. Exit codes for `switch`: 0 switched, 2 nothing to switch (or paused,
 * off, bad usage), 3 no account can take over.
 */

// --- pause / per-repo off ---------------------------------------------------------------------

const DURATION_RE = /^(\d+(?:\.\d+)?)\s*(m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)$/i;

/** "30m", "2h", "1d" or "until-tomorrow" → when the pause ends; null when it can't be read. */
export function parsePauseUntil(spec: string | undefined, now = new Date()): Date | null {
  if (!spec) return new Date(now.getTime() + 24 * 3600_000);
  const s = spec.trim().toLowerCase();
  if (s === "until-tomorrow" || s === "tomorrow") {
    const d = new Date(now);
    d.setHours(24, 0, 0, 0); // next local midnight
    return d;
  }
  const m = DURATION_RE.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] ?? "m")[0];
  const ms = n * (unit === "d" ? 86_400_000 : unit === "h" ? 3_600_000 : 60_000);
  if (!Number.isFinite(ms) || ms <= 0 || ms > 365 * 86_400_000) return null;
  return new Date(now.getTime() + ms);
}

/** `nowall pause [--for] [30m|2h|1d|until-tomorrow]` (default: 24 hours). */
export function runPause(argv: string[], now = new Date()): number {
  const i = argv.indexOf("--for");
  const spec = i >= 0 ? argv[i + 1] : argv.find((a) => !a.startsWith("-"));
  const until = parsePauseUntil(spec, now);
  if (!until) {
    process.stderr.write(
      "usage: nowall pause [30m|2h|1d|until-tomorrow]   (no duration: 24 hours)\n",
    );
    return 2;
  }
  const config = loadConfig();
  config.pausedUntil = until.toISOString();
  saveConfig(config);
  process.stdout.write(
    `nowall is paused until ${fmtTime(until.toISOString())}. Sessions still show in the notch; nothing takes over. Resume sooner with: nowall resume\n`,
  );
  return 0;
}

/** `nowall resume`: clears the pause. */
export function runResume(now = new Date()): number {
  const config = loadConfig();
  const was = pausedUntil(config, now);
  config.pausedUntil = undefined;
  saveConfig(config);
  process.stdout.write(was ? "nowall is back on.\n" : "nowall wasn't paused; nothing changed.\n");
  return 0;
}

/** `nowall off`: hooks and takeovers ignore this repo until `nowall on`. */
export function runOff(cwd = process.cwd()): number {
  const root = repoRoot(cwd);
  if (!root) {
    process.stderr.write("nowall off: run this inside a git repository.\n");
    return 2;
  }
  const problem = handoffProblem(root);
  if (problem) {
    process.stderr.write(`nowall off: ${problem}; nowall already ignores this repo.\n`);
    return 2;
  }
  try {
    mkdirSync(handoffDir(root), { recursive: true });
    excludeLocally(root, ".handoff/");
    writeAtomic(
      join(handoffDir(root), OFF_MARKER),
      "nowall is off in this repository. Delete this file or run `nowall on` to turn it back on.\n",
    );
  } catch (err) {
    process.stderr.write(`nowall off: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  process.stdout.write(
    `nowall is off in ${root}. Other repos are unaffected. Turn it back on with: nowall on\n`,
  );
  return 0;
}

/** `nowall on`: removes the per-repo marker. */
export function runOn(cwd = process.cwd()): number {
  const root = repoRoot(cwd);
  if (!root) {
    process.stderr.write("nowall on: run this inside a git repository.\n");
    return 2;
  }
  const marker = join(handoffDir(root), OFF_MARKER);
  if (!existsSync(marker)) {
    process.stdout.write("nowall was already on in this repo.\n");
    return 0;
  }
  rmSync(marker, { force: true });
  process.stdout.write(`nowall is on again in ${root}.\n`);
  return 0;
}

// --- switch ---------------------------------------------------------------------------------

const LIVE_PHASES = new Set(["idle", "working", "needs-input", "your-turn", "handing-off"]);
const LIVE_MAX_AGE_MS = 6 * 3600_000;

export interface SwitchTarget {
  sid: string;
  root: string;
  agent: AgentId;
  /** Account the session runs as (the agent id for its default login). */
  from: AccountId;
}

function realish(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** Status files of sessions that are still going (active phase, touched recently), newest first. */
export function liveStatuses(now = new Date()): SessionStatus[] {
  let names: string[];
  try {
    names = readdirSync(statusDir()).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const out: SessionStatus[] = [];
  for (const name of names) {
    const s = readJsonSafe<SessionStatus>(join(statusDir(), name), 64 * 1024);
    if (!s || s.v !== 1 || typeof s.sid !== "string" || typeof s.repo !== "string") continue;
    if (!LIVE_PHASES.has(s.phase)) continue;
    if ((s as { parentSid?: string }).parentSid) continue; // a subagent: switch the parent chat
    const age = now.getTime() - Date.parse(s.updatedAt);
    if (!Number.isFinite(age) || age > LIVE_MAX_AGE_MS) continue;
    out.push(s);
  }
  return out.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

function targetFromStatus(s: SessionStatus): SwitchTarget {
  const root = repoRoot(s.repo) ?? s.repo;
  return { sid: s.sid, root, agent: s.agent, from: s.account ?? s.agent };
}

function targetFromSession(root: string, s: Session): SwitchTarget | null {
  const seg = s.segments.at(-1);
  if (!seg || s.finished) return null;
  return { sid: s.sid, root, agent: seg.agent, from: seg.account ?? seg.agent };
}

/**
 * Which session `nowall switch` acts on: `--sid`, else the newest live one in `--repo`/the
 * current repo (falling back to the repo's unfinished session.json), else with `--latest` the
 * newest live one anywhere. Returns a message when nothing fits.
 */
export function resolveTarget(
  opts: { sid?: string; repo?: string; latest?: boolean; cwd?: string },
  now = new Date(),
): SwitchTarget | string {
  const live = liveStatuses(now);
  if (opts.sid) {
    const s = live.find((x) => x.sid === opts.sid);
    if (s) return targetFromStatus(s);
    const root = repoRoot(opts.repo ?? opts.cwd ?? process.cwd());
    const session = root ? loadSession(root) : null;
    const t = root && session?.sid === opts.sid ? targetFromSession(root, session) : null;
    return t ?? `no live session ${opts.sid}`;
  }
  const here = opts.repo ?? (opts.latest ? null : (opts.cwd ?? process.cwd()));
  if (here) {
    const root = repoRoot(here);
    if (!root) return `${here} is not inside a git repository (pass --latest or --sid)`;
    const real = realish(root);
    const s = live.find((x) => realish(x.repo) === real);
    if (s) return targetFromStatus(s);
    const session = loadSession(root);
    const t = session ? targetFromSession(root, session) : null;
    return t ?? `no live session in ${root}`;
  }
  const s = live[0];
  return s ? targetFromStatus(s) : "no live session anywhere";
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

/**
 * Accounts that could take over right now: in the order, agent enabled and installed, login not
 * known to be missing. Sign-in comes from `refreshAgents`, which caches checks for 10 minutes.
 */
async function candidateAccounts(): Promise<Set<AccountId>> {
  const snap = await refreshAgents();
  const out = new Set<AccountId>();
  for (const a of snap.accounts) {
    if (!a.active || a.signedIn === false) continue;
    if (!resolveBinary(ADAPTERS[a.agent].binary, process.argv[1])) continue;
    out.add(a.id);
  }
  return out;
}

/** The newest takeover still running, or the one named by `sid`. */
function runningTakeover(sid: string | undefined, now: Date): SessionStatus | undefined {
  return liveStatuses(now).find(
    (s) =>
      (sid === undefined || s.sid === sid) &&
      (s.origin?.kind === "takeover" || s.phase === "handing-off"),
  );
}

/** Only ever signal a process that really is this session's takeover: pids get reused. */
function isTakeoverProcess(pid: number, sid: string): boolean {
  const words = commandLineOf(pid).replace(/"/g, "").trim().split(/\s+/);
  return words.includes("takeover") && words.includes(sid);
}

/** Tells a takeover to stop and clean up after itself (see `watchCancelFile`). */
export function sendCancel(pid: number, root: string, windows = isWindows): void {
  if (windows) writeAtomic(cancelPath(root), `${pid}\n`);
  else process.kill(pid, "SIGINT");
}

/**
 * `nowall cancel [--sid <sid>]`: stops a running takeover and keeps what it has done so far, as a
 * checkpoint. Exit codes: 0 stopped, 2 nothing to stop, 1 it didn't stop in time.
 */
export function runCancel(argv: string[], now = new Date(), waitMs = 15_000): number {
  const err = (s: string) => process.stderr.write(`nowall cancel: ${s}\n`);
  const target = runningTakeover(flag(argv, "--sid"), now);
  if (!target) {
    err("no takeover is running.");
    return 2;
  }
  const pid = lockHolder(target.repo);
  if (pid === null || !isTakeoverProcess(pid, target.sid)) {
    err(`no takeover is running for ${target.repoName}.`);
    return 2;
  }
  sendCancel(pid, target.repo);
  const deadline = Date.now() + waitMs;
  const nap = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < deadline && lockHolder(target.repo) === pid) Atomics.wait(nap, 0, 0, 100);
  if (lockHolder(target.repo) === pid) {
    err(`${target.repoName} hasn't stopped yet (process ${pid}). It may still be finishing up.`);
    return 1;
  }
  process.stdout.write(
    `Stopped the takeover in ${target.repoName}. Its edits are still in your files; \`nowall undo\` lists the checkpoints if you want them gone.\n`,
  );
  return 0;
}

function unknownSwitchArg(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--latest") continue;
    if (a === "--sid" || a === "--repo" || a === "--to") {
      i++;
      continue;
    }
    return a;
  }
  return undefined;
}

/** `nowall switch [--to <account>] [--sid <sid>] [--repo <path>] [--latest]`. */
export async function runSwitch(argv: string[], now = new Date()): Promise<number> {
  const err = (s: string) => process.stderr.write(`nowall switch: ${s}\n`);
  // A switch starts real work on someone's account, so an argument it can't read must never start one.
  const unknown = unknownSwitchArg(argv);
  if (unknown !== undefined) {
    err(`unknown argument "${unknown}". Nothing switched.`);
    return 2;
  }
  const resolved = resolveTarget(
    {
      sid: flag(argv, "--sid"),
      repo: flag(argv, "--repo"),
      latest: argv.includes("--latest"),
    },
    now,
  );
  if (typeof resolved === "string") {
    err(`${resolved}. Nothing to switch.`);
    return 2;
  }
  const { sid, agent, from } = resolved;
  const root = trustedRoot(resolved.root);
  if (!root) {
    err(`nowall isn't set up for ${resolved.root}. Nothing to switch.`);
    return 2;
  }
  const blocked = takeoverBlocked(root, now);
  if (blocked) {
    err(`${blocked}.`);
    return 2;
  }
  const holder = lockHolder(root);
  if (holder !== null && isTakeoverProcess(holder, sid)) {
    err("this session is already being taken over. Stop it with: nowall cancel");
    return 2;
  }

  const config = loadConfig();
  const state = loadState();
  const to = flag(argv, "--to");
  if (to !== undefined) {
    if (!findAccount(config, to)) {
      err(`unknown account "${to}". See: nowall account list`);
      return 2;
    }
    if (to === from) {
      err(`${accountName(from)} is already working on this session.`);
      return 2;
    }
  }
  const candidates = await candidateAccounts();
  candidates.delete(from);
  let next: AccountId | null;
  if (to !== undefined) {
    if (!candidates.has(to)) {
      const why = !resolveBinary(ADAPTERS[accountAgent(to) ?? "claude"].binary, process.argv[1])
        ? "isn't installed"
        : !config.order.includes(to)
          ? "is off (not in the takeover order)"
          : "isn't signed in";
      err(`${accountName(to)} ${why}.`);
      return 3;
    }
    next = to;
  } else {
    next = pickNext(config, state, candidates, [from], now);
  }
  if (!next) {
    const er = earliestReset(state, now);
    err(
      `no account can take over right now${er ? `; ${accountName(er.account)} resets ${fmtTime(er.at)}` : ""}. Check: nowall agents`,
    );
    return 3;
  }

  const session = loadSession(root);
  const last = session?.segments.at(-1);
  if (isLocked(root)) {
    if (session?.sid === sid && last?.mode === "interactive" && !last.endedAt) {
      // `nowall run` is supervising this session: the wrapper stops the agent and fails over.
      const signal: LimitSignal = {
        agent,
        sid,
        window: "unknown",
        message: "switched by you",
        observedAt: now.toISOString(),
        kind: "manual",
      };
      if (from !== agent) signal.account = from;
      if (to !== undefined) signal.to = to;
      writeJson(signalPath(root, sid), signal);
      updateStatus(sid, root, {
        agent,
        ...(from !== agent ? { account: from } : {}),
        phase: "handing-off",
        detail: `Switching to ${accountName(next)} on request`,
      });
      process.stdout.write(
        `Handing off from ${accountName(from)} to ${accountName(next)}. The nowall run session will print the summary.\n`,
      );
      return 0;
    }
    err("a nowall takeover is already running in this repo (nowall logs -f).");
    return 2;
  }

  // A session nowall didn't launch (desktop app, IDE chat, plain terminal): background takeover.
  ensureExternalSession(root, sid, agent, now);
  const s = loadSession(root);
  if (!s || s.sid !== sid) {
    err("couldn't attach to this session (another nowall process got there first). Try again.");
    return 2;
  }
  if (s.finished) {
    // A chat that kept going after an earlier takeover finished: reopen the session.
    s.finished = undefined;
    s.segments.push({ agent, mode: "interactive", startedAt: now.toISOString() });
  }
  s.switch = { from, at: now.toISOString() };
  if (to !== undefined) s.switch.to = to;
  saveSession(root, s);
  updateStatus(sid, root, {
    agent,
    ...(from !== agent ? { account: from } : {}),
    phase: "handing-off",
    detail: `Switching to ${accountName(next)} on request`,
  });
  launchTakeover(root, sid, from, process.env);
  process.stdout.write(
    `Handing off from ${accountName(from)} to ${accountName(next)} in the background. Watch it: nowall logs -f\n`,
  );
  return 0;
}
