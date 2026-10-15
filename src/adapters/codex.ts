import { join } from "node:path";
import { classifyLimit } from "../limits.js";
import { HOOK_MARK, cmdHook, mergeHooksFile, withHooks } from "./common.js";
import { type AgentAdapter, type AgentEvent, versionOf } from "./types.js";

type Json = Record<string, unknown>;

export function parseCodexLine(line: string): AgentEvent[] {
  let o: Json;
  try {
    o = JSON.parse(line) as Json;
  } catch {
    return line.trim() ? [{ kind: "text", text: line.trim() }] : [];
  }
  const type = o.type;
  if (type === "thread.started" && typeof o.thread_id === "string") {
    return [{ kind: "session", id: o.thread_id }];
  }
  if (type === "item.completed" || type === "item.started") {
    const item = (o.item ?? {}) as Json;
    if (type === "item.started") return [];
    switch (item.type) {
      case "agent_message":
        return typeof item.text === "string" ? [{ kind: "text", text: item.text }] : [];
      case "command_execution":
        return [{ kind: "tool", name: "shell", detail: String(item.command ?? "") }];
      case "file_change": {
        const changes = Array.isArray(item.changes) ? (item.changes as Json[]) : [];
        const files = changes.map((c) => c.path).filter((p): p is string => typeof p === "string");
        return [{ kind: "tool", name: "edit", files }];
      }
      case "error":
        return [{ kind: "error", text: String(item.message ?? "") }];
      default:
        return [];
    }
  }
  if (type === "turn.failed") {
    const err = (o.error ?? {}) as Json;
    return [
      { kind: "error", text: String(err.message ?? JSON.stringify(o.error)) },
      { kind: "done", isError: true },
    ];
  }
  if (type === "error") return [{ kind: "error", text: String(o.message ?? "") }];
  if (type === "turn.completed") return [{ kind: "done", isError: false }];
  return [];
}

export const codex: AgentAdapter = {
  id: "codex",
  displayName: "Codex",
  binary: "codex",
  installHint: "npm i -g @openai/codex",
  loginHint: "codex login",
  maturity: "beta",

  async detect(run, bin) {
    const version = await versionOf(run, bin);
    if (version === null) return { installed: false, signedIn: false };
    const status = await run(bin, ["login", "status"]);
    return { installed: true, version, signedIn: status.code === 0 };
  },

  headless({ prompt, resumeId, yolo }) {
    const flags = [
      "--json",
      "--skip-git-repo-check",
      ...(yolo ? ["--dangerously-bypass-approvals-and-sandbox"] : ["--sandbox", "workspace-write"]),
    ];
    // Flag placement for `exec resume` is unverified against a real install (see RESEARCH.md).
    return {
      args: resumeId ? ["exec", "resume", resumeId, ...flags, prompt] : ["exec", ...flags, prompt],
    };
  },

  parseLine: parseCodexLine,

  detectLimit(text, now) {
    return classifyLimit(text, now);
  },

  resumeCommand(sessionId) {
    return sessionId ? `codex resume ${sessionId}` : "codex resume --last";
  },

  installHooks(root, nowall) {
    const hook = (name: string) => `${HOOK_MARK} ${nowall} hook ${name} --agent codex`;
    return [
      mergeHooksFile(join(root, ".codex", "hooks.json"), (existing) =>
        withHooks(existing, {
          UserPromptSubmit: [cmdHook(hook("prompt"))],
          PostToolUse: [cmdHook(hook("post-tool"))],
        }),
      ),
    ];
  },
};
