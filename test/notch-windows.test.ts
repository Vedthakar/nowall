import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  cscArgs,
  exeFromRunValue,
  findCsc,
  parseRegQuery,
  runValue,
  trayExeName,
} from "../src/notch-windows.js";
import { startNotch } from "../src/setup.js";

// The tray app's Node side as pure logic, so it's checked on every OS. The app itself runs on a real
// Windows machine in CI: see scripts/windows-tray-smoke.mjs.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = readFileSync(join(ROOT, "notch", "windows", "NowallTray.cs"), "utf8");

describe("the tray app's source", () => {
  it("ships in the npm package", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    expect(pkg.files).toContain("notch/windows/NowallTray.cs");
  });

  it("is ASCII, so no code page can change what the compiler reads", () => {
    expect(/[^\t\n\r -~]/.test(SOURCE)).toBe(false);
  });

  it("never starts a shell, and only ever runs node with the nowall CLI", () => {
    expect(SOURCE).toContain("UseShellExecute = false");
    expect(SOURCE).not.toContain("UseShellExecute = true");
    expect(SOURCE).not.toMatch(/cmd\.exe|powershell/i);
    expect(SOURCE.match(/new ProcessStartInfo\(/g)).toHaveLength(1);
    expect(SOURCE).toContain("new ProcessStartInfo(Node)");
  });

  it("only talks to this computer", () => {
    expect(SOURCE).not.toMatch(/System\.Net|HttpClient|WebClient|Socket|https?:\/\//);
  });
});

describe("building it", () => {
  it("finds the compiler that ships with Windows, 64-bit first", () => {
    const has =
      (...found: string[]) =>
      (p: string) =>
        found.includes(p);
    const x64 = "C:\\W\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
    const x86 = "C:\\W\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe";
    expect(findCsc({ WINDIR: "C:\\W" }, has(x86, x64))).toBe(x64);
    expect(findCsc({ WINDIR: "C:\\W" }, has(x86))).toBe(x86);
    expect(findCsc({ SystemRoot: "C:\\W" }, has(x64))).toBe(x64);
    expect(findCsc({ WINDIR: "C:\\W" }, has())).toBeNull();
  });

  it("makes a windowed exe, with each path as one argument", () => {
    const args = cscArgs("C:\\my home\\t.exe", "C:\\a b\\NowallTray.cs");
    expect(args).toContain("/target:winexe");
    expect(args).toContain("/out:C:\\my home\\t.exe");
    expect(args.at(-1)).toBe("C:\\a b\\NowallTray.cs");
  });

  it("names the exe after its source, so a new version never fights the running one", () => {
    expect(trayExeName("one")).toMatch(/^NowallTray-[0-9a-f]{8}\.exe$/);
    expect(trayExeName("one")).toBe(trayExeName("one"));
    expect(trayExeName("two")).not.toBe(trayExeName("one"));
  });
});

describe("the startup entry", () => {
  const OUTPUT = `\r
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\r
    OneDrive    REG_SZ    "C:\\Program Files\\OneDrive.exe" /background\r
    dev.nowall.notch    REG_SZ    "C:\\Users\\my name\\.config\\nowall\\notch\\NowallTray-abcd1234.exe"\r
\r
`;

  it("reads our value and no other", () => {
    expect(parseRegQuery(OUTPUT, "dev.nowall.notch")).toBe(
      '"C:\\Users\\my name\\.config\\nowall\\notch\\NowallTray-abcd1234.exe"',
    );
    expect(parseRegQuery(OUTPUT, "dev.nowall.notch.1234")).toBeNull();
    expect(parseRegQuery("", "dev.nowall.notch")).toBeNull();
  });

  it("round-trips a path with spaces", () => {
    const exe = "C:\\Users\\my name\\.config\\nowall\\notch\\NowallTray-abcd1234.exe";
    expect(exeFromRunValue(runValue(exe))).toBe(exe);
  });
});

describe("on a test run", () => {
  it("never starts anything, so a test can't touch the user's tray", () => {
    expect(process.env.NOWALL_NO_LAUNCHD).toBe("1");
    expect(startNotch()).toMatch(/skipped/);
  });
});
