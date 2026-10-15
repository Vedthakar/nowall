import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { handleHook } from "../src/hooks.js";
import { installAlias, stripBlock } from "../src/init.js";
import { readJournal, signalPath } from "../src/session.js";
import { loadState } from "../src/state.js";
import { tempRepo } from "./helpers.js";

const NOW = new Date("2026-10-15T18:00:00Z");

beforeEach(() => {
  process.env.NOWALL_HOME = mkdtempSync(join(tmpdir(), "nowall-home-"));
});

function initRepo(): string {
  const repo = tempRepo();
  mkdirSync(join(repo, ".handoff"));
  return repo;
}

describe("handleHook", () => {
  it("does nothing in repos without nowall", () => {
    const repo = tempRepo();
    expect(handleHook("prompt", "claude", { cwd: repo, prompt: "hi" }, {}, NOW)).toBe("");
    expect(readJournal(repo)).toEqual([]);
  });

  it("journals prompts (not slash commands), edits relative to root, and commands", () => {
    const repo = initRepo();
    const env = { NOWALL_SID: "s1" };
    handleHook("prompt", "claude", { cwd: repo, prompt: "build the thing" }, env, NOW);
    handleHook("prompt", "claude", { cwd: repo, prompt: "/usage" }, env, NOW);
    handleHook(
      "post-tool",
      "claude",
      { cwd: repo, tool_name: "Edit", tool_input: { file_path: join(repo, "src/a.ts") } },
      env,
      NOW,
    );
    handleHook(
      "post-tool",
      "codex",
      { cwd: repo, tool_name: "shell", tool_input: { command: ["npm", "test"] } },
      env,
      NOW,
    );
    handleHook("post-tool", "cursor", { cwd: repo, file_path: join(repo, "b.ts") }, env, NOW);
    const j = readJournal(repo, "s1");
    expect(j.map((l) => [l.kind, l.text, l.files])).toEqual([
      ["goal", "build the thing", undefined],
      ["edit", "Edit", ["src/a.ts"]],
      ["cmd", "npm test", undefined],
      ["edit", "Edit", ["b.ts"]],
    ]);
  });

  it("session-start injects the journal rule as context", () => {
    const repo = initRepo();
    const out = JSON.parse(handleHook("session-start", "claude", { cwd: repo }, {}, NOW));
    expect(out.hookSpecificOutput.additionalContext).toContain("nowall note --task");
  });

  it("stop-failure records cooldown and writes the signal only under the wrapper", () => {
    const repo = initRepo();
    const transcript = join(repo, ".handoff", "t.jsonl");
    writeFileSync(
      transcript,
      `${JSON.stringify({
        isApiErrorMessage: true,
        error: "rate_limit",
        message: {
          content: [
            {
              type: "text",
              text: "You've hit your weekly limit · resets Mon 12:00am (America/Toronto)",
            },
          ],
        },
      })}\n`,
    );
    handleHook("stop-failure", "claude", { cwd: repo, transcript_path: transcript }, {}, NOW);
    expect(loadState().agents.claude?.cooldownUntil).toBe("2026-10-19T04:00:00.000Z");

    handleHook(
      "stop-failure",
      "claude",
      { cwd: repo, transcript_path: transcript },
      { NOWALL_SID: "s9" },
      NOW,
    );
    const signal = JSON.parse(readFileSync(signalPath(repo, "s9"), "utf8"));
    expect(signal).toMatchObject({
      agent: "claude",
      window: "weekly",
      resetsAt: "2026-10-19T04:00:00.000Z",
    });
  });

  it("stop-failure without a readable transcript still signals with a default", () => {
    const repo = initRepo();
    handleHook("stop-failure", "claude", { cwd: repo }, { NOWALL_SID: "s2" }, NOW);
    expect(JSON.parse(readFileSync(signalPath(repo, "s2"), "utf8")).window).toBe("unknown");
  });
});

describe("shell alias block", () => {
  it("installs once, preserves the rest of the rc file, and strips cleanly", () => {
    const rc = join(mkdtempSync(join(tmpdir(), "nowall-rc-")), ".zshrc");
    writeFileSync(rc, "export FOO=1");
    installAlias(rc);
    installAlias(rc);
    const text = readFileSync(rc, "utf8");
    expect(text.match(/>>> nowall >>>/g)).toHaveLength(1);
    expect(text).toContain('claude() { command nowall run claude -- "$@"; }');
    expect(stripBlock(text)).toBe("export FOO=1\n");
  });
});
