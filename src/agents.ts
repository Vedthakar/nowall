import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { accountEnv, accountName, allAccounts } from "./accounts.js";
import { ADAPTERS, resolveBinary } from "./adapters/index.js";
import { type Runner, defaultRunner } from "./adapters/types.js";
import { readJsonSafe, readTail, writeAtomic } from "./fsafe.js";
import { AGENT_IDS, type AccountId, type AgentId } from "./schemas.js";
import { configDir, loadConfig, loadState } from "./state.js";

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

/** Detects every agent, merges cooldowns and usage, and writes agents.json for the notch. */
export async function refreshAgents(
  run: Runner = defaultRunner,
  now = new Date(),
): Promise<AgentsSnapshot> {
  const prev = readJsonSafe<AgentsSnapshot>(agentsPath());
  const fresh = prev && now.getTime() - Date.parse(prev.updatedAt) < SIGNIN_TTL_MS;
  const config = loadConfig();
  const state = loadState();
  const agents = await Promise.all(
    AGENT_IDS.map(async (id): Promise<AgentInfo> => {
      const a = ADAPTERS[id];
      const bin = resolveBinary(a.binary, process.argv[1]);
      const cached = fresh ? prev?.agents.find((x) => x.id === id) : undefined;
      let installed = Boolean(bin);
      let signedIn: boolean | "unknown" = false;
      if (bin) {
        // Sign-in checks can hit the network (Cursor); reuse a recent answer.
        signedIn = cached?.installed ? cached.signedIn : (await a.detect(run, bin)).signedIn;
      }
      const info: AgentInfo = {
        id,
        name: a.displayName,
        installed,
        signedIn,
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
        active: config.order.includes(a.id) && agent.enabled,
      };
      const env = accountEnv(config, a.id);
      if (a.id !== a.agent) {
        const bin = resolveBinary(ADAPTERS[a.agent].binary, process.argv[1]);
        const cached = fresh ? prev?.accounts?.find((x) => x.id === a.id) : undefined;
        if (!bin) info.signedIn = false;
        else if (cached) info.signedIn = cached.signedIn;
        else if (a.secret && !env[a.secret.env])
          info.signedIn = false; // key missing
        else info.signedIn = (await ADAPTERS[a.agent].detect(run, bin, env)).signedIn;
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
