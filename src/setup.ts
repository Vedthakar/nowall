import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { type Interface, createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
  KEY_ENV,
  accountEnv,
  accountFromEnv,
  accountName,
  addAccount,
  askHidden as askHiddenLine,
  profilePath,
  validLabel,
} from "./accounts.js";
import {
  isOurs,
  mergeHooksFile,
  nowallInvocation,
  unwrapStatusLine,
  withHooks,
} from "./adapters/common.js";
import { ADAPTERS, resolveBinary } from "./adapters/index.js";
import { defaultRunner } from "./adapters/types.js";
import {
  type AgentInfo,
  type AgentsSnapshot,
  claudeDesktopInstalled,
  claudeUsagePath,
  refreshAgents,
} from "./agents.js";
import { writeAtomic } from "./fsafe.js";
import { gitBash, isWindows, spawnSync } from "./proc.js";
import type { AgentId } from "./schemas.js";
import { configDir, loadConfig, saveConfig } from "./state.js";
import { shortTour, wantColor } from "./tour.js";

const BASE_LABEL = "dev.nowall.notch";

/** The user's real config folder, independent of a redirected $HOME (tests set HOME to a temp dir). */
function realDefaultHome(): string {
  let base = homedir();
  try {
    base = userInfo().homedir || base;
  } catch {
    // no passwd entry (containers): fall back to $HOME
  }
  return join(base, ".config", "nowall");
}

/**
 * launchd label for the notch that reads `home`: the plain label for the real config folder, and
 * `dev.nowall.notch.<hash>` for any other NOWALL_HOME, so a sandboxed run can never address the
 * user's live notch.
 */
export function notchLabel(home = configDir()): string {
  if (home === realDefaultHome()) return BASE_LABEL;
  return `${BASE_LABEL}.${createHash("sha1").update(home).digest("hex").slice(0, 8)}`;
}

/** `pgrep -f` / `pkill -f` pattern for the notch process that reads `home`, and no other. */
export function notchPattern(home = configDir()): string {
  const escaped = home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `NowallNotch\\.app/Contents/MacOS/NowallNotch .*--home ${escaped}( |$)`;
}

/** Set by the test runner and the stress script: never call launchctl, pgrep or pkill. */
function noLaunchd(): boolean {
  return process.env.NOWALL_NO_LAUNCHD === "1";
}

export const GLOBAL_CONSENT = `nowall keeps your coding agents going when one hits its usage limit.
Everything runs on this computer. No account, no server, no telemetry.

Setting up will:
  • Add small hooks to Claude Code (~/.claude/settings.json), and to Codex and Cursor if you have
    them, so nowall notices limits and keeps a tiny journal of each task (~100–300 tokens/session).
  • Cover every git repo you work in. Per repo it creates a git-ignored .handoff/ folder and hidden
    snapshots (refs/nowall/...). Your branches, index and files are never touched.
  • When an agent hits its limit, quietly continue in the next agent you're signed in to, with the
    same context. No pop-ups; progress shows in the notch. Undo any step with \`nowall undo\`.
  • Start the nowall notch (macOS): a small black tab on the right edge of your screen.
nowall never reads, stores or sends your credentials. Undo all of this with: nowall uninstall --global`;

export function packageRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

function notchApp(): string | null {
  const app = join(
    packageRoot(),
    "notch",
    "build",
    "NowallNotch.app",
    "Contents",
    "MacOS",
    "NowallNotch",
  );
  return existsSync(app) ? app : null;
}

function plistPath(home = homedir()): string {
  return join(home, "Library", "LaunchAgents", `${notchLabel()}.plist`);
}

function cliPath(): string {
  return join(packageRoot(), "dist", "cli.js");
}

/** Hook command: plain `nowall` when it's on PATH, else the absolute node + script (quoted). */
export function nowallCommand(): string {
  return nowallInvocation(Boolean(resolveBinary("nowall")), () => realpathSync(cliPath()));
}

/**
 * Questions for `setup`. One readline over stdin for the whole run, with answers buffered, so piped
 * input ("y\nwork\nn\n") works as well as a terminal. Without a terminal (curl | sh, CI) nothing is
 * asked and every question gets its default; NOWALL_FORCE_PROMPTS=1 asks anyway (tests).
 */
export class Prompter {
  readonly interactive: boolean;
  private rl: Interface | undefined;
  private readonly lines: string[] = [];
  private readonly waiting: ((line: string) => void)[] = [];
  private closed = false;
  private suspending = false;
  private watchingEnd = false;

  constructor(yes: boolean) {
    this.interactive =
      !yes && (Boolean(process.stdin.isTTY) || process.env.NOWALL_FORCE_PROMPTS === "1");
  }

  private open(): Interface {
    if (this.rl) return this.rl;
    if (!this.watchingEnd) {
      this.watchingEnd = true;
      process.stdin.once("end", () => {
        this.closed = true;
        for (const w of this.waiting.splice(0)) w("");
      });
    }
    this.rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: Boolean(process.stdin.isTTY),
    });
    this.rl.on("line", (line) => {
      const w = this.waiting.shift();
      if (w) w(line);
      else this.lines.push(line);
    });
    this.rl.on("close", () => {
      if (this.suspending) return; // reopened after the child exits; buffered answers survive
      this.closed = true;
      for (const w of this.waiting.splice(0)) w("");
    });
    return this.rl;
  }

  private nextLine(): Promise<string> {
    const buffered = this.lines.shift();
    if (buffered !== undefined) return Promise.resolve(buffered);
    if (this.closed) return Promise.resolve("");
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  /** Asks and returns the trimmed answer; `fallback` when not interactive. */
  async ask(question: string, fallback = ""): Promise<string> {
    if (!this.interactive) return fallback;
    this.open();
    process.stdout.write(question);
    return (await this.nextLine()).trim();
  }

  /** "Do you …? [y/N]" style question; only an explicit y/yes is true. */
  async yes(question: string): Promise<boolean> {
    return /^y(es)?$/i.test(await this.ask(question));
  }

  /** Reads a secret: nothing is echoed, and the value is never logged. */
  async askHidden(question: string): Promise<string> {
    if (!this.interactive) return "";
    this.suspend(); // the hidden prompt needs the terminal to itself
    return askHiddenLine(question);
  }

  /** Hands the terminal to a child process (an agent's login); questions reopen stdin afterwards. */
  suspend(): void {
    if (!this.rl) return;
    this.suspending = true;
    this.rl.close();
    this.rl = undefined;
    this.suspending = false;
  }

  close(): void {
    this.rl?.close();
    this.rl = undefined;
  }
}

const xml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** True while a notch process is running (from launchd or opened directly). */
export function notchRunning(): boolean {
  if (process.platform !== "darwin" || noLaunchd() || tempHomeProblem()) return false;
  return spawnSync("pgrep", ["-f", notchPattern()], { stdio: "ignore" }).status === 0;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitFor(check: () => boolean, ms: number): boolean {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    sleepSync(200);
  }
  return check();
}

/** A config folder inside the temp dir means a stray NOWALL_HOME (e.g. from tests): never persist that. */
export function tempHomeProblem(): string | null {
  const dir = configDir();
  const tmp = [tmpdir(), "/tmp", "/private/tmp", "/var/folders", "/private/var/folders"];
  return tmp.some((t) => dir.startsWith(t))
    ? `NOWALL_HOME points at a temporary folder (${dir}). Run \`unset NOWALL_HOME\` and try again.`
    : null;
}

/** Installs (or refreshes) the login item that keeps the notch running, starts it, and verifies it. */
export function startNotch(home = homedir()): string {
  if (noLaunchd()) return "Notch skipped (NOWALL_NO_LAUNCHD).";
  if (process.platform !== "darwin") {
    return "The notch is macOS-only for now, so `nowall status` and `nowall logs -f` show what's happening. Failover works the same without it.";
  }
  const app = notchApp();
  if (!app) return "Notch app not found in this build (it is built on macOS with Xcode tools).";
  const problem = tempHomeProblem();
  if (problem) return `Notch not started: ${problem}`;
  const label = notchLabel();
  const args = [
    "--node",
    process.execPath,
    "--cli",
    realpathSync(cliPath()),
    "--home",
    configDir(),
  ];
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${[app, ...args].map((a) => `    <string>${xml(a)}</string>`).join("\n")}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
`;
  writeAtomic(plistPath(home), plist, 0o644);

  // Restart cleanly. `bootout` is asynchronous: bootstrapping before the old job is gone fails.
  const domain = `gui/${process.getuid?.() ?? ""}`;
  const loaded = () =>
    spawnSync("launchctl", ["print", `${domain}/${label}`], { stdio: "ignore" }).status === 0;
  spawnSync("launchctl", ["bootout", `${domain}/${label}`], { stdio: "ignore" });
  waitFor(() => !loaded(), 5000);
  spawnSync("pkill", ["-f", notchPattern()], { stdio: "ignore" });
  let error = "";
  for (let attempt = 0; attempt < 3 && !loaded(); attempt++) {
    const r = spawnSync("launchctl", ["bootstrap", domain, plistPath(home)], { encoding: "utf8" });
    if (r.status !== 0) error = (r.stderr || r.stdout || "").trim();
    if (!loaded()) sleepSync(1000);
  }
  if (waitFor(notchRunning, 4000)) {
    return "Notch is running (right edge of your screen, middle) and starts at login.";
  }
  // launchd refused (some terminals can't reach the GUI session): open it directly for now.
  spawnSync("open", ["-g", join(app, "..", "..", ".."), "--args", ...args], { stdio: "ignore" });
  if (waitFor(notchRunning, 4000)) {
    return `Notch is running now. It couldn't be added to login items${error ? ` (${error})` : ""}; run \`nowall notch\` from Terminal.app to fix that.`;
  }
  return `The notch failed to start${error ? ` (${error})` : ""}. Run \`nowall notch\` from Terminal.app; if it still fails, run \`nowall notch status\` and share the output.`;
}

/**
 * Unloads and quits the notch that reads the current config folder. Only ever addresses this
 * folder's own launchd label and process (see `notchLabel`/`notchPattern`); under
 * NOWALL_NO_LAUNCHD or a temporary NOWALL_HOME it just removes the plist.
 */
export function stopNotch(home = homedir()): void {
  if (process.platform !== "darwin") return;
  rmSync(plistPath(home), { force: true });
  if (noLaunchd()) return;
  const problem = tempHomeProblem();
  if (problem) {
    process.stderr.write(`Notch left alone: ${problem}\n`);
    return;
  }
  const uid = String(process.getuid?.() ?? "");
  spawnSync("launchctl", ["bootout", `gui/${uid}/${notchLabel()}`], { stdio: "ignore" });
  spawnSync("pkill", ["-f", notchPattern()], { stdio: "ignore" });
}

/** `nowall notch status`: what's installed, where it reads from, and whether it's running. */
export function notchStatus(home = homedir()): string {
  const lines: string[] = [];
  lines.push(`App:         ${notchApp() ?? "not in this build"}`);
  lines.push(`Label:       ${notchLabel()}`);
  lines.push(`Login item:  ${existsSync(plistPath(home)) ? plistPath(home) : "not installed"}`);
  if (existsSync(plistPath(home))) {
    const text = readFileSync(plistPath(home), "utf8");
    const m = /<string>--home<\/string>\s*<string>([^<]*)<\/string>/.exec(text);
    lines.push(
      `Reads from:  ${m?.[1] ?? "?"}${m?.[1] && m[1] !== configDir() ? `  (current config is ${configDir()}: run nowall notch to fix)` : ""}`,
    );
  }
  lines.push(`Running:     ${notchRunning() ? "yes" : "no"}`);
  lines.push(
    `Data:        ${existsSync(join(configDir(), "agents.json")) ? "agents.json present" : "no agents.json yet (run nowall setup)"}`,
  );
  return lines.join("\n");
}

function describe(a: AgentInfo): string {
  if (!a.installed) return `not installed${a.id === "qwen" ? "" : ` (install: ${a.installHint})`}`;
  if (a.desktopOnly) return "found (desktop app)";
  if (a.signedIn === false) return `found, but not signed in. Run: ${a.loginHint}`;
  return "found and ready";
}

const PROFILE_LOGIN: Partial<Record<AgentId, string[]>> = {
  claude: ["auth", "login"],
  codex: ["login"],
  cursor: ["login"],
};

/**
 * The accounts step of `setup`: for each installed agent, offer to add another login, signed in
 * right here inside its own new profile. Every question defaults to "no".
 */
export async function accountWizard(p: Prompter, snap: AgentsSnapshot): Promise<number> {
  let added = 0;
  const out = (s: string) => process.stdout.write(s);
  for (const agent of ["claude", "codex", "cursor"] as const) {
    const info = snap.agents.find((a) => a.id === agent);
    const bin = resolveBinary(ADAPTERS[agent].binary, process.argv[1]);
    if (!info?.installed || info.desktopOnly || !bin) continue;
    const name = ADAPTERS[agent].displayName;
    let first = true;
    while (await p.yes(`${first ? "Do you have another" : "Another"} ${name} account? [y/N] `)) {
      first = false;
      const label = await p.ask("Label for it (e.g. work): ");
      if (!validLabel(label)) {
        out("Label: letters, digits, - or _, up to 24 characters (e.g. work).\n");
        continue;
      }
      try {
        const account = addAccount(agent, label);
        added += 1;
        const env = account.env ?? {};
        const loginArgs = PROFILE_LOGIN[agent] ?? ["login"];
        out(
          `Sign in to ${accountName(account.id)} now. This login lives in ${profilePath(account)}, apart from your main one.\n\n`,
        );
        p.suspend(); // the login owns the terminal while it runs
        spawnSync(bin, loginArgs, { stdio: "inherit", env: { ...process.env, ...env } });
        const d = await ADAPTERS[agent].detect(defaultRunner, bin, env);
        const finish = `nowall account login ${account.id}`;
        out(
          d.signedIn === false
            ? `\n✗ ${accountName(account.id)} is not signed in yet. Finish later with: ${finish}\n`
            : `\n✓ ${accountName(account.id)} signed in.\n`,
        );
      } catch (err) {
        out(
          `Could not add ${name} (${label}): ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }
  }
  return added;
}

/** `nowall setup`: one command, no per-repo steps. Finds agents, installs hooks, starts the notch. */
export async function runSetup(argv: string[]): Promise<number> {
  if (argv.includes("--apply")) return applySetup(argv);
  if (guiAvailable(argv)) {
    const code = runSetupWindow(argv);
    if (code !== null) return code;
    process.stdout.write("The setup window couldn't open, so setup continues here.\n\n");
  }
  const yes = argv.includes("--yes") || argv.includes("-y");
  const p = new Prompter(yes);
  try {
    return await setupFlow(argv, p);
  } finally {
    p.close();
  }
}

/** The setup window needs a Mac, a desktop session, and someone at it. */
function guiAvailable(argv: string[]): boolean {
  if (process.platform !== "darwin" || noLaunchd() || !notchApp() || tempHomeProblem())
    return false;
  if (["--cli", "--yes", "-y", "--no-notch"].some((f) => argv.includes(f))) return false;
  if (process.env.SSH_CONNECTION || process.env.CI) return false;
  return argv.includes("--gui") || Boolean(process.stdin.isTTY);
}

/** Runs the setup window and waits for it. Null when it couldn't run at all. */
function runSetupWindow(argv: string[]): number | null {
  process.stdout.write("Opening the nowall setup window...\n");
  const r = spawnSync(
    notchApp() as string,
    [
      "--setup",
      "--node",
      process.execPath,
      "--cli",
      realpathSync(cliPath()),
      "--home",
      configDir(),
      ...(argv.includes("--yolo") ? ["--yolo"] : []),
    ],
    { stdio: "ignore" },
  );
  if (r.status === 0) {
    process.stdout.write("nowall is on. Double-click the notch on the right edge to open it.\n");
    return 0;
  }
  if (r.status === 3) {
    process.stdout.write("Setup cancelled. Nothing changed.\n");
    return 1;
  }
  return null;
}

/** Hooks and config: the part of setup that needs no questions. */
function installEverything(argv: string[], home: string): string[] {
  const cmd = nowallCommand();
  const written: string[] = [];
  // Claude Code always (its desktop app uses ~/.claude too); others only if they're on this machine.
  written.push(...(ADAPTERS.claude.installUserHooks?.(home, cmd) ?? []));
  if (existsSync(join(home, ".codex")))
    written.push(...(ADAPTERS.codex.installUserHooks?.(home, cmd) ?? []));
  if (existsSync(join(home, ".cursor")))
    written.push(...(ADAPTERS.cursor.installUserHooks?.(home, cmd) ?? []));

  const config = loadConfig();
  config.scope = "global";
  if (config.takeover === "off") config.takeover = "background"; // setup means "turn it on"
  config.path = process.env.PATH ?? config.path;
  if (argv.includes("--yolo")) config.yolo = true;
  saveConfig(config);
  return written;
}

/** `nowall setup --apply`: what the setup window runs after you agree. Prints one JSON object. */
async function applySetup(argv: string[]): Promise<number> {
  const home = homedir();
  const problem = tempHomeProblem();
  if (problem && !argv.includes("--no-notch")) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: problem })}\n`);
    return 1;
  }
  try {
    const hooks = installEverything(argv, home);
    await refreshAgents(undefined, undefined, { force: true });
    const notch =
      loadConfig().notch === false || argv.includes("--no-notch")
        ? "Notch is off."
        : startNotch(home);
    process.stdout.write(`${JSON.stringify({ ok: true, hooks, notch })}\n`);
    return 0;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    process.stdout.write(`${JSON.stringify({ ok: false, error })}\n`);
    return 1;
  }
}

async function setupFlow(argv: string[], p: Prompter): Promise<number> {
  const home = homedir();
  const color = wantColor(argv);
  const problem = tempHomeProblem();
  if (problem && !argv.includes("--no-notch")) {
    process.stderr.write(`nowall setup: ${problem}\n`);
    return 1;
  }
  process.stdout.write(`${GLOBAL_CONSENT}\n\n`);
  if ((await p.ask("Turn nowall on? [Y/n] ")).toLowerCase() === "n") {
    process.stdout.write("Nothing changed.\n");
    return 1;
  }

  const written = installEverything(argv, home);
  const config = loadConfig();

  let snap = await refreshAgents();
  process.stdout.write("Found on this computer:\n");
  for (const a of snap.agents.filter((x) => x.id !== "qwen" || x.installed)) {
    process.stdout.write(`  ${a.name.padEnd(12)} ${describe(a)}\n`);
  }
  const claude = snap.agents.find((a) => a.id === "claude");
  if (claudeDesktopInstalled()) {
    process.stdout.write(
      "  Claude desktop app: covered by the same hooks, nothing to switch on.\n",
    );
    if (claude?.desktopOnly) {
      process.stdout.write(
        `  For usage rings and \`nowall run claude\`, install the terminal version too: ${claude.installHint}\n`,
      );
    }
  }
  process.stdout.write(
    `\nHooks installed: ${written.map((w) => w.replace(home, "~")).join(", ")}\n`,
  );
  if (config.notch === false) {
    process.stdout.write("Notch is off (turn it on with: nowall notch on)\n");
  } else if (!argv.includes("--no-notch")) {
    process.stdout.write(`${startNotch(home)}\n`);
  }

  if (!argv.includes("--no-accounts") && p.interactive) {
    process.stdout.write(
      "\nAccounts. If you have more than one subscription, nowall can fall through them before it switches agents.\n",
    );
    if ((await accountWizard(p, snap)) > 0) snap = await refreshAgents();
  }

  const ready = snap.accounts.filter(
    (a) =>
      a.active &&
      a.signedIn !== false &&
      a.id !== "claude" &&
      snap.agents.find((x) => x.id === a.agent)?.installed,
  );
  const order = snap.accounts.filter(
    (a) => a.active && snap.agents.find((x) => x.id === a.agent)?.installed,
  );
  process.stdout.write(
    `\nnowall is on. Takeover order: ${order.map((a) => accountName(a.id)).join(" → ")}.\n`,
  );
  if (ready.length === 0) {
    process.stdout.write(
      "No agent is ready to take over yet: sign in to one of the agents above (or install Cursor, Codex or Antigravity).\n",
    );
  }
  for (const a of snap.agents.filter((x) => x.installed && x.signedIn === false)) {
    process.stdout.write(`To finish: run \`${a.loginHint}\` so ${a.name} can take over.\n`);
  }
  if (claude?.installed && !claude.desktopOnly && !claude.usage?.length) {
    process.stdout.write(
      "To see Claude's usage: run `claude` in a terminal and send one message. Claude only reports usage there, so its circle stays plain until you do.\n",
    );
  }
  process.stdout.write(`\n${shortTour({ color })}`);
  return 0;
}

/** `nowall uninstall --global`: removes user-level hooks, the status-line tap and the notch. */
export function runTeardown(): number {
  const home = homedir();
  for (const rel of [".claude/settings.json", ".codex/hooks.json", ".cursor/hooks.json"]) {
    const p = join(home, rel);
    if (!existsSync(p)) continue;
    mergeHooksFile(
      p,
      (e) => {
        const next = withHooks(e, {});
        if (next.statusLine && isOurs(next.statusLine)) {
          // Give the user back their own status line if ours was chained in front of it.
          const sl = next.statusLine as Record<string, unknown>;
          const inner = typeof sl.command === "string" ? unwrapStatusLine(sl.command) : undefined;
          next.statusLine = inner ? { ...sl, command: inner } : undefined;
        }
        return JSON.parse(JSON.stringify(next));
      },
      { followSymlink: true },
    );
  }
  stopNotch(home);
  const config = loadConfig();
  config.scope = "repo";
  saveConfig(config);
  process.stdout.write(
    "nowall is off: hooks, status-line tap and notch removed. Your snapshots and .handoff/ folders are kept.\n",
  );
  return 0;
}

/**
 * `nowall statusline [--then <cmd>]`: Claude Code pipes its status JSON here; we keep the usage
 * numbers and print nothing. With `--then`, the user's own status-line command gets the same JSON
 * on stdin and its output and exit code are passed straight through. Runs inside Claude's
 * environment, so CLAUDE_CONFIG_DIR tells us which account it is.
 */
export function runStatusline(
  raw: string,
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = [],
): number {
  try {
    const input = JSON.parse(raw) as { rate_limits?: unknown };
    if (input.rate_limits && typeof input.rate_limits === "object") {
      const account = accountFromEnv("claude", env);
      writeAtomic(claudeUsagePath(account), `${JSON.stringify(input.rate_limits)}\n`);
    }
  } catch {
    // never disturb Claude's UI
  }
  const at = argv.indexOf("--then");
  const encoded = argv.indexOf("--then-b64");
  const inner =
    encoded >= 0
      ? Buffer.from(argv[encoded + 1] ?? "", "base64").toString()
      : at >= 0
        ? argv[at + 1]
        : undefined;
  if (!inner) return 0;
  const stdio: ["pipe", "inherit", "inherit"] = ["pipe", "inherit", "inherit"];
  if (isWindows) {
    // Claude runs a status line under Git Bash, so that's what the user's command was written for.
    const bash = gitBash(env);
    const r = bash
      ? spawnSync(bash, ["-c", inner], { input: raw, stdio, env })
      : spawnSync(inner, [], { input: raw, stdio, env, shell: true });
    return r.status ?? 1;
  }
  const r = spawnSync("/bin/sh", ["-c", inner], { input: raw, stdio, env });
  return r.status ?? 1;
}

/** `nowall logs [-f]`: what the background takeover is doing in this repo. */
export function runLogs(root: string, follow: boolean): number {
  const log = join(root, ".handoff", "takeover.log");
  if (!existsSync(log)) {
    process.stdout.write("No takeover has run in this repo yet.\n");
    return 0;
  }
  if (follow) {
    if (isWindows) {
      spawnSync(
        "powershell.exe",
        ["-NoProfile", "-Command", "Get-Content -LiteralPath $env:NOWALL_LOG -Tail 50 -Wait"],
        { stdio: "inherit", env: { ...process.env, NOWALL_LOG: log } },
      );
      return 0;
    }
    spawnSync("tail", ["-n", "50", "-f", log], { stdio: "inherit" });
    return 0;
  }
  const lines = readFileSync(log, "utf8").trimEnd().split("\n");
  process.stdout.write(`${lines.slice(-80).join("\n")}\n`);
  return 0;
}
