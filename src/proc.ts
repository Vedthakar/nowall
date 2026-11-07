import * as cp from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { win32 } from "node:path";

/**
 * Every child process nowall starts goes through here, so Windows behaves in one place:
 * - agents installed by npm are `.cmd` shims, which Node refuses to spawn directly. We run the script
 *   behind the shim with our own Node, so a handoff prompt never passes through cmd.exe, where
 *   repo-controlled text could run as commands and a newline would cut the prompt short.
 * - a background takeover has no console, so without `windowsHide` every git call flashes a window.
 *   A child that shares our terminal must keep its console, so it is never hidden.
 * - there are no signals: stopping means ending the whole process tree, or the agent outlives it.
 * On macOS and Linux all of this is the plain node:child_process call.
 */

export const isWindows = process.platform === "win32";

const RUNNABLE = [".exe", ".cmd", ".bat", ".com"];

/** Extensions Windows can start without a shell helper, in PATHEXT order. Never `.ps1`. */
function runnableExts(pathext: string): string[] {
  const listed = pathext
    .split(";")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => RUNNABLE.includes(e));
  return listed.length ? listed : RUNNABLE;
}

/**
 * Finds a program the way cmd.exe would, except it skips what can't be spawned: npm also drops an
 * extensionless `sh` script and a `.ps1` next to each `.cmd`.
 */
export function findOnWindowsPath(
  name: string,
  pathVar = process.env.PATH ?? "",
  pathext = process.env.PATHEXT ?? "",
  exists: (p: string) => boolean = existsSync,
): string | null {
  const exts = runnableExts(pathext);
  const hasExt = RUNNABLE.includes(win32.extname(name).toLowerCase());
  const named = hasExt ? [name] : exts.map((e) => `${name}${e}`);
  const dirs = /[\\/]/.test(name)
    ? [""]
    : pathVar
        .split(";")
        .map((d) => d.trim().replace(/^"(.*)"$/, "$1"))
        .filter(Boolean);
  for (const dir of new Set(dirs)) {
    for (const file of named) {
      const candidate = dir ? win32.join(dir, file) : file;
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

/** What an npm `.cmd` shim runs: the script or program it forwards `%*` to, as an absolute path. */
export function npmShimTarget(shimPath: string, text: string): string | null {
  const m = /"%~?dp0%?\\?([^"%]+)"\s+%\*/.exec(text);
  if (!m?.[1]) return null;
  return win32.join(win32.dirname(shimPath), m[1]);
}

const CMD_META = /([()[\]%!^"`<>&|;, *?])/g;

/** Quotes one argument for `cmd /s /c`, twice over: once for cmd, once for the batch file's `%*`. */
function cmdArg(arg: string): string {
  const quoted = `"${arg
    .replace(/[\r\n]+/g, " ") // cmd ends the command at a newline, whatever the quoting
    .replace(/(\\*)"/g, '$1$1\\"')
    .replace(/(\\+)$/, "$1$1")}"`;
  return quoted.replace(CMD_META, "^^^$1");
}

export interface Launch {
  file: string;
  args: string[];
  /** Arguments are already quoted for cmd.exe. */
  verbatim?: boolean;
}

export interface LaunchDeps {
  find?: (name: string) => string | null;
  read?: (path: string) => string;
  exists?: (path: string) => boolean;
  node?: string;
  comspec?: string;
}

/** How to really start `bin` on Windows. A missing program comes back as is, for spawn to report. */
export function windowsLaunch(bin: string, args: string[], deps: LaunchDeps = {}): Launch {
  const find = deps.find ?? ((n: string) => findOnWindowsPath(n));
  const read = deps.read ?? ((p: string) => readFileSync(p, "utf8"));
  const exists = deps.exists ?? existsSync;
  const resolved = find(bin);
  if (!resolved) return { file: bin, args };
  if (!/\.(cmd|bat)$/i.test(resolved)) return { file: resolved, args };
  let shim = "";
  try {
    shim = read(resolved);
  } catch {
    // unreadable: cmd.exe below reports it
  }
  const target = npmShimTarget(resolved, shim);
  if (target && exists(target)) {
    if (/\.(exe|com)$/i.test(target)) return { file: target, args };
    if (/\bnode(\.exe)?\b/i.test(shim)) {
      return { file: deps.node ?? process.execPath, args: [target, ...args] };
    }
  }
  const line = [resolved.replace(CMD_META, "^$1"), ...args.map(cmdArg)].join(" ");
  return {
    file: deps.comspec ?? process.env.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/c", `"${line}"`],
    verbatim: true,
  };
}

/** True when this program can only be started through cmd.exe, which can't carry a real prompt. */
export function needsCmdExe(bin: string, deps: LaunchDeps = {}): boolean {
  return windowsLaunch(bin, [], deps).verbatim === true;
}

type WithStdio = { stdio?: cp.StdioOptions | undefined; shell?: boolean | string | undefined };

function prepare<O extends WithStdio>(
  cmd: string,
  args: readonly string[],
  options: O | undefined,
): [string, string[], O & { windowsHide?: boolean; windowsVerbatimArguments?: boolean }] {
  if (!isWindows) return [cmd, [...args], { ...(options as O) }];
  const stdio = options?.stdio;
  const sharesTerminal = stdio === "inherit" || (Array.isArray(stdio) && stdio.includes("inherit"));
  const opts = { windowsHide: !sharesTerminal, ...(options as O) };
  if (options?.shell) return [cmd, [...args], opts];
  const launch = windowsLaunch(cmd, [...args]);
  return [
    launch.file,
    launch.args,
    launch.verbatim ? { ...opts, windowsVerbatimArguments: true } : opts,
  ];
}

export function spawn(
  cmd: string,
  args: readonly string[] = [],
  options: cp.SpawnOptions = {},
): cp.ChildProcess {
  const [file, argv, opts] = prepare(cmd, args, options);
  return cp.spawn(file, argv, opts);
}

export function spawnSync(
  cmd: string,
  args: readonly string[],
  options: cp.SpawnSyncOptionsWithStringEncoding,
): cp.SpawnSyncReturns<string>;
export function spawnSync(
  cmd: string,
  args?: readonly string[],
  options?: cp.SpawnSyncOptions,
): cp.SpawnSyncReturns<Buffer>;
export function spawnSync(
  cmd: string,
  args: readonly string[] = [],
  options: cp.SpawnSyncOptions = {},
): cp.SpawnSyncReturns<string | Buffer> {
  const [file, argv, opts] = prepare(cmd, args, options);
  return cp.spawnSync(file, argv, opts);
}

export function execFileSync(
  cmd: string,
  args: readonly string[],
  options: cp.ExecFileSyncOptionsWithStringEncoding,
): string;
export function execFileSync(
  cmd: string,
  args: readonly string[],
  options?: cp.ExecFileSyncOptions,
): Buffer;
export function execFileSync(
  cmd: string,
  args: readonly string[],
  options: cp.ExecFileSyncOptions = {},
): string | Buffer {
  const [file, argv, opts] = prepare(cmd, args, options);
  return cp.execFileSync(file, argv, opts);
}

export function execFile(
  cmd: string,
  args: readonly string[],
  options: cp.ExecFileOptionsWithStringEncoding,
  callback: (err: cp.ExecFileException | null, stdout: string, stderr: string) => void,
): cp.ChildProcess {
  const [file, argv, opts] = prepare(cmd, args, options);
  return cp.execFile(file, argv, opts, callback);
}

/**
 * Asks a child to stop. On Windows nothing can be asked, so this ends the child and everything it
 * started: killing only the top process would leave the real agent running and editing files.
 */
export function stopChild(child: cp.ChildProcess, force = false): void {
  if (!isWindows) {
    child.kill(force ? "SIGKILL" : "SIGTERM");
    return;
  }
  if (child.pid === undefined) return;
  cp.spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
    stdio: "ignore",
    windowsHide: true,
  });
}

/** A process's full command line, or "" when it can't be read. */
export function commandLineOf(pid: number): string {
  if (!isWindows) {
    const r = cp.spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
    return r.stdout ?? "";
  }
  const r = cp.spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${Math.trunc(pid)}").CommandLine`,
    ],
    { encoding: "utf8", windowsHide: true, timeout: 15_000 },
  );
  return r.stdout ?? "";
}

/** Git for Windows' bash, which is what Claude Code runs a user's status line with. */
export function gitBash(
  env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = existsSync,
): string | null {
  const candidates = [
    env.CLAUDE_CODE_GIT_BASH_PATH,
    env.ProgramFiles && win32.join(env.ProgramFiles, "Git", "bin", "bash.exe"),
    env["ProgramFiles(x86)"] && win32.join(env["ProgramFiles(x86)"], "Git", "bin", "bash.exe"),
  ];
  return candidates.find((c): c is string => Boolean(c && exists(c))) ?? null;
}
