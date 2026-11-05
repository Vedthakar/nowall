import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "./fsafe.js";
import { agentName } from "./prompt.js";
import {
  ACCOUNT_LABEL_RE,
  AGENT_IDS,
  type Account,
  type AccountId,
  type AgentId,
  type Config,
  accountAgent,
  accountLabel,
} from "./schemas.js";
import { configDir, loadConfig, saveConfig } from "./state.js";

/**
 * Accounts: one login per entry. The default account of an agent is the agent's own login
 * ("claude"); extra accounts ("claude:work") are separate logins the user did once in an isolated
 * profile, selected through the agent's own environment variable. nowall never reads an agent's
 * credentials; the only secret it keeps is a Cursor API key the user typed in on purpose.
 */

/** The env var that points an agent at a separate profile (login + settings), if it has one. */
export const PROFILE_ENV: Partial<Record<AgentId, string>> = {
  claude: "CLAUDE_CONFIG_DIR",
  codex: "CODEX_HOME",
};

/** Agents whose extra accounts are an API key passed in the environment. */
export const KEY_ENV: Partial<Record<AgentId, string>> = {
  cursor: "CURSOR_API_KEY",
};

export function supportsExtraAccounts(agent: AgentId): boolean {
  return agent in PROFILE_ENV || agent in KEY_ENV;
}

/** "Claude Code" for the default account, "Claude Code (work)" for an extra one. */
export function accountName(id: AccountId): string {
  const agent = accountAgent(id);
  if (!agent) return id;
  const label = accountLabel(id);
  return label ? `${agentName(agent)} (${label})` : agentName(agent);
}

export function profileDir(agent: AgentId, label: string): string {
  return join(configDir(), "profiles", `${agent}-${label}`);
}

/** Every account in priority order: those in `order` first, then the rest (which are off). */
export function allAccounts(config: Config): Account[] {
  const defaults: Account[] = AGENT_IDS.map((agent) => ({ id: agent, agent, label: "" }));
  const extras = config.accounts ?? [];
  const byId = new Map<string, Account>();
  for (const a of [...defaults, ...extras]) byId.set(a.id, a);
  const ordered: Account[] = [];
  for (const id of config.order) {
    const a = byId.get(id);
    if (a) {
      ordered.push(a);
      byId.delete(id);
    }
  }
  return [...ordered, ...byId.values()];
}

export function findAccount(config: Config, id: AccountId): Account | null {
  return allAccounts(config).find((a) => a.id === id) ?? null;
}

/** Environment overrides that select this account's login, secrets resolved. */
export function accountEnv(config: Config, id: AccountId): Record<string, string> {
  const a = findAccount(config, id);
  if (!a) return {};
  const env = { ...(a.env ?? {}) };
  if (a.secret) {
    const value = readSecret(a.id, a.secret.store);
    if (value) env[a.secret.env] = value;
  }
  return env;
}

/**
 * Which account an agent process is running as, from its environment: the account whose profile
 * env vars all match. Hooks use this so a limit in `CLAUDE_CONFIG_DIR=~/.../claude-work claude`
 * cools down "claude:work", not "claude".
 */
export function accountFromEnv(agent: AgentId, env: NodeJS.ProcessEnv): AccountId {
  for (const a of loadConfig().accounts ?? []) {
    if (a.agent !== agent || !a.env) continue;
    const entries = Object.entries(a.env);
    if (entries.length && entries.every(([k, v]) => env[k] === v)) return a.id;
  }
  return agent;
}

// --- secrets -------------------------------------------------------------------------------

const SERVICE = "nowall";

function secretStore(): "keychain" | "file" {
  return process.platform === "darwin" && process.env.NOWALL_SECRET_STORE !== "file"
    ? "keychain"
    : "file";
}

function secretFile(id: AccountId): string {
  return join(configDir(), "secrets", id.replace(/[^A-Za-z0-9_-]/g, "_"));
}

export function storeSecret(id: AccountId, value: string): "keychain" | "file" {
  const store = secretStore();
  if (store === "keychain") {
    const r = spawnSync(
      "security",
      ["add-generic-password", "-U", "-s", SERVICE, "-a", id, "-w", value],
      { stdio: "ignore" },
    );
    if (r.status === 0) return "keychain";
  }
  mkdirSync(join(configDir(), "secrets"), { recursive: true, mode: 0o700 });
  writeAtomic(secretFile(id), value, 0o600);
  return "file";
}

export function readSecret(id: AccountId, store: "keychain" | "file"): string | undefined {
  if (store === "keychain") {
    const r = spawnSync("security", ["find-generic-password", "-s", SERVICE, "-a", id, "-w"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return r.status === 0 ? r.stdout.trim() || undefined : undefined;
  }
  try {
    return readFileSync(secretFile(id), "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

export function deleteSecret(id: AccountId, store: "keychain" | "file"): void {
  if (store === "keychain") {
    spawnSync("security", ["delete-generic-password", "-s", SERVICE, "-a", id], {
      stdio: "ignore",
    });
  }
  rmSync(secretFile(id), { force: true });
}

// --- editing -------------------------------------------------------------------------------

export function validLabel(label: string): boolean {
  return ACCOUNT_LABEL_RE.test(label);
}

/**
 * Registers an extra account and puts it in the order right after the last account of the same
 * agent (so "claude:work" follows "claude"). Returns the saved account. For agents with a profile
 * directory the caller still has to run the login inside that profile.
 */
export function addAccount(agent: AgentId, label: string, opts: { apiKey?: string } = {}): Account {
  if (!validLabel(label)) throw new Error(`label must match ${ACCOUNT_LABEL_RE}`);
  const id: AccountId = `${agent}:${label}`;
  const config = loadConfig();
  if (findAccount(config, id)) throw new Error(`${id} already exists`);
  const account: Account = { id, agent, label };
  const profileVar = PROFILE_ENV[agent];
  const keyVar = KEY_ENV[agent];
  if (profileVar) {
    const dir = profileDir(agent, label);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    account.env = { [profileVar]: dir };
  } else if (keyVar) {
    if (!opts.apiKey) throw new Error(`${agentName(agent)} accounts need an API key`);
    account.secret = { env: keyVar, store: storeSecret(id, opts.apiKey) };
  } else {
    throw new Error(`${agentName(agent)} does not support extra accounts yet`);
  }
  config.accounts = [...(config.accounts ?? []), account];
  const order = [...config.order];
  let at = -1;
  order.forEach((x, i) => {
    if (accountAgent(x) === agent) at = i;
  });
  order.splice(at + 1, 0, id);
  config.order = order;
  saveConfig(config);
  return account;
}

/** Removes an extra account from the config and forgets its secret. The profile dir is kept. */
export function removeAccount(id: AccountId): Account | null {
  const config = loadConfig();
  const account = (config.accounts ?? []).find((a) => a.id === id);
  if (!account) return null;
  if (account.secret) deleteSecret(id, account.secret.store);
  const rest = (config.accounts ?? []).filter((a) => a.id !== id);
  if (rest.length) config.accounts = rest;
  else config.accounts = undefined;
  config.order = config.order.filter((x) => x !== id);
  saveConfig(config);
  return account;
}

/** Replaces the takeover order. Every id must be a known account; duplicates are dropped. */
export function setOrder(ids: string[]): Config {
  const config = loadConfig();
  const known = new Set(allAccounts(config).map((a) => a.id));
  const bad = ids.filter((id) => !known.has(id));
  if (bad.length) throw new Error(`unknown account${bad.length > 1 ? "s" : ""}: ${bad.join(", ")}`);
  config.order = ids.filter((id, i) => ids.indexOf(id) === i);
  saveConfig(config);
  return config;
}

/** Where a profile keeps its login, for messages. */
export function profilePath(account: Account): string | null {
  const v = account.env ? Object.values(account.env)[0] : undefined;
  return v && existsSync(v) ? v : (v ?? null);
}
