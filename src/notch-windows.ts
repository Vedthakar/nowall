import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join, win32 } from "node:path";
import { writeAtomic } from "./fsafe.js";
import { spawn, spawnSync } from "./proc.js";

/**
 * The Windows counterpart of the macOS notch: a tray app in notch/windows/NowallTray.cs.
 *
 * It's compiled here, on the user's machine, by the C# compiler in every Windows 10 and 11. So the
 * npm package carries only its source, there's no toolchain to install and nothing to code-sign.
 * The exe lands in <nowall home>\notch\, whose parent tells it which home to read. Starting at login
 * is one value under HKCU's Run key, named like the launchd label so a sandboxed NOWALL_HOME can
 * never touch the user's real tray.
 */

const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const EXE = /^NowallTray-[0-9a-f]{8}\.exe$/;

export interface TrayPaths {
  /** notch/windows/NowallTray.cs in the installed package. */
  source: string;
  /** The nowall home it reads. */
  home: string;
  node: string;
  cli: string;
  /** Registry value name: the notch's label. */
  label: string;
}

export function trayDir(home: string): string {
  return join(home, "notch");
}

/** Named after its source: a new version gets a new file, even while the old one is running. */
export function trayExeName(source: string): string {
  const hash = createHash("sha1").update(source).digest("hex").slice(0, 8);
  return `NowallTray-${hash}.exe`;
}

/** Every Windows 10 and 11 has one of these, as part of .NET Framework 4. */
export function findCsc(
  env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = existsSync,
): string | null {
  const windir = env.WINDIR ?? env.SystemRoot ?? "C:\\Windows";
  const candidates = ["Framework64", "Framework"].map((f) =>
    win32.join(windir, "Microsoft.NET", f, "v4.0.30319", "csc.exe"),
  );
  return candidates.find(exists) ?? null;
}

export function cscArgs(out: string, source: string): string[] {
  return [
    "/nologo",
    "/target:winexe",
    "/optimize+",
    `/out:${out}`,
    "/r:System.Drawing.dll",
    "/r:System.Windows.Forms.dll",
    "/r:System.Web.Extensions.dll",
    source,
  ];
}

/** The login item's value: the exe alone, since its folder says everything else. */
export function runValue(exe: string): string {
  return `"${exe}"`;
}

/** The value out of `reg query`'s output, or null when it isn't there. */
export function parseRegQuery(output: string, name: string): string | null {
  for (const line of output.split(/\r?\n/)) {
    const m = /^\s+(\S+)\s+REG_SZ\s+(.*?)\s*$/.exec(line);
    if (m && m[1]?.toLowerCase() === name.toLowerCase()) return m[2] ?? "";
  }
  return null;
}

/** The exe path out of a login item's value. */
export function exeFromRunValue(value: string): string {
  return value.replace(/^"([^"]*)".*$/, "$1");
}

/** Built exes for this home. Older versions stay until uninstall, so all of them are asked to quit. */
function builtExes(home: string): string[] {
  const dir = trayDir(home);
  try {
    return readdirSync(dir)
      .filter((n) => EXE.test(n))
      .map((n) => join(dir, n));
  } catch {
    return [];
  }
}

export function trayLoginItem(label: string): string | null {
  const r = spawnSync("reg.exe", ["query", RUN_KEY, "/v", label], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return r.status === 0 ? parseRegQuery(r.stdout ?? "", label) : null;
}

/** The tray for `home` is running. Any built version can tell: they share one name per home. */
export function trayRunning(home: string): boolean {
  const exe = builtExes(home)[0];
  return exe ? spawnSync(exe, ["--running"], { stdio: "ignore" }).status === 0 : false;
}

function quitTray(home: string): void {
  for (const exe of builtExes(home)) spawnSync(exe, ["--quit"], { stdio: "ignore" });
}

/** Compiles the tray if this version isn't built yet. Returns the exe, or why it couldn't. */
export function buildTray(paths: TrayPaths): { exe: string } | { error: string } {
  let text: string;
  try {
    text = readFileSync(paths.source, "utf8");
  } catch {
    return { error: "its source isn't in this install of nowall" };
  }
  const exe = join(trayDir(paths.home), trayExeName(text));
  if (existsSync(exe)) return { exe };
  const csc = findCsc();
  if (!csc) return { error: ".NET Framework's C# compiler (csc.exe) wasn't found" };
  mkdirSync(dirname(exe), { recursive: true });
  const tmp = `${exe}.${process.pid}.tmp.exe`;
  const r = spawnSync(csc, cscArgs(tmp, paths.source), {
    encoding: "utf8",
    timeout: 120_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.status !== 0 || !existsSync(tmp)) {
    rmSync(tmp, { force: true });
    const why = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().split(/\r?\n/)[0];
    return { error: why || r.error?.message || `csc exited with ${r.status}` };
  }
  renameSync(tmp, exe);
  return { exe };
}

/** Quits whatever is running, builds this version, adds the login item, and starts it. */
export function startTray(paths: TrayPaths): string {
  const fallback = "`nowall status` and `nowall logs -f` still show what's happening.";
  quitTray(paths.home);
  const built = buildTray(paths);
  if ("error" in built) {
    return `The nowall tray app couldn't be built: ${built.error}. Failover works the same without it, and ${fallback}`;
  }
  writeAtomic(join(dirname(built.exe), "launch.txt"), `${paths.node}\n${paths.cli}\n`);

  const reg = spawnSync(
    "reg.exe",
    ["add", RUN_KEY, "/v", paths.label, "/t", "REG_SZ", "/d", runValue(built.exe), "/f"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const child = spawn(built.exe, [], { detached: true, stdio: "ignore" });
  child.on("error", () => {
    // reported below: it never shows up as running
  });
  child.unref();

  const deadline = Date.now() + 8000;
  const nap = new Int32Array(new SharedArrayBuffer(4));
  let running = trayRunning(paths.home);
  while (!running && Date.now() < deadline) {
    Atomics.wait(nap, 0, 0, 200);
    running = trayRunning(paths.home);
  }
  if (!running) {
    return `The nowall tray app failed to start. Run \`nowall notch\` to try again; ${fallback}`;
  }
  return reg.status === 0
    ? "nowall is in your system tray (click ^ by the clock if it's hidden) and starts at login."
    : `nowall is in your system tray now, but it couldn't be added to startup (${(reg.stderr ?? "").trim()}). Run \`nowall notch\` to try again.`;
}

/** Quits the tray for `home` and removes its login item. Leaves the built exe for `nowall notch on`. */
export function stopTray(home: string, label: string): void {
  spawnSync("reg.exe", ["delete", RUN_KEY, "/v", label, "/f"], { stdio: "ignore" });
  quitTray(home);
}

/** Uninstall: the exe is generated, not the user's data, so it goes even when the data stays. */
export function removeTrayFiles(home: string): void {
  rmSync(trayDir(home), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

export function trayStatusLines(home: string, label: string): string[] {
  const item = trayLoginItem(label);
  const exes = builtExes(home);
  const exe = item ? exeFromRunValue(item) : exes[0];
  return [
    `App:         ${exe ?? "not built yet (run nowall notch)"}`,
    `Label:       ${label}`,
    `Login item:  ${item ? `${RUN_KEY}\\${label}` : "not installed"}`,
    `Reads from:  ${home}`,
    `Running:     ${trayRunning(home) ? "yes" : "no"}`,
  ];
}
