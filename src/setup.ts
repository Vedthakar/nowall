import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { isOurs, mergeHooksFile, withHooks } from "./adapters/common.js";
import { ADAPTERS, resolveBinary } from "./adapters/index.js";
import { type AgentInfo, refreshAgents } from "./agents.js";
import { shq, writeAtomic } from "./fsafe.js";
import { configDir, loadConfig, saveConfig } from "./state.js";

const LABEL = "dev.nowall.notch";

export const GLOBAL_CONSENT = `nowall keeps your coding agents going when one hits its usage limit.
Everything runs on this computer. No account, no server, no telemetry.

Setting up will:
  • Add small hooks to Claude Code (~/.claude/settings.json), and to Codex and Cursor if you have
    them, so nowall notices limits and keeps a tiny journal of each task (~100–300 tokens/session).
  • Cover every git repo you work in. Per repo it creates a git-ignored .handoff/ folder and hidden
    snapshots (refs/nowall/...). Your branches, index and files are never touched.
  • When an agent hits its limit, quietly continue in the next agent you're signed in to, with the
    same context. No pop-ups; progress shows in the notch. Undo any step with \`nowall undo\`.
  • Start the nowall notch (macOS): a small black status pill at the top-right of your screen.
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
  return join(home, "Library", "LaunchAgents", `${LABEL}.plist`);
}

function cliPath(): string {
  return join(packageRoot(), "dist", "cli.js");
}

/** Hook command: plain `nowall` when it's on PATH, else the absolute node + script (quoted). */
export function nowallCommand(): string {
  if (resolveBinary("nowall")) return "nowall";
  return `${shq(process.execPath)} ${shq(realpathSync(cliPath()))}`;
}

async function ask(q: string): Promise<string> {
  if (!process.stdin.isTTY) return "";
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(q)).trim().toLowerCase();
  } finally {
    rl.close();
  }
}

const xml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Installs (or refreshes) the login item that keeps the notch running, then starts it. */
export function startNotch(home = homedir()): string {
  if (process.platform !== "darwin")
    return "The notch is macOS-only for now (Windows/Linux are on the roadmap).";
  const app = notchApp();
  if (!app) return "Notch app not found in this build (it is built on macOS with Xcode tools).";
  const args = [
    app,
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
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${xml(a)}</string>`).join("\n")}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
`;
  writeAtomic(plistPath(home), plist, 0o644);
  const uid = String(process.getuid?.() ?? "");
  spawnSync("launchctl", ["bootout", `gui/${uid}/${LABEL}`], { stdio: "ignore" });
  const r = spawnSync("launchctl", ["bootstrap", `gui/${uid}`, plistPath(home)], {
    stdio: "ignore",
  });
  return r.status === 0
    ? "Notch is running (top-right of your screen) and starts at login."
    : "Notch installed; it will appear at your next login.";
}

export function stopNotch(home = homedir()): void {
  if (process.platform !== "darwin") return;
  const uid = String(process.getuid?.() ?? "");
  spawnSync("launchctl", ["bootout", `gui/${uid}/${LABEL}`], { stdio: "ignore" });
  rmSync(plistPath(home), { force: true });
}

function describe(a: AgentInfo): string {
  if (!a.installed) return `not installed${a.id === "qwen" ? "" : ` (install: ${a.installHint})`}`;
  if (a.desktopOnly) return "found (desktop app)";
  if (a.signedIn === false) return `found, but not signed in. Run: ${a.loginHint}`;
  return "found and ready";
}

/** `nowall setup`: one command, no per-repo steps. Finds agents, installs hooks, starts the notch. */
export async function runSetup(argv: string[]): Promise<number> {
  const yes = argv.includes("--yes") || argv.includes("-y");
  const home = homedir();
  process.stdout.write(`${GLOBAL_CONSENT}\n\n`);
  if (!yes && (await ask("Turn nowall on? [Y/n] ")) === "n") {
    process.stdout.write("Nothing changed.\n");
    return 1;
  }

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

  const snap = await refreshAgents();
  process.stdout.write("Found on this computer:\n");
  for (const a of snap.agents.filter((x) => x.id !== "qwen" || x.installed)) {
    process.stdout.write(`  ${a.name.padEnd(12)} ${describe(a)}\n`);
  }
  const ready = snap.agents.filter((a) => a.installed && a.signedIn !== false && a.id !== "claude");
  process.stdout.write(
    `\nHooks installed: ${written.map((w) => w.replace(home, "~")).join(", ")}\n`,
  );
  if (!argv.includes("--no-notch")) process.stdout.write(`${startNotch(home)}\n`);

  const order = config.order.filter((id) => snap.agents.find((a) => a.id === id)?.installed);
  process.stdout.write(
    `\nnowall is on. Takeover order: ${order.map((id) => ADAPTERS[id].displayName).join(" → ")}.\n`,
  );
  if (ready.length === 0) {
    process.stdout.write(
      "No agent is ready to take over yet: sign in to one of the agents above (or install Cursor, Codex or Antigravity).\n",
    );
  }
  for (const a of snap.agents.filter((x) => x.installed && x.signedIn === false)) {
    process.stdout.write(`To finish: run \`${a.loginHint}\` so ${a.name} can take over.\n`);
  }
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
        if (next.statusLine && isOurs(next.statusLine)) next.statusLine = undefined;
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

/** `nowall statusline`: Claude Code pipes its status JSON here; we keep the usage numbers, print nothing. */
export function runStatusline(raw: string): number {
  try {
    const input = JSON.parse(raw) as { rate_limits?: unknown };
    if (input.rate_limits && typeof input.rate_limits === "object") {
      writeAtomic(join(configDir(), "claude-usage.json"), `${JSON.stringify(input.rate_limits)}\n`);
    }
  } catch {
    // never disturb Claude's UI
  }
  return 0;
}

/** `nowall logs [-f]`: what the background takeover is doing in this repo. */
export function runLogs(root: string, follow: boolean): number {
  const log = join(root, ".handoff", "takeover.log");
  if (!existsSync(log)) {
    process.stdout.write("No takeover has run in this repo yet.\n");
    return 0;
  }
  if (follow) {
    spawnSync("tail", ["-n", "50", "-f", log], { stdio: "inherit" });
    return 0;
  }
  const lines = readFileSync(log, "utf8").trimEnd().split("\n");
  process.stdout.write(`${lines.slice(-80).join("\n")}\n`);
  return 0;
}
