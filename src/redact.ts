import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readSmall } from "./fsafe.js";

export interface RedactOptions {
  /** Exact secret values to strip (e.g. values from the repo's .env files). */
  knownValues?: string[];
  emails?: boolean;
}

const R = (kind: string) => `[REDACTED:${kind}]`;

const PATTERNS: [string, RegExp][] = [
  [
    "private-key",
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
  ],
  ["anthropic-key", /\bsk-ant-[A-Za-z0-9_-]{16,}/g],
  ["openai-key", /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g],
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{22,})/g],
  ["google-key", /\bAIza[0-9A-Za-z_-]{30,}/g],
  ["aws-key-id", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ["slack-token", /\bxox[abprse]-[A-Za-z0-9-]{10,}/g],
  ["stripe-key", /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g],
  ["npm-token", /\bnpm_[A-Za-z0-9]{30,}/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
  ["bearer", /\b(Bearer)\s+[A-Za-z0-9._~+/-]{16,}=*/g],
];

// Assignments are matched with bounded, anchored quantifiers so the scan stays linear on
// adversarial input (an unbounded name class backtracked quadratically: 130 s on 200 KB).
const ASSIGNMENT =
  /(?<![A-Za-z0-9_.-])([A-Za-z0-9_.-]{1,64})(\s{0,4}["']?\s{0,4}[:=]\s{0,4})(["']?)([^\s"',;]{6,512})\3/g;
const SECRET_WORD =
  /secret|token|passw(?:or)?d|api[_-]?key|apikey|private[_-]?key|access[_-]?key|client[_-]?secret/i;

const URL_CREDS =
  /(?<![A-Za-z0-9+.-])([a-z][a-z0-9+.-]{0,30}:\/\/)[^\s/:@]{1,256}:[^\s/@]{1,256}@/gi;
const EMAIL =
  /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}\b/g;

/** Strips secrets from free text. Pure; safe to call on anything we persist. */
export function redact(input: string, opts: RedactOptions = {}): string {
  let out = input;
  for (const value of (opts.knownValues ?? []).filter((v) => v.length >= 6)) {
    out = out.split(value).join(R("env-value"));
  }
  for (const [kind, re] of PATTERNS) {
    out = out.replace(re, (_m, g1?: string) =>
      kind === "bearer" && g1 ? `${g1} ${R(kind)}` : R(kind),
    );
  }
  out = out.replace(URL_CREDS, (_m, scheme: string) => `${scheme}${R("url-credentials")}@`);
  out = out.replace(ASSIGNMENT, (match, name: string, sep: string, quote: string, value: string) =>
    !SECRET_WORD.test(name) || !/[A-Za-z]/.test(value) || value.startsWith("[REDACTED")
      ? match
      : `${name}${sep}${quote}${R("secret")}${quote}`,
  );
  if (opts.emails) out = out.replace(EMAIL, R("email"));
  return out;
}

/** Recursively redacts every string in a JSON-like value. */
export function redactDeep<T>(value: T, opts: RedactOptions = {}): T {
  if (typeof value === "string") return redact(value, opts) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, opts)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v, opts);
    return out as T;
  }
  return value;
}

/** Reads values from `.env*` files in `dir` so they can be stripped verbatim. Never logged. */
export function loadEnvValues(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const values: string[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.startsWith(".env") || name === ".env.example") continue;
    const content = readSmall(join(dir, name), 256 * 1024);
    if (content === null) continue;
    for (const line of content.split("\n")) {
      const m = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*)$/.exec(line);
      const v = m?.[1]?.trim().replace(/^(["'])(.*)\1$/, "$2");
      if (v && v.length >= 6) values.push(v);
    }
  }
  return values;
}
