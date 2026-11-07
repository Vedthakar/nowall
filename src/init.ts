import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, rmdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import { createInterface } from "node:readline/promises";
import { isOurs, mergeHooksFile, nowallInvocation, withHooks } from "./adapters/common.js";
import { ADAPTERS, resolveBinary } from "./adapters/index.js";
import { defaultRunner } from "./adapters/types.js";
import { claudeDesktopInstalled } from "./agents.js";
import { readJsonSafe, writeAtomic } from "./fsafe.js";
import { excludeLocally, repoRoot, snapshotTree } from "./git.js";
import { AGENT_IDS, type Config } from "./schemas.js";
import { handoffDir, handoffProblem } from "./session.js";
import { configDir, loadConfig, saveConfig, trustRepo, untrustRepo } from "./state.js";

export const CONSENT = `nowall runs entirely on this machine. No account, no server, no telemetry.

What it does in this repo:
  • Adds hooks for Claude Code / Codex / Cursor that append tiny lines to .handoff/journal.jsonl
    (your prompts, files edited, commands run). Secrets are redacted before anything is written.
  • Asks the agent to log one line per finished task. Cost: roughly 100–300 tokens per session.
  • Before every handoff, snapshots your files to a hidden git ref (refs/nowall/...). Your branches,
    index and working tree are never touched, and the refs are never pushed. Undo with \`nowall undo\`.
  • When an agent hits its usage limit, starts the next agent you already have installed and signed
    in, using YOUR account with that agent. nowall never sees, stores or sends your credentials.
  • If Claude Code hits its limit in the desktop app or an IDE (not under \`nowall run\`), opens a new
    Terminal window and continues there. Turn off with "takeover": "off" in the config.
  • Headless agents run with edit-only permissions by default; full auto-approve is opt-in.

Files: .handoff/ (git-excluded), .claude/settings.local.json, .codex/hooks.json, .cursor/hooks.json,
       ${join(configDir(), "{config,state}.json")}`;

export const CHINA_CONSENT = `The provider you chose (DeepSeek, Kimi or GLM) is hosted in China.
If nowall hands work to it, your code and prompts will be sent to servers in China, under that
provider's terms. This stays off unless you type "yes".`;

export const MARK_START = "# >>> nowall >>>";
export const MARK_END = "# <<< nowall <<<";

function rcFile(): string {
  return join(homedir(), (process.env.SHELL ?? "").includes("zsh") ? ".zshrc" : ".bashrc");
}

/** Per-repo files `nowall init` writes hooks into (relative to the repo root). */
export const REPO_HOOK_FILES = [
  ".claude/settings.local.json",
  ".codex/hooks.json",
  ".cursor/hooks.json",
] as const;

async function ask(question: string): Promise<string> {
  if (!process.stdin.isTTY) return "";
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim().toLowerCase();
  } finally {
    rl.close();
  }
}

function nowallCommand(): { cmd: string; global: boolean } {
  const global = Boolean(resolveBinary("nowall"));
  // Hooks run through a shell: the paths are quoted so nothing in them can inject commands.
  return { cmd: nowallInvocation(global, () => realpathSync(process.argv[1] ?? "")), global };
}

export async function runInit(argv: string[]): Promise<number> {
  const yes = argv.includes("--yes") || argv.includes("-y");
  const root = repoRoot(process.cwd());
  if (!root) {
    process.stderr.write("nowall init: run this inside a git repository (git init first).\n");
    return 1;
  }
  const problem = handoffProblem(root);
  if (problem) {
    process.stderr.write(`nowall init: refusing to set up here: ${problem}.\n`);
    return 1;
  }

  process.stdout.write(`${CONSENT}\n\n`);
  if (!yes && (await ask("Set up nowall in this repo? [y/N] ")) !== "y") {
    process.stdout.write(
      process.stdin.isTTY
        ? "Nothing changed.\n"
        : "Nothing changed. To confirm without a prompt, run: nowall init --yes\n",
    );
    return 1;
  }

  // Agents
  process.stdout.write("\nAgents on this machine:\n");
  let ready = 0;
  for (const id of AGENT_IDS) {
    const a = ADAPTERS[id];
    const bin = resolveBinary(a.binary, process.argv[1]);
    const d = bin
      ? await a.detect(defaultRunner, bin)
      : { installed: false, signedIn: false as const };
    let line: string;
    if (!d.installed && id === "claude" && claudeDesktopInstalled()) {
      line = `desktop app found (no \`claude\` terminal command). Desktop sessions are covered: a limit opens a Terminal and continues. For in-terminal use: ${a.installHint}`;
    } else if (!d.installed) line = `not installed. Install: ${a.installHint}`;
    else if (d.signedIn === false) line = `installed, not signed in. Run: ${a.loginHint}`;
    else {
      line = `ready${d.signedIn === "unknown" ? " (sign-in not checkable; make sure you're logged in)" : ""}`;
      if (id !== "qwen" && id !== "claude") ready += 1;
    }
    process.stdout.write(`  ${a.displayName.padEnd(12)} ${line}\n`);
  }
  if (ready < 1) {
    process.stdout.write(
      "\nNo agent to fail over to yet. Install and sign in to at least one of Codex, Cursor or Antigravity.\n",
    );
  }

  // Repo setup
  mkdirSync(handoffDir(root), { recursive: true });
  for (const p of [
    ".handoff/",
    ".claude/settings.local.json",
    ".codex/hooks.json",
    ".cursor/hooks.json",
  ]) {
    excludeLocally(root, p);
  }
  const { cmd, global } = nowallCommand();
  const written: string[] = [];
  for (const id of ["claude", "codex", "cursor"] as const) {
    written.push(...(ADAPTERS[id].installHooks?.(root, cmd) ?? []));
  }
  process.stdout.write(
    `\nInstalled hooks: ${written.map((w) => w.replace(`${root}${sep}`, "")).join(", ")}\n`,
  );

  // Config (+ opt-in fallback)
  const config: Config = loadConfig();
  if (argv.includes("--yolo")) config.yolo = true;
  if (argv.includes("--fallback")) {
    const cn = await ask(
      "Will Qwen Code use a China-hosted provider (DeepSeek, Kimi, GLM)? [y/N] ",
    );
    if (cn === "y") {
      process.stdout.write(`\n${CHINA_CONSENT}\n`);
      if ((await ask('Type "yes" to allow: ')) === "yes") {
        config.fallback = { enabled: true, chinaConsent: true };
        config.enabled.qwen = true;
      } else {
        process.stdout.write("Fallback left off.\n");
      }
    } else {
      config.fallback = { enabled: true, chinaConsent: false };
      config.enabled.qwen = true;
    }
    if (config.fallback.enabled) {
      process.stdout.write(
        "Fallback on. Configure your own provider key inside Qwen Code; nowall never stores it.\n",
      );
    }
  }
  saveConfig(config);
  trustRepo(root);
  snapshotTree(root); // warms the snapshot index so the first session starts fast

  // Shell alias
  const wantAlias =
    argv.includes("--alias") ||
    (!yes && (await ask("\nRoute `claude` through nowall in your shell? [y/N] ")) === "y");
  if (wantAlias && process.platform === "win32") {
    process.stdout.write(
      "\nThe `claude` shortcut isn't available on Windows yet. Start sessions with: nowall run claude\n",
    );
  } else if (wantAlias) {
    if (!global) {
      process.stdout.write(
        "Skipped: install nowall globally first (npm i -g nowall), then rerun `nowall init --alias`.\n",
      );
    } else {
      installAlias();
      process.stdout.write(
        `Added a \`claude\` shell function to ${rcFile()}. Open a new terminal to use it.\n`,
      );
    }
  } else {
    process.stdout.write("\nNo alias. Start sessions with: nowall run claude\n");
  }
  process.stdout.write(
    "\nDone. Work in Claude Code as usual; if it hits its limit, the next agent takes over.\n",
  );
  return 0;
}

/** Edits the real file behind a (possibly symlinked, e.g. dotfile-managed) shell rc file. */
function rcTarget(file: string): string {
  try {
    return realpathSync(file);
  } catch {
    return file;
  }
}

export function installAlias(rc = rcFile()): void {
  const block = `${MARK_START}\nclaude() { command nowall run claude -- "$@"; }\n${MARK_END}\n`;
  const file = rcTarget(rc);
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  const stripped = stripBlock(current);
  writeAtomic(
    file,
    `${stripped}${stripped && !stripped.endsWith("\n") ? "\n" : ""}${block}`,
    0o644,
  );
}

export function stripBlock(text: string): string {
  const re = new RegExp(`${MARK_START}[\\s\\S]*?${MARK_END}\\n?`, "g");
  return text.replace(re, "");
}

/** The shell rc files nowall may have added its alias block to (real paths behind symlinks). */
export function rcFiles(home = homedir()): string[] {
  return [join(home, ".zshrc"), join(home, ".bashrc")].map(rcTarget);
}

/**
 * Drops every hook nowall wrote into this repo's own hook files (any event, including the Cursor
 * subagent ones), keeping the user's entries. Returns the files it changed.
 */
export function removeRepoHooks(root: string): string[] {
  const changed: string[] = [];
  for (const f of REPO_HOOK_FILES) {
    const p = join(root, f);
    if (!existsSync(p)) continue;
    const raw = readFileSync(p, "utf8");
    if (!isOurs(raw)) continue; // nothing of ours in it: leave the file byte for byte
    if (f === ".cursor/hooks.json") {
      mergeHooksFile(p, (existing) => {
        const hooks: Record<string, unknown[]> = {};
        for (const [event, list] of Object.entries(existing.hooks ?? {})) {
          if (!Array.isArray(list)) continue;
          const kept = list.filter((h) => !isOurs(h));
          if (kept.length) hooks[event] = kept;
        }
        return { ...existing, hooks };
      });
    } else {
      mergeHooksFile(p, (existing) => withHooks(existing, {}));
    }
    changed.push(p);
    removeIfEmptied(p);
  }
  return changed;
}

/** A hook file that held only our hooks goes away, so uninstalling leaves no new file in the repo. */
function removeIfEmptied(path: string): void {
  const doc = readJsonSafe<Record<string, unknown>>(path);
  if (!doc) return;
  const { hooks, version, ...rest } = doc;
  const noHooks = !hooks || Object.keys(hooks).length === 0;
  if (!noHooks || Object.keys(rest).length) return;
  rmSync(path, { force: true });
  try {
    rmdirSync(dirname(path)); // only succeeds when empty
  } catch {
    // the folder holds other files: keep it
  }
}

export async function runUninstall(cwd = process.cwd()): Promise<number> {
  for (const file of rcFiles()) {
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    if (text.includes(MARK_START)) writeAtomic(file, stripBlock(text), 0o644);
  }
  const root = repoRoot(cwd);
  if (root) {
    untrustRepo(root);
    removeRepoHooks(root);
    rmSync(join(handoffDir(root), "off"), { force: true }); // per-repo opt-out marker
  }
  process.stdout.write(
    "Removed nowall hooks and shell alias. .handoff/ and checkpoints are kept; delete them if you like.\n",
  );
  return 0;
}
