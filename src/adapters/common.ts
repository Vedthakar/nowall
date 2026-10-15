import { realpathSync } from "node:fs";
import { readJsonSafe, writeAtomic } from "../fsafe.js";
import type { AgentEvent } from "./types.js";

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : null;
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

export function filesFromInput(input: unknown): string[] {
  const i = obj(input);
  if (!i) return [];
  const out: string[] = [];
  for (const k of ["file_path", "path", "notebook_path", "filePath", "target_file"]) {
    const v = str(i[k]);
    if (v) out.push(v);
  }
  if (Array.isArray(i.paths)) for (const p of i.paths) if (typeof p === "string") out.push(p);
  return out;
}

/**
 * Parser for the Claude-style stream-json format. Claude Code emits it; Cursor CLI, Antigravity
 * and Qwen Code emit close variants, so tolerant field lookups cover all of them.
 */
export function parseStreamJson(line: string): AgentEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  let o: Json | null;
  try {
    o = obj(JSON.parse(trimmed));
  } catch {
    return [{ kind: "text", text: trimmed }];
  }
  if (!o) return [];
  const events: AgentEvent[] = [];
  const sid = str(o.session_id) ?? str(o.conversation_id) ?? str(o.chat_id);
  const type = str(o.type);

  if (type === "system" || type === "init") {
    if (sid) events.push({ kind: "session", id: sid });
    return events;
  }
  if (type === "assistant") {
    if (sid) events.push({ kind: "session", id: sid });
    const content = obj(o.message)?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        const b = obj(block);
        if (!b) continue;
        if (b.type === "text" && str(b.text))
          events.push({ kind: "text", text: str(b.text) ?? "" });
        if (b.type === "tool_use") {
          const files = filesFromInput(b.input);
          const command = str(obj(b.input)?.command);
          const ev: AgentEvent = { kind: "tool", name: str(b.name) ?? "tool" };
          if (files.length) ev.files = files;
          if (command) ev.detail = command;
          events.push(ev);
        }
      }
    }
    return events;
  }
  if (type === "tool_call" && o.subtype === "started") {
    // Cursor: {"type":"tool_call","tool_call":{"writeToolCall":{"args":{"path":...}}}}
    const call = obj(o.tool_call);
    const name = call ? Object.keys(call)[0] : undefined;
    if (name) {
      const args = obj(call?.[name])?.args;
      const files = filesFromInput(args);
      events.push(files.length ? { kind: "tool", name, files } : { kind: "tool", name });
    }
    return events;
  }
  if (type === "result") {
    if (sid) events.push({ kind: "session", id: sid });
    const isError = o.is_error === true || (str(o.subtype) ?? "").startsWith("error");
    const text = str(o.result) ?? str(o.error);
    events.push(text !== undefined ? { kind: "done", isError, text } : { kind: "done", isError });
    return events;
  }
  if (type === "error") {
    const e = obj(o.error);
    events.push({
      kind: "error",
      text: str(o.message) ?? str(e?.message) ?? str(o.error) ?? trimmed,
    });
    return events;
  }
  return events;
}

/** Merges our hook entries into a JSON settings file, replacing earlier nowall entries. */
export function mergeHooksFile(
  path: string,
  build: (existing: Json) => Json,
  opts: { followSymlink?: boolean } = {},
): string {
  // Project files: symlink-safe, so a repo can't redirect this write to e.g. ~/.zshrc.
  // User files (~/.claude/settings.json): follow the user's own dotfile symlinks.
  let target = path;
  if (opts.followSymlink) {
    try {
      target = realpathSync(path);
    } catch {
      // doesn't exist yet
    }
  }
  const current = obj(readJsonSafe<unknown>(target)) ?? {};
  writeAtomic(target, `${JSON.stringify(build(current), null, 2)}\n`, 0o644);
  return target;
}

type HookGroup = {
  matcher?: string;
  hooks: { type: "command"; command: string; timeout?: number }[];
};

/** Prefix on every hook command we install (a no-op sh assignment) so we can always find ours. */
export const HOOK_MARK = "NOWALL_HOOK=1";

/** True for hook entries nowall installed, in any form we have ever written. */
export function isOurs(entry: unknown): boolean {
  const text = JSON.stringify(entry);
  return text.includes(HOOK_MARK) || text.includes("nowall hook");
}

/** Claude/Codex-style `hooks` object: drop prior nowall groups, add ours. */
export function withHooks(existing: Json, ours: Record<string, HookGroup[]>): Json {
  const hooks: Record<string, unknown[]> = {};
  const prev = obj(existing.hooks) ?? {};
  for (const [event, groups] of Object.entries(prev)) {
    if (!Array.isArray(groups)) continue;
    const kept = groups.filter((g) => !isOurs(g));
    if (kept.length) hooks[event] = kept;
  }
  for (const [event, groups] of Object.entries(ours)) {
    hooks[event] = [...(hooks[event] ?? []), ...groups];
  }
  return { ...existing, hooks };
}

/** A hook group; `timeout` (seconds) caps how long the agent waits on us. */
export const cmdHook = (command: string, matcher?: string, timeout?: number): HookGroup => {
  const hook = timeout
    ? { type: "command" as const, command, timeout }
    : { type: "command" as const, command };
  return matcher ? { matcher, hooks: [hook] } : { hooks: [hook] };
};
