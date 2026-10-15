import { join } from "node:path";
import { readTail } from "../fsafe.js";
import { classifyLimit } from "../limits.js";
import type { LimitHit } from "../schemas.js";
import { HOOK_MARK, cmdHook, mergeHooksFile, parseStreamJson, withHooks } from "./common.js";
import { type AgentAdapter, versionOf } from "./types.js";

export const claude: AgentAdapter = {
  id: "claude",
  displayName: "Claude Code",
  binary: "claude",
  installHint: "curl -fsSL https://claude.ai/install.sh | bash",
  loginHint: "claude  (then /login)",
  maturity: "stable",

  async detect(run, bin) {
    const version = await versionOf(run, bin);
    if (version === null) return { installed: false, signedIn: false };
    // No documented non-interactive auth check; credentials are never read by us.
    return { installed: true, version, signedIn: "unknown" };
  },

  headless({ prompt, resumeId, yolo }) {
    const args = ["-p", prompt, "--output-format", "stream-json", "--verbose"];
    if (resumeId) args.push("--resume", resumeId);
    // Headless runs cannot show approval prompts: default is edits-only, full auto is opt-in.
    args.push(
      ...(yolo ? ["--dangerously-skip-permissions"] : ["--permission-mode", "acceptEdits"]),
    );
    return { args };
  },

  parseLine: parseStreamJson,

  detectLimit(text, now) {
    return classifyLimit(text, now);
  },

  resumeCommand(sessionId) {
    return sessionId ? `claude --resume ${sessionId}` : "claude --continue";
  },

  installHooks(root, nowall) {
    return [
      mergeHooksFile(join(root, ".claude", "settings.local.json"), (e) => claudeHooks(e, nowall)),
    ];
  },

  installUserHooks(home, nowall) {
    return [
      mergeHooksFile(
        join(home, ".claude", "settings.json"),
        (e) => {
          const next = claudeHooks(e, nowall);
          // Claude's 5h/weekly usage is only exposed to the status line; add a silent tap if none exists.
          if (!next.statusLine) {
            next.statusLine = { type: "command", command: `${HOOK_MARK} ${nowall} statusline` };
          }
          return next;
        },
        { followSymlink: true },
      ),
    ];
  },
};

function claudeHooks(existing: Record<string, unknown>, nowall: string): Record<string, unknown> {
  const hook = (name: string) => `${HOOK_MARK} ${nowall} hook ${name} --agent claude`;
  return withHooks(existing, {
    SessionStart: [cmdHook(hook("session-start"), undefined, 30)],
    UserPromptSubmit: [cmdHook(hook("prompt"), undefined, 10)],
    PostToolUse: [cmdHook(hook("post-tool"), "Edit|Write|MultiEdit|NotebookEdit|Bash", 10)],
    StopFailure: [cmdHook(hook("stop-failure"), "rate_limit", 30)],
    Notification: [cmdHook(hook("notification"), undefined, 10)],
    Stop: [cmdHook(hook("stop"), undefined, 10)],
    SessionEnd: [cmdHook(hook("session-end"), undefined, 10)],
  });
}

/**
 * Reads the most recent rate-limit error from a Claude transcript (JSONL). The StopFailure hook
 * calls this because its own payload is not documented to carry the message text.
 */
export function lastLimitFromTranscript(path: string, now: Date): LimitHit | null {
  const raw = readTail(path, 1024 * 1024); // transcripts can be huge; the error is at the end
  if (raw === null) return null;
  const lines = raw.trimEnd().split("\n").slice(-300).reverse();
  for (const l of lines) {
    if (!l.includes('"isApiErrorMessage":true')) continue;
    try {
      const o = JSON.parse(l) as {
        error?: string;
        message?: { content?: { text?: string }[] };
        quotaLimits?: { resetsAt?: number | string };
      };
      const text = o.message?.content?.find((c) => typeof c.text === "string")?.text ?? "";
      const hit =
        classifyLimit(text, now) ??
        (o.error === "rate_limit"
          ? { kind: "quota" as const, window: "unknown" as const, message: text || "rate limit" }
          : null);
      if (!hit) continue;
      const r = o.quotaLimits?.resetsAt;
      if (r !== undefined) {
        const ms = typeof r === "number" ? (r < 1e12 ? r * 1000 : r) : Date.parse(r);
        if (Number.isFinite(ms)) hit.resetsAt = new Date(ms).toISOString();
      }
      return hit;
    } catch {
      // skip malformed line
    }
  }
  return null;
}
