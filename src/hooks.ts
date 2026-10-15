import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { lastLimitFromTranscript } from "./adapters/claude.js";
import { repoRoot } from "./git.js";
import { JOURNAL_RULE } from "./prompt.js";
import type { AgentId, LimitHit } from "./schemas.js";
import {
  type LimitSignal,
  appendJournal,
  isInitialized,
  loadSession,
  signalPath,
} from "./session.js";
import { loadConfig, loadState, recordLimit, saveState, writeJson } from "./state.js";

type Json = Record<string, unknown>;
const EDIT_TOOLS = /^(Edit|Write|MultiEdit|NotebookEdit|apply_patch|edit|write_file|replace)$/i;
const SHELL_TOOLS = /^(Bash|shell|exec_command|run_shell_command|local_shell)$/i;

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
  const root = repoRoot(cwd);
  if (!root || !isInitialized(root)) return "";
  const sid = env.NOWALL_SID ?? loadSession(root)?.sid ?? "manual";
  const rel = (p: string) => (isAbsolute(p) ? relative(root, realish(p)) : p);

  switch (name) {
    case "session-start":
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
        const signal: LimitSignal = {
          agent,
          sid: env.NOWALL_SID,
          window: hit.window,
          message: hit.message,
          observedAt: now.toISOString(),
        };
        if (hit.resetsAt) signal.resetsAt = hit.resetsAt;
        writeJson(signalPath(root, env.NOWALL_SID), signal);
      }
      return "";
    }
    default:
      return "";
  }
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
