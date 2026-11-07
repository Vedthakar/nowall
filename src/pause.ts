import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./schemas.js";
import { handoffDir } from "./session.js";
import { loadConfig } from "./state.js";

/** Name of the marker file `nowall off` writes inside .handoff/. */
export const OFF_MARKER = "off";

const clock = (d: Date) => d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** When `nowall pause` ends, or null when nowall isn't paused. */
export function pausedUntil(config: Config = loadConfig(), now = new Date()): Date | null {
  const raw = config.pausedUntil;
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) && ms > now.getTime() ? new Date(ms) : null;
}

/** True when the user ran `nowall off` in this repo (a `.handoff/off` marker). */
export function repoOff(root: string): boolean {
  return existsSync(join(handoffDir(root), OFF_MARKER));
}

/**
 * Why nowall must not take over right now, in the user's words, or null when it may. Hooks call
 * this before signalling the wrapper or launching a background takeover; `switch` honours it too.
 */
export function takeoverBlocked(root: string, now = new Date()): string | null {
  if (repoOff(root)) return "nowall is off in this repo (nowall on)";
  const until = pausedUntil(loadConfig(), now);
  if (until) return `nowall is paused until ${clock(until)} (nowall resume)`;
  return null;
}
