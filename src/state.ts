import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { redactDeep } from "./redact.js";
import {
  type AgentId,
  type Config,
  DEFAULT_CONFIG,
  type LimitHit,
  type State,
  isAgentId,
} from "./schemas.js";

export function configDir(): string {
  return process.env.NOWALL_HOME ?? join(homedir(), ".config", "nowall");
}

export function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Atomic write (tmp + rename) so a crash never leaves half a file. */
export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

export function loadState(): State {
  const s = readJson<State>(join(configDir(), "state.json"));
  return s && s.v === 1 && typeof s.agents === "object" ? s : { v: 1, agents: {} };
}

export function saveState(state: State): void {
  writeJson(join(configDir(), "state.json"), redactDeep(state));
}

export function loadConfig(): Config {
  const c = readJson<Partial<Config>>(join(configDir(), "config.json")) ?? {};
  return {
    ...DEFAULT_CONFIG,
    ...c,
    order: (c.order ?? DEFAULT_CONFIG.order).filter(isAgentId),
    enabled: { ...DEFAULT_CONFIG.enabled, ...c.enabled },
    stop: { ...DEFAULT_CONFIG.stop, ...c.stop },
    fallback: { ...DEFAULT_CONFIG.fallback, ...c.fallback },
  };
}

export function saveConfig(config: Config): void {
  writeJson(join(configDir(), "config.json"), config);
}

/** Records a quota hit and sets the cooldown (reset time, else the default backoff). */
export function recordLimit(
  state: State,
  agent: AgentId,
  hit: LimitHit,
  now: Date,
  defaultCooldownMinutes: number,
): State {
  const until =
    hit.resetsAt ?? new Date(now.getTime() + defaultCooldownMinutes * 60_000).toISOString();
  const lastLimit: NonNullable<State["agents"][AgentId]>["lastLimit"] = {
    window: hit.window,
    message: hit.message,
    observedAt: now.toISOString(),
  };
  if (hit.resetsAt) lastLimit.resetsAt = hit.resetsAt;
  return {
    ...state,
    agents: {
      ...state.agents,
      [agent]: { ...state.agents[agent], cooldownUntil: until, lastLimit },
    },
  };
}

export function isCoolingDown(state: State, agent: AgentId, now: Date): boolean {
  const until = state.agents[agent]?.cooldownUntil;
  return until !== undefined && Date.parse(until) > now.getTime();
}

/** Next agent: configured order ∩ enabled ∩ available ∩ not cooling down ∩ not excluded. */
export function pickNext(
  config: Config,
  state: State,
  available: ReadonlySet<AgentId>,
  exclude: readonly AgentId[],
  now: Date,
): AgentId | null {
  for (const id of config.order) {
    if (!config.enabled[id] || !available.has(id) || exclude.includes(id)) continue;
    if (id === "qwen" && !config.fallback.enabled) continue;
    if (isCoolingDown(state, id, now)) continue;
    return id;
  }
  return null;
}

export function earliestReset(state: State, now: Date): { agent: AgentId; at: string } | null {
  let best: { agent: AgentId; at: string } | null = null;
  for (const [id, s] of Object.entries(state.agents)) {
    if (!isAgentId(id) || !s?.cooldownUntil || Date.parse(s.cooldownUntil) <= now.getTime())
      continue;
    if (!best || Date.parse(s.cooldownUntil) < Date.parse(best.at))
      best = { agent: id, at: s.cooldownUntil };
  }
  return best;
}
