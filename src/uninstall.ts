import {
  type Stats,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative, sep } from "node:path";
import { createInterface } from "node:readline/promises";
import { deleteSecret } from "./accounts.js";
import { isOurs, unwrapStatusLine } from "./adapters/common.js";
import { readJsonSafe, writeAtomic } from "./fsafe.js";
import { CHECKPOINT_PREFIX } from "./git.js";
import { MARK_START, REPO_HOOK_FILES, rcFiles, removeRepoHooks, stripBlock } from "./init.js";
import { spawn, spawnSync } from "./proc.js";
import { type Account, accountAgent } from "./schemas.js";
import { notchLabel, notchRunning, stopNotch, tempHomeProblem } from "./setup.js";
import { configDir, loadConfig, saveConfig } from "./state.js";
import type { SessionStatus } from "./status.js";

/**
 * `nowall uninstall --global`: takes nowall back out of this computer, and only nowall.
 *
 * - Hooks: drops our entries (marked NOWALL_HOOK=1) from the user-level hook files and leaves the
 *   user's own hooks and keys exactly as they were; a status line we chained in front of (`--then`)
 *   goes back to the original command.
 * - Shell: removes the `# >>> nowall >>>` alias block from ~/.zshrc and ~/.bashrc.
 * - Notch: unloads and deletes the LaunchAgent for THIS config folder only (W0's home-derived
 *   label) and quits that process. Never touches launchctl/pkill under NOWALL_NO_LAUNCHD.
 * - Data: kept by default (accounts, profiles, secrets); `--purge` removes ~/.config/nowall and
 *   the Keychain items of its accounts after a confirmation (`--yes` skips it).
 * - Repos: kept by default; `--repos` removes .handoff/ and refs/nowall/* in every repo we know.
 * Every step is idempotent and `--dry-run` only prints what would happen.
 */

export const REINSTALL_LINE =
  process.platform === "win32"
    ? "irm https://raw.githubusercontent.com/Vedthakar/nowall/main/install.ps1 | iex"
    : "curl -fsSL https://raw.githubusercontent.com/Vedthakar/nowall/main/install.sh | sh";
const NPM_UNINSTALL = "npm uninstall -g nowall";
const USER_HOOK_FILES = [".claude/settings.json", ".codex/hooks.json", ".cursor/hooks.json"];
const CLAUDE_MD_START = "<!-- nowall:start -->";
const CLAUDE_MD_END = "<!-- nowall:end -->";
const KEYCHAIN_SERVICE = "nowall";

export interface UninstallIO {
  out: (s: string) => void;
  err: (s: string) => void;
  ask: (q: string) => Promise<string>;
}

type Json = Record<string, unknown>;

interface Flags {
  yes: boolean;
  purge: boolean;
  keepData: boolean;
  npm: boolean;
  repos: boolean;
  dryRun: boolean;
}

function parseFlags(argv: string[]): Flags {
  const has = (...names: string[]) => names.some((n) => argv.includes(n));
  return {
    yes: has("--yes", "-y"),
    purge: has("--purge"),
    keepData: has("--keep-data"),
    npm: has("--npm"),
    repos: has("--repos"),
    dryRun: has("--dry-run"),
  };
}

async function askTty(q: string): Promise<string> {
  if (!process.stdin.isTTY) return "";
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(q)).trim().toLowerCase();
  } finally {
    rl.close();
  }
}

/** Prints what is being done; runs it unless this is a dry run. */
class Actor {
  constructor(
    private io: UninstallIO,
    readonly dryRun: boolean,
  ) {}
  do(what: string, fn: () => void): void {
    this.io.out(`${this.dryRun ? "would: " : ""}${what}\n`);
    if (!this.dryRun) fn();
  }
  note(what: string): void {
    this.io.out(`${what}\n`);
  }
}

function noLaunchd(): boolean {
  return process.env.NOWALL_NO_LAUNCHD === "1";
}

function keychainUsable(): boolean {
  return process.platform === "darwin" && process.env.NOWALL_SECRET_STORE !== "file";
}

const tilde = (p: string) => p.replace(homedir(), "~");

// --- hooks ---------------------------------------------------------------------------------

/** Any trace of a nowall hook or status-line tap, in any form we have ever written. */
export function mentionsNowall(text: string): boolean {
  return isOurs(text) || /\bnowall statusline\b/.test(text);
}

/**
 * Splits a POSIX shell command line into words (single/double quotes and backslashes), enough to
 * undo `shq` and plain quoting. Unterminated quotes are tolerated.
 */
export function shellWords(line: string): string[] {
  const words: string[] = [];
  let cur = "";
  let inWord = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string;
    if (ch === "'") {
      inWord = true;
      const end = line.indexOf("'", i + 1);
      cur += line.slice(i + 1, end < 0 ? line.length : end);
      i = end < 0 ? line.length : end;
    } else if (ch === '"') {
      inWord = true;
      i++;
      for (; i < line.length && line[i] !== '"'; i++) {
        if (line[i] === "\\" && i + 1 < line.length && '"\\$`'.includes(line[i + 1] as string)) {
          i++;
        }
        cur += line[i];
      }
    } else if (ch === "\\" && i + 1 < line.length) {
      inWord = true;
      cur += line[++i];
    } else if (/\s/.test(ch)) {
      if (inWord) words.push(cur);
      cur = "";
      inWord = false;
    } else {
      inWord = true;
      cur += ch;
    }
  }
  if (inWord) words.push(cur);
  return words;
}

/**
 * The user's own status-line command wrapped by `nowall statusline --then '<cmd>'`, or null when
 * the status line is ours alone.
 */
export function wrappedStatusCommand(command: string): string | null {
  if (command.includes(" --then-b64 ")) return unwrapStatusLine(command) ?? null;
  const words = shellWords(command);
  const at = words.indexOf("--then");
  if (at < 0) return null;
  const rest = words.slice(at + 1).filter((w) => w !== "");
  return rest.length ? rest.join(" ") : null;
}

/** Puts a status line back the way it was before nowall: unwrapped, or gone if it was only ours. */
export function restoreStatusLine(statusLine: unknown): unknown {
  if (!statusLine || typeof statusLine !== "object" || Array.isArray(statusLine)) return statusLine;
  const sl = statusLine as Json;
  const command = typeof sl.command === "string" ? sl.command : "";
  if (!mentionsNowall(JSON.stringify(sl))) return statusLine;
  const inner = wrappedStatusCommand(command);
  if (inner === null) return undefined;
  return { ...sl, command: inner };
}

/**
 * Removes nowall's hooks from a Claude/Codex/Cursor hooks document: our groups in every event
 * (empty events disappear), and the status-line tap. Everything else is returned untouched.
 */
export function stripNowallHooks(doc: Json): Json {
  const next: Json = { ...doc };
  const prev = doc.hooks;
  if (prev && typeof prev === "object" && !Array.isArray(prev)) {
    const hooks: Record<string, unknown> = {};
    for (const [event, groups] of Object.entries(prev as Json)) {
      if (!Array.isArray(groups)) {
        hooks[event] = groups;
        continue;
      }
      const kept = groups.filter((g) => !isOurs(g));
      if (kept.length) hooks[event] = kept;
    }
    if (Object.keys(hooks).length) next.hooks = hooks;
    else next.hooks = undefined; // dropped when serialized
  }
  if ("statusLine" in next) {
    const restored = restoreStatusLine(next.statusLine);
    next.statusLine = restored; // undefined is dropped when serialized
  }
  return next;
}

function realTarget(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function cleanUserHookFiles(home: string, act: Actor, io: UninstallIO): void {
  for (const rel of USER_HOOK_FILES) {
    const target = realTarget(join(home, rel));
    if (!existsSync(target)) continue;
    let raw: string;
    try {
      raw = readFileSync(target, "utf8");
    } catch {
      continue;
    }
    if (!mentionsNowall(raw)) continue; // the user's file, untouched byte for byte
    let doc: Json;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("shape");
      doc = parsed as Json;
    } catch {
      io.err(
        `${tilde(join(home, rel))} is not valid JSON; left alone. Remove the nowall lines by hand.\n`,
      );
      continue;
    }
    act.do(`remove nowall hooks from ${tilde(join(home, rel))}`, () => {
      writeAtomic(target, `${JSON.stringify(stripNowallHooks(doc), null, 2)}\n`, 0o644);
    });
  }
}

function cleanClaudeMd(home: string, act: Actor): void {
  const file = realTarget(join(home, ".claude", "CLAUDE.md"));
  if (!existsSync(file)) return;
  const text = readFileSync(file, "utf8");
  if (!text.includes(CLAUDE_MD_START)) return;
  const re = new RegExp(`${CLAUDE_MD_START}[\\s\\S]*?${CLAUDE_MD_END}\\n?`, "g");
  act.do(`remove the nowall block from ${tilde(join(home, ".claude", "CLAUDE.md"))}`, () => {
    writeAtomic(file, text.replace(re, ""), 0o644);
  });
}

function cleanRcFiles(home: string, act: Actor): void {
  for (const file of rcFiles(home)) {
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    if (!text.includes(MARK_START)) continue;
    act.do(`remove the nowall alias block from ${tilde(file)}`, () => {
      writeAtomic(file, stripBlock(text), 0o644);
    });
  }
}

// --- notch ---------------------------------------------------------------------------------

function launchAgentsDir(home: string): string {
  return join(home, "Library", "LaunchAgents");
}

/** The `--home` argument inside a notch plist, if any. */
function plistHome(text: string): string | null {
  const m = /<string>--home<\/string>\s*<string>([^<]*)<\/string>/.exec(text);
  return m?.[1] ?? null;
}

/**
 * Every LaunchAgent plist that belongs to the notch reading this config folder: the one with our
 * label, plus any older-named `dev.nowall.*` plist whose `--home` is this folder. A plist for
 * another home (another user's sandbox, another NOWALL_HOME) is never touched.
 */
function ownNotchPlists(home: string, dataDir: string): string[] {
  const dir = launchAgentsDir(home);
  if (!existsSync(dir)) return [];
  const ours = `${notchLabel()}.plist`;
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    if (!/^dev\.nowall\..*\.plist$/.test(name)) continue;
    const path = join(dir, name);
    if (name === ours) {
      found.push(path);
      continue;
    }
    try {
      if (plistHome(readFileSync(path, "utf8")) === dataDir) found.push(path);
    } catch {
      // unreadable: not ours to judge
    }
  }
  return found;
}

function bootout(label: string): void {
  if (noLaunchd() || process.platform !== "darwin" || tempHomeProblem()) return;
  const uid = String(process.getuid?.() ?? "");
  spawnSync("launchctl", ["bootout", `gui/${uid}/${label}`], { stdio: "ignore" });
}

function cleanNotch(home: string, dataDir: string, act: Actor): void {
  const plists = ownNotchPlists(home, dataDir);
  for (const path of plists) {
    const label =
      path
        .split("/")
        .pop()
        ?.replace(/\.plist$/, "") ?? notchLabel();
    act.do(`unload and delete ${tilde(path)}`, () => {
      if (label !== notchLabel()) bootout(label);
      rmSync(path, { force: true });
    });
  }
  const running = notchRunning();
  if (plists.length || running) {
    act.do(
      running
        ? `quit the notch process for ${tilde(dataDir)}`
        : `make sure no notch for ${tilde(dataDir)} is loaded (${notchLabel()})`,
      () => stopNotch(home),
    );
  }
}

// --- repos ---------------------------------------------------------------------------------

/** Repos nowall has touched: those from `nowall init` and those seen in session status files. */
export function knownRepos(dataDir: string): string[] {
  const set = new Set<string>();
  const trusted = readJsonSafe<unknown>(join(dataDir, "repos.json"));
  if (Array.isArray(trusted)) for (const r of trusted) if (typeof r === "string") set.add(r);
  const statusDir = join(dataDir, "status");
  if (existsSync(statusDir)) {
    for (const f of readdirSync(statusDir)) {
      if (!f.endsWith(".json")) continue;
      const s = readJsonSafe<Partial<SessionStatus>>(join(statusDir, f), 64 * 1024);
      if (typeof s?.repo === "string") set.add(s.repo);
    }
  }
  return [...set].filter((r) => {
    try {
      return lstatSync(r).isDirectory();
    } catch {
      return false;
    }
  });
}

function git(root: string, args: string[]): string | null {
  const r = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return r.status === 0 ? r.stdout.trimEnd() : null;
}

/** nowall's checkpoint refs in a repo. */
export function nowallRefs(root: string): string[] {
  const out = git(root, ["for-each-ref", "--format=%(refname)", `${CHECKPOINT_PREFIX}/`]);
  return out ? out.split("\n").filter(Boolean) : [];
}

/** Removes .handoff/, our checkpoint refs, our local excludes and our per-repo hooks. */
function cleanRepo(root: string, act: Actor): void {
  const handoff = join(root, ".handoff");
  let st: Stats | null = null;
  try {
    st = lstatSync(handoff);
  } catch {
    // absent
  }
  if (st?.isDirectory() && !st.isSymbolicLink()) {
    act.do(`remove ${join(root, ".handoff")}/`, () =>
      rmSync(handoff, { recursive: true, force: true }),
    );
  } else if (st) {
    act.note(`${handoff} is not a plain directory; left alone`);
  }
  const refs = nowallRefs(root);
  if (refs.length) {
    act.do(
      `delete ${refs.length} checkpoint ref${refs.length === 1 ? "" : "s"} (refs/nowall/*) in ${root}`,
      () => {
        for (const ref of refs) git(root, ["update-ref", "-d", ref]);
      },
    );
  }
  if (
    REPO_HOOK_FILES.some(
      (f) => existsSync(join(root, f)) && isOurs(readFileSync(join(root, f), "utf8")),
    )
  ) {
    act.do(`remove nowall hooks from ${root}/{.claude,.codex,.cursor}`, () => {
      removeRepoHooks(root);
    });
  }
  const gitDir = git(root, ["rev-parse", "--absolute-git-dir"]);
  if (gitDir) {
    const exclude = join(gitDir, "info", "exclude");
    if (existsSync(exclude)) {
      const lines = readFileSync(exclude, "utf8").split("\n");
      // A hook file the user still has settings in stays hidden from git, as it was.
      const ours = new Set<string>([
        ".handoff/",
        ...REPO_HOOK_FILES.filter((f) => !existsSync(join(root, f))),
      ]);
      const kept = lines.filter((l) => !ours.has(l));
      if (kept.length !== lines.length) {
        act.do(`remove nowall's lines from ${relative(root, exclude)}`, () =>
          writeFileSync(exclude, kept.join("\n")),
        );
      }
    }
  }
}

// --- data ----------------------------------------------------------------------------------

interface Inventory {
  dir: string;
  exists: boolean;
  files: string[]; // top-level json files present
  statusFiles: number;
  profiles: string[]; // profile dirs inside dataDir
  foreignProfiles: string[]; // account env dirs outside dataDir (hand-edited): never deleted
  secretFiles: string[];
  keychainAccounts: Account[];
}

function inventory(dataDir: string): Inventory {
  const inv: Inventory = {
    dir: dataDir,
    exists: existsSync(dataDir),
    files: [],
    statusFiles: 0,
    profiles: [],
    foreignProfiles: [],
    secretFiles: [],
    keychainAccounts: [],
  };
  if (!inv.exists) return inv;
  for (const f of ["config.json", "state.json", "agents.json", "repos.json"]) {
    if (existsSync(join(dataDir, f))) inv.files.push(f);
  }
  const status = join(dataDir, "status");
  if (existsSync(status)) inv.statusFiles = readdirSync(status).length;
  const profiles = join(dataDir, "profiles");
  if (existsSync(profiles)) inv.profiles = readdirSync(profiles).map((d) => join(profiles, d));
  const secrets = join(dataDir, "secrets");
  if (existsSync(secrets)) inv.secretFiles = readdirSync(secrets).map((d) => join(secrets, d));
  const config = loadConfig();
  for (const a of config.accounts ?? []) {
    if (a.secret?.store === "keychain") inv.keychainAccounts.push(a);
    for (const dir of Object.values(a.env ?? {})) {
      if (!dir.startsWith(`${dataDir}${sep}`) && !inv.foreignProfiles.includes(dir)) {
        inv.foreignProfiles.push(dir);
      }
    }
  }
  return inv;
}

/** Keychain items under service `nowall` that look like account ids. Read-only; never in tests. */
function keychainItems(): string[] {
  if (!keychainUsable()) return [];
  const r = spawnSync("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (r.status !== 0) return [];
  const m = /"acct"<blob>="([^"]*)"/.exec(r.stdout);
  return m?.[1] !== undefined && accountAgent(m[1]) ? [m[1]] : [];
}

function purgeData(inv: Inventory, act: Actor): void {
  const ids = new Set(inv.keychainAccounts.map((a) => a.id));
  if (keychainUsable()) {
    for (const id of ids) {
      act.do(`delete Keychain item (service nowall, account ${id})`, () =>
        deleteSecret(id, "keychain"),
      );
    }
    // Items an older or hand-edited config no longer lists: one explicit delete per account id.
    if (!act.dryRun) {
      for (let i = 0; i < 50; i++) {
        const [left] = keychainItems();
        if (left === undefined) break;
        if (ids.has(left)) break; // the delete above did not take: don't loop forever
        act.do(`delete leftover Keychain item (service nowall, account ${left})`, () =>
          deleteSecret(left, "keychain"),
        );
        ids.add(left);
      }
    }
  } else if (ids.size) {
    act.note(
      `Keychain items for ${[...ids].join(", ")} not touched (${process.platform !== "darwin" ? "not macOS" : "NOWALL_SECRET_STORE=file"})`,
    );
  }
  if (inv.exists) {
    act.do(
      `remove ${tilde(inv.dir)} (config, state, ${inv.profiles.length} profile${inv.profiles.length === 1 ? "" : "s"}, ${inv.secretFiles.length} secret file${inv.secretFiles.length === 1 ? "" : "s"})`,
      () => rmSync(inv.dir, { recursive: true, force: true }),
    );
  }
  for (const dir of inv.foreignProfiles) {
    act.note(`profile outside ${tilde(inv.dir)} left alone: ${dir}`);
  }
}

// --- npm -----------------------------------------------------------------------------------

/** True when `nowall` is installed as a global npm package. */
export function npmInstalled(): boolean {
  const r = spawnSync("npm", ["ls", "-g", "nowall", "--depth=0", "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 20_000,
  });
  if (!r.stdout) return false;
  try {
    const j = JSON.parse(r.stdout) as { dependencies?: Record<string, unknown> };
    return Boolean(j.dependencies && "nowall" in j.dependencies);
  } catch {
    return false;
  }
}

/** The running CLI lives inside the package, so npm removes it a moment after we exit. */
function scheduleNpmUninstall(): void {
  const child =
    process.platform === "win32"
      ? spawn("cmd.exe", ["/d", "/c", `ping -n 2 127.0.0.1 >nul & ${NPM_UNINSTALL}`], {
          detached: true,
          stdio: "ignore",
        })
      : spawn("sh", ["-c", `sleep 1; exec ${NPM_UNINSTALL}`], { detached: true, stdio: "ignore" });
  child.unref();
}

// --- report --------------------------------------------------------------------------------

function report(home: string, dataDir: string, flags: Flags, npmWasInstalled: boolean): string {
  const lines: string[] = ["", "Check:"];
  const mark = (ok: boolean) => (ok ? "ok  " : "LEFT");
  for (const rel of USER_HOOK_FILES) {
    const p = realTarget(join(home, rel));
    if (!existsSync(p)) {
      lines.push(`  ${mark(true)} ${tilde(join(home, rel))}: not present`);
      continue;
    }
    const clean = !mentionsNowall(readFileSync(p, "utf8"));
    lines.push(
      `  ${mark(clean)} ${tilde(join(home, rel))}: ${clean ? "no nowall hooks" : "still mentions nowall"}`,
    );
  }
  const rcDirty = rcFiles(home).filter(
    (f) => existsSync(f) && readFileSync(f, "utf8").includes(MARK_START),
  );
  lines.push(
    `  ${mark(!rcDirty.length)} shell alias block: ${rcDirty.length ? `still in ${rcDirty.map(tilde).join(", ")}` : "none"}`,
  );

  const label = notchLabel();
  const plists = ownNotchPlists(home, dataDir);
  lines.push(
    `  ${mark(!plists.length)} LaunchAgent plist: ${plists.length ? plists.map(tilde).join(", ") : "none"}`,
  );
  if (process.platform !== "darwin") {
    lines.push("  ok   launchd/notch: not macOS");
  } else if (noLaunchd() || tempHomeProblem()) {
    lines.push(
      `  ok   launchd ${label}: not checked (${noLaunchd() ? "NOWALL_NO_LAUNCHD" : "temporary NOWALL_HOME"})`,
    );
  } else {
    const uid = String(process.getuid?.() ?? "");
    const loaded =
      spawnSync("launchctl", ["print", `gui/${uid}/${label}`], { stdio: "ignore" }).status === 0;
    lines.push(
      `  ${mark(!loaded)} launchctl print gui/${uid}/${label}: ${loaded ? "still loaded" : "absent"}`,
    );
    const running = notchRunning();
    lines.push(
      `  ${mark(!running)} notch process for ${tilde(dataDir)}: ${running ? "still running" : "gone"}`,
    );
  }

  if (keychainUsable()) {
    const items = keychainItems();
    lines.push(
      `  ${mark(!items.length)} Keychain (service nowall): ${items.length ? `item for ${items.join(", ")}` : "empty"}`,
    );
  } else {
    lines.push(
      `  ok   Keychain: not checked (${process.platform !== "darwin" ? "not macOS" : "NOWALL_SECRET_STORE=file"})`,
    );
  }

  const inv = inventory(dataDir);
  if (!inv.exists) lines.push(`  ok   ${tilde(dataDir)}: removed`);
  else {
    lines.push(
      `  kept ${tilde(dataDir)}: ${inv.files.join(", ") || "no config"}${inv.profiles.length ? `, ${inv.profiles.length} profile${inv.profiles.length === 1 ? "" : "s"}` : ""}${inv.secretFiles.length ? `, ${inv.secretFiles.length} secret file${inv.secretFiles.length === 1 ? "" : "s"}` : ""} (remove with: nowall uninstall --global --purge)`,
    );
  }
  if (npmWasInstalled) {
    lines.push(
      flags.npm
        ? `  ${flags.dryRun ? "would" : "ok  "} npm package: ${flags.dryRun ? `run ${NPM_UNINSTALL}` : `${NPM_UNINSTALL} runs as soon as this command exits`}`
        : `  LEFT npm package: still installed. Last step: ${NPM_UNINSTALL}`,
    );
  } else {
    lines.push(
      `  ok   npm package: not installed globally${flags.npm ? " (nothing for --npm to do; remove nowall the way you installed it)" : ""}`,
    );
  }
  lines.push("", `Reinstall any time with: ${REINSTALL_LINE}`);
  return `${lines.join("\n")}\n`;
}

// --- entry ---------------------------------------------------------------------------------

export async function runUninstallGlobal(
  argv: string[],
  ioOverride: Partial<UninstallIO> = {},
): Promise<number> {
  const io: UninstallIO = {
    out: ioOverride.out ?? ((s) => process.stdout.write(s)),
    err: ioOverride.err ?? ((s) => process.stderr.write(s)),
    ask: ioOverride.ask ?? askTty,
  };
  const flags = parseFlags(argv);
  if (flags.purge && flags.keepData) {
    io.err("nowall uninstall: --purge and --keep-data contradict each other.\n");
    return 2;
  }
  const act = new Actor(io, flags.dryRun);
  const home = homedir();
  const dataDir = configDir();
  if (flags.dryRun) io.out("Dry run: nothing below is changed.\n");

  // 1. What we know before anything is deleted.
  const repos = knownRepos(dataDir);
  const inv = inventory(dataDir);
  const npmWasInstalled = npmInstalled();

  // 2. Hooks, status line, alias, CLAUDE.md.
  cleanUserHookFiles(home, act, io);
  cleanClaudeMd(home, act);
  cleanRcFiles(home, act);

  // 3. Notch (this config folder's label and process only).
  cleanNotch(home, dataDir, act);

  // 4. Repos.
  if (repos.length) {
    if (flags.repos) {
      for (const root of repos) cleanRepo(root, act);
    } else {
      io.out(`\nRepos with nowall data (kept):\n${repos.map((r) => `  ${r}`).join("\n")}\n`);
      io.out(
        "To remove their .handoff/ folders and refs/nowall/* snapshots: nowall uninstall --global --repos\n",
      );
    }
  }

  // 5. Data.
  let purge = flags.purge;
  if (!flags.keepData && inv.exists) {
    const what = [
      inv.files.length ? `config (${inv.files.join(", ")})` : "",
      inv.profiles.length
        ? `${inv.profiles.length} profile${inv.profiles.length === 1 ? "" : "s"} with their logins (${inv.profiles.map((p) => basename(p)).join(", ")})`
        : "",
      inv.secretFiles.length
        ? `${inv.secretFiles.length} secret file${inv.secretFiles.length === 1 ? "" : "s"}`
        : "",
      inv.keychainAccounts.length
        ? `${inv.keychainAccounts.length} Keychain item${inv.keychainAccounts.length === 1 ? "" : "s"} (${inv.keychainAccounts.map((a) => a.id).join(", ")})`
        : "",
    ].filter(Boolean);
    if (purge && !flags.yes) {
      const answer = await io.ask(`\nDelete ${what.join(", ")} in ${tilde(dataDir)}? [y/N] `);
      if (answer !== "y" && answer !== "yes") {
        purge = false;
        io.out(
          process.stdin.isTTY
            ? "Kept.\n"
            : "Kept: --purge needs a confirmation. Re-run with --purge --yes to delete without asking.\n",
        );
      }
    } else if (!purge && !flags.yes && process.stdin.isTTY) {
      const answer = await io.ask(`\nAlso delete ${what.join(", ")} in ${tilde(dataDir)}? [y/N] `);
      purge = answer === "y" || answer === "yes";
    }
  }
  if (purge) {
    purgeData(inv, act);
  } else if (inv.exists) {
    io.out(
      `\nKept ${tilde(dataDir)}: your accounts, profiles and settings survive a reinstall. Remove it with: nowall uninstall --global --purge\n`,
    );
    // Without the user-level hooks nothing is global any more; say so in the config too.
    if (inv.files.includes("config.json") && loadConfig().scope !== "repo") {
      act.do("set scope to repo in config.json", () => {
        const config = loadConfig();
        config.scope = "repo";
        saveConfig(config);
      });
    }
  }

  // 6. npm.
  if (flags.npm && npmWasInstalled) {
    act.do(`run ${NPM_UNINSTALL} after this command exits`, scheduleNpmUninstall);
  }

  io.out(report(home, dataDir, flags, npmWasInstalled));
  return 0;
}
