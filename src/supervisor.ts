import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { createInterface } from "node:readline";
import { accountEnv, accountName, allAccounts } from "./accounts.js";
import type { AgentAdapter } from "./adapters/types.js";
import { readJsonSafe, sanitizeTerminal } from "./fsafe.js";
import { checkpoint, shortStat, snapshotTree } from "./git.js";
import { isAuthError } from "./limits.js";
import { buildPacket } from "./packet.js";
import { agentName, continuePrompt, masterPrompt } from "./prompt.js";
import { loadEnvValues, redact } from "./redact.js";
import {
  type AccountId,
  type AgentId,
  type Config,
  type LimitHit,
  accountAgent,
} from "./schemas.js";
import {
  type LimitSignal,
  type Segment,
  type Session,
  type StopReason,
  appendJournal,
  archiveTasks,
  loadSession,
  newSessionId,
  readTasks,
  remainingTasks,
  saveSession,
  signalPath,
} from "./session.js";
import { earliestReset, loadState, pickNext, recordLimit, saveState } from "./state.js";
import { type Phase, describeTool, updateStatus } from "./status.js";

export interface Deps {
  root: string;
  adapters: Record<AgentId, AgentAdapter>;
  /** Resolved binaries of agents that are installed (and not known to be signed out). */
  binaries: Partial<Record<AgentId, string>>;
  /**
   * Accounts that may take over. Absent: every configured account whose agent has a binary.
   * The CLI narrows it to accounts whose login checked out.
   */
  accounts?: ReadonlySet<AccountId>;
  config: Config;
  now: () => Date;
  out: (s: string) => void;
  sleep: (ms: number) => Promise<void>;
  pollMs?: number;
}

export function startSession(root: string, agent: AgentId, now: Date): Session {
  const sid = newSessionId();
  archiveTasks(root);
  const base = checkpoint(root, sid, 0, `nowall: session start (${agent})`);
  const session: Session = {
    v: 1,
    sid,
    startedAt: now.toISOString(),
    baseCommit: base.commit,
    checkpoints: 1,
    segments: [],
  };
  saveSession(root, session);
  return session;
}

/** Reuses an unfinished session in this repo, or starts a new one. */
export function currentOrNewSession(root: string, agent: AgentId, now: Date): Session {
  const s = loadSession(root);
  return s && !s.finished ? s : startSession(root, agent, now);
}

function takeCheckpoint(root: string, session: Session, label: string) {
  const cp = checkpoint(root, session.sid, session.checkpoints, `nowall: ${label}`);
  session.checkpoints += 1;
  return cp;
}

const MAX_DISPLAY = 20_000;
/** Keeps a runaway single message from flooding the terminal (the agent's own log keeps it all). */
const clip = (s: string) =>
  s.length > MAX_DISPLAY
    ? `${s.slice(0, MAX_DISPLAY)}… [${s.length - MAX_DISPLAY} more characters not shown]`
    : s;

const dim = (s: string) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);

/**
 * Runs an agent interactively with the user's terminal. Resolves early with the limit
 * signal if the agent's hook reports a usage limit (the agent would otherwise sit waiting).
 */
export async function runInteractive(
  deps: Deps,
  session: Session,
  agent: AgentId,
  bin: string,
  args: string[],
): Promise<{ limit: LimitSignal | null; exitCode: number }> {
  const sigFile = signalPath(deps.root, session.sid);
  rmSync(sigFile, { force: true });
  session.segments.push({ agent, mode: "interactive", startedAt: deps.now().toISOString() });
  saveSession(deps.root, session);

  const child = spawn(bin, args, {
    stdio: "inherit",
    env: { ...process.env, NOWALL_SID: session.sid, NOWALL_ROOT: deps.root },
  });
  const ignoreInt = () => {};
  process.on("SIGINT", ignoreInt); // the agent owns Ctrl-C while it is in the foreground

  let limit: LimitSignal | null = null;
  const readSignal = () => {
    if (limit || !existsSync(sigFile)) return;
    const sig = readJsonSafe<LimitSignal>(sigFile, 64 * 1024);
    if (!sig || sig.sid !== session.sid) return; // unreadable or not ours: ignore
    limit = sig;
    child.kill("SIGTERM");
    setTimeout(() => child.exitCode === null && child.kill("SIGKILL"), 3000).unref();
  };
  const timer = setInterval(readSignal, deps.pollMs ?? 500);

  const exitCode = await new Promise<number>((resolve) => {
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 128 : 1)));
    child.on("error", () => resolve(127));
  });
  clearInterval(timer);
  readSignal();
  process.off("SIGINT", ignoreInt);
  rmSync(sigFile, { force: true });
  if (limit && process.stdout.isTTY) process.stdout.write("\x1b[?1049l\x1b[?25h\n"); // restore TTY

  return { limit, exitCode };
}

export interface TurnResult {
  sessionId?: string;
  limit: LimitHit | null;
  isError: boolean;
  /** The agent isn't signed in / its login expired: skip it, don't count it as a failure. */
  authError: boolean;
  exitCode: number;
  interrupted: boolean;
}

export async function runHeadlessTurn(
  deps: Deps,
  session: Session,
  adapter: AgentAdapter,
  bin: string,
  prompt: string,
  resumeId: string | undefined,
  account: AccountId = adapter.id,
): Promise<TurnResult> {
  const opts = resumeId
    ? { prompt, resumeId, yolo: deps.config.yolo }
    : { prompt, yolo: deps.config.yolo };
  const { args, env } = adapter.headless(opts);
  const child = spawn(bin, args, {
    cwd: deps.root,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      ...accountEnv(deps.config, account), // profile dir or API key that selects this login
      ...env,
      NOWALL_SID: session.sid,
      NOWALL_AGENT: adapter.id,
      NOWALL_ROOT: deps.root,
    },
  });
  let interrupted = false;
  const onInt = () => {
    interrupted = true;
    child.kill("SIGTERM");
  };
  process.once("SIGINT", onInt);

  const result: TurnResult = {
    limit: null,
    isError: false,
    authError: false,
    exitCode: 0,
    interrupted: false,
  };
  const errorTexts: string[] = [];
  let sawDone = false;
  let lastStatus = 0;
  let stderr = "";
  child.stderr?.on("data", (d: Buffer) => {
    stderr = (stderr + d.toString()).slice(-8192);
  });
  if (!child.stdout) throw new Error(`could not read ${adapter.displayName} output`);
  const rl = createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    for (const ev of adapter.parseLine(line)) {
      switch (ev.kind) {
        case "session":
          result.sessionId = ev.id;
          break;
        case "text":
          deps.out(`${sanitizeTerminal(redact(clip(ev.text)))}\n`);
          break;
        case "tool":
          if (Date.now() - lastStatus > 1000) {
            lastStatus = Date.now();
            updateStatus(session.sid, deps.root, {
              agent: adapter.id,
              phase: "working",
              detail: describeTool(ev.name, ev.files?.[0], ev.detail),
            });
          }
          deps.out(
            dim(
              `  · ${sanitizeTerminal(`${ev.name} ${redact((ev.files ?? []).join(" ") || (ev.detail ?? ""))}`).slice(0, 120)}\n`,
            ),
          );
          break;
        case "error":
          errorTexts.push(ev.text);
          break;
        case "done":
          sawDone = true;
          if (ev.isError) {
            result.isError = true;
            if (ev.text) errorTexts.push(ev.text);
          }
          break;
      }
    }
  });

  result.exitCode = await new Promise<number>((resolve) => {
    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(127));
  });
  process.off("SIGINT", onInt);
  result.interrupted = interrupted;
  if (!sawDone && result.exitCode !== 0) result.isError = true;
  if (stderr.trim()) errorTexts.push(stderr);

  const now = deps.now();
  for (const t of errorTexts) {
    const hit = adapter.detectLimit(t, now);
    if (hit && (!result.limit || (result.limit.kind === "transient" && hit.kind === "quota")))
      result.limit = hit;
  }
  if (!result.limit && result.isError) result.authError = errorTexts.some(isAuthError);
  return result;
}

/** Accounts that can take over right now: configured, agent binary present, login not ruled out. */
function available(deps: Deps): Set<AccountId> {
  const out = new Set<AccountId>();
  for (const a of allAccounts(deps.config)) {
    if (!deps.binaries[a.agent]) continue;
    if (deps.accounts && !deps.accounts.has(a.id)) continue;
    out.add(a.id);
  }
  return out;
}

/**
 * Hands off from `from` (the account that just hit `limit`) and supervises headless agents until a
 * stop condition. Every handoff is checkpointed; returns why it stopped.
 */
export async function failover(
  deps: Deps,
  session: Session,
  from: AccountId,
  limit: LimitHit,
): Promise<StopReason> {
  const startMs = deps.now().getTime();
  const envValues = loadEnvValues(deps.root);
  let current: AccountId = from;
  let currentLimit = limit;
  let turns = 0;
  let skippedForAuth = false;
  let cp = { ref: "", commit: session.baseCommit };
  const dropped = new Set<AccountId>();

  for (;;) {
    const currentAgent = accountAgent(current) ?? "claude";
    // 1. Record the limit and close the segment that hit it (not again after an auth skip).
    if (!skippedForAuth) {
      saveState(
        recordLimit(
          loadState(),
          current,
          currentLimit,
          deps.now(),
          deps.config.defaultCooldownMinutes,
        ),
      );
      cp = takeCheckpoint(deps.root, session, `handoff from ${current}`);
      closeSegment(session, "limit", cp.commit, currentLimit, deps.now());
      appendJournal(deps.root, {
        sid: session.sid,
        agent: currentAgent,
        kind: "limit",
        text: currentLimit.message,
      });
    }
    skippedForAuth = false;

    // 2. Choose who continues.
    const state = loadState();
    const candidates = available(deps);
    for (const id of dropped) candidates.delete(id);
    const next = pickNext(deps.config, state, candidates, [current], deps.now());
    if (!next) {
      const er = earliestReset(state, deps.now());
      deps.out(
        `\nnowall: every account is at its limit${er ? `; ${accountName(er.account)} resets ${fmtTime(er.at)}` : ""}.\n`,
      );
      return finish(deps, session, "all-limited");
    }
    const nextAgent = accountAgent(next) ?? "claude";

    // 3. Build the packet and launch the next agent with the master prompt.
    const packet = buildPacket({
      root: deps.root,
      sid: session.sid,
      baseCommit: session.baseCommit,
      checkpoint: cp,
      from: currentAgent,
      to: nextAgent,
      limit: currentLimit,
      now: deps.now(),
      envValues,
    });
    appendJournal(deps.root, {
      sid: session.sid,
      agent: nextAgent,
      kind: "handoff",
      text: `${current} -> ${next}`,
    });
    const segment: Segment = {
      agent: nextAgent,
      mode: "headless",
      startedAt: deps.now().toISOString(),
    };
    if (next !== nextAgent) segment.account = next;
    session.segments.push(segment);
    saveSession(deps.root, session);
    updateStatus(session.sid, deps.root, {
      agent: nextAgent,
      ...(next !== nextAgent ? { account: next } : {}),
      phase: "working",
      detail: `Taking over from ${accountName(current)}`,
      shares: agentShares(deps.root, session),
    });
    deps.out(dim(`\n── continuing in ${accountName(next)} ──\n`));

    const adapter = deps.adapters[nextAgent];
    const bin = deps.binaries[nextAgent] as string;
    let prompt = masterPrompt(packet);
    let resumeId: string | undefined;
    let lastTree = snapshotTree(deps.root);
    let noDiff = 0;
    let errors = 0;
    let transientRetries = 0;
    let handedOff = false;

    while (!handedOff) {
      turns += 1;
      const r = await runHeadlessTurn(deps, session, adapter, bin, prompt, resumeId, next);
      if (r.sessionId) {
        resumeId = r.sessionId;
        const seg = session.segments.at(-1);
        if (seg) seg.agentSessionId = r.sessionId;
        saveSession(deps.root, session);
      }
      if (r.interrupted) return finish(deps, session, "interrupted");

      if (r.authError) {
        // Not signed in: drop this account for the rest of the run and try the next one.
        const a = deps.adapters[nextAgent];
        const notice = `${accountName(next)} isn't signed in. Run: ${a.loginHint}`;
        session.notices = [...new Set([...(session.notices ?? []), notice])];
        closeSegment(
          session,
          "auth",
          takeCheckpoint(deps.root, session, `${next} not signed in`).commit,
          null,
          deps.now(),
        );
        saveSession(deps.root, session);
        dropped.add(next);
        deps.out(dim(`  ${notice}. Trying the next account.\n`));
        updateStatus(session.sid, deps.root, {
          agent: nextAgent,
          phase: "handing-off",
          detail: notice,
        });
        skippedForAuth = true;
        handedOff = true;
        continue;
      }

      if (r.limit?.kind === "quota") {
        current = next;
        currentLimit = r.limit;
        handedOff = true;
        continue;
      }
      if (r.limit?.kind === "transient") {
        if (transientRetries < 2) {
          transientRetries += 1;
          await deps.sleep(30_000 * transientRetries);
          continue;
        }
        current = next;
        currentLimit = {
          ...r.limit,
          resetsAt: new Date(deps.now().getTime() + 15 * 60_000).toISOString(),
        };
        handedOff = true;
        continue;
      }
      transientRetries = 0;
      errors = r.isError ? errors + 1 : 0;
      if (errors >= 2) return finish(deps, session, "error");

      const tasks = readTasks(deps.root);
      if (tasks) {
        updateStatus(session.sid, deps.root, {
          agent: nextAgent,
          phase: "working",
          tasks: {
            done: tasks.tasks.filter((t) => t.status === "done").length,
            total: tasks.tasks.length,
          },
        });
      }
      const tree = snapshotTree(deps.root);
      noDiff = tree === lastTree ? noDiff + 1 : 0;
      lastTree = tree;

      if (tasks && remainingTasks(tasks) === 0) return finish(deps, session, "complete");
      if (noDiff >= deps.config.stop.noDiffTurns) return finish(deps, session, "stalled");
      if (turns >= deps.config.stop.maxTurns) return finish(deps, session, "max-turns");
      if (deps.now().getTime() - startMs > deps.config.stop.maxMinutes * 60_000) {
        return finish(deps, session, "max-time");
      }
      prompt = continuePrompt(tasks);
    }
  }
}

function closeSegment(
  session: Session,
  reason: NonNullable<Session["segments"][number]["endReason"]>,
  commit: string,
  limit: LimitHit | null,
  now: Date,
): void {
  const seg = session.segments.at(-1);
  if (!seg || seg.endedAt) return;
  seg.endedAt = now.toISOString();
  seg.endReason = reason;
  seg.checkpoint = commit;
  if (limit) {
    seg.limit = { window: limit.window, message: limit.message };
    if (limit.resetsAt) seg.limit.resetsAt = limit.resetsAt;
  }
}

function finish(deps: Deps, session: Session, reason: StopReason): StopReason {
  const cp = takeCheckpoint(deps.root, session, `session end (${reason})`);
  closeSegment(session, reason, cp.commit, null, deps.now());
  session.finished = { at: deps.now().toISOString(), reason };
  saveSession(deps.root, session);
  const phase: Phase =
    reason === "complete" ? "done" : reason === "all-limited" ? "paused" : "stopped";
  const last = session.segments.filter((s) => s.endReason !== "auth").at(-1);
  updateStatus(session.sid, deps.root, {
    agent: last?.agent ?? "claude",
    phase,
    detail: phase === "done" ? "Task complete" : `Stopped: ${reason}`,
    shares: agentShares(deps.root, session),
  });
  return reason;
}

/** Lines changed per agent, from consecutive checkpoints (for the notch's "who built what" bar). */
export function agentShares(root: string, session: Session): { agent: AgentId; lines: number }[] {
  const totals = new Map<AgentId, number>();
  let from = session.baseCommit;
  for (const seg of session.segments) {
    if (!seg.checkpoint) continue;
    const stat = shortStat(root, from, seg.checkpoint);
    const lines = [...stat.matchAll(/(\d+) (?:insertion|deletion)/g)].reduce(
      (n, m) => n + Number(m[1]),
      0,
    );
    totals.set(seg.agent, (totals.get(seg.agent) ?? 0) + lines);
    from = seg.checkpoint;
  }
  return [...totals].map(([agent, lines]) => ({ agent, lines }));
}

export function fmtTime(iso: string): string {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : d.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
}
