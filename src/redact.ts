import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

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

const SECRET_NAME =
  /\b([A-Za-z0-9_.-]*(?:secret|token|passw(?:or)?d|api[_-]?key|apikey|private[_-]?key|access[_-]?key|client[_-]?secret)[A-Za-z0-9_.-]*)(\s*["']?\s*[:=]\s*)(["']?)((?=[^\s"',;]*[A-Za-z])[^\s"',;]{6,})\3/gi;

const URL_CREDS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi;
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

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
  out = out.replace(
    SECRET_NAME,
    (match, name: string, sep: string, quote: string, value: string) =>
      value.startsWith("[REDACTED") ? match : `${name}${sep}${quote}${R("secret")}${quote}`,
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
    try {
      for (const line of readFileSync(join(dir, name), "utf8").split("\n")) {
        const m = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*)$/.exec(line);
        const v = m?.[1]?.trim().replace(/^(["'])(.*)\1$/, "$2");
        if (v && v.length >= 6) values.push(v);
      }
    } catch {
      // unreadable env file: skip
    }
  }
  return values;
}
