import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  changedFiles,
  checkpoint,
  excludeLocally,
  listCheckpoints,
  restore,
  snapshotTree,
} from "../src/git.js";
import {
  appendJournal,
  readJournal,
  readTasks,
  remainingTasks,
  tasksPath,
} from "../src/session.js";
import { sh, tempRepo } from "./helpers.js";

describe("checkpoints", () => {
  it("snapshots tracked + untracked files without touching index, HEAD or branch", () => {
    const repo = tempRepo();
    writeFileSync(join(repo, "README.md"), "# changed\n");
    writeFileSync(join(repo, "new.ts"), "export const x = 1;\n");
    sh(repo, "git", ["add", "README.md"]);
    const before = {
      head: sh(repo, "git", ["rev-parse", "HEAD"]),
      branch: sh(repo, "git", ["branch", "--show-current"]),
      status: sh(repo, "git", ["status", "--porcelain"]),
    };

    const cp = checkpoint(repo, "s_test", 1, "nowall: checkpoint");

    expect(sh(repo, "git", ["rev-parse", "HEAD"])).toBe(before.head);
    expect(sh(repo, "git", ["branch", "--show-current"])).toBe(before.branch);
    expect(sh(repo, "git", ["status", "--porcelain"])).toBe(before.status);
    expect(sh(repo, "git", ["show", `${cp.commit}:new.ts`])).toContain("export const x");
    expect(sh(repo, "git", ["show", `${cp.commit}:README.md`])).toBe("# changed");
    expect(listCheckpoints(repo, "s_test").map((c) => c.ref)).toEqual(["refs/nowall/s_test/1"]);
  });

  it("honours .gitignore (never snapshots .env)", () => {
    const repo = tempRepo();
    writeFileSync(join(repo, ".gitignore"), ".env\n");
    writeFileSync(join(repo, ".env"), "SECRET=nope\n");
    const cp = checkpoint(repo, "s_t", 1, "m");
    expect(() => sh(repo, "git", ["show", `${cp.commit}:.env`])).toThrow();
  });

  it("excludes .handoff from snapshots", () => {
    const repo = tempRepo();
    appendJournal(repo, { sid: "s", agent: "claude", kind: "goal", text: "x" });
    const cp = checkpoint(repo, "s", 1, "m");
    expect(() => sh(repo, "git", ["show", `${cp.commit}:.handoff/journal.jsonl`])).toThrow();
  });

  it("tree hash changes only when content changes", () => {
    const repo = tempRepo();
    const a = snapshotTree(repo);
    expect(snapshotTree(repo)).toBe(a);
    writeFileSync(join(repo, "f.txt"), "1");
    expect(snapshotTree(repo)).not.toBe(a);
  });

  it("works in a repo with no commits", () => {
    const repo = tempRepo();
    sh(repo, "git", ["update-ref", "-d", "HEAD"]);
    const cp = checkpoint(repo, "s", 0, "m");
    expect(cp.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it("restore brings files back to a checkpoint", () => {
    const repo = tempRepo();
    const base = checkpoint(repo, "s", 0, "base");
    writeFileSync(join(repo, "README.md"), "# broken by agent\n");
    const after = checkpoint(repo, "s", 1, "after");
    expect(changedFiles(repo, base.commit, after.commit)).toEqual(["README.md"]);
    restore(repo, base.commit);
    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("# demo\n");
  });

  it("excludeLocally is idempotent and leaves .gitignore alone", () => {
    const repo = tempRepo();
    excludeLocally(repo, ".handoff/");
    excludeLocally(repo, ".handoff/");
    const ex = readFileSync(join(repo, ".git/info/exclude"), "utf8");
    expect(ex.split("\n").filter((l) => l === ".handoff/")).toHaveLength(1);
  });
});

describe("journal", () => {
  it("appends redacted, capped lines and filters by session", () => {
    const repo = tempRepo();
    const token = `gh${"p_"}${"a1B2c3D4e5".repeat(4)}`;
    appendJournal(repo, { sid: "s1", agent: "claude", kind: "cmd", text: `curl -H "x: ${token}"` });
    appendJournal(repo, { sid: "s1", agent: "claude", kind: "goal", text: "y".repeat(500) });
    appendJournal(repo, {
      sid: "s2",
      agent: "codex",
      kind: "edit",
      text: "edit",
      files: ["a.ts", "a.ts"],
    });
    const raw = readFileSync(join(repo, ".handoff/journal.jsonl"), "utf8");
    expect(raw).not.toContain(token);
    const s1 = readJournal(repo, "s1");
    expect(s1).toHaveLength(2);
    expect(s1[1]?.text).toHaveLength(200);
    expect(readJournal(repo, "s2")[0]?.files).toEqual(["a.ts"]);
  });

  it("tolerates torn lines", () => {
    const repo = tempRepo();
    appendJournal(repo, { sid: "s", agent: "claude", kind: "goal", text: "ok" });
    writeFileSync(
      join(repo, ".handoff/journal.jsonl"),
      `${readFileSync(join(repo, ".handoff/journal.jsonl"), "utf8")}{"v":1,"ts`,
    );
    expect(readJournal(repo)).toHaveLength(1);
  });
});

describe("tasks", () => {
  it("reads valid task lists and counts remaining", () => {
    const repo = tempRepo();
    expect(readTasks(repo)).toBeNull();
    appendJournal(repo, { sid: "s", agent: "claude", kind: "goal", text: "mkdir" });
    writeFileSync(
      tasksPath(repo),
      JSON.stringify({
        v: 1,
        updatedAt: "x",
        updatedBy: "codex",
        tasks: [
          { id: "1", title: "a", status: "done" },
          { id: "2", title: "b", status: "todo" },
        ],
      }),
    );
    expect(remainingTasks(readTasks(repo))).toBe(1);
  });

  it("rejects malformed task lists", () => {
    const repo = tempRepo();
    appendJournal(repo, { sid: "s", agent: "claude", kind: "goal", text: "mkdir" });
    writeFileSync(tasksPath(repo), JSON.stringify({ tasks: [{ title: "a", status: "maybe" }] }));
    expect(readTasks(repo)).toBeNull();
  });
});
