import { readdirSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { readJsonSafe, writeAtomic } from "./fsafe.js";
import { redact } from "./redact.js";
import type { AgentId } from "./schemas.js";
import { configDir } from "./state.js";

/**
 * Live status the notch renders. One small file per session under ~/.config/nowall/status/,
 * written by hooks and the supervisor. The notch only reads files, so it never runs nowall code.
 */
export type Phase =
  | "idle" // session open, nothing happening
  | "working" // an agent is working
  | "needs-input" // the agent is waiting on the user (permission prompt, question)
  | "your-turn" // the agent finished its turn
  | "handing-off" // a limit hit; moving to the next agent
  | "done" // task complete
  | "stopped" // stopped by a stop condition or the user
  | "paused" // every agent is at its limit
  | "ended"; // the agent session closed

/** A subagent the session is waiting on. `id` is Claude's `agent_id` or Cursor's `subagent_id`. */
export interface ChildStatus {
  id: string;
  type?: string;
  startedAt: string;
  /** Last time one of the child's own hooks reached us; keeps a long-running child alive. */
  seenAt?: string;
}

export interface SessionStatus {
  v: 1;
  sid: string;
  repo: string;
  repoName: string;
  phase: Phase;
  agent: AgentId;
  /** Account id when it isn't the agent's default login. */
  account?: string;
  detail?: string;
  tasks?: { done: number; total: number };
  /** Lines changed per agent across the session, for the "who built what" bar. */
  shares?: { agent: AgentId; lines: number }[];
  startedAt: string;
  updatedAt: string;
  summary?: string;
  /** Set on a subagent's own session (Cursor): the sid of the chat that spawned it. Hidden in the notch. */
  parentSid?: string;
  /** Running subagents of this session. The phase stays `working` while any remain. */
  children?: ChildStatus[];
  /** True when the agent's own turn ended while children were still running. */
  turnEnded?: boolean;
}

/** A child that has been silent this long no longer pins its parent to `working`. */
export const CHILD_MAX_AGE_MS = 30 * 60_000;

export function statusDir(): string {
  return join(configDir(), "status");
}

function statusFile(sid: string): string {
  return join(statusDir(), `${sid}.json`);
}

export function readStatus(sid: string): SessionStatus | null {
  return readJsonSafe<SessionStatus>(statusFile(sid), 64 * 1024);
}

/** Children still counted as running: seen (or started) within CHILD_MAX_AGE_MS. */
export function liveChildren(children: ChildStatus[] | undefined, now: Date): ChildStatus[] {
  if (!children?.length) return [];
  return children.filter((c) => {
    const last = Date.parse(c.seenAt ?? c.startedAt);
    return !Number.isFinite(last) || now.getTime() - last <= CHILD_MAX_AGE_MS;
  });
}

/** Short line for a parent that is waiting on children, e.g. "Running 2 subagents: explore, shell". */
export function describeChildren(children: ChildStatus[], waiting = false): string {
  const n = children.length;
  const noun = n === 1 ? "subagent" : "subagents";
  const types = [...new Set(children.map((c) => c.type).filter(Boolean))].join(", ");
  const head = waiting ? `Waiting on ${n} ${noun}` : `Running ${n} ${noun}`;
  return types ? `${head}: ${types}` : head;
}

/** Merges a patch into the session's status file. Never throws: status is best-effort. */
export function updateStatus(
  sid: string,
  repo: string,
  patch: Partial<Omit<SessionStatus, "v" | "sid" | "repo">> & { agent: AgentId },
  now = new Date(),
): void {
  try {
    const prev = readStatus(sid);
    const next: SessionStatus = {
      v: 1,
      sid,
      repo,
      repoName: basename(repo),
      phase: "idle",
      startedAt: prev?.startedAt ?? now.toISOString(),
      ...prev,
      ...patch,
      updatedAt: now.toISOString(),
    };
    if (patch.detail !== undefined)
      next.detail = redact(patch.detail).replace(/\s+/g, " ").slice(0, 120);
    if (next.children) {
      // Stale children drop out; a parent whose turn already ended then settles into your-turn.
      next.children = liveChildren(next.children, now);
      if (!next.children.length) {
        next.children = undefined;
        if (next.turnEnded && next.phase === "working") {
          next.phase = "your-turn";
          next.detail = "Finished its turn";
        }
      }
    }
    writeAtomic(statusFile(sid), `${JSON.stringify(next)}\n`);
  } catch {
    // the notch is a nicety; never let it break a hook or a handoff
  }
}

/** Where Cursor child conversations are mapped to the chat that spawned them. */
export function childrenMapPath(): string {
  return join(statusDir(), "children.json");
}

export interface ChildLink {
  parentSid: string;
  repo: string;
  type?: string;
  startedAt: string;
  /** The child's own sid once one of its hooks has been matched to this entry. */
  sid?: string;
}

export function readChildrenMap(): Record<string, ChildLink> {
  const m = readJsonSafe<Record<string, ChildLink>>(childrenMapPath(), 256 * 1024);
  return m && typeof m === "object" && !Array.isArray(m) ? m : {};
}

export function writeChildrenMap(map: Record<string, ChildLink>): void {
  try {
    writeAtomic(childrenMapPath(), `${JSON.stringify(map)}\n`);
  } catch {
    // best-effort, like the status files
  }
}

/**
 * Deletes status files for sessions that ended or went quiet long ago, child links of the same
 * age, and child status files whose parent is gone.
 */
export function pruneStatus(now = new Date(), maxAgeMs = 6 * 3600_000): void {
  let names: string[];
  try {
    names = readdirSync(statusDir());
  } catch {
    return;
  }
  const kept = new Set<string>();
  for (const name of names) {
    const path = join(statusDir(), name);
    try {
      if (now.getTime() - statSync(path).mtimeMs > maxAgeMs) rmSync(path, { force: true });
      else kept.add(name);
    } catch {
      // ignore
    }
  }
  for (const name of kept) {
    if (!name.endsWith(".json") || name === "children.json") continue;
    const s = readStatus(name.slice(0, -5));
    if (s?.parentSid && !kept.has(`${s.parentSid}.json`))
      rmSync(join(statusDir(), name), { force: true });
  }
  const map = readChildrenMap();
  let changed = false;
  for (const [id, link] of Object.entries(map)) {
    const age = now.getTime() - Date.parse(link.startedAt);
    if (!(age <= maxAgeMs) || !kept.has(`${link.parentSid}.json`)) {
      delete map[id];
      changed = true;
    }
  }
  if (changed) writeChildrenMap(map);
}

/** Short human line for a tool event, e.g. "Editing src/a.ts" or "Running npm test". */
export function describeTool(tool: string, file?: string, command?: string): string {
  if (file) return `Editing ${file}`;
  if (command) return `Running ${command}`;
  return tool ? `Using ${tool}` : "Working";
}
