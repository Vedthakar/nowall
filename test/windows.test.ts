import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  hookCommand,
  isOurs,
  nowallInvocation,
  statusLineCommand,
  unwrapStatusLine,
} from "../src/adapters/common.js";
import { readSmall, renameRetry } from "../src/fsafe.js";
import { findOnWindowsPath, gitBash, npmShimTarget, windowsLaunch } from "../src/proc.js";
import { cancelPath } from "../src/session.js";
import { fitPrompt, watchCancelFile } from "../src/supervisor.js";
import { sendCancel } from "../src/switch.js";
import { wrappedStatusCommand } from "../src/uninstall.js";

// Windows behaviour as pure logic, so it is checked on every OS. The real thing runs on a Windows
// machine in CI: see scripts/windows-smoke.mjs.

const NPM_SHIM = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0
IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)
endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*
`;

describe("finding programs", () => {
  const files = new Set([
    "C:\\npm\\codex",
    "C:\\npm\\codex.ps1",
    "C:\\npm\\codex.cmd",
    "C:\\tools\\git.exe",
    "C:\\only\\script.ps1",
  ]);
  const exists = (p: string) => files.has(p);
  const find = (n: string) =>
    findOnWindowsPath(n, 'C:\\tools;"C:\\npm";C:\\only', ".COM;.EXE;.BAT;.CMD;.PS1", exists);

  it("picks what can be spawned, not npm's sh script or .ps1 next to it", () => {
    expect(find("codex")).toBe("C:\\npm\\codex.cmd");
    expect(find("git")).toBe("C:\\tools\\git.exe");
  });
  it("never picks a .ps1, even when PATHEXT lists it", () => {
    expect(find("script")).toBeNull();
  });
  it("accepts a full path and an explicit extension", () => {
    expect(find("C:\\npm\\codex.cmd")).toBe("C:\\npm\\codex.cmd");
    expect(find("codex.cmd")).toBe("C:\\npm\\codex.cmd");
  });
});

describe("starting programs", () => {
  const shimDeps = {
    find: () => "C:\\npm\\codex.cmd",
    read: () => NPM_SHIM,
    exists: () => true,
    node: "C:\\node\\node.exe",
    comspec: "cmd.exe",
  };
  const script = "C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js";

  it("reads the script out of a real npm shim", () => {
    expect(npmShimTarget("C:\\npm\\codex.cmd", NPM_SHIM)).toBe(script);
    expect(npmShimTarget("C:\\b\\x.cmd", '@node "%~dp0\\x.mjs" %*')).toBe("C:\\b\\x.mjs");
    expect(npmShimTarget("C:\\b\\x.cmd", "@echo hi")).toBeNull();
  });

  it("gives a prompt to the agent byte for byte, with no cmd.exe in between", () => {
    const hostile = 'line one\nline two & del /q * | "quoted" %PATH% ^caret';
    const launch = windowsLaunch("codex", ["exec", hostile], shimDeps);
    expect(launch).toEqual({ file: "C:\\node\\node.exe", args: [script, "exec", hostile] });
  });

  it("runs an .exe directly", () => {
    const launch = windowsLaunch("git", ["status"], { find: () => "C:\\g\\git.exe" });
    expect(launch).toEqual({ file: "C:\\g\\git.exe", args: ["status"] });
  });

  it("leaves a missing program for spawn to report", () => {
    expect(windowsLaunch("nope", ["x"], { find: () => null })).toEqual({
      file: "nope",
      args: ["x"],
    });
  });

  it("neuters everything cmd.exe would act on when a batch file can't be read through", () => {
    const launch = windowsLaunch("tool", ["a & calc", "%PATH%", "two\nlines"], {
      find: () => "C:\\Program Files\\tool.cmd",
      read: () => "@echo custom batch file",
      comspec: "cmd.exe",
    });
    expect(launch.verbatim).toBe(true);
    expect(launch.file).toBe("cmd.exe");
    expect(launch.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    const line = launch.args[3] as string;
    expect(line.startsWith('"C:\\Program^ Files\\tool.cmd ')).toBe(true);
    expect(line).toContain("a^^^ ^^^&^^^ calc");
    expect(line).toContain("^^^%PATH^^^%");
    expect(line).not.toMatch(/[\r\n]/);
    expect(line).toContain("two^^^ lines");
  });

  it("finds Git Bash for a user's status line", () => {
    const bash = "C:\\Program Files\\Git\\bin\\bash.exe";
    expect(gitBash({ ProgramFiles: "C:\\Program Files" }, (p) => p === bash)).toBe(bash);
    expect(gitBash({ CLAUDE_CODE_GIT_BASH_PATH: "D:\\b.exe" }, (p) => p === "D:\\b.exe")).toBe(
      "D:\\b.exe",
    );
    expect(gitBash({}, () => false)).toBeNull();
  });
});

describe("hook commands", () => {
  it("avoid sh-only syntax, and can still be found again", () => {
    const line = hookCommand("nowall.cmd", "hook prompt --agent claude", true);
    expect(line).toBe("nowall.cmd hook prompt --agent claude NOWALL_HOOK=1");
    expect(line.startsWith("NOWALL_HOOK")).toBe(false);
    expect(isOurs({ command: line })).toBe(true);
  });

  it("stay exactly as they were on macOS and Linux", () => {
    expect(hookCommand("nowall", "hook stop --agent codex", false)).toBe(
      "NOWALL_HOOK=1 nowall hook stop --agent codex",
    );
    expect(nowallInvocation(true, () => "/x/cli.js", "/n/node", false)).toBe("nowall");
    expect(nowallInvocation(false, () => "/x y/cli.js", "/n/node", false)).toBe(
      "'/n/node' '/x y/cli.js'",
    );
  });

  it("call the .cmd shim, or bare node with a quoted forward-slash path", () => {
    const script = () => "C:\\Users\\A B\\nowall\\dist\\cli.js";
    expect(nowallInvocation(true, script, "x", true)).toBe("nowall.cmd");
    expect(nowallInvocation(false, script, "x", true)).toBe(
      'node "C:/Users/A B/nowall/dist/cli.js"',
    );
  });

  it("carry the user's status line through every shell and give it back on uninstall", () => {
    const mine = `bash -c 'echo "$(whoami)" & echo 100%' | cut -d' ' -f1`;
    const line = statusLineCommand("nowall.cmd", mine, true);
    expect(line).not.toMatch(/['"&|%$]/);
    expect(isOurs({ command: line })).toBe(true);
    expect(unwrapStatusLine(line)).toBe(mine);
    expect(wrappedStatusCommand(line)).toBe(mine);
    expect(wrappedStatusCommand(statusLineCommand("nowall.cmd", undefined, true))).toBeNull();
  });
});

describe("prompts on the command line", () => {
  const dir = () => {
    const root = mkdtempSync(join(tmpdir(), "nowall-win-"));
    return { root, done: () => rmSync(root, { recursive: true, force: true }) };
  };

  it("pass through untouched when they fit", () => {
    const { root, done } = dir();
    expect(fitPrompt(root, "s1", "short\nprompt", false)).toBe("short\nprompt");
    expect(existsSync(join(root, ".handoff", "prompt-s1.md"))).toBe(false);
    done();
  });

  it("go in a file when too long for Windows, or when cmd.exe would mangle them", () => {
    const { root, done } = dir();
    const long = "x".repeat(40_000);
    const told = fitPrompt(root, "s1", long, false);
    expect(told).toContain(".handoff/prompt-s1.md");
    expect(told.length).toBeLessThan(200);
    expect(readFileSync(join(root, ".handoff", "prompt-s1.md"), "utf8")).toBe(long);

    expect(fitPrompt(root, "s2", "a\nb & calc", true)).not.toContain("calc");
    expect(readFileSync(join(root, ".handoff", "prompt-s2.md"), "utf8")).toBe("a\nb & calc");
    done();
  });
});

describe("nowall cancel without signals", () => {
  it("reaches the takeover through a file and becomes its normal SIGINT", async () => {
    const root = mkdtempSync(join(tmpdir(), "nowall-win-"));
    let got = 0;
    const onInt = () => {
      got += 1;
    };
    process.on("SIGINT", onInt);
    const timer = watchCancelFile(root, 10);
    try {
      sendCancel(12345, root, true);
      expect(existsSync(cancelPath(root))).toBe(true);
      for (let i = 0; i < 100 && got === 0; i++) await new Promise((r) => setTimeout(r, 10));
      expect(got).toBe(1);
      expect(existsSync(cancelPath(root))).toBe(false);
    } finally {
      clearInterval(timer);
      process.off("SIGINT", onInt);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ignores a request left over from an earlier takeover", async () => {
    const root = mkdtempSync(join(tmpdir(), "nowall-win-"));
    sendCancel(1, root, true);
    let got = 0;
    const onInt = () => {
      got += 1;
    };
    process.on("SIGINT", onInt);
    const timer = watchCancelFile(root, 5);
    await new Promise((r) => setTimeout(r, 40));
    clearInterval(timer);
    process.off("SIGINT", onInt);
    expect(got).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("files", () => {
  it("rename gives up with the real error when the source is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "nowall-win-"));
    expect(() => renameRetry(join(root, "nope"), join(root, "x"))).toThrow(/ENOENT/);
    rmSync(root, { recursive: true, force: true });
  });

  it.skipIf(process.platform === "win32")("reads refuse a planted symlink", () => {
    const root = mkdtempSync(join(tmpdir(), "nowall-win-"));
    writeFileSync(join(root, "secret"), "s");
    symlinkSync(join(root, "secret"), join(root, "link"));
    expect(readSmall(join(root, "link"))).toBeNull();
    rmSync(root, { recursive: true, force: true });
  });
});
