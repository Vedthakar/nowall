import { join } from "node:path";
import { classifyLimit } from "../limits.js";
import { mergeHooksFile, parseStreamJson } from "./common.js";
import { type AgentAdapter, versionOf } from "./types.js";

/** Generic limit wording for agents whose exact error text has not been captured yet. */
function genericLimit(text: string, now: Date) {
  const hit = classifyLimit(text, now);
  if (hit) return hit;
  if (
    /usage limit|quota|out of (fast )?requests|upgrade (your plan|to pro)|limit reached/i.test(text)
  ) {
    return {
      kind: "quota" as const,
      window: "unknown" as const,
      message: text.trim().slice(0, 300),
    };
  }
  return null;
}

export const cursor: AgentAdapter = {
  id: "cursor",
  displayName: "Cursor",
  binary: "cursor-agent",
  installHint: "curl https://cursor.com/install -fsS | bash",
  loginHint: "cursor-agent login",
  maturity: "beta",

  async detect(run, bin) {
    const version = await versionOf(run, bin);
    if (version === null) return { installed: false, signedIn: false };
    // `status --format json` reports isAuthenticated:true even when the server rejects an expired
    // login (seen on 2026.07.09); the plain output says "unable to fetch user details" then.
    const plain = await run(bin, ["status"]);
    if (
      /unable to fetch user details|not logged in|authentication required/i.test(
        plain.stdout + plain.stderr,
      )
    ) {
      return { installed: true, version, signedIn: false };
    }
    const r = await run(bin, ["status", "--format", "json"]);
    try {
      const s = JSON.parse(r.stdout) as { isAuthenticated?: boolean };
      return { installed: true, version, signedIn: s.isAuthenticated === true };
    } catch {
      return { installed: true, version, signedIn: "unknown" };
    }
  },

  headless({ prompt, resumeId, yolo }) {
    const args = ["-p", prompt, "--output-format", "stream-json", "--trust"];
    if (resumeId) args.push("--resume", resumeId);
    if (yolo) args.push("--force");
    return { args };
  },

  parseLine: parseStreamJson,
  detectLimit: genericLimit,

  resumeCommand(sessionId) {
    return sessionId ? `cursor-agent --resume ${sessionId}` : "cursor-agent resume";
  },

  installHooks(root, nowall) {
    // Documented for the IDE agent; CLI support unverified. Harmless if ignored.
    return [
      mergeHooksFile(join(root, ".cursor", "hooks.json"), (existing) => {
        const hooks = { ...((existing.hooks as Record<string, unknown[]>) ?? {}) };
        hooks.afterFileEdit = [
          ...(hooks.afterFileEdit ?? []).filter((h) => !JSON.stringify(h).includes("nowall hook")),
          { command: `${nowall} hook post-tool --agent cursor` },
        ];
        return { version: 1, ...existing, hooks };
      }),
    ];
  },
};

export const antigravity: AgentAdapter = {
  id: "antigravity",
  displayName: "Antigravity",
  binary: "agy",
  installHint: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
  loginHint: "agy  (sign in interactively once)",
  maturity: "beta",

  async detect(run, bin) {
    const version = await versionOf(run, bin);
    if (version === null) return { installed: false, signedIn: false };
    return { installed: true, version, signedIn: "unknown" };
  },

  headless({ prompt, resumeId }) {
    const args = ["-p", prompt, "--output-format", "stream-json"];
    if (resumeId) args.push("--conversation", resumeId);
    return { args };
  },

  parseLine: parseStreamJson,
  detectLimit: genericLimit,

  resumeCommand(sessionId) {
    return sessionId ? `agy --conversation ${sessionId}` : "agy -c";
  },
};

/** Opt-in own-key fallback. Qwen Code is configured by the user with their own provider. */
export const qwen: AgentAdapter = {
  id: "qwen",
  displayName: "Qwen Code",
  binary: "qwen",
  installHint: "npm i -g @qwen-code/qwen-code",
  loginHint: "configure your own provider key in Qwen Code's settings",
  maturity: "beta",

  async detect(run, bin) {
    const version = await versionOf(run, bin);
    if (version === null) return { installed: false, signedIn: false };
    return { installed: true, version, signedIn: "unknown" };
  },

  headless({ prompt, resumeId, yolo }) {
    const args = ["-p", prompt, "--output-format", "stream-json"];
    if (resumeId) args.push("--resume", resumeId);
    args.push(...(yolo ? ["--yolo"] : ["--approval-mode", "auto-edit"]));
    return { args };
  },

  parseLine: parseStreamJson,
  detectLimit: genericLimit,

  resumeCommand() {
    return "qwen --continue";
  },
};
