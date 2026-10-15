import { spawn } from "node:child_process";
import { constants, chmodSync, closeSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { lastLimitFromTranscript } from "./adapters/claude.js";
import { shq, writeAtomic } from "./fsafe.js";
import { checkpoint, excludeLocally, findRepoRoot, repoRoot } from "./git.js";
import { JOURNAL_RULE } from "./prompt.js";
import type { AgentId, LimitHit } from "./schemas.js";
import {
  type LimitSignal,
  SID_RE,
  appendJournal,
  archiveTasks,
  handoffDir,
  handoffProblem,
  isInitialized,
  isLocked,
  loadSession,
  saveSession,
  signalPath,
} from "./session.js";
import {
  isTrustedRepo,
  loadConfig,
  loadState,
  recordLimit,
  saveState,
  writeJson,
} from "./state.js";
import { describeTool, updateStatus } from "./status.js";

type Json = Record<string, unknown>;
const EDIT_TOOLS = /^(Edit|Write|MultiEdit|NotebookEdit|apply_patch|edit|write_file|replace)$/i;
const SHELL_TOOLS = /^(Bash|shell|exec_command|run_shell_command|local_shell)$/i;

/**
 * Root of a repo nowall may act in, or null. With `nowall setup` (global scope) that is any git
 * repo, set up on first use; otherwise only repos the user ran `nowall init` in. Either way a repo
 * that commits or symlinks .handoff/ is refused. `deep` also asks git about committed files.
 */
export function trustedRoot(cwd: string, deep = true): string | null {
  const root = deep ? repoRoot(cwd) : findRepoRoot(cwd);
  if (!root) return null;
  if (handoffProblem(root, { git: deep })) return null;
  if (loadConfig().scope === "global") {
    if (!isInitialized(root)) {
      try {
        mkdirSync(handoffDir(root), { recursive: true });
        excludeLocally(root, ".handoff/");
      } catch {
        return null;
      }
    }
    return root;
  }
  return isInitialized(root) && isTrustedRepo(root) ? root : null;
}

/**
 * Session id for hook events. Under `nowall run` it comes from NOWALL_SID. When the agent runs
 * on its own (Claude desktop app, IDE, plain terminal) it is derived from the agent's session id.
 */
export function hookSid(input: Json, env: NodeJS.ProcessEnv, fallback?: string): string {
  if (env.NOWALL_SID && SID_RE.test(env.NOWALL_SID)) return env.NOWALL_SID;
  const raw =
    typeof input.session_id === "string" ? input.session_id.replace(/[^A-Za-z0-9-]/g, "") : "";
  if (raw) return `c_${raw.slice(0, 62)}`;
  return fallback ?? "c_manual";
}

/** Starts tracking an agent session nowall did not launch, so a later limit can be taken over. */
export function ensureExternalSession(root: string, sid: string, agent: AgentId, now: Date): void {
  if (loadSession(root)?.sid === sid) return;
  if (isLocked(root)) return; // a supervised run owns session.json right now
  const base = checkpoint(root, sid, 0, `nowall: session start (${agent})`);
  if (loadSession(root)?.sid === sid || isLocked(root)) return; // another process got there first
  archiveTasks(root);
  saveSession(root, {
    v: 1,
    sid,
    startedAt: now.toISOString(),
    baseCommit: base.commit,
    checkpoints: 1,
    segments: [{ agent, mode: "interactive", startedAt: now.toISOString() }],
  });
}

const HOT = new Set(["prompt", "post-tool", "notification", "stop", "session-end"]);

/**
 * Handles `nowall hook <name>` invoked by an agent's hook system. Must never throw and must
 * print nothing unless the event uses stdout (SessionStart context). Returns stdout text.
 */
export function handleHook(
  name: string,
  agent: AgentId,
  input: Json,
  env: NodeJS.ProcessEnv,
  now: Date,
): string {
  const cwd = typeof input.cwd === "string" ? input.cwd : process.cwd();
  // Frequent hooks run on every tool call or turn: no git process on that path.
  const root = trustedRoot(cwd, !HOT.has(name));
  if (!root) return "";
  const sid = hookSid(input, env, loadSession(root)?.sid);
  const rel = (p: string) => (isAbsolute(p) ? relative(root, realish(p)) : p);
  const status = (patch: Parameters<typeof updateStatus>[2]) => updateStatus(sid, root, patch, now);

  switch (name) {
    case "session-start":
      // Synchronous on purpose: the base must predate the agent's first edit, or that work would
      // look like it was already there. Fast thanks to the persistent snapshot index.
      if (!env.NOWALL_SID) ensureExternalSession(root, sid, agent, now);
      status({ agent, phase: "idle", detail: "Session started" });
      return JSON.stringify({
        hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: JOURNAL_RULE },
      });

    case "prompt": {
      const prompt = typeof input.prompt === "string" ? input.prompt : "";
      if (prompt.trim() && !prompt.trim().startsWith("/")) {
        appendJournal(root, { sid, agent, kind: "goal", text: prompt });
        status({ agent, phase: "working", detail: prompt });
      }
      return "";
    }

    case "post-tool": {
      const tool = String(input.tool_name ?? (input.file_path ? "Edit" : ""));
      const ti = (input.tool_input ?? {}) as Json;
      const file = [ti.file_path, ti.path, ti.notebook_path, input.file_path].find(
        (v): v is string => typeof v === "string",
      );
      if (EDIT_TOOLS.test(tool) || (file && !SHELL_TOOLS.test(tool))) {
        const f = file ? rel(file) : undefined;
        appendJournal(root, { sid, agent, kind: "edit", text: tool, files: f ? [f] : [] });
        status({ agent, phase: "working", detail: describeTool(tool, f) });
      } else if (SHELL_TOOLS.test(tool)) {
        const cmd = ti.command;
        const text = Array.isArray(cmd) ? cmd.join(" ") : String(cmd ?? "");
        if (text) appendJournal(root, { sid, agent, kind: "cmd", text: text.slice(0, 120) });
        status({ agent, phase: "working", detail: describeTool(tool, undefined, text) });
      }
      return "";
    }

    case "notification": {
      // Claude asks for permission or is waiting on the user.
      const message = typeof input.message === "string" ? input.message : "Needs your input";
      status({ agent, phase: "needs-input", detail: message });
      return "";
    }

    case "stop":
      status({ agent, phase: "your-turn", detail: "Finished its turn" });
      return "";

    case "session-end":
      status({ agent, phase: "ended", detail: "Session closed" });
      return "";

    case "stop-failure": {
      const transcript = typeof input.transcript_path === "string" ? input.transcript_path : "";
      const hit: LimitHit = lastLimitFromTranscript(transcript, now) ?? {
        kind: "quota",
        window: "unknown",
        message: "usage limit reached",
      };
      saveState(recordLimit(loadState(), agent, hit, now, loadConfig().defaultCooldownMinutes));
      appendJournal(root, { sid, agent, kind: "limit", text: hit.message });
      status({ agent, phase: "handing-off", detail: hit.message });

      if (env.NOWALL_SID) {
        // Supervised by `nowall run`: tell the wrapper, which stops the agent and hands off.
        const signal: LimitSignal = {
          agent,
          sid,
          window: hit.window,
          message: hit.message,
          observedAt: now.toISOString(),
        };
        if (hit.resetsAt) signal.resetsAt = hit.resetsAt;
        writeJson(signalPath(root, sid), signal);
      } else if (loadConfig().takeover !== "off" && !isLocked(root)) {
        ensureExternalSession(root, sid, agent, now);
        launchTakeover(root, sid, agent, env);
      }
      return "";
    }
    default:
      return "";
  }
}

function takeoverArgs(cli: string, sid: string, agent: AgentId): string[] {
  return [cli, "takeover", "--sid", sid, "--from", agent];
}

/**
 * Continues a session nowall didn't launch (e.g. Claude desktop app). By default it runs silently
 * in the background, logging to .handoff/takeover.log, and the notch shows progress. With
 * `"takeover": "terminal"` it opens a Terminal window instead (macOS). Every value in the Terminal
 * script is passed as a quoted env var, so paths or ids can never inject shell commands.
 */
export function launchTakeover(
  root: string,
  sid: string,
  agent: AgentId,
  env: NodeJS.ProcessEnv,
  open: (script: string) => void = (script) =>
    spawn("open", ["-a", "Terminal", script], { detached: true, stdio: "ignore" }).unref(),
): string | null {
  // Our own CLI, next to this module (never trust argv[1]: a test runner or wrapper may own it).
  const cli = join(dirname(fileURLToPath(import.meta.url)), "cli.js");
  const config = loadConfig();
  // Agent CLIs usually live on the user's shell PATH, which GUI apps (and their hooks) don't get.
  const path = [config.path, env.PATH].filter(Boolean).join(":");

  if (config.takeover !== "terminal" || process.platform !== "darwin") {
    const log = join(handoffDir(root), "takeover.log");
    const fd = openSync(log, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT, 0o600);
    try {
      spawn(process.execPath, takeoverArgs(cli, sid, agent), {
        cwd: root,
        detached: true,
        stdio: ["ignore", fd, fd],
        env: { ...env, PATH: path },
      }).unref();
    } finally {
      closeSync(fd);
    }
    return null;
  }

  const script = join(handoffDir(root), `takeover-${sid}.command`);
  const vars: Record<string, string> = {
    NOWALL_NODE: process.execPath,
    NOWALL_CLI: cli,
    NOWALL_TAKEOVER_SID: sid,
    NOWALL_TAKEOVER_FROM: agent,
    NOWALL_EXTRA_PATH: path,
  };
  if (env.NOWALL_HOME) vars.NOWALL_HOME = env.NOWALL_HOME;
  const exports = Object.entries(vars)
    .map(([k, v]) => `export ${k}=${shq(v)}`)
    .join("\n");
  const inner =
    'export PATH="$NOWALL_EXTRA_PATH:$PATH"; exec "$NOWALL_NODE" "$NOWALL_CLI" takeover --sid "$NOWALL_TAKEOVER_SID" --from "$NOWALL_TAKEOVER_FROM"';
  writeAtomic(
    script,
    `#!/bin/sh\ncd ${shq(root)} || exit 1\n${exports}\nexec "\${SHELL:-/bin/zsh}" -lic ${shq(inner)}\n`,
    0o700,
  );
  chmodSync(script, 0o700);
  open(script);
  return script;
}

/** realpath that also works for files that don't exist yet (resolves the nearest existing parent). */
function realish(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    const parent = dirname(p);
    return parent === p ? p : join(realish(parent), basename(p));
  }
}
