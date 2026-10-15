#!/usr/bin/env node
// Simulates Claude Code / Codex / Cursor for end-to-end tests without burning real usage.
// Usage: fake-agent.mjs <agent-name> [agent args...]
// A turn may also set `auth: "<message>"` to simulate an expired or missing login.
// Behaviour comes from the JSON plan at $FAKE_PLAN: { "<agent>": [turn, turn, ...] }, where a turn is
//   { prompt?, files?: {path: content}, notes?: [["--task","x"],...], tasks?: {...}, text?, limit?: "message", sleepMs? }
// Every invocation is logged to $FAKE_PLAN.calls.jsonl so tests can assert on prompts and flags.
import { execSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const [name, ...args] = process.argv.slice(2);
const planPath = process.env.FAKE_PLAN;
const plan = JSON.parse(readFileSync(planPath, "utf8"));
const counter = `${planPath}.${name}.count`;
const n = existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0;
writeFileSync(counter, String(n + 1));
const turn = plan[name]?.[n] ?? { text: "Nothing left to do." };
appendFileSync(`${planPath}.calls.jsonl`, `${JSON.stringify({ name, n, args })}\n`);

const cwd = process.cwd();
const headless = args.includes("-p") || args[0] === "exec";
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

/** Runs the hook command that `nowall init` installed for `event`, exactly as Claude would. */
function fireClaudeHook(event, payload) {
  // Like Claude Code: user settings (~/.claude/settings.json) plus the project's local settings.
  const groups = [
    join(process.env.HOME ?? "", ".claude/settings.json"),
    join(cwd, ".claude/settings.local.json"),
  ]
    .filter((f) => existsSync(f))
    .flatMap((f) => JSON.parse(readFileSync(f, "utf8")).hooks?.[event] ?? []);
  for (const group of groups) {
    for (const h of group.hooks ?? []) {
      spawnSync("sh", ["-c", h.command], {
        input: JSON.stringify({ hook_event_name: event, cwd, session_id: "fake", ...payload }),
        env: process.env,
      });
    }
  }
}

function nowallNote(noteArgs) {
  execSync(`${process.env.FAKE_NOWALL} note ${noteArgs.map((a) => JSON.stringify(a)).join(" ")}`, {
    cwd,
    env: process.env,
  });
}

function doWork() {
  for (const [file, content] of Object.entries(turn.files ?? {})) {
    mkdirSync(dirname(join(cwd, file)), { recursive: true });
    writeFileSync(join(cwd, file), content);
    if (!headless)
      fireClaudeHook("PostToolUse", {
        tool_name: "Write",
        tool_input: { file_path: join(cwd, file) },
      });
  }
  for (const note of turn.notes ?? []) nowallNote(note);
  if (turn.tasks) writeFileSync(join(cwd, ".handoff/tasks.json"), JSON.stringify(turn.tasks));
}

if (!headless) {
  // Interactive Claude Code.
  fireClaudeHook("SessionStart", { source: "startup" });
  if (turn.prompt) fireClaudeHook("UserPromptSubmit", { prompt: turn.prompt });
  doWork();
  if (!turn.limit) process.exit(0);
  const transcript = join(cwd, ".handoff", `fake-transcript-${n}.jsonl`);
  writeFileSync(
    transcript,
    `${JSON.stringify({
      type: "assistant",
      isApiErrorMessage: true,
      error: "rate_limit",
      message: { content: [{ type: "text", text: turn.limit }] },
    })}\n`,
  );
  fireClaudeHook("StopFailure", { transcript_path: transcript, error: "rate_limit" });
  // Real Claude now waits for the reset; nowall must terminate us.
  process.on("SIGTERM", () => process.exit(143));
  setInterval(() => {}, 1000);
} else if (turn.auth) {
  // Expired / missing login, in each agent's real shape.
  if (name === "codex") {
    out({ type: "turn.failed", error: { message: turn.auth } });
    process.exit(1);
  }
  if (name === "cursor") {
    process.stderr.write(`Error: ${turn.auth}\n`);
    process.exit(1);
  }
  out({
    type: "result",
    subtype: "success",
    is_error: true,
    result: turn.auth,
    terminal_reason: "api_error",
  });
  process.exit(1);
} else if (name === "codex") {
  out({ type: "thread.started", thread_id: `codex-thread-${n}` });
  out({ type: "turn.started" });
  doWork();
  if (turn.text) out({ type: "item.completed", item: { type: "agent_message", text: turn.text } });
  const changes = Object.keys(turn.files ?? {}).map((path) => ({ path, kind: "add" }));
  if (changes.length) out({ type: "item.completed", item: { type: "file_change", changes } });
  if (turn.limit) {
    out({ type: "error", message: turn.limit });
    out({ type: "turn.failed", error: { message: turn.limit } });
    process.exit(1);
  }
  out({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
} else {
  // Claude-style stream-json (Claude Code -p, Cursor CLI).
  const sid = `${name}-session-${n}`;
  out({ type: "system", subtype: "init", session_id: sid });
  doWork();
  if (turn.sleepMs) {
    if (turn.text)
      out({
        type: "assistant",
        message: { content: [{ type: "text", text: turn.text }] },
        session_id: sid,
      });
    await new Promise((r) => setTimeout(r, turn.sleepMs));
  }
  const content = [];
  if (turn.text) content.push({ type: "text", text: turn.text });
  for (const f of Object.keys(turn.files ?? {}))
    content.push({ type: "tool_use", name: "Write", input: { file_path: f } });
  if (content.length) out({ type: "assistant", message: { content }, session_id: sid });
  // Mirrors the real bug: limit errors come back as subtype "success" + is_error, exit 0.
  out({
    type: "result",
    subtype: "success",
    is_error: Boolean(turn.limit),
    result: turn.limit ?? turn.text ?? "",
    session_id: sid,
  });
}
