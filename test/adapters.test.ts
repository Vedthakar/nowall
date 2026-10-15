import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { lastLimitFromTranscript } from "../src/adapters/claude.js";
import { parseCodexLine } from "../src/adapters/codex.js";
import { parseStreamJson } from "../src/adapters/common.js";
import { ADAPTERS } from "../src/adapters/index.js";
import type { Runner } from "../src/adapters/types.js";

const NOW = new Date("2026-10-15T18:00:00Z");
const j = (o: unknown) => JSON.stringify(o);

describe("parseStreamJson (Claude-style)", () => {
  it("init, text, tool_use and result", () => {
    expect(parseStreamJson(j({ type: "system", subtype: "init", session_id: "abc" }))).toEqual([
      { kind: "session", id: "abc" },
    ]);
    const a = parseStreamJson(
      j({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Adding the route." },
            { type: "tool_use", name: "Edit", input: { file_path: "src/a.ts" } },
            { type: "tool_use", name: "Bash", input: { command: "npm test" } },
          ],
        },
      }),
    );
    expect(a).toEqual([
      { kind: "text", text: "Adding the route." },
      { kind: "tool", name: "Edit", files: ["src/a.ts"] },
      { kind: "tool", name: "Bash", detail: "npm test" },
    ]);
  });

  it("treats is_error results as errors even when subtype is success (#79500)", () => {
    const ev = parseStreamJson(
      j({
        type: "result",
        subtype: "success",
        is_error: true,
        result: "API Error: Rate limit reached",
        session_id: "s",
      }),
    );
    expect(ev).toContainEqual({
      kind: "done",
      isError: true,
      text: "API Error: Rate limit reached",
    });
  });

  it("parses Cursor tool_call events", () => {
    const ev = parseStreamJson(
      j({
        type: "tool_call",
        subtype: "started",
        tool_call: { writeToolCall: { args: { path: "x.ts" } } },
      }),
    );
    expect(ev).toEqual([{ kind: "tool", name: "writeToolCall", files: ["x.ts"] }]);
  });

  it("parses error events and tolerates non-JSON", () => {
    expect(parseStreamJson(j({ type: "error", error: { message: "boom" } }))).toEqual([
      { kind: "error", text: "boom" },
    ]);
    expect(parseStreamJson("plain text")).toEqual([{ kind: "text", text: "plain text" }]);
    expect(parseStreamJson("")).toEqual([]);
  });
});

describe("parseCodexLine", () => {
  it("maps codex exec --json events", () => {
    expect(parseCodexLine(j({ type: "thread.started", thread_id: "t1" }))).toEqual([
      { kind: "session", id: "t1" },
    ]);
    expect(
      parseCodexLine(j({ type: "item.completed", item: { type: "agent_message", text: "hi" } })),
    ).toEqual([{ kind: "text", text: "hi" }]);
    expect(
      parseCodexLine(
        j({
          type: "item.completed",
          item: { type: "file_change", changes: [{ path: "a.ts", kind: "add" }] },
        }),
      ),
    ).toEqual([{ kind: "tool", name: "edit", files: ["a.ts"] }]);
    expect(parseCodexLine(j({ type: "turn.completed", usage: {} }))).toEqual([
      { kind: "done", isError: false },
    ]);
  });

  it("surfaces usage-limit failures as error + failed done", () => {
    const ev = parseCodexLine(
      j({
        type: "turn.failed",
        error: { message: "You've hit your usage limit. Try again in 2 hours." },
      }),
    );
    expect(ev[0]).toMatchObject({ kind: "error" });
    expect(ev[1]).toEqual({ kind: "done", isError: true });
    const hit = ADAPTERS.codex.detectLimit((ev[0] as { text: string }).text, NOW);
    expect(hit).toMatchObject({ kind: "quota", resetsAt: "2026-10-15T20:00:00.000Z" });
  });
});

describe("headless args", () => {
  it("claude: edits-only by default, bypass only with yolo", () => {
    const safe = ADAPTERS.claude.headless({ prompt: "p", yolo: false }).args;
    expect(safe).toContain("acceptEdits");
    expect(safe).not.toContain("--dangerously-skip-permissions");
    expect(ADAPTERS.claude.headless({ prompt: "p", yolo: true, resumeId: "r" }).args).toEqual(
      expect.arrayContaining(["--dangerously-skip-permissions", "--resume", "r"]),
    );
  });

  it("codex: sandboxed by default, resume subcommand", () => {
    expect(ADAPTERS.codex.headless({ prompt: "p", yolo: false }).args).toEqual(
      expect.arrayContaining(["exec", "--json", "--sandbox", "workspace-write", "p"]),
    );
    expect(
      ADAPTERS.codex.headless({ prompt: "p", yolo: false, resumeId: "t" }).args.slice(0, 3),
    ).toEqual(["exec", "resume", "t"]);
  });

  it("cursor: --force only with yolo", () => {
    expect(ADAPTERS.cursor.headless({ prompt: "p", yolo: false }).args).not.toContain("--force");
    expect(ADAPTERS.cursor.headless({ prompt: "p", yolo: true }).args).toContain("--force");
  });
});

describe("detect", () => {
  const runner =
    (map: Record<string, { code: number; stdout: string }>): Runner =>
    async (cmd, args) => ({
      ...(map[[cmd, ...args].join(" ")] ?? { code: 127, stdout: "" }),
      stderr: "",
    });

  it("cursor reads isAuthenticated from status json", async () => {
    const run = runner({
      "/bin/cursor-agent --version": { code: 0, stdout: "2026.07.09-a3815c0\n" },
      "/bin/cursor-agent status --format json": { code: 0, stdout: j({ isAuthenticated: true }) },
    });
    expect(await ADAPTERS.cursor.detect(run, "/bin/cursor-agent")).toEqual({
      installed: true,
      version: "2026.07.09-a3815c0",
      signedIn: true,
    });
  });

  it("codex uses login status exit code; missing binary is not installed", async () => {
    const run = runner({
      "/bin/codex --version": { code: 0, stdout: "codex-cli 0.160.0" },
      "/bin/codex login status": { code: 1, stdout: "" },
    });
    expect((await ADAPTERS.codex.detect(run, "/bin/codex")).signedIn).toBe(false);
    expect((await ADAPTERS.claude.detect(run, "/bin/claude")).installed).toBe(false);
  });
});

describe("lastLimitFromTranscript", () => {
  it("reads message and quotaLimits.resetsAt from a synthetic transcript", () => {
    const dir = mkdtempSync(join(tmpdir(), "nowall-tr-"));
    const path = join(dir, "t.jsonl");
    writeFileSync(
      path,
      [
        j({ type: "user", message: { content: "lorem ipsum" } }),
        j({
          type: "assistant",
          isApiErrorMessage: true,
          error: "rate_limit",
          message: {
            content: [
              {
                type: "text",
                text: "You've hit your session limit · resets 5:20pm (America/Toronto)",
              },
            ],
          },
          quotaLimits: { status: "rejected", resetsAt: 1760563200, rateLimitType: "five_hour" },
        }),
      ].join("\n"),
    );
    const hit = lastLimitFromTranscript(path, NOW);
    expect(hit).toMatchObject({ kind: "quota", window: "session" });
    expect(hit?.resetsAt).toBe(new Date(1760563200 * 1000).toISOString());
  });

  it("returns null for missing files or no errors", () => {
    expect(lastLimitFromTranscript("/nonexistent", NOW)).toBeNull();
  });
});

describe("installHooks", () => {
  it("merges into existing settings, preserves user hooks, and is idempotent", () => {
    const root = mkdtempSync(join(tmpdir(), "nowall-hooks-"));
    const file = join(root, ".claude", "settings.local.json");
    ADAPTERS.claude.installHooks?.(root, "nowall");
    const user = JSON.parse(readFileSync(file, "utf8"));
    user.permissions = { allow: ["Bash(ls)"] };
    user.hooks.PostToolUse.push({
      matcher: "Bash",
      hooks: [{ type: "command", command: "my-linter" }],
    });
    writeFileSync(file, j(user));

    ADAPTERS.claude.installHooks?.(root, "nowall");
    const after = JSON.parse(readFileSync(file, "utf8"));
    expect(after.permissions).toEqual({ allow: ["Bash(ls)"] });
    expect(JSON.stringify(after.hooks.PostToolUse)).toContain("my-linter");
    expect(after.hooks.StopFailure).toEqual([
      {
        matcher: "rate_limit",
        hooks: [
          {
            type: "command",
            command: "NOWALL_HOOK=1 nowall hook stop-failure --agent claude",
            timeout: 30,
          },
        ],
      },
    ]);
    const nowallGroups = after.hooks.PostToolUse.filter((g: unknown) =>
      JSON.stringify(g).includes("nowall hook"),
    );
    expect(nowallGroups).toHaveLength(1);
  });
});
