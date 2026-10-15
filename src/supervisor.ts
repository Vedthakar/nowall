import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { createInterface } from "node:readline";
import type { AgentAdapter } from "./adapters/types.js";
import { checkpoint, snapshotTree } from "./git.js";
import { buildPacket } from "./packet.js";
import { agentName, continuePrompt, masterPrompt } from "./prompt.js";
import { loadEnvValues, redact } from "./redact.js";
import type { AgentId, Config, LimitHit } from "./schemas.js";
import {
  type LimitSignal,
  type Session,
  type StopReason,
  appendJournal,
  loadSession,
  newSessionId,
  readTasks,
  remainingTasks,
  saveSession,
  signalPath,
} from "./session.js";
import { earliestReset, loadState, pickNext, recordLimit, saveState } from "./state.js";

export interface Deps {
  root: string;
  adapters: Record<AgentId, AgentAdapter>;
  /** Resolved binaries of agents that are installed (and not known to be signed out). */
  binaries: Partial<Record<AgentId, string>>;
  config: Config;
  now: () => Date;
  out: (s: string) => void;
  sleep: (ms: number) => Promise<void>;
  pollMs?: number;
}

export function startSession(root: string, agent: AgentId, now: Date): Session {
  const sid = newSessionId();
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
    try {
      limit = JSON.parse(readFileSync(sigFile, "utf8")) as LimitSignal;
    } catch {
      return; // half-written; next poll
    }
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

  const result: TurnResult = { limit: null, isError: false, exitCode: 0, interrupted: false };
  const errorTexts: string[] = [];
  let sawDone = false;
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
          deps.out(`${redact(ev.text)}\n`);
          break;
        case "tool":
          deps.out(
            dim(
              `  · ${ev.name} ${redact((ev.files ?? []).join(" ") || (ev.detail ?? "")).slice(0, 100)}\n`,
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
  return result;
}

function available(deps: Deps): Set<AgentId> {
  return new Set(Object.keys(deps.binaries) as AgentId[]);
}

/**
 * Hands off from `from` (which just hit `limit`) and supervises headless agents until a stop
 * condition. Every handoff is checkpointed; returns why it stopped.
 */
export async function failover(
  deps: Deps,
  session: Session,
  from: AgentId,
  limit: LimitHit,
): Promise<StopReason> {
  const startMs = deps.now().getTime();
  const envValues = loadEnvValues(deps.root);
  let current: AgentId = from;
  let currentLimit = limit;
  let turns = 0;

  for (;;) {
    // 1. Record the limit and close the segment that hit it.
    let state = recordLimit(
      loadState(),
      current,
      currentLimit,
      deps.now(),
      deps.config.defaultCooldownMinutes,
    );
    saveState(state);
    const cp = takeCheckpoint(deps.root, session, `handoff from ${current}`);
    closeSegment(session, "limit", cp.commit, currentLimit, deps.now());
    appendJournal(deps.root, {
      sid: session.sid,
      agent: current,
      kind: "limit",
      text: currentLimit.message,
    });

    // 2. Choose who continues.
    state = loadState();
    const next = pickNext(deps.config, state, available(deps), [current], deps.now());
    if (!next) {
      const er = earliestReset(state, deps.now());
      deps.out(
        `\nnowall: every agent is at its limit${er ? `; ${agentName(er.agent)} resets ${fmtTime(er.at)}` : ""}.\n`,
      );
      return finish(deps, session, "all-limited");
    }

    // 3. Build the packet and launch the next agent with the master prompt.
    const packet = buildPacket({
      root: deps.root,
      sid: session.sid,
      baseCommit: session.baseCommit,
      checkpoint: cp,
      from: current,
      to: next,
      limit: currentLimit,
      now: deps.now(),
      envValues,
    });
    appendJournal(deps.root, {
      sid: session.sid,
      agent: next,
      kind: "handoff",
      text: `${current} -> ${next}`,
    });
    session.segments.push({ agent: next, mode: "headless", startedAt: deps.now().toISOString() });
    saveSession(deps.root, session);
    deps.out(dim(`\n── continuing in ${agentName(next)} ──\n`));

    const adapter = deps.adapters[next];
    const bin = deps.binaries[next] as string;
    let prompt = masterPrompt(packet);
    let resumeId: string | undefined;
    let lastTree = snapshotTree(deps.root);
    let noDiff = 0;
    let errors = 0;
    let transientRetries = 0;
    let handedOff = false;

    while (!handedOff) {
      turns += 1;
      const r = await runHeadlessTurn(deps, session, adapter, bin, prompt, resumeId);
      if (r.sessionId) {
        resumeId = r.sessionId;
        const seg = session.segments.at(-1);
        if (seg) seg.agentSessionId = r.sessionId;
        saveSession(deps.root, session);
      }
      if (r.interrupted) return finish(deps, session, "interrupted");

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
  return reason;
}

export function fmtTime(iso: string): string {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : d.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
}
