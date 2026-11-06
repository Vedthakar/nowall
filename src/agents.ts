import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  accountEnv,
  accountIdentity,
  accountName,
  accountProblem,
  allAccounts,
  askHidden,
  findAccount,
  loginAccount,
} from "./accounts.js";
import { ADAPTERS, resolveBinary } from "./adapters/index.js";
import { type Runner, defaultRunner } from "./adapters/types.js";
import { readJsonSafe, readTail, writeAtomic } from "./fsafe.js";
import { AGENT_IDS, type Account, type AccountId, type AgentId } from "./schemas.js";
import { configDir, loadConfig, loadConfigReport, loadState } from "./state.js";

export interface UsageWindow {
  label: string; // "5h", "week"
  usedPct: number;
  resetsAt?: string;
}

export interface AgentInfo {
  id: AgentId;
  name: string;
  installed: boolean;
  /** Installed only as a desktop app (no terminal command), e.g. Claude desktop. */
  desktopOnly?: boolean;
  signedIn: boolean | "unknown";
  /** When `signedIn` was last asked of the agent (cached for 10 minutes per entry). */
  checkedAt?: string;
  enabled: boolean;
  cooldownUntil?: string;
  limitMessage?: string;
  usage?: UsageWindow[];
  loginHint: string;
  installHint: string;
}

/** One login of one agent, as the notch shows it: one icon per account, in takeover order. */
export interface AccountInfo {
  id: AccountId;
  agent: AgentId;
  /** "Claude Code (work)"; the default account is just the agent's name. */
  name: string;
  label: string;
  signedIn: boolean | "unknown";
  /** When `signedIn` was last asked of the agent (cached for 10 minutes per account). */
  checkedAt?: string;
  /** Why it can't work right now and what to run, e.g. "profile missing". Never a secret. */
  problem?: string;
  hint?: string;
  /** In the takeover order (accounts left out are off). */
  active: boolean;
  cooldownUntil?: string;
  limitMessage?: string;
  usage?: UsageWindow[];
}

export interface AgentsSnapshot {
  v: 1;
  updatedAt: string;
  agents: AgentInfo[];
  /** Every account in priority order (those in `order` first, `active: true`), then the rest. */
  accounts: AccountInfo[];
}

export function agentsPath(): string {
  return join(configDir(), "agents.json");
}

const SIGNIN_TTL_MS = 10 * 60_000;

function claudeDesktopInstalled(): boolean {
  return (
    existsSync("/Applications/Claude.app") ||
    existsSync(join(homedir(), "Applications", "Claude.app"))
  );
}

/** Latest Codex rate-limit windows from its newest rollout log (~/.codex/sessions/Y/M/D/rollout-*.jsonl). */
export function codexUsage(home = homedir(), codexHome?: string): UsageWindow[] | undefined {
  const root = join(codexHome ?? join(home, ".codex"), "sessions");
  const newest = (dir: string): string | null => {
    try {
      const names = readdirSync(dir).sort();
      return names.length ? join(dir, names[names.length - 1] as string) : null;
    } catch {
      return null;
    }
  };
  let day: string | null = root;
  for (let i = 0; i < 3 && day; i++) day = newest(day); // year → month → day
  if (!day) return undefined;
  let files: string[];
  try {
    files = readdirSync(day)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => join(day as string, f))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  } catch {
    return undefined;
  }
  const text = files[0] ? readTail(files[0], 512 * 1024) : null;
  if (!text) return undefined;
  for (const line of text.trimEnd().split("\n").reverse()) {
    if (!line.includes('"rate_limits"')) continue;
    try {
      const rl = (JSON.parse(line) as { payload?: { rate_limits?: Record<string, unknown> } })
        .payload?.rate_limits as
        | Record<
            string,
            { used_percent?: number; window_minutes?: number; resets_at?: number } | null
          >
        | undefined;
      if (!rl) continue;
      const out: UsageWindow[] = [];
      for (const key of ["primary", "secondary"]) {
        const w = rl[key];
        if (!w || typeof w.used_percent !== "number") continue;
        const label =
          (w.window_minutes ?? 0) >= 7 * 24 * 60
            ? "week"
            : `${Math.round((w.window_minutes ?? 300) / 60)}h`;
        const win: UsageWindow = { label, usedPct: w.used_percent };
        if (typeof w.resets_at === "number")
          win.resetsAt = new Date(w.resets_at * 1000).toISOString();
        out.push(win);
      }
      return out.length ? out : undefined;
    } catch {
      // keep looking
    }
  }
  return undefined;
}

/** Where `nowall statusline` keeps Claude's last usage numbers, per account. */
export function claudeUsagePath(account: AccountId = "claude"): string {
  const suffix = account === "claude" ? "" : `-${account.replace(/[^A-Za-z0-9_-]/g, "_")}`;
  return join(configDir(), `claude-usage${suffix}.json`);
}

/** Claude's 5-hour/weekly usage as last seen by `nowall statusline` (only when Claude runs it). */
export function claudeUsage(
  now = new Date(),
  account: AccountId = "claude",
): UsageWindow[] | undefined {
  const saved = readJsonSafe<{
    five_hour?: { used_percentage?: number; resets_at?: number };
    seven_day?: { used_percentage?: number; resets_at?: number };
  }>(claudeUsagePath(account));
  if (!saved) return undefined;
  const out: UsageWindow[] = [];
  for (const [key, label] of [
    ["five_hour", "5h"],
    ["seven_day", "week"],
  ] as const) {
    const w = saved[key];
    if (!w || typeof w.used_percentage !== "number") continue;
    if (typeof w.resets_at === "number" && w.resets_at * 1000 < now.getTime()) continue; // stale window
    const win: UsageWindow = { label, usedPct: w.used_percentage };
    if (typeof w.resets_at === "number") win.resetsAt = new Date(w.resets_at * 1000).toISOString();
    out.push(win);
  }
  return out.length ? out : undefined;
}

export interface RefreshOptions {
  /** Ask the agents again even if the cached answer is recent: every account, or these ids. */
  force?: true | readonly AccountId[];
}

/**
 * Detects every agent, merges cooldowns and usage, and writes agents.json for the notch.
 * Sign-in checks can hit the network (Cursor), so each account's answer is reused for 10 minutes
 * (`checkedAt`); `account add|remove|login` mark an entry stale and `verify` forces the check.
 */
export async function refreshAgents(
  run: Runner = defaultRunner,
  now = new Date(),
  opts: RefreshOptions = {},
): Promise<AgentsSnapshot> {
  const prev = readJsonSafe<AgentsSnapshot>(agentsPath());
  const forced = (id: AccountId) =>
    opts.force === true || (Array.isArray(opts.force) && opts.force.includes(id));
  /** The cached entry if it is recent enough and not forced, else undefined. */
  const recent = <T extends { id: string; checkedAt?: string }>(
    list: T[] | undefined,
    id: AccountId,
  ): T | undefined => {
    const entry = list?.find((x) => x.id === id);
    if (!entry || !prev || forced(id)) return undefined;
    const at = Date.parse(entry.checkedAt ?? prev.updatedAt);
    return Number.isFinite(at) && now.getTime() - at < SIGNIN_TTL_MS ? entry : undefined;
  };
  const config = loadConfig();
  const state = loadState();
  const agents = await Promise.all(
    AGENT_IDS.map(async (id): Promise<AgentInfo> => {
      const a = ADAPTERS[id];
      const bin = resolveBinary(a.binary, process.argv[1]);
      const cached = recent(prev?.agents, id);
      let installed = Boolean(bin);
      let signedIn: boolean | "unknown" = false;
      let checkedAt = now.toISOString();
      if (bin) {
        if (cached?.installed) {
          signedIn = cached.signedIn;
          checkedAt = cached.checkedAt ?? (prev as AgentsSnapshot).updatedAt;
        } else signedIn = (await a.detect(run, bin)).signedIn;
      }
      const info: AgentInfo = {
        id,
        name: a.displayName,
        installed,
        signedIn,
        checkedAt,
        enabled: Boolean(config.enabled[id]) && (id !== "qwen" || config.fallback.enabled),
        loginHint: a.loginHint,
        installHint: a.installHint,
      };
      if (!bin && id === "claude" && claudeDesktopInstalled()) {
        installed = true;
        info.installed = true;
        info.desktopOnly = true;
        info.signedIn = "unknown";
      }
      const s = state.agents[id];
      if (s?.cooldownUntil && Date.parse(s.cooldownUntil) > now.getTime()) {
        info.cooldownUntil = s.cooldownUntil;
        if (s.lastLimit?.message) info.limitMessage = s.lastLimit.message;
      }
      const usage = id === "codex" ? codexUsage() : id === "claude" ? claudeUsage(now) : undefined;
      if (usage) info.usage = usage;
      return info;
    }),
  );

  // Accounts: the default one reuses its agent's detection; extras are checked in their own env.
  const accounts = await Promise.all(
    allAccounts(config).map(async (a): Promise<AccountInfo> => {
      const agent = agents.find((x) => x.id === a.agent) as AgentInfo;
      const info: AccountInfo = {
        id: a.id,
        agent: a.agent,
        name: accountName(a.id),
        label: a.label,
        signedIn: agent.signedIn,
        checkedAt: agent.checkedAt,
        active: config.order.includes(a.id) && agent.enabled,
      };
      const env = accountEnv(config, a.id);
      if (a.id !== a.agent) {
        const bin = resolveBinary(ADAPTERS[a.agent].binary, process.argv[1]);
        const problem = accountProblem(a); // a deleted profile or a lost key: no need to ask
        const cached = problem ? undefined : recent(prev?.accounts, a.id);
        info.checkedAt = now.toISOString();
        if (!bin) info.signedIn = false;
        else if (problem) {
          info.signedIn = false;
          info.problem = problem.problem;
          info.hint = problem.hint;
        } else if (cached) {
          info.signedIn = cached.signedIn;
          info.checkedAt = cached.checkedAt ?? (prev as AgentsSnapshot).updatedAt;
        } else info.signedIn = (await ADAPTERS[a.agent].detect(run, bin, env)).signedIn;
      }
      const s = state.agents[a.id];
      if (s?.cooldownUntil && Date.parse(s.cooldownUntil) > now.getTime()) {
        info.cooldownUntil = s.cooldownUntil;
        if (s.lastLimit?.message) info.limitMessage = s.lastLimit.message;
      }
      const usage =
        a.agent === "codex"
          ? codexUsage(homedir(), env.CODEX_HOME)
          : a.agent === "claude"
            ? claudeUsage(now, a.id)
            : undefined;
      if (usage) info.usage = usage;
      return info;
    }),
  );

  const snapshot: AgentsSnapshot = { v: 1, updatedAt: now.toISOString(), agents, accounts };
  writeAtomic(agentsPath(), `${JSON.stringify(snapshot, null, 2)}\n`);
  return snapshot;
}

// --- account verify / login ------------------------------------------------------------------

export interface VerifyRow {
  id: AccountId;
  name: string;
  agent: AgentId;
  installed: boolean;
  signedIn: boolean | "unknown";
  /** In the takeover order and the agent is enabled. */
  active: boolean;
  /** "profile missing", "same login as claude", … Never a secret. */
  problem?: string;
  hint?: string;
}

/**
 * Asks every account (or just `ids`) whether its login works right now, bypassing the cache, and
 * notices two profiles that hold the same login. Updates agents.json so the notch agrees.
 */
export async function verifyAccounts(
  ids?: readonly AccountId[],
  run: Runner = defaultRunner,
  now = new Date(),
): Promise<VerifyRow[]> {
  const config = loadConfig();
  const all = allAccounts(config);
  const wanted = ids ? all.filter((a) => ids.includes(a.id)) : all;
  const snap = await refreshAgents(run, now, { force: ids ?? true });

  // Duplicate logins: compare fingerprints of every signed-in account of the agents involved.
  const identities = new Map<AccountId, string>();
  const agentsInvolved = new Set(wanted.map((a) => a.agent));
  await Promise.all(
    all
      .filter((a) => agentsInvolved.has(a.agent))
      .map(async (a) => {
        const info = snap.accounts.find((x) => x.id === a.id);
        const bin = resolveBinary(ADAPTERS[a.agent].binary, process.argv[1]);
        if (!bin || info?.signedIn !== true) return;
        const who = await accountIdentity(run, bin, a, accountEnv(config, a.id));
        if (who) identities.set(a.id, who);
      }),
  );
  const sameLoginAs = (a: Account): AccountId | undefined => {
    const mine = identities.get(a.id);
    if (!mine) return undefined;
    // Name the first account in order that shares the login (the default one first).
    return all.find((o) => o.id !== a.id && identities.get(o.id) === mine)?.id;
  };

  return wanted.map((a): VerifyRow => {
    const info = snap.accounts.find((x) => x.id === a.id);
    const agent = snap.agents.find((x) => x.id === a.agent);
    const row: VerifyRow = {
      id: a.id,
      name: accountName(a.id),
      agent: a.agent,
      installed: agent?.installed ?? false,
      signedIn: info?.signedIn ?? false,
      active: info?.active ?? false,
    };
    if (info?.problem) {
      row.problem = info.problem;
      if (info.hint) row.hint = info.hint;
    } else if (!row.installed) {
      row.problem = "not installed";
      row.hint = ADAPTERS[a.agent].installHint;
    } else if (row.signedIn === false) {
      row.problem = "not signed in";
      row.hint = a.id === a.agent ? ADAPTERS[a.agent].loginHint : `nowall account login ${a.id}`;
    }
    const twin = sameLoginAs(a);
    if (twin) {
      row.problem = `${row.problem ? `${row.problem}; ` : ""}same login as ${twin}`;
      row.hint ??= `nowall account login ${a.id}  (sign in to a different account)`;
    }
    return row;
  });
}

function stateWord(row: VerifyRow): string {
  if (!row.installed) return "not installed";
  if (row.signedIn === true) return "signed in";
  if (row.signedIn === false) return "not signed in";
  return "unknown";
}

/**
 * `nowall account verify [id]`: a fresh sign-in check per account, as a table. Exit 1 when an
 * active account is not signed in (so scripts and `doctor` can rely on it). Prints no secrets.
 */
export async function runAccountVerify(argv: string[]): Promise<number> {
  const id = argv.find((a) => !a.startsWith("-"));
  const config = loadConfig();
  if (id !== undefined && !findAccount(config, id)) {
    process.stderr.write(`nowall account verify: no account "${id}". See: nowall account list\n`);
    return 2;
  }
  const rows = await verifyAccounts(id === undefined ? undefined : [id]);
  process.stdout.write("Accounts (fresh check):\n");
  for (const r of rows) {
    const extra = [r.problem, r.hint ? `run: ${r.hint}` : ""].filter(Boolean).join("; ");
    process.stdout.write(
      `  ${r.id.padEnd(20)} ${r.name.padEnd(24)} ${stateWord(r).padEnd(14)} ${(r.active ? "on" : "off").padEnd(4)}${extra ? ` ${extra}` : ""}\n`,
    );
  }
  for (const p of loadConfigReport().problems) process.stdout.write(`Config: ${p}\n`);
  const failing = rows.filter((r) => r.active && r.signedIn === false);
  if (failing.length) {
    process.stdout.write(
      `\n${failing.length} active account${failing.length > 1 ? "s" : ""} can't take over right now.\n`,
    );
    return 1;
  }
  return 0;
}

/**
 * `nowall account login <id> [--api-key [KEY]]`: runs the agent's login inside the profile
 * (recreating a deleted profile folder), or replaces a Cursor account's key, then verifies it and
 * warns when the profile ended up holding the same login as another account.
 */
export async function runAccountLogin(argv: string[]): Promise<number> {
  const id = argv.find((a, i) => !a.startsWith("-") && argv[i - 1] !== "--api-key");
  const config = loadConfig();
  const account = id !== undefined ? findAccount(config, id) : null;
  if (!id || !account) {
    process.stderr.write(
      id
        ? `nowall account login: no account "${id}". See: nowall account list\n`
        : "usage: nowall account login <id> [--api-key [KEY]]\n",
    );
    return 2;
  }
  try {
    let apiKey: string | undefined;
    if (account.secret) {
      const i = argv.indexOf("--api-key");
      apiKey = i >= 0 && !argv[i + 1]?.startsWith("-") ? argv[i + 1] : undefined;
      if (apiKey === undefined) apiKey = process.env[account.secret.env];
      if (!apiKey) apiKey = await askHidden("Paste the new API key: ");
      if (!apiKey) {
        process.stderr.write("No key given; nothing changed.\n");
        return 1;
      }
    } else if (account.env) {
      process.stdout.write(
        `Sign in to ${accountName(id)} now (kept apart from your other logins, in ${Object.values(account.env)[0]}):\n\n`,
      );
    }
    const r = loginAccount(id, apiKey === undefined ? {} : { apiKey });
    if (r.notice) process.stdout.write(`${r.notice}\n`);
    if (r.recreated) process.stdout.write("The profile folder was missing; created it again.\n");
    if (!r.ok) {
      process.stdout.write(`\nLogin didn't finish. Run it later with: ${r.command}\n`);
      return 1;
    }
  } catch (err) {
    process.stderr.write(
      `nowall account login: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
  const [row] = await verifyAccounts([id]);
  if (!row) return 0;
  if (row.signedIn === true) process.stdout.write(`\n${row.name}: signed in.\n`);
  else if (row.signedIn === false)
    process.stdout.write(
      `\n${row.name}: still not signed in${row.hint ? ` (run: ${row.hint})` : ""}.\n`,
    );
  else process.stdout.write(`\n${row.name}: can't tell whether it is signed in.\n`);
  if (row.problem?.includes("same login as")) {
    process.stdout.write(
      `Warning: ${row.id} is the ${row.problem.slice(row.problem.indexOf("same login as"))}. Both will hit the same limit; sign in to a different account to get a second one.\n`,
    );
  }
  return row.signedIn === false ? 1 : 0;
}
