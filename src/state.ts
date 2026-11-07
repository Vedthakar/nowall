import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readJsonSafe, readSmall, writeAtomic } from "./fsafe.js";
import { redactDeep } from "./redact.js";
import {
  type Account,
  type AccountId,
  type AgentId,
  type Config,
  DEFAULT_CONFIG,
  type LimitHit,
  type State,
  accountAgent,
  accountLabel,
} from "./schemas.js";

export function configDir(): string {
  return process.env.NOWALL_HOME ?? join(homedir(), ".config", "nowall");
}

export function readJson<T>(path: string): T | null {
  return readJsonSafe<T>(path);
}

/** Atomic, symlink-safe write so a crash never leaves half a file. */
export function writeJson(path: string, value: unknown): void {
  writeAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

function realRoot(root: string): string {
  try {
    return process.platform === "win32" ? realpathSync.native(root) : realpathSync(root);
  } catch {
    return root;
  }
}

/** Repos the user ran `nowall init` in. Hooks and takeovers only act in these. */
export function isTrustedRepo(root: string): boolean {
  const list = readJson<string[]>(join(configDir(), "repos.json"));
  return Array.isArray(list) && list.includes(realRoot(root));
}

export function trustRepo(root: string): void {
  const path = join(configDir(), "repos.json");
  const list = readJson<string[]>(path);
  const set = new Set(Array.isArray(list) ? list : []);
  set.add(realRoot(root));
  writeJson(path, [...set]);
}

export function untrustRepo(root: string): void {
  const path = join(configDir(), "repos.json");
  const list = readJson<string[]>(path);
  if (Array.isArray(list))
    writeJson(
      path,
      list.filter((r) => r !== realRoot(root)),
    );
}

/**
 * Cooldowns keyed by account id. Keys that aren't account ids (a hand edit, or an agent that no
 * longer exists) are dropped; plain agent ids are the agents' default accounts and stay valid.
 */
export function loadState(): State {
  const s = readJson<State>(join(configDir(), "state.json"));
  if (!s || s.v !== 1 || !isObject(s.agents)) return { v: 1, agents: {} };
  const agents: State["agents"] = {};
  for (const [id, entry] of Object.entries(s.agents)) {
    if (accountAgent(id) && isObject(entry)) agents[id] = entry as State["agents"][string];
  }
  return { v: 1, agents };
}

export function saveState(state: State): void {
  writeJson(join(configDir(), "state.json"), redactDeep(state));
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Extra accounts that are well-formed: id matches "<agent>:<label>" and agrees with its fields.
 * Malformed entries are dropped (and named in `dropped`) rather than failing the whole config.
 */
function validAccounts(list: unknown): { accounts: Account[]; dropped: string[] } {
  const accounts: Account[] = [];
  const dropped: string[] = [];
  if (!Array.isArray(list)) return { accounts, dropped };
  list.forEach((raw, i) => {
    const a = isObject(raw) ? (raw as Partial<Account>) : {};
    const id = typeof a.id === "string" ? a.id : `#${i + 1}`;
    const agent = accountAgent(id);
    const label = accountLabel(id);
    if (!agent || !label || a.agent !== agent || accounts.some((x) => x.id === id)) {
      dropped.push(id);
      return;
    }
    const acc: Account = { id, agent, label };
    if (isObject(a.env)) {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(a.env)) if (typeof v === "string") env[k] = v;
      acc.env = env;
    }
    if (
      isObject(a.secret) &&
      typeof a.secret.env === "string" &&
      (a.secret.store === "keychain" || a.secret.store === "file")
    ) {
      acc.secret = { env: a.secret.env, store: a.secret.store };
    }
    if (!acc.env && !acc.secret) {
      dropped.push(id); // nothing selects this login
      return;
    }
    accounts.push(acc);
  });
  return { accounts, dropped };
}

export interface ConfigReport {
  config: Config;
  /** What was ignored or repaired while loading, one plain sentence each. */
  problems: string[];
}

/** Keeps a copy of an unreadable config so a hand edit is never lost; best effort. */
function keepBackup(path: string, raw: string): boolean {
  try {
    const bak = `${path}.bak`;
    if (readSmall(bak) !== raw) writeAtomic(bak, raw);
    return true;
  } catch {
    return false;
  }
}

/**
 * Loads config.json, falling back field by field to the defaults. A file that isn't valid JSON
 * is copied to config.json.bak and ignored; unknown accounts and order entries are dropped.
 */
export function loadConfigReport(): ConfigReport {
  const path = join(configDir(), "config.json");
  const problems: string[] = [];
  let c: Partial<Config> & Record<string, unknown> = {};
  const raw = readSmall(path);
  if (raw?.trim()) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isObject(parsed)) c = parsed as typeof c;
      else {
        keepBackup(path, raw);
        problems.push(
          "config.json is not a JSON object; using defaults (copy kept as config.json.bak)",
        );
      }
    } catch {
      const kept = keepBackup(path, raw);
      problems.push(
        `config.json is not valid JSON; using defaults${kept ? " (copy kept as config.json.bak)" : ""}`,
      );
    }
  }
  const { accounts, dropped } = validAccounts(c.accounts);
  if (dropped.length)
    problems.push(
      `ignored malformed accounts entr${dropped.length > 1 ? "ies" : "y"}: ${dropped.join(", ")}`,
    );
  const known = (id: unknown): id is AccountId => {
    const agent = accountAgent(id);
    return agent !== null && (id === agent || accounts.some((a) => a.id === id));
  };
  const rawOrder: unknown[] = Array.isArray(c.order) ? c.order : DEFAULT_CONFIG.order;
  const unknown = rawOrder.filter((id) => !known(id)).map(String);
  if (unknown.length) problems.push(`dropped unknown account(s) from order: ${unknown.join(", ")}`);
  const order = rawOrder.filter(
    (id, i, all): id is AccountId => known(id) && all.indexOf(id) === i,
  );
  const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
  const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  const oneOf = <T extends string>(v: unknown, allowed: readonly T[], d: T): T =>
    allowed.includes(v as T) ? (v as T) : d;
  const enabled: Config["enabled"] = { ...DEFAULT_CONFIG.enabled };
  for (const [k, v] of Object.entries(isObject(c.enabled) ? c.enabled : {}))
    if (typeof v === "boolean" && accountAgent(k) === k) enabled[k as AgentId] = v;
  const stop: Record<string, unknown> = isObject(c.stop) ? c.stop : {};
  const fallback: Record<string, unknown> = isObject(c.fallback) ? c.fallback : {};
  const config: Config = {
    ...DEFAULT_CONFIG,
    ...c,
    v: 1,
    order,
    enabled,
    yolo: bool(c.yolo, DEFAULT_CONFIG.yolo),
    stop: {
      maxTurns: num(stop.maxTurns, DEFAULT_CONFIG.stop.maxTurns),
      maxMinutes: num(stop.maxMinutes, DEFAULT_CONFIG.stop.maxMinutes),
      noDiffTurns: num(stop.noDiffTurns, DEFAULT_CONFIG.stop.noDiffTurns),
    },
    defaultCooldownMinutes: num(c.defaultCooldownMinutes, DEFAULT_CONFIG.defaultCooldownMinutes),
    takeover: oneOf(c.takeover, ["background", "terminal", "off"], DEFAULT_CONFIG.takeover),
    scope: oneOf(c.scope, ["repo", "global"], DEFAULT_CONFIG.scope),
    fallback: {
      enabled: bool(fallback.enabled, DEFAULT_CONFIG.fallback.enabled),
      chinaConsent: bool(fallback.chinaConsent, DEFAULT_CONFIG.fallback.chinaConsent),
    },
  };
  if (["openrouter", "deepseek", "kimi", "glm"].includes(fallback.provider as string))
    config.fallback.provider = fallback.provider as NonNullable<Config["fallback"]["provider"]>;
  if (typeof c.path !== "string") config.path = undefined;
  if (typeof c.notch !== "boolean") config.notch = undefined;
  if (accounts.length) config.accounts = accounts;
  else config.accounts = undefined;
  return { config, problems };
}

export function loadConfig(): Config {
  return loadConfigReport().config;
}

export function saveConfig(config: Config): void {
  writeJson(join(configDir(), "config.json"), config);
}

/** Records a quota hit and sets the cooldown (reset time, else the default backoff). */
export function recordLimit(
  state: State,
  account: AccountId,
  hit: LimitHit,
  now: Date,
  defaultCooldownMinutes: number,
): State {
  const until =
    hit.resetsAt ?? new Date(now.getTime() + defaultCooldownMinutes * 60_000).toISOString();
  const lastLimit: NonNullable<State["agents"][AccountId]>["lastLimit"] = {
    window: hit.window,
    message: hit.message,
    observedAt: now.toISOString(),
  };
  if (hit.resetsAt) lastLimit.resetsAt = hit.resetsAt;
  return {
    ...state,
    agents: {
      ...state.agents,
      [account]: { ...state.agents[account], cooldownUntil: until, lastLimit },
    },
  };
}

export function isCoolingDown(state: State, account: AccountId, now: Date): boolean {
  const until = state.agents[account]?.cooldownUntil;
  return until !== undefined && Date.parse(until) > now.getTime();
}

/**
 * Next account: configured order ∩ agent enabled ∩ available ∩ not cooling down ∩ not excluded.
 * `available` holds account ids (an agent id stands for its default account).
 */
export function pickNext(
  config: Config,
  state: State,
  available: ReadonlySet<AccountId>,
  exclude: readonly AccountId[],
  now: Date,
): AccountId | null {
  for (const id of config.order) {
    const agent = accountAgent(id);
    if (!agent || !config.enabled[agent] || !available.has(id) || exclude.includes(id)) continue;
    if (agent === "qwen" && !config.fallback.enabled) continue;
    if (isCoolingDown(state, id, now)) continue;
    return id;
  }
  return null;
}

export function earliestReset(
  state: State,
  now: Date,
): { account: AccountId; agent: AgentId; at: string } | null {
  let best: { account: AccountId; agent: AgentId; at: string } | null = null;
  for (const [id, s] of Object.entries(state.agents)) {
    const agent = accountAgent(id);
    if (!agent || !s?.cooldownUntil || Date.parse(s.cooldownUntil) <= now.getTime()) continue;
    if (!best || Date.parse(s.cooldownUntil) < Date.parse(best.at))
      best = { account: id, agent, at: s.cooldownUntil };
  }
  return best;
}
