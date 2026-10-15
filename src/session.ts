import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  constants,
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { appendSafe, readSmall, readTail } from "./fsafe.js";
import { redact } from "./redact.js";
import type { AgentId, JournalLine, LimitWindow, TaskList } from "./schemas.js";
import { isTaskList } from "./schemas.js";
import { readJson, writeJson } from "./state.js";

export const HANDOFF_DIR = ".handoff";

export function handoffDir(root: string): string {
  return join(root, HANDOFF_DIR);
}

export function isInitialized(root: string): boolean {
  return existsSync(handoffDir(root));
}

/**
 * Why nowall must not trust this repo's .handoff/, or null if it is safe. A repo that commits
 * .handoff/ (or makes it a symlink) could feed planted "context" to the next agent.
 */
export function handoffProblem(root: string): string | null {
  const dir = handoffDir(root);
  try {
    const st = lstatSync(dir);
    if (st.isSymbolicLink()) return ".handoff is a symlink";
    if (!st.isDirectory()) return ".handoff is not a directory";
  } catch {
    return null; // absent: fine
  }
  try {
    const tracked = execFileSync("git", ["ls-files", "--", ".handoff"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (tracked.trim()) return "this repository commits a .handoff/ directory";
  } catch {
    // not a git repo or git missing: caller decides
  }
  return null;
}

export const SID_RE = /^[sc]_[A-Za-z0-9-]{1,64}$/;

export interface Segment {
  agent: AgentId;
  mode: "interactive" | "headless";
  startedAt: string;
  endedAt?: string;
  endReason?: "limit" | "exit" | StopReason;
  limit?: { window: LimitWindow; message: string; resetsAt?: string };
  /** Checkpoint commit taken when the segment ended. */
  checkpoint?: string;
  agentSessionId?: string;
}

export type StopReason =
  | "complete"
  | "stalled"
  | "max-turns"
  | "max-time"
  | "all-limited"
  | "error"
  | "interrupted";

export interface Session {
  v: 1;
  sid: string;
  startedAt: string;
  /** Snapshot commit of the working tree when the session started. */
  baseCommit: string;
  checkpoints: number;
  segments: Segment[];
  finished?: { at: string; reason: StopReason };
}

export function newSessionId(): string {
  return `s_${randomBytes(4).toString("hex")}`;
}

export function sessionPath(root: string): string {
  return join(handoffDir(root), "session.json");
}

export function loadSession(root: string): Session | null {
  const s = readJson<Session>(sessionPath(root));
  return s &&
    s.v === 1 &&
    typeof s.sid === "string" &&
    SID_RE.test(s.sid) &&
    Array.isArray(s.segments)
    ? s
    : null;
}

export function saveSession(root: string, session: Session): void {
  writeJson(sessionPath(root), session);
}

export function journalPath(root: string): string {
  return join(handoffDir(root), "journal.jsonl");
}

/** Appends one redacted journal line. Text is capped so the journal stays tiny. */
export function appendJournal(
  root: string,
  line: Omit<JournalLine, "v" | "ts"> & { ts?: string },
): void {
  const entry: JournalLine = {
    v: 1,
    ts: line.ts ?? new Date().toISOString(),
    sid: line.sid,
    agent: line.agent,
    kind: line.kind,
    text: redact(line.text).replace(/\s+/g, " ").trim().slice(0, 200),
  };
  if (line.files?.length) entry.files = [...new Set(line.files.map((f) => redact(f)))].slice(0, 20);
  if (line.status) entry.status = line.status;
  appendSafe(journalPath(root), `${JSON.stringify(entry)}\n`);
}

export function readJournal(root: string, sid?: string): JournalLine[] {
  const raw = readTail(journalPath(root), 2 * 1024 * 1024);
  if (raw === null) return [];
  const out: JournalLine[] = [];
  for (const l of raw.split("\n")) {
    if (!l.trim()) continue;
    try {
      const j = JSON.parse(l) as JournalLine;
      if (j.v === 1 && (!sid || j.sid === sid)) out.push(j);
    } catch {
      // tolerate a torn last line
    }
  }
  return out;
}

export function tasksPath(root: string): string {
  return join(handoffDir(root), "tasks.json");
}

export function readTasks(root: string): TaskList | null {
  const t = readJson<unknown>(tasksPath(root));
  return isTaskList(t) ? t : null;
}

/** Moves a previous session's task list aside so it can't end a new session early. */
export function archiveTasks(root: string): void {
  if (existsSync(tasksPath(root))) renameSync(tasksPath(root), `${tasksPath(root)}.prev`);
}

export function remainingTasks(tasks: TaskList | null): number {
  return tasks ? tasks.tasks.filter((t) => t.status === "todo").length : Number.NaN;
}

function lockPath(root: string): string {
  return join(handoffDir(root), "active.lock");
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** True while another live nowall process supervises this repo. */
export function isLocked(root: string): boolean {
  const pid = Number(readSmall(lockPath(root), 64)?.trim());
  return pid !== process.pid && pidAlive(pid);
}

/** One supervisor per repo. Returns false if another live process holds the lock. */
export function acquireLock(root: string): boolean {
  if (isLocked(root)) return false;
  rmSync(lockPath(root), { force: true }); // stale lock from a dead process
  try {
    const fd = openSync(
      lockPath(root),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    writeSync(fd, String(process.pid));
    closeSync(fd);
  } catch {
    return false; // lost a race with another process
  }
  process.once("exit", () => releaseLock(root));
  return true;
}

export function releaseLock(root: string): void {
  if (Number(readSmall(lockPath(root), 64)?.trim()) === process.pid)
    rmSync(lockPath(root), { force: true });
}

export function signalPath(root: string, sid: string): string {
  return join(handoffDir(root), "signals", `limit-${sid}.json`);
}

export interface LimitSignal {
  agent: AgentId;
  sid: string;
  window: LimitWindow;
  message: string;
  resetsAt?: string;
  observedAt: string;
}
