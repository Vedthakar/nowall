import { spawn } from "node:child_process";
import { chmodSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { lastLimitFromTranscript } from "./adapters/claude.js";
import { shq, writeAtomic } from "./fsafe.js";
import { checkpoint, findRepoRoot, repoRoot } from "./git.js";
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

type Json = Record<string, unknown>;
const EDIT_TOOLS = /^(Edit|Write|MultiEdit|NotebookEdit|apply_patch|edit|write_file|replace)$/i;
const SHELL_TOOLS = /^(Bash|shell|exec_command|run_shell_command|local_shell)$/i;

/**
 * Root of a repo nowall may act in: initialized by this user, and .handoff/ is trustworthy.
 * `deep` also asks git whether .handoff/ is committed (slower; used where it matters).
 */
export function trustedRoot(cwd: string, deep = true): string | null {
  const root = deep ? repoRoot(cwd) : findRepoRoot(cwd);
  if (!root || !isInitialized(root) || !isTrustedRepo(root)) return null;
  return handoffProblem(root, { git: deep }) ? null : root;
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
  // Prompt/edit hooks run on every tool call: no git process on that path.
  const root = trustedRoot(cwd, !(name === "prompt" || name === "post-tool"));
  if (!root) return "";
  const sid = hookSid(input, env, loadSession(root)?.sid);
  const rel = (p: string) => (isAbsolute(p) ? relative(root, realish(p)) : p);

  switch (name) {
    case "session-start":
      // Synchronous on purpose: the base must predate the agent's first edit, or that work would
      // look like it was already there. Fast thanks to the persistent snapshot index (warmed by init).
      if (!env.NOWALL_SID) ensureExternalSession(root, sid, agent, now);
      return JSON.stringify({
        hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: JOURNAL_RULE },
      });

    case "prompt": {
      const prompt = typeof input.prompt === "string" ? input.prompt : "";
      if (prompt.trim() && !prompt.trim().startsWith("/")) {
        appendJournal(root, { sid, agent, kind: "goal", text: prompt });
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
        appendJournal(root, {
          sid,
          agent,
          kind: "edit",
          text: tool,
          files: file ? [rel(file)] : [],
        });
      } else if (SHELL_TOOLS.test(tool)) {
        const cmd = ti.command;
        const text = Array.isArray(cmd) ? cmd.join(" ") : String(cmd ?? "");
        if (text) appendJournal(root, { sid, agent, kind: "cmd", text: text.slice(0, 120) });
      }
      return "";
    }

    case "stop-failure": {
      const transcript = typeof input.transcript_path === "string" ? input.transcript_path : "";
      const hit: LimitHit = lastLimitFromTranscript(transcript, now) ?? {
        kind: "quota",
        window: "unknown",
        message: "usage limit reached",
      };
      saveState(recordLimit(loadState(), agent, hit, now, loadConfig().defaultCooldownMinutes));
      appendJournal(root, { sid, agent, kind: "limit", text: hit.message });

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

/**
 * Opens a new Terminal window running `nowall takeover` (macOS). The script quotes every value
 * with shq(), so repo paths containing quotes, `$` or spaces cannot inject commands.
 * NOWALL_TAKEOVER=inline runs it detached in the background instead (tests, Linux, headless).
 */
export function launchTakeover(
  root: string,
  sid: string,
  agent: AgentId,
  env: NodeJS.ProcessEnv,
  open: (script: string) => void = (script) =>
    spawn("open", ["-a", "Terminal", script], { detached: true, stdio: "ignore" }).unref(),
): string | null {
  const cli = realpathSync(process.argv[1] ?? "");
  const args = [cli, "takeover", "--sid", sid, "--from", agent];
  if (env.NOWALL_TAKEOVER === "inline" || process.platform !== "darwin") {
    spawn(process.execPath, args, { cwd: root, detached: true, stdio: "ignore", env }).unref();
    return null;
  }
  const script = join(handoffDir(root), `takeover-${sid}.command`);
  // Values travel as quoted env vars; the shell command itself is a constant string, so nothing in
  // a path or id can inject commands. Running via the login shell picks up the user's own PATH
  // (where agent CLIs usually live); the hook's PATH is prepended in case it knows more.
  const vars: Record<string, string> = {
    NOWALL_NODE: process.execPath,
    NOWALL_CLI: cli,
    NOWALL_TAKEOVER_SID: sid,
    NOWALL_TAKEOVER_FROM: agent,
    NOWALL_EXTRA_PATH: env.PATH ?? "",
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
