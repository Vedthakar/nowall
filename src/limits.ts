import type { LimitHit, LimitWindow } from "./schemas.js";

/**
 * Classifies error text from any agent as a quota limit, a transient throttle, or neither.
 * Only feed this error-channel text (error events, is_error results, stderr) — never
 * assistant prose, which may legitimately talk about rate limits.
 */
export function classifyLimit(text: string, now: Date, defaultTz?: string): LimitHit | null {
  const t = text.replace(/[’‘]/g, "'");

  for (const re of TRANSIENT) {
    if (re.test(t)) return { kind: "transient", window: "per-minute", message: firstLine(t) };
  }

  const gemini = /RESOURCE_EXHAUSTED|quota exceeded/i.test(t);
  if (gemini) {
    const retry = /retry in ([\d.]+)\s*s/i.exec(t);
    const secs = retry?.[1] ? Number.parseFloat(retry[1]) : undefined;
    if (secs !== undefined && secs < 120) {
      return { kind: "transient", window: "per-minute", message: firstLine(t) };
    }
    const hit: LimitHit = { kind: "quota", window: "daily", message: firstLine(t) };
    if (secs !== undefined) hit.resetsAt = new Date(now.getTime() + secs * 1000).toISOString();
    return hit;
  }

  for (const [re, window] of QUOTA) {
    if (re.test(t)) {
      const hit: LimitHit = { kind: "quota", window, message: firstLine(t) };
      const reset = parseResetTime(t, now, defaultTz);
      if (reset) hit.resetsAt = reset.toISOString();
      return hit;
    }
  }
  return null;
}

/**
 * True when error text means the agent isn't signed in (or its login expired). Real examples:
 * Claude Code "Failed to authenticate: OAuth session expired and could not be refreshed",
 * Cursor CLI "Authentication required. Please run 'agent login' first".
 */
export function isAuthError(text: string): boolean {
  return /authentication required|failed to authenticate|not (logged|signed) in|please (run|use) [`'"]?[\w-]+ login|oauth session expired|invalid api key|unauthorized|\b401\b|authentication_failed/i.test(
    text,
  );
}

const TRANSIENT: RegExp[] = [
  /temporarily limiting requests/i,
  /request rejected \(429\)/i,
  /\boverloaded(_error)?\b/i,
  /\b529\b.*overload/i,
];

const QUOTA: [RegExp, LimitWindow][] = [
  [/you've hit your session limit/i, "session"],
  [/you've hit your weekly limit/i, "weekly"],
  [/you've hit your (opus|sonnet|haiku|fable) limit/i, "model"],
  [/you've hit your .*spend (limit|cap)|you hit your spend cap|spend limit reached/i, "spend"],
  [/you've hit your team's shared budget/i, "spend"],
  [/out of credits|credit balance is too low|insufficient_quota/i, "credits"],
  [/free allocated quota exceeded/i, "daily"],
  [/you've hit your (individual )?usage limit|usage limit reached|rate limit reached/i, "unknown"],
];

function firstLine(t: string): string {
  return (t.split("\n").find((l) => l.trim()) ?? t).trim().slice(0, 300);
}

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * Extracts a reset time from limit text. Handles:
 *  - Claude: "resets 5:20pm (America/Toronto)", "resets 9pm", "resets Mon 12:00am", "resets Oct 20, 3pm"
 *  - Codex:  "try again in 2 days 3 hours 5 minutes", "try again at 3:05 PM", "try again at Oct 17th, 2026 3:05 AM"
 *  - Generic: "retry in 15.2s"
 * Clock times are interpreted in the IANA zone in parentheses, else `defaultTz`, else the system zone.
 */
export function parseResetTime(text: string, now: Date, defaultTz?: string): Date | null {
  const t = text.replace(/[’‘]/g, "'");

  const rel =
    /(?:try again|retry|resets?) in ((?:\s*\d+(?:\.\d+)?\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b,?(?:\s*and)?)+)/i.exec(
      t,
    );
  if (rel?.[1]) {
    let ms = 0;
    for (const m of rel[1].matchAll(/(\d+(?:\.\d+)?)\s*([a-z]+)/gi)) {
      const n = Number.parseFloat(m[1] ?? "0");
      const u = (m[2] ?? "").toLowerCase();
      if (u.startsWith("d")) ms += n * 86_400_000;
      else if (u.startsWith("h")) ms += n * 3_600_000;
      else if (u.startsWith("m")) ms += n * 60_000;
      else ms += n * 1000;
    }
    if (ms > 0) return new Date(now.getTime() + ms);
  }

  const abs =
    /(?:resets?|try again at|until)\s+(?:at\s+)?([^·\n]*?\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?)(?:\s*\(([A-Za-z_]+(?:\/[A-Za-z_+-]+)*)\))?/i.exec(
      t,
    );
  if (!abs?.[1]) return null;
  const tz = abs[2] && isValidTz(abs[2]) ? abs[2] : (defaultTz ?? systemTz());
  return resolveClock(abs[1], now, tz);
}

function resolveClock(spec: string, now: Date, tz: string): Date | null {
  const s = spec.toLowerCase();
  const time = /(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?\s*$/.exec(s);
  if (!time) return null;
  let hour = Number(time[1]) % 12;
  if (time[3] === "p") hour += 12;
  const minute = time[2] ? Number(time[2]) : 0;

  const today = zonedParts(now, tz);
  const monthMatch =
    /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?/.exec(
      s,
    );
  if (monthMatch?.[1] && monthMatch[2]) {
    const month = MONTHS.indexOf(monthMatch[1]);
    const day = Number(monthMatch[2]);
    const yearMatch = /\b(20\d{2})\b/.exec(s);
    let year = yearMatch?.[1] ? Number(yearMatch[1]) : today.year;
    let d = zonedToUtc(year, month, day, hour, minute, tz);
    if (!yearMatch && d.getTime() <= now.getTime()) {
      year += 1;
      d = zonedToUtc(year, month, day, hour, minute, tz);
    }
    return d;
  }

  const wd = /\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*\b/.exec(s);
  let addDays = 0;
  if (wd?.[1]) {
    addDays = (WEEKDAYS.indexOf(wd[1]) - today.weekday + 7) % 7;
  }
  let candidate = zonedToUtc(today.year, today.month, today.day + addDays, hour, minute, tz);
  if (candidate.getTime() <= now.getTime()) {
    candidate = zonedToUtc(
      today.year,
      today.month,
      today.day + addDays + (wd ? 7 : 1),
      hour,
      minute,
      tz,
    );
  }
  return candidate;
}

export function systemTz(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function isValidTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

interface ZonedParts {
  year: number;
  month: number; // 0-based
  day: number;
  hour: number;
  minute: number;
  weekday: number; // 0 = Sunday
}

function zonedParts(date: Date, tz: string): ZonedParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    weekday: "short",
  });
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(date)) p[part.type] = part.value;
  return {
    year: Number(p.year),
    month: Number(p.month) - 1,
    day: Number(p.day),
    hour: Number(p.hour) % 24,
    minute: Number(p.minute),
    weekday: WEEKDAYS.indexOf((p.weekday ?? "").toLowerCase().slice(0, 3)),
  };
}

function offsetMs(date: Date, tz: string): number {
  const p = zonedParts(date, tz);
  const asUtc = Date.UTC(p.year, p.month, p.day, p.hour, p.minute, date.getUTCSeconds());
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** Converts a wall-clock time in `tz` to a UTC Date (DST-safe; day may overflow). */
export function zonedToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  tz: string,
): Date {
  const guess = Date.UTC(year, month, day, hour, minute);
  let result = guess - offsetMs(new Date(guess), tz);
  result = guess - offsetMs(new Date(result), tz);
  return new Date(result);
}
