import { spawn } from "node:child_process";
import {
  constants,
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { accountFromEnv } from "./accounts.js";
import { lastLimitFromTranscript } from "./adapters/claude.js";
import { CURSOR_EVENTS } from "./adapters/others.js";
import { appendSafe, readTail, shq, writeAtomic } from "./fsafe.js";
import { checkpoint, excludeLocally, findRepoRoot, repoRoot } from "./git.js";
import { JOURNAL_RULE } from "./prompt.js";
import { redact, redactDeep } from "./redact.js";
import type { AccountId, AgentId, LimitHit } from "./schemas.js";
import {
  type LimitSignal,
  SID_RE,
  appendJournal,
  archiveTasks,
  handoffDir,
  handoffProblem,
  isInitialized,
  isLocked,
  journalPath,
  loadSession,
  saveSession,
  signalPath,
} from "./session.js";
import {
  configDir,
  isTrustedRepo,
  loadConfig,
  loadState,
  recordLimit,
  saveState,
  writeJson,
} from "./state.js";
import {
  type ChildStatus,
  describeChildren,
  describeTool,
  liveChildren,
  readChildrenMap,
  readStatus,
  updateStatus,
  writeChildrenMap,
} from "./status.js";

type Json = Record<string, unknown>;
const EDIT_TOOLS = /^(Edit|Write|MultiEdit|NotebookEdit|apply_patch|edit|write_file|replace)$/i;
const SHELL_TOOLS = /^(Bash|shell|exec_command|run_shell_command|local_shell)$/i;
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** Cursor's subagentStart is a permission hook: this is the only answer that never gets in the way. */
export const ALLOW_SUBAGENT = JSON.stringify({ permission: "allow" });
/** Cursor can submit one prompt twice (retry); the second copy within this window is dropped. */
export const PROMPT_DEDUPE_MS = 90_000;
/** A Cursor child whose conversation id matches no subagent_id adopts a child started this recently. */
export const CHILD_LINK_WINDOW_MS = 5_000;
const DEBUG_MAX_BYTES = 2 * 1024 * 1024;

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
  // Cursor's common fields name it conversation_id; its payloads carry session_id too.
  const raw = cleanId(input.session_id) || cleanId(input.conversation_id);
  if (raw) return sidFromId(raw);
  return fallback ?? "c_manual";
}

/** An agent-supplied id reduced to the characters a sid may contain. */
function cleanId(v: unknown): string {
  return typeof v === "string" ? v.replace(/[^A-Za-z0-9-]/g, "").slice(0, 62) : "";
}

/** Sid for an agent-supplied id; empty when there is none. */
const sidFromId = (raw: string): string => (raw ? `c_${raw}` : "");

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

const HOT = new Set([
  "prompt",
  "post-tool",
  "notification",
  "stop",
  "session-end",
  "subagent-start",
  "subagent-stop",
]);

/**
 * Directory the hook event is about. Claude and Codex send `cwd`. Cursor sends `workspace_roots`
 * (and sets CURSOR_PROJECT_DIR) but runs user-level hooks from ~/.cursor, so process.cwd() is
 * only the last resort.
 */
export function hookCwd(input: Json, env: NodeJS.ProcessEnv): string {
  if (typeof input.cwd === "string" && input.cwd) return input.cwd;
  const roots = input.workspace_roots;
  if (Array.isArray(roots) && typeof roots[0] === "string" && roots[0]) return roots[0];
  for (const key of ["CURSOR_PROJECT_DIR", "CLAUDE_PROJECT_DIR"]) {
    const v = env[key];
    if (v) return v;
  }
  return process.cwd();
}

/**
 * Cursor also runs Claude-format hooks (~/.claude/settings.json), so one Cursor event can reach
 * nowall twice: once from .cursor/hooks.json as `--agent cursor` and once as `--agent claude`.
 * Cursor's payloads are recognisable (conversation_id, workspace_roots, camelCase event names).
 */
export function isCursorPayload(input: Json): boolean {
  if (typeof input.conversation_id === "string" || Array.isArray(input.workspace_roots))
    return true;
  // Cursor's subagent events, even when stripped of the common fields.
  if (typeof input.parent_conversation_id === "string" || typeof input.subagent_id === "string")
    return true;
  return typeof input.hook_event_name === "string" && input.hook_event_name in CURSOR_EVENTS;
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
  if (env.NOWALL_HOOK_DEBUG === "1") debugDump(name, agent, input, now);
  // A Cursor chat reaching us through Claude's hooks: Cursor's own hooks carry this event.
  if (agent !== "cursor" && isCursorPayload(input)) return "";
  // Cursor blocks a subagent when its subagentStart hook answers with anything but valid JSON,
  // so that event is allowed no matter what happens inside (untrusted repo, I/O error, …).
  const fallback = agent === "cursor" && name === "subagent-start" ? ALLOW_SUBAGENT : "";
  try {
    return dispatch(name, agent, input, env, now) || fallback;
  } catch (err) {
    if (fallback) return fallback;
    throw err;
  }
}

function dispatch(name: string, agent: AgentId, input: Json, env: NodeJS.ProcessEnv, now: Date) {
  const cwd = hookCwd(input, env);
  // Frequent hooks run on every tool call or turn: no git process on that path.
  const root = trustedRoot(cwd, !HOT.has(name));
  if (!root) return "";
  const sid = hookSid(input, env, loadSession(root)?.sid);
  const account = accountFromEnv(agent, env);
  const rel = (p: string) => (isAbsolute(p) ? relative(root, realish(p)) : p);
  // Cursor hooks answer in Cursor's own output shapes; Claude's prompt hook would treat any
  // stdout as extra context, so it must stay silent.
  const cursor = agent === "cursor";
  // A Cursor subagent is its own conversation: find the chat that spawned it, if any.
  const link = cursor ? linkCursorChild(sid, root, name, now) : undefined;
  const parentSid = link?.parentSid;
  // Claude runs hooks inside subagents under the parent's session_id, tagged with agent_id.
  const childId = !cursor ? cleanId(input.agent_id) : "";
  const ts = now.toISOString();
  const status = (patch: Omit<Parameters<typeof updateStatus>[2], "agent">) =>
    updateStatus(
      sid,
      root,
      {
        agent,
        ...(account !== agent ? { account } : {}),
        ...(parentSid ? { parentSid } : {}),
        ...patch,
      },
      now,
    );
  // A child's hook also keeps its parent fresh: the parent never looks stale while a child works.
  const touch = (detail?: string) => {
    if (link) touchParent(link.parentSid, link.childId, detail, now);
  };
  // Claude: a tool event from inside a subagent refreshes that child and reads "↳ …" on the card.
  const seen = (): { children?: ChildStatus[] } => {
    if (!childId) return {};
    const children = liveChildren(readStatus(sid)?.children, now);
    const child = children.find((c) => c.id === childId);
    if (!child) return {};
    child.seenAt = ts;
    return { children };
  };
  const mark = (detail: string) => (childId ? `↳ ${detail}` : detail);

  switch (name) {
    case "session-start":
      // Synchronous on purpose: the base must predate the agent's first edit, or that work would
      // look like it was already there. Fast thanks to the persistent snapshot index.
      // A subagent's conversation never takes over session.json from the chat that spawned it.
      if (!env.NOWALL_SID && !parentSid) ensureExternalSession(root, sid, agent, now);
      status({ phase: "idle", detail: "Session started" });
      touch();
      if (cursor) return JSON.stringify({ additional_context: JOURNAL_RULE });
      return JSON.stringify({
        hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: JOURNAL_RULE },
      });

    case "prompt": {
      const prompt = typeof input.prompt === "string" ? input.prompt : "";
      if (prompt.trim() && !prompt.trim().startsWith("/")) {
        if (!isDuplicatePrompt(root, sid, prompt, now))
          appendJournal(root, { ts, sid, agent, kind: "goal", text: prompt });
        status({ phase: "working", detail: prompt, turnEnded: false });
        touch(prompt);
      }
      return cursor ? JSON.stringify({ continue: true }) : "";
    }

    case "post-tool": {
      clearCooldownIfWorking(account, now);
      // Cursor's afterShellExecution carries the command at the top level, afterFileEdit the file.
      const tool = String(
        input.tool_name ??
          (input.file_path ? "Edit" : typeof input.command === "string" ? "shell" : ""),
      );
      const ti = (input.tool_input ?? {}) as Json;
      const file = [ti.file_path, ti.path, ti.notebook_path, input.file_path].find(
        (v): v is string => typeof v === "string",
      );
      if (EDIT_TOOLS.test(tool) || (file && !SHELL_TOOLS.test(tool))) {
        const f = file ? rel(file) : undefined;
        appendJournal(root, { ts, sid, agent, kind: "edit", text: tool, files: f ? [f] : [] });
        const detail = describeTool(tool, f);
        status({ phase: "working", detail: mark(detail), ...seen() });
        touch(detail);
      } else if (SHELL_TOOLS.test(tool)) {
        const cmd = ti.command ?? input.command;
        const text = Array.isArray(cmd) ? cmd.join(" ") : String(cmd ?? "");
        if (text) appendJournal(root, { ts, sid, agent, kind: "cmd", text: text.slice(0, 120) });
        const detail = describeTool(tool, undefined, text);
        status({ phase: "working", detail: mark(detail), ...seen() });
        touch(detail);
      }
      return "";
    }

    case "notification": {
      // Claude asks for permission or is waiting on the user.
      const message = typeof input.message === "string" ? input.message : "Needs your input";
      status({ phase: "needs-input", detail: mark(message), ...seen() });
      touch(message);
      return "";
    }

    case "stop": {
      // Claude's Stop is main-agent only; a copy tagged with agent_id belongs to SubagentStop.
      if (childId) return "";
      // Cursor's stop hook says how the turn ended; Claude's just fires.
      const outcome = typeof input.status === "string" ? input.status : "completed";
      const detail =
        outcome === "error"
          ? "Stopped with an error"
          : outcome === "aborted"
            ? "Stopped by you"
            : "Finished its turn";
      if (link) {
        // A Cursor subagent's turn ended: its parent is one child closer to done.
        status({ phase: "your-turn", detail });
        finishChild(link.parentSid, { id: link.childId }, now);
        return "";
      }
      const children = liveChildren(readStatus(sid)?.children, now);
      if (children.length) {
        // The chat delegated and its own turn ended: keep the dots going until the children finish.
        status({
          phase: "working",
          turnEnded: true,
          children,
          detail: describeChildren(children, true),
        });
      } else {
        status({ phase: "your-turn", detail, turnEnded: true });
      }
      return "";
    }

    case "subagent-start": {
      const id = cleanId(cursor ? input.subagent_id : input.agent_id);
      if (!id) return cursor ? ALLOW_SUBAGENT : "";
      const type = str(cursor ? input.subagent_type : input.agent_type) || undefined;
      const parent = cursor ? sidFromId(cleanId(input.parent_conversation_id)) || sid : sid;
      if (cursor) {
        // Remember the child so its own conversation can be tied back to this chat.
        const map = readChildrenMap();
        map[id] = { parentSid: parent, repo: root, startedAt: ts, ...(type ? { type } : {}) };
        writeChildrenMap(map);
      }
      const prev = readStatus(parent);
      const children = liveChildren(prev?.children, now).filter((c) => c.id !== id);
      children.push({ id, startedAt: ts, ...(type ? { type } : {}) });
      updateStatus(
        parent,
        root,
        {
          agent: prev?.agent ?? agent,
          ...(!prev && account !== agent ? { account } : {}),
          phase: "working",
          turnEnded: false,
          children,
          detail: describeChildren(children),
        },
        now,
      );
      return cursor ? ALLOW_SUBAGENT : "";
    }

    case "subagent-stop": {
      if (cursor) {
        // The documented payload has no subagent_id; the transcript path ends in the child's id.
        const id = cleanId(input.subagent_id) || idFromTranscript(input.agent_transcript_path);
        const type = str(input.subagent_type) || undefined;
        const map = readChildrenMap();
        const parent =
          sidFromId(cleanId(input.parent_conversation_id)) ||
          (id && map[id]?.parentSid) ||
          parentSid ||
          sid;
        finishChild(parent, { id, type }, now);
        if (id && map[id]) {
          delete map[id];
          writeChildrenMap(map);
        }
        return "{}";
      }
      // Claude's internal helper agents also fire SubagentStop, with an empty agent_type and an
      // agent_id we never saw start: finishChild leaves the count alone for those.
      const type = str(input.agent_type) || undefined;
      if (!childId && !type) return "";
      finishChild(sid, { id: childId, type }, now);
      return "";
    }

    case "session-end":
      if (link) {
        status({ phase: "ended", detail: "Session closed" });
        finishChild(link.parentSid, { id: link.childId }, now);
        return "";
      }
      status({ phase: "ended", detail: "Session closed", children: [] });
      forgetChildrenOf(sid);
      return "";

    case "stop-failure": {
      const transcript = typeof input.transcript_path === "string" ? input.transcript_path : "";
      const hit: LimitHit = lastLimitFromTranscript(transcript, now) ?? {
        kind: "quota",
        window: "unknown",
        message: "usage limit reached",
      };
      saveState(recordLimit(loadState(), account, hit, now, loadConfig().defaultCooldownMinutes));
      appendJournal(root, { ts, sid, agent, kind: "limit", text: hit.message });
      status({ phase: "handing-off", detail: hit.message });

      if (env.NOWALL_SID) {
        // Supervised by `nowall run`: tell the wrapper, which stops the agent and hands off.
        const signal: LimitSignal = {
          agent,
          account,
          sid,
          window: hit.window,
          message: hit.message,
          observedAt: now.toISOString(),
        };
        if (hit.resetsAt) signal.resetsAt = hit.resetsAt;
        writeJson(signalPath(root, sid), signal);
      } else if (loadConfig().takeover !== "off" && !isLocked(root)) {
        ensureExternalSession(root, sid, agent, now);
        launchTakeover(root, sid, account, env);
      }
      return "";
    }
    default:
      return "";
  }
}

// ---- Subagents -------------------------------------------------------------------------------
//
// Claude Code runs hooks inside a subagent with the parent's session_id plus agent_id, so its
// events already land on the parent. A Cursor subagent is a separate conversation with its own
// id; subagentStart (fired for the parent) records subagent_id → parent in children.json and the
// child's first hook looks itself up there. The parent's phase stays "working" while any child is
// running, even after its own turn ended, and becomes "your-turn" when the last child finishes.

interface ChildLinkResult {
  parentSid: string;
  childId: string;
}

/**
 * Ties a Cursor conversation to the chat that spawned it, or undefined for a top-level chat.
 * Matches the conversation id against recorded subagent_ids; a child whose id differs (unverified
 * either way) adopts the newest unmatched child started in this repo within the last 5 s, but
 * only at its sessionStart so an established chat can never be re-labelled.
 */
function linkCursorChild(
  sid: string,
  root: string,
  name: string,
  now: Date,
): ChildLinkResult | undefined {
  const map = readChildrenMap();
  const raw = sid.slice(2);
  const prev = readStatus(sid);
  if (prev?.parentSid) {
    const known = map[raw] ? raw : Object.entries(map).find(([, l]) => l.sid === sid)?.[0];
    return { parentSid: prev.parentSid, childId: known ?? raw };
  }
  const direct = map[raw];
  if (direct) {
    if (direct.sid !== sid) {
      direct.sid = sid;
      writeChildrenMap(map);
    }
    return { parentSid: direct.parentSid, childId: raw };
  }
  if (name !== "session-start") return undefined;
  const candidates = Object.entries(map)
    .filter(([, l]) => {
      if (l.sid || l.repo !== root) return false;
      const age = now.getTime() - Date.parse(l.startedAt);
      return age >= -1000 && age <= CHILD_LINK_WINDOW_MS;
    })
    .sort(([, a], [, b]) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  const adopted = candidates[0];
  if (!adopted) return undefined;
  adopted[1].sid = sid;
  writeChildrenMap(map);
  return { parentSid: adopted[1].parentSid, childId: adopted[0] };
}

/** A child's hook refreshes its parent: `updatedAt`, the child's `seenAt`, and the card's detail. */
function touchParent(parentSid: string, childId: string, detail: string | undefined, now: Date) {
  const prev = readStatus(parentSid);
  if (!prev) return;
  const children = liveChildren(prev.children, now);
  for (const c of children) if (c.id === childId) c.seenAt = now.toISOString();
  updateStatus(
    parentSid,
    prev.repo,
    { agent: prev.agent, children, ...(detail ? { detail: `↳ ${detail}` } : {}) },
    now,
  );
}

/**
 * Removes one child from its parent: by id, else the oldest of the same type. An unknown child
 * (Claude's internal helper agents, a type we never saw) changes nothing. When the last child
 * goes and the parent's turn had already ended, the parent becomes "your-turn".
 */
function finishChild(parentSid: string, child: { id?: string; type?: string }, now: Date): void {
  const prev = readStatus(parentSid);
  if (!prev) return;
  const children = liveChildren(prev.children, now);
  let idx = child.id ? children.findIndex((c) => c.id === child.id) : -1;
  if (idx < 0 && child.type) idx = children.findIndex((c) => c.type === child.type);
  if (idx < 0) return;
  children.splice(idx, 1);
  const patch: Parameters<typeof updateStatus>[2] = { agent: prev.agent, children };
  if (children.length) patch.detail = describeChildren(children, prev.turnEnded);
  else if (prev.turnEnded) {
    patch.phase = "your-turn";
    patch.detail = "Finished its turn";
  }
  updateStatus(parentSid, prev.repo, patch, now);
}

/** Drops the children.json links of a chat that closed. */
function forgetChildrenOf(parentSid: string): void {
  const map = readChildrenMap();
  const rest = Object.fromEntries(Object.entries(map).filter(([, l]) => l.parentSid !== parentSid));
  if (Object.keys(rest).length !== Object.keys(map).length) writeChildrenMap(rest);
}

/** Cursor writes a subagent's transcript as `<parent>/subagents/<child conversation id>.jsonl`. */
function idFromTranscript(path: unknown): string {
  if (typeof path !== "string" || !/[\\/]subagents[\\/]/.test(path)) return "";
  return cleanId(basename(path).replace(/\.[A-Za-z0-9]+$/, ""));
}

/** True when the same prompt was journaled for this sid moments ago (Cursor can submit twice). */
function isDuplicatePrompt(root: string, sid: string, prompt: string, now: Date): boolean {
  const raw = readTail(journalPath(root), 64 * 1024);
  if (!raw) return false;
  const text = redact(prompt).replace(/\s+/g, " ").trim().slice(0, 200);
  const lines = raw.trimEnd().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const j = JSON.parse(lines[i] ?? "") as {
        sid?: string;
        kind?: string;
        text?: string;
        ts?: string;
      };
      if (j.sid !== sid || j.kind !== "goal") continue;
      const age = now.getTime() - Date.parse(j.ts ?? "");
      return j.text === text && age >= 0 && age <= PROMPT_DEDUPE_MS;
    } catch {
      // torn line
    }
  }
  return false;
}

// ---- Debug ----------------------------------------------------------------------------------

/** Payload fields that carry bodies (prompt text, outputs): kept out of the dump. */
const DEBUG_OMIT = new Set([
  "prompt",
  "summary",
  "output",
  "last_assistant_message",
  "tool_response",
  "task",
  "edits",
]);

function clipDeep(v: unknown): unknown {
  if (typeof v === "string") return v.length > 300 ? `${v.slice(0, 300)}…` : v;
  if (Array.isArray(v)) return v.slice(0, 50).map(clipDeep);
  if (v && typeof v === "object")
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clipDeep(x)]));
  return v;
}

/**
 * NOWALL_HOOK_DEBUG=1: appends every hook payload (redacted, bodies omitted, never the env) to
 * ~/.config/nowall/debug/hooks.jsonl so new agent events can be studied. Starts over past 2 MB.
 */
function debugDump(name: string, agent: AgentId, input: Json, now: Date): void {
  try {
    const path = join(configDir(), "debug", "hooks.jsonl");
    try {
      if (statSync(path).size > DEBUG_MAX_BYTES) rmSync(path, { force: true });
    } catch {
      // no file yet
    }
    const slim: Json = {};
    for (const [k, v] of Object.entries(input)) {
      slim[k] = DEBUG_OMIT.has(k)
        ? `[omitted ${JSON.stringify(v)?.length ?? 0} chars]`
        : clipDeep(v);
    }
    const line = { ts: now.toISOString(), name, agent, input: redactDeep(slim) };
    appendSafe(path, `${JSON.stringify(line)}\n`, Number.POSITIVE_INFINITY);
  } catch {
    // debugging must never affect the hook
  }
}

/**
 * A tool call only completes after the model answered, so the account isn't limited right now:
 * drop any cooldown we recorded (e.g. the user raised their spend limit or bought more usage).
 */
export function clearCooldownIfWorking(account: AccountId, now: Date): void {
  const state = loadState();
  const s = state.agents[account];
  if (!s?.cooldownUntil || Date.parse(s.cooldownUntil) <= now.getTime()) return;
  state.agents[account] = { ...s, cooldownUntil: now.toISOString() };
  saveState(state);
}

function takeoverArgs(cli: string, sid: string, from: AccountId): string[] {
  return [cli, "takeover", "--sid", sid, "--from", from];
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
  from: AccountId,
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
      spawn(process.execPath, takeoverArgs(cli, sid, from), {
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
    NOWALL_TAKEOVER_FROM: from,
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
