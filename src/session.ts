import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
  return s && s.v === 1 ? s : null;
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
  mkdirSync(handoffDir(root), { recursive: true });
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
  appendFileSync(journalPath(root), `${JSON.stringify(entry)}\n`);
}

export function readJournal(root: string, sid?: string): JournalLine[] {
  let raw: string;
  try {
    raw = readFileSync(journalPath(root), "utf8");
  } catch {
    return [];
  }
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

export function remainingTasks(tasks: TaskList | null): number {
  return tasks ? tasks.tasks.filter((t) => t.status === "todo").length : Number.NaN;
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
