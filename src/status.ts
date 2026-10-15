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

export interface SessionStatus {
  v: 1;
  sid: string;
  repo: string;
  repoName: string;
  phase: Phase;
  agent: AgentId;
  detail?: string;
  tasks?: { done: number; total: number };
  /** Lines changed per agent across the session, for the "who built what" bar. */
  shares?: { agent: AgentId; lines: number }[];
  startedAt: string;
  updatedAt: string;
  summary?: string;
}

export function statusDir(): string {
  return join(configDir(), "status");
}

function statusFile(sid: string): string {
  return join(statusDir(), `${sid}.json`);
}

export function readStatus(sid: string): SessionStatus | null {
  return readJsonSafe<SessionStatus>(statusFile(sid), 64 * 1024);
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
    writeAtomic(statusFile(sid), `${JSON.stringify(next)}\n`);
  } catch {
    // the notch is a nicety; never let it break a hook or a handoff
  }
}

/** Deletes status files for sessions that ended or went quiet long ago. */
export function pruneStatus(now = new Date(), maxAgeMs = 6 * 3600_000): void {
  let names: string[];
  try {
    names = readdirSync(statusDir());
  } catch {
    return;
  }
  for (const name of names) {
    const path = join(statusDir(), name);
    try {
      if (now.getTime() - statSync(path).mtimeMs > maxAgeMs) rmSync(path, { force: true });
    } catch {
      // ignore
    }
  }
}

/** Short human line for a tool event, e.g. "Editing src/a.ts" or "Running npm test". */
export function describeTool(tool: string, file?: string, command?: string): string {
  if (file) return `Editing ${file}`;
  if (command) return `Running ${command}`;
  return tool ? `Using ${tool}` : "Working";
}
