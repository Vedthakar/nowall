import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyLimit } from "../limits.js";
import type { LimitHit } from "../schemas.js";
import { cmdHook, mergeHooksFile, parseStreamJson, withHooks } from "./common.js";
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
    const hook = (name: string) => `${nowall} hook ${name} --agent claude`;
    return [
      mergeHooksFile(join(root, ".claude", "settings.local.json"), (existing) =>
        withHooks(existing, {
          SessionStart: [cmdHook(hook("session-start"))],
          UserPromptSubmit: [cmdHook(hook("prompt"))],
          PostToolUse: [cmdHook(hook("post-tool"), "Edit|Write|MultiEdit|NotebookEdit|Bash")],
          StopFailure: [cmdHook(hook("stop-failure"), "rate_limit")],
        }),
      ),
    ];
  },
};

/**
 * Reads the most recent rate-limit error from a Claude transcript (JSONL). The StopFailure hook
 * calls this because its own payload is not documented to carry the message text.
 */
export function lastLimitFromTranscript(path: string, now: Date): LimitHit | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
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
