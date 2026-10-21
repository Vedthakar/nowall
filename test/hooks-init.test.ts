import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { ADAPTERS, resolveBinary } from "../src/adapters/index.js";
import { sanitizeTerminal } from "../src/fsafe.js";
import { handleHook, hookSid, launchTakeover, trustedRoot } from "../src/hooks.js";
import { installAlias, stripBlock } from "../src/init.js";
import { DEFAULT_CONFIG } from "../src/schemas.js";
import {
  appendJournal,
  handoffProblem,
  loadSession,
  readJournal,
  signalPath,
} from "../src/session.js";
import { loadState, saveConfig, saveState, trustRepo } from "../src/state.js";
import { sh, tempRepo } from "./helpers.js";

const NOW = new Date("2026-10-15T18:00:00Z");

beforeEach(() => {
  process.env.NOWALL_HOME = mkdtempSync(join(tmpdir(), "nowall-home-"));
  saveConfig({ ...DEFAULT_CONFIG, takeover: "off" }); // never open real Terminal windows in tests
});

function initRepo(): string {
  const repo = tempRepo();
  mkdirSync(join(repo, ".handoff"));
  trustRepo(repo);
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
    const env = { NOWALL_SID: "s_1" };
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
    const j = readJournal(repo, "s_1");
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
      { NOWALL_SID: "s_9" },
      NOW,
    );
    const signal = JSON.parse(readFileSync(signalPath(repo, "s_9"), "utf8"));
    expect(signal).toMatchObject({
      agent: "claude",
      window: "weekly",
      resetsAt: "2026-10-19T04:00:00.000Z",
    });
  });

  it("stop-failure without a readable transcript still signals with a default", () => {
    const repo = initRepo();
    handleHook("stop-failure", "claude", { cwd: repo }, { NOWALL_SID: "s_2" }, NOW);
    expect(JSON.parse(readFileSync(signalPath(repo, "s_2"), "utf8")).window).toBe("unknown");
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

describe("trust boundaries", () => {
  it("ignores hooks in repos the user never initialized", () => {
    const repo = tempRepo();
    mkdirSync(join(repo, ".handoff")); // exists, but not trusted
    handleHook("prompt", "claude", { cwd: repo, prompt: "x" }, { NOWALL_SID: "s_1" }, NOW);
    expect(readJournal(repo)).toEqual([]);
  });

  it("refuses a repo that commits .handoff/ (planted context)", () => {
    const repo = tempRepo();
    mkdirSync(join(repo, ".handoff"));
    writeFileSync(join(repo, ".handoff", "journal.jsonl"), '{"v":1}\n');
    sh(repo, "git", ["add", "-f", ".handoff"]);
    sh(repo, "git", ["commit", "-qm", "plant"]);
    trustRepo(repo);
    expect(handoffProblem(repo)).toMatch(/commits a .handoff/);
    expect(trustedRoot(repo)).toBeNull();
  });

  it("refuses a symlinked .handoff", () => {
    const repo = tempRepo();
    symlinkSync(mkdtempSync(join(tmpdir(), "elsewhere-")), join(repo, ".handoff"));
    trustRepo(repo);
    expect(handoffProblem(repo)).toMatch(/symlink/);
  });

  it("never writes through a planted symlink (journal or settings)", () => {
    const repo = initRepo();
    const victim = join(mkdtempSync(join(tmpdir(), "victim-")), "zshrc");
    writeFileSync(victim, "ORIGINAL\n");
    symlinkSync(victim, join(repo, ".handoff", "journal.jsonl"));
    expect(() =>
      appendJournal(repo, { sid: "s_1", agent: "claude", kind: "goal", text: "x" }),
    ).toThrow();
    mkdirSync(join(repo, ".claude"));
    symlinkSync(victim, join(repo, ".claude", "settings.local.json"));
    ADAPTERS.claude.installHooks?.(repo, "nowall");
    expect(readFileSync(victim, "utf8")).toBe("ORIGINAL\n");
    expect(lstatSync(join(repo, ".claude", "settings.local.json")).isSymbolicLink()).toBe(false);
  });

  it("rejects malformed session ids from the environment", () => {
    expect(hookSid({}, { NOWALL_SID: "../../etc" })).toBe("c_manual");
    expect(hookSid({ session_id: "ab$(rm -rf)cd" }, {})).toBe("c_abrm-rfcd");
  });
});

describe("desktop takeover", () => {
  it("starts a session at SessionStart and opens a safely quoted takeover script on a limit", () => {
    const repo = initRepo();
    saveConfig({ ...DEFAULT_CONFIG, takeover: "terminal" });
    handleHook("session-start", "claude", { cwd: repo, session_id: "abc-123" }, {}, NOW);
    expect(loadSession(repo)?.sid).toBe("c_abc-123");

    let opened = "";
    const script = launchTakeover(repo, "c_abc-123", "claude", {}, (s) => {
      opened = s;
    });
    expect(opened).toBe(script);
    const text = readFileSync(script as string, "utf8");
    expect(text).toContain("export NOWALL_TAKEOVER_SID='c_abc-123'");
    expect(text).toContain("export NOWALL_TAKEOVER_FROM='claude'");
    expect(text).toContain('takeover --sid "$NOWALL_TAKEOVER_SID"');
    expect(statSync(script as string).mode & 0o777).toBe(0o700);
  });

  it("quotes hostile repo paths so they can't inject shell commands", () => {
    const parent = mkdtempSync(join(tmpdir(), "nowall-q-"));
    const evil = join(parent, `it's $(touch PWNED) "x"`);
    mkdirSync(evil);
    sh(evil, "git", ["init", "-q"]);
    mkdirSync(join(evil, ".handoff"));
    saveConfig({ ...DEFAULT_CONFIG, takeover: "terminal" });
    const script = launchTakeover(evil, "c_x", "claude", {}, () => {}) as string;
    // Run only the `cd` line to prove the path survives quoting intact and nothing executes.
    const cdLine = readFileSync(script, "utf8").split("\n")[1] as string;
    const out = sh(parent, "sh", ["-c", `${cdLine.replace(" || exit 1", "")} && pwd`]);
    expect(out.endsWith(`it's $(touch PWNED) "x"`)).toBe(true);
    expect(existsSync(join(parent, "PWNED"))).toBe(false);
  });
});

describe("sanitizeTerminal", () => {
  it("strips escape sequences and control chars but keeps text and newlines", () => {
    const evil =
      "ok\x1b]0;pwned\x07 \x1b[2J\x1b[31mred\x1b[0m\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\\x07\x00\nnext\ttab";
    expect(sanitizeTerminal(evil)).toBe("ok redlink\nnext\ttab");
  });
});

describe("real-world fixes", () => {
  it("an agent that is visibly working loses its stale cooldown", () => {
    const repo = initRepo();
    saveState({
      v: 1,
      agents: {
        claude: {
          cooldownUntil: "2026-10-22T23:00:00.000Z",
          lastLimit: {
            window: "spend",
            message: "monthly spend limit",
            observedAt: "2026-10-15T10:00:00Z",
          },
        },
      },
    });
    handleHook(
      "post-tool",
      "claude",
      { cwd: repo, tool_name: "Bash", tool_input: { command: "ls" } },
      {},
      NOW,
    );
    expect(Date.parse(loadState().agents.claude?.cooldownUntil ?? "")).toBeLessThanOrEqual(
      NOW.getTime(),
    );
    expect(loadState().agents.claude?.lastLimit?.window).toBe("spend"); // history kept
  });

  it("finds agent CLIs on the shell PATH saved at setup, even from a bare background PATH", () => {
    const bin = mkdtempSync(join(tmpdir(), "nowall-localbin-"));
    writeFileSync(join(bin, "cursor-agent"), "#!/bin/sh\n", { mode: 0o755 });
    const original = process.env.PATH;
    process.env.PATH = "/usr/bin:/bin";
    try {
      expect(resolveBinary("cursor-agent")).toBeNull();
      saveConfig({ ...DEFAULT_CONFIG, takeover: "off", path: `/opt/none:${bin}` });
      expect(resolveBinary("cursor-agent")).toBe(join(bin, "cursor-agent"));
    } finally {
      process.env.PATH = original;
    }
  });
});
