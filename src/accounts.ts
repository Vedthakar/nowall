import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { createInterface } from "node:readline/promises";
import { ADAPTERS, resolveBinary } from "./adapters/index.js";
import type { Runner } from "./adapters/types.js";
import { readJsonSafe, writeAtomic } from "./fsafe.js";
import { agentName } from "./prompt.js";
import {
  AGENT_IDS,
  type Account,
  type AccountId,
  type AgentId,
  type Config,
  accountAgent,
  accountLabel,
  labelProblem,
} from "./schemas.js";
import { configDir, loadConfig, loadState, saveConfig, saveState } from "./state.js";

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

/** The agent's own sign-in command, run inside a profile by `nowall account add|login`. */
export function loginArgs(agent: AgentId): string[] | null {
  if (agent === "claude") return ["auth", "login"];
  if (agent === "codex") return ["login"];
  return null;
}

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

export function profilesDir(): string {
  return join(configDir(), "profiles");
}

export function profileDir(agent: AgentId, label: string): string {
  return join(profilesDir(), `${agent}-${label}`);
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

/** Where a profile keeps its login, for messages. */
export function profilePath(account: Account): string | null {
  const v = account.env ? Object.values(account.env)[0] : undefined;
  return v && existsSync(v) ? v : (v ?? null);
}

/** True when nowall created this profile directory (so it may also delete it). */
export function profileIsManaged(account: Account): boolean {
  const dir = account.env ? Object.values(account.env)[0] : undefined;
  if (!dir) return false;
  const base = resolve(profilesDir()) + sep;
  return resolve(dir).startsWith(base);
}

/**
 * What stops this account from working right now, before asking the agent: its profile folder
 * is gone, or its key is missing. Null when nothing obvious is wrong. Never reveals secrets.
 */
export function accountProblem(account: Account): { problem: string; hint: string } | null {
  if (account.env) {
    const dir = Object.values(account.env)[0];
    if (dir && !existsSync(dir))
      return { problem: "profile missing", hint: `nowall account login ${account.id}` };
  }
  if (account.secret) {
    if (!readSecret(account.id, account.secret.store))
      return {
        problem: `API key missing (${account.secret.store})`,
        hint: `nowall account login ${account.id} --api-key`,
      };
    if (account.secret.store === "file") fixSecretPerms(account.id);
  }
  return null;
}

// --- secrets -------------------------------------------------------------------------------

const SERVICE = "nowall";

/** Keychain on macOS unless NOWALL_SECRET_STORE says otherwise ("file" | "keychain"). */
function secretStore(): "keychain" | "file" {
  const pref = process.env.NOWALL_SECRET_STORE;
  if (pref === "file" || pref === "keychain") return pref;
  return process.platform === "darwin" ? "keychain" : "file";
}

function secretFile(id: AccountId): string {
  return join(configDir(), "secrets", id.replace(/[^A-Za-z0-9_-]/g, "_"));
}

/** `secrets/` is 0700 and every key file 0600, even if the directory already existed. */
function fixSecretPerms(id: AccountId): void {
  try {
    chmodSync(join(configDir(), "secrets"), 0o700);
    if ((statSync(secretFile(id)).mode & 0o777) !== 0o600) chmodSync(secretFile(id), 0o600);
  } catch {
    // missing file: nothing to fix
  }
}

/** Why a pasted key can't be used, or null. Keys are one non-empty line. */
export function apiKeyProblem(key: string): string | null {
  const k = key.trim();
  if (!k) return "API key is empty";
  if (/[\r\n]/.test(k)) return "API key must be a single line";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: a pasted key must not carry control characters
  if (/[\x00-\x1f\x7f]/.test(k)) return "API key contains control characters";
  return null;
}

export interface StoredSecret {
  store: "keychain" | "file";
  /** One line for the user when the Keychain couldn't be used and the file store took over. */
  notice?: string;
}

export function storeSecret(id: AccountId, value: string): StoredSecret {
  let notice: string | undefined;
  if (secretStore() === "keychain") {
    const r = spawnSync(
      "security",
      ["add-generic-password", "-U", "-s", SERVICE, "-a", id, "-w", value],
      { stdio: "ignore" },
    );
    if (r.status === 0) return { store: "keychain" };
    const why = r.error
      ? `security: ${r.error.message}`
      : `security exited ${r.status ?? "by signal"}`;
    notice = `Keychain unavailable (${why}); keeping the key in ${secretFile(id)} (0600) instead.`;
  }
  try {
    mkdirSync(join(configDir(), "secrets"), { recursive: true, mode: 0o700 });
    writeAtomic(secretFile(id), value, 0o600);
  } catch (err) {
    throw homeProblem(err, "the secrets folder");
  }
  fixSecretPerms(id);
  return notice ? { store: "file", notice } : { store: "file" };
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

/** Reads a secret from the terminal without echoing it; "" when there is no terminal. */
export async function askHidden(question: string): Promise<string> {
  if (!process.stdin.isTTY) return "";
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const mute = rl as unknown as { _writeToOutput: (s: string) => void };
  const original = mute._writeToOutput.bind(rl);
  mute._writeToOutput = (s: string) => {
    if (s.includes(question)) original(question);
  };
  try {
    const answer = await rl.question(question);
    process.stdout.write("\n");
    return answer.trim();
  } finally {
    rl.close();
  }
}

// --- sign-in cache ---------------------------------------------------------------------------

const EPOCH = "1970-01-01T00:00:00.000Z";

/**
 * Marks these accounts' cached sign-in answers in agents.json as stale, so the next
 * `refreshAgents` asks the agent again. Entries stay so the notch keeps showing them.
 */
export function forgetSignIn(ids: readonly AccountId[]): void {
  const path = join(configDir(), "agents.json");
  const snap = readJsonSafe<{
    agents?: { id: string; checkedAt?: string }[];
    accounts?: { id: string; checkedAt?: string }[];
  }>(path);
  if (!snap) return;
  const set = new Set(ids);
  for (const a of snap.agents ?? []) if (set.has(a.id)) a.checkedAt = EPOCH;
  for (const a of snap.accounts ?? []) if (set.has(a.id)) a.checkedAt = EPOCH;
  try {
    writeAtomic(path, `${JSON.stringify(snap, null, 2)}\n`);
  } catch {
    // best effort: a stale cache only delays the next check by up to 10 minutes
  }
}

// --- identity --------------------------------------------------------------------------------

/**
 * A stable, non-secret fingerprint of the login behind an account, so two profiles signed in
 * to the same account can be noticed ("claude:work is the same login as claude"). Claude's
 * `auth status --json` reports the email; we keep only the first 16 hex chars of its sha256,
 * and nothing is written to disk. Other agents expose nothing comparable → null.
 */
export async function accountIdentity(
  run: Runner,
  bin: string,
  account: Account,
  env: Record<string, string>,
): Promise<string | null> {
  if (account.agent !== "claude") return null;
  const r = await run(bin, ["auth", "status", "--json"], 15_000, env);
  let s: { loggedIn?: boolean; email?: string; configDirectory?: string };
  try {
    s = JSON.parse(r.stdout) as typeof s;
  } catch {
    return null;
  }
  if (s.loggedIn !== true) return null;
  const who =
    typeof s.email === "string" && s.email.trim()
      ? `email:${s.email.trim().toLowerCase()}`
      : typeof s.configDirectory === "string" && s.configDirectory
        ? `dir:${s.configDirectory}`
        : null;
  if (!who) return null;
  return createHash("sha256").update(`claude|${who}`).digest("hex").slice(0, 16);
}

// --- editing -------------------------------------------------------------------------------

export function validLabel(label: string): boolean {
  return labelProblem(label) === null;
}

/** Turns an EACCES/EROFS from the config folder into one sentence the user can act on. */
function homeProblem(err: unknown, what: string): Error {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (code === "EACCES" || code === "EPERM" || code === "EROFS" || code === "ENOTDIR") {
    return new Error(
      `can't write ${what} in ${configDir()} (${code}). Check NOWALL_HOME and the folder's permissions.`,
    );
  }
  return err instanceof Error ? err : new Error(String(err));
}

function saveConfigOrExplain(config: Config): void {
  try {
    saveConfig(config);
  } catch (err) {
    throw homeProblem(err, "config.json");
  }
}

/**
 * Registers an extra account and puts it in the order right after the last account of the same
 * agent (so "claude:work" follows "claude"). Returns the saved account. For agents with a profile
 * directory the caller still has to run the login inside that profile (`loginAccount`).
 * A Keychain failure falls back to the 0600 file and is reported through `notice` (stderr by default).
 */
export function addAccount(
  agent: AgentId,
  label: string,
  opts: { apiKey?: string; notice?: (line: string) => void } = {},
): Account {
  const bad = labelProblem(label);
  if (bad) throw new Error(bad);
  const id: AccountId = `${agent}:${label}`;
  const config = loadConfig();
  if (findAccount(config, id)) throw new Error(`${id} already exists`);
  const account: Account = { id, agent, label };
  const profileVar = PROFILE_ENV[agent];
  const keyVar = KEY_ENV[agent];
  if (profileVar) {
    const dir = profileDir(agent, label);
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch (err) {
      throw homeProblem(err, "a profile folder");
    }
    account.env = { [profileVar]: dir };
  } else if (keyVar) {
    if (opts.apiKey === undefined) throw new Error(`${agentName(agent)} accounts need an API key`);
    const problem = apiKeyProblem(opts.apiKey);
    if (problem) throw new Error(problem);
    const saved = storeSecret(id, opts.apiKey.trim());
    if (saved.notice) (opts.notice ?? ((s) => process.stderr.write(`${s}\n`)))(saved.notice);
    account.secret = { env: keyVar, store: saved.store };
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
  saveConfigOrExplain(config);
  forgetSignIn([id]);
  return account;
}

/**
 * Removes an extra account from the config, forgets its secret and drops its cooldown. The
 * profile dir (the login) is kept unless `purge` is set; even then only a folder nowall created
 * under `profiles/` is deleted. Returns the removed account, or null if there was none.
 */
export function removeAccount(id: AccountId, opts: { purge?: boolean } = {}): Account | null {
  const config = loadConfig();
  const account = (config.accounts ?? []).find((a) => a.id === id);
  if (!account) return null;
  if (account.secret) deleteSecret(id, account.secret.store);
  if (opts.purge && profileIsManaged(account)) {
    const dir = Object.values(account.env ?? {})[0] as string;
    rmSync(dir, { recursive: true, force: true });
  }
  const rest = (config.accounts ?? []).filter((a) => a.id !== id);
  if (rest.length) config.accounts = rest;
  else config.accounts = undefined;
  config.order = config.order.filter((x) => x !== id);
  saveConfigOrExplain(config);
  const state = loadState();
  if (state.agents[id]) {
    delete state.agents[id];
    saveState(state);
  }
  forgetSignIn([id]);
  return account;
}

export interface LoginResult {
  /** The login command exited 0 (or the key was replaced). */
  ok: boolean;
  /** The profile folder had been deleted and was created again before the login. */
  recreated: boolean;
  /** The exact command to run by hand if this didn't finish. */
  command: string;
  notice?: string;
}

/** How to sign in to this account by hand, e.g. `CLAUDE_CONFIG_DIR=… claude auth login`. */
export function loginCommand(account: Account, bin?: string): string {
  const args = loginArgs(account.agent);
  if (!args) return `nowall account login ${account.id}`;
  const env = Object.entries(account.env ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  return `${env ? `${env} ` : ""}${bin ?? ADAPTERS[account.agent].binary} ${args.join(" ")}`;
}

export type LoginSpawner = (bin: string, args: string[], env: NodeJS.ProcessEnv) => number | null;

const inheritSpawn: LoginSpawner = (bin, args, env) =>
  spawnSync(bin, args, { stdio: "inherit", env }).status;

/**
 * Signs an account in again: runs the agent's own login inside the profile (recreating the folder
 * if it was deleted), or, for key accounts, replaces the stored API key. The cached sign-in
 * answer is forgotten either way. Throws with a plain sentence when it can't.
 */
export function loginAccount(
  id: AccountId,
  opts: { apiKey?: string; spawn?: LoginSpawner } = {},
): LoginResult {
  const config = loadConfig();
  const account = findAccount(config, id);
  if (!account) throw new Error(`no account "${id}". See: nowall account list`);
  if (account.secret) {
    if (opts.apiKey === undefined) {
      throw new Error(
        `${accountName(id)} uses an API key, not a login. Replace the key with: nowall account login ${id} --api-key`,
      );
    }
    const problem = apiKeyProblem(opts.apiKey);
    if (problem) throw new Error(problem);
    const saved = storeSecret(id, opts.apiKey.trim());
    const entry = (config.accounts ?? []).find((a) => a.id === id);
    if (entry?.secret && entry.secret.store !== saved.store) {
      deleteSecret(id, entry.secret.store);
      entry.secret = { env: entry.secret.env, store: saved.store };
      saveConfigOrExplain(config);
    }
    forgetSignIn([id]);
    const out: LoginResult = {
      ok: true,
      recreated: false,
      command: `nowall account login ${id} --api-key`,
    };
    if (saved.notice) out.notice = saved.notice;
    return out;
  }
  const args = loginArgs(account.agent);
  if (!args)
    throw new Error(`${agentName(account.agent)} signs in interactively; just run it once.`);
  const bin = resolveBinary(ADAPTERS[account.agent].binary, process.argv[1]);
  if (!bin) {
    throw new Error(
      `${agentName(account.agent)} is not installed. Install: ${ADAPTERS[account.agent].installHint}`,
    );
  }
  let recreated = false;
  const dir = account.env ? Object.values(account.env)[0] : undefined;
  if (dir && !existsSync(dir)) {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch (err) {
      throw homeProblem(err, "the profile folder");
    }
    recreated = true;
  }
  const status = (opts.spawn ?? inheritSpawn)(bin, args, {
    ...process.env,
    ...(account.env ?? {}),
  });
  forgetSignIn([id]);
  return { ok: status === 0, recreated, command: loginCommand(account, bin) };
}

/** Replaces the takeover order. Every id must be a known account; duplicates are dropped. */
export function setOrder(ids: string[]): Config {
  const config = loadConfig();
  const known = new Set(allAccounts(config).map((a) => a.id));
  const bad = ids.filter((id) => !known.has(id));
  if (bad.length) throw new Error(`unknown account${bad.length > 1 ? "s" : ""}: ${bad.join(", ")}`);
  config.order = ids.filter((id, i) => ids.indexOf(id) === i);
  saveConfigOrExplain(config);
  return config;
}
