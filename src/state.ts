import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readJsonSafe, writeAtomic } from "./fsafe.js";
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
    return realpathSync(root);
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

export function loadState(): State {
  const s = readJson<State>(join(configDir(), "state.json"));
  return s && s.v === 1 && typeof s.agents === "object" ? s : { v: 1, agents: {} };
}

export function saveState(state: State): void {
  writeJson(join(configDir(), "state.json"), redactDeep(state));
}

/** Extra accounts that are well-formed: id matches "<agent>:<label>" and agrees with its fields. */
function validAccounts(list: unknown): Account[] {
  if (!Array.isArray(list)) return [];
  const out: Account[] = [];
  for (const a of list as Partial<Account>[]) {
    if (!a || typeof a.id !== "string") continue;
    const agent = accountAgent(a.id);
    const label = accountLabel(a.id);
    if (!agent || !label || a.agent !== agent || out.some((x) => x.id === a.id)) continue;
    const acc: Account = { id: a.id, agent, label };
    if (a.env && typeof a.env === "object") acc.env = { ...a.env };
    if (a.secret && typeof a.secret.env === "string") acc.secret = a.secret;
    out.push(acc);
  }
  return out;
}

export function loadConfig(): Config {
  const c = readJson<Partial<Config>>(join(configDir(), "config.json")) ?? {};
  const accounts = validAccounts(c.accounts);
  const known = (id: string) => {
    const agent = accountAgent(id);
    return agent !== null && (id === agent || accounts.some((a) => a.id === id));
  };
  const order = (Array.isArray(c.order) ? c.order : DEFAULT_CONFIG.order).filter(
    (id, i, all): id is AccountId => known(id) && all.indexOf(id) === i,
  );
  const config: Config = {
    ...DEFAULT_CONFIG,
    ...c,
    order,
    enabled: { ...DEFAULT_CONFIG.enabled, ...c.enabled },
    stop: { ...DEFAULT_CONFIG.stop, ...c.stop },
    fallback: { ...DEFAULT_CONFIG.fallback, ...c.fallback },
  };
  if (accounts.length) config.accounts = accounts;
  else config.accounts = undefined;
  return config;
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
