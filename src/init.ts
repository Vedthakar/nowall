import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { mergeHooksFile, withHooks } from "./adapters/common.js";
import { ADAPTERS, resolveBinary } from "./adapters/index.js";
import { defaultRunner } from "./adapters/types.js";
import { shq, writeAtomic } from "./fsafe.js";
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

const MARK_START = "# >>> nowall >>>";
const MARK_END = "# <<< nowall <<<";

function rcFile(): string {
  return join(homedir(), (process.env.SHELL ?? "").includes("zsh") ? ".zshrc" : ".bashrc");
}

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
  if (resolveBinary("nowall")) return { cmd: "nowall", global: true };
  // Hooks run through sh: quote paths so spaces, quotes or `$` in them can't inject commands.
  const script = realpathSync(process.argv[1] ?? "");
  return { cmd: `${shq(process.execPath)} ${shq(script)}`, global: false };
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
    process.stdout.write("Nothing changed.\n");
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
    if (!d.installed && id === "claude" && existsSync("/Applications/Claude.app")) {
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
    `\nInstalled hooks: ${written.map((w) => w.replace(`${root}/`, "")).join(", ")}\n`,
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
  if (wantAlias) {
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

export async function runUninstall(): Promise<number> {
  for (const file of [join(homedir(), ".zshrc"), join(homedir(), ".bashrc")].map(rcTarget)) {
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    if (text.includes(MARK_START)) writeAtomic(file, stripBlock(text), 0o644);
  }
  const root = repoRoot(process.cwd());
  if (root) {
    untrustRepo(root);
    for (const f of [".claude/settings.local.json", ".codex/hooks.json"]) {
      const p = join(root, f);
      if (existsSync(p)) mergeHooksFile(p, (existing) => withHooks(existing, {}));
    }
    const cursor = join(root, ".cursor/hooks.json");
    if (existsSync(cursor)) {
      mergeHooksFile(cursor, (existing) => {
        const hooks = { ...((existing.hooks as Record<string, unknown[]>) ?? {}) };
        hooks.afterFileEdit = (hooks.afterFileEdit ?? []).filter(
          (h) => !JSON.stringify(h).includes("nowall hook"),
        );
        return { ...existing, hooks };
      });
    }
  }
  process.stdout.write(
    "Removed nowall hooks and shell alias. .handoff/ and checkpoints are kept; delete them if you like.\n",
  );
  return 0;
}
