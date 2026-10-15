import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkpoint } from "../src/git.js";
import { buildPacket, journalHints } from "../src/packet.js";
import { MASTER_PROMPT_VERSION, continuePrompt, masterPrompt } from "../src/prompt.js";
import { appendJournal, tasksPath } from "../src/session.js";
import { tempRepo } from "./helpers.js";

const NOW = new Date("2026-10-15T18:00:00Z");

describe("journalHints", () => {
  it("latest task status wins and remaining excludes done", () => {
    const base = { v: 1 as const, ts: "", sid: "s", agent: "claude" as const };
    const h = journalHints(
      [
        { ...base, kind: "goal", text: "build login page" },
        { ...base, kind: "task", text: "form", status: "todo" },
        { ...base, kind: "task", text: "form", status: "done" },
        { ...base, kind: "task", text: "tests", status: "todo" },
        { ...base, kind: "decision", text: "use zod" },
      ],
      null,
    );
    expect(h).toEqual({
      goal: ["build login page"],
      decisions: ["use zod"],
      claimedDone: ["form"],
      remaining: ["tests"],
    });
  });
});

describe("buildPacket + masterPrompt", () => {
  it("combines journal and git, redacts, and renders a prompt", () => {
    const repo = tempRepo();
    const base = checkpoint(repo, "s1", 0, "base");
    const secret = `sk-ant-${"Zq9".repeat(10)}`;
    appendJournal(repo, {
      sid: "s1",
      agent: "claude",
      kind: "goal",
      text: "add a /health endpoint",
    });
    appendJournal(repo, {
      sid: "s1",
      agent: "claude",
      kind: "task",
      text: "route added",
      status: "done",
    });
    appendJournal(repo, {
      sid: "s1",
      agent: "claude",
      kind: "task",
      text: "write tests",
      status: "todo",
    });
    appendJournal(repo, { sid: "other", agent: "codex", kind: "goal", text: "unrelated" });
    writeFileSync(join(repo, "server.ts"), `// key ${secret}\nexport const health = () => "ok";\n`);
    const cp = checkpoint(repo, "s1", 1, "handoff");

    const p = buildPacket({
      root: repo,
      sid: "s1",
      baseCommit: base.commit,
      checkpoint: cp,
      from: "claude",
      to: "codex",
      limit: {
        kind: "quota",
        window: "session",
        message: "You've hit your session limit · resets 5pm",
        resetsAt: "2026-10-15T21:00:00.000Z",
      },
      now: NOW,
    });

    expect(p.goal).toEqual(["add a /health endpoint"]);
    expect(p.claimedDone).toEqual(["route added"]);
    expect(p.remaining).toEqual(["write tests"]);
    expect(p.filesTouched).toContain("server.ts");
    expect(p.git.diffStat).toContain("server.ts");
    expect(p.from.resetsAt).toBe("2026-10-15T21:00:00.000Z");
    expect(JSON.stringify(p)).not.toContain(secret);

    const prompt = masterPrompt(p);
    expect(prompt).toContain(`version="${MASTER_PROMPT_VERSION}"`);
    expect(prompt).toContain(`git diff ${base.commit}`);
    expect(prompt).toContain("Claude Code was working on it");
    expect(prompt).toContain('"updatedBy":"codex"');
    expect(prompt).toContain("nowall note --task");
  });

  it("reconciles the existing tasks.json into hints", () => {
    const repo = tempRepo();
    appendJournal(repo, { sid: "s", agent: "claude", kind: "goal", text: "g" });
    writeFileSync(
      tasksPath(repo),
      JSON.stringify({
        v: 1,
        updatedAt: "",
        updatedBy: "codex",
        tasks: [
          { id: "1", title: "a", status: "done" },
          { id: "2", title: "b", status: "todo" },
        ],
      }),
    );
    const base = checkpoint(repo, "s", 0, "b");
    const p = buildPacket({
      root: repo,
      sid: "s",
      baseCommit: base.commit,
      checkpoint: base,
      from: "codex",
      to: "cursor",
      limit: { kind: "quota", window: "unknown", message: "m" },
      now: NOW,
    });
    expect(p.claimedDone).toContain("a");
    expect(p.remaining).toEqual(["b"]);
  });
});

describe("continuePrompt", () => {
  it("lists remaining tasks or asks for the task list", () => {
    expect(continuePrompt(null)).toContain("tasks.json");
    const c = continuePrompt({
      v: 1,
      updatedAt: "",
      updatedBy: "",
      tasks: [
        { id: "2", title: "tests", status: "todo" },
        { id: "1", title: "x", status: "done" },
      ],
    });
    expect(c).toContain("[2] tests");
    expect(c).not.toContain("[1] x");
  });
});
