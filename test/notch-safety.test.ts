import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The user's live notch runs from launchd as `dev.nowall.notch` and is found by `pkill -f`.
// Nothing a test does (directly or through the CLI) may address that label or that process.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawnSync: vi.fn(() => ({ status: 1, stdout: "", stderr: "", pid: 0, output: [] })),
  };
});
const real = await vi.importActual<typeof import("node:child_process")>("node:child_process");
const { notchLabel, notchPattern, startNotch, stopNotch, notchRunning, notchStatus } = await import(
  "../src/setup.js"
);

const ROOT = resolve(__dirname, "..");
const CLI = join(ROOT, "dist", "cli.js");
const REAL_LABEL = "dev.nowall.notch";
const mocked = vi.mocked(spawnSync);
const saved = { ...process.env };

function calls(bin: string): string[][] {
  return mocked.mock.calls.filter((c) => c[0] === bin).map((c) => (c[1] ?? []) as string[]);
}

beforeEach(() => {
  mocked.mockClear();
});
afterEach(() => {
  for (const k of ["NOWALL_HOME", "NOWALL_NO_LAUNCHD"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("notch safety", () => {
  it("the launchd label is derived from NOWALL_HOME and differs from the real one", () => {
    const temp = mkdtempSync(join(tmpdir(), "nowall-ns-"));
    expect(notchLabel(temp)).not.toBe(REAL_LABEL);
    expect(notchLabel(temp)).toMatch(/^dev\.nowall\.notch\.[0-9a-f]{8}$/);
    expect(notchLabel(temp)).toBe(notchLabel(temp)); // stable
    expect(notchLabel(`${temp}-other`)).not.toBe(notchLabel(temp));
    // The real config folder keeps the plain label, so the user's existing login item still works.
    expect(notchLabel(join(homedir(), ".config", "nowall"))).toBe(REAL_LABEL);
    // A redirected HOME (what tests do) is not the real folder: hashed label.
    const fakeHome = join(temp, "home", ".config", "nowall");
    expect(notchLabel(fakeHome)).toMatch(/^dev\.nowall\.notch\.[0-9a-f]{8}$/);

    process.env.NOWALL_HOME = temp;
    expect(notchLabel()).toBe(notchLabel(temp));
    expect(notchStatus(join(temp, "home"))).toContain(`Label:       ${notchLabel(temp)}`);
  });

  it("the pkill/pgrep pattern names this home's notch process and no other", () => {
    const home = "/Users/someone/.config/nowall";
    const pattern = notchPattern(home);
    expect(pattern).toContain("NowallNotch");
    expect(pattern).toContain("--home /Users/someone/\\.config/nowall");
    const re = new RegExp(pattern);
    const cmd = (h: string) =>
      `/x/NowallNotch.app/Contents/MacOS/NowallNotch --node /n --cli /c.js --home ${h}`;
    expect(re.test(cmd(home))).toBe(true);
    expect(re.test(cmd("/Users/someone/.config/nowall2"))).toBe(false);
    expect(re.test(cmd("/var/folders/x/nowall-j-abc/home"))).toBe(false);
    expect(re.test(cmd("/UsersXsomeoneX.config/nowall"))).toBe(false); // dots are literal
  });

  it("stopNotch/startNotch/notchRunning under NOWALL_NO_LAUNCHD never call launchctl or pkill", () => {
    const temp = mkdtempSync(join(tmpdir(), "nowall-ns-"));
    const home = join(temp, "home");
    mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
    process.env.NOWALL_HOME = join(temp, "cfg");
    process.env.NOWALL_NO_LAUNCHD = "1";
    const plist = join(home, "Library", "LaunchAgents", `${notchLabel()}.plist`);
    writeFileSync(plist, "<plist/>");

    expect(startNotch(home)).toContain("NOWALL_NO_LAUNCHD");
    expect(notchRunning()).toBe(false);
    stopNotch(home);
    expect(existsSync(plist)).toBe(false); // the plist is still cleaned up
    expect(mocked).not.toHaveBeenCalled();
    expect(calls("launchctl")).toEqual([]);
    expect(calls("pkill")).toEqual([]);
    expect(calls("pgrep")).toEqual([]);
  });

  it.skipIf(process.platform !== "darwin")(
    "stopNotch with launchd enabled only addresses the hashed label and this home's process",
    () => {
      const temp = mkdtempSync(join(tmpdir(), "nowall-ns-"));
      // A non-temporary, non-real folder (nothing is executed: spawnSync is mocked).
      const cfg = "/Users/nobody-nowall-test/.config/nowall-alt";
      process.env.NOWALL_HOME = cfg;
      process.env.NOWALL_NO_LAUNCHD = "0";
      stopNotch(join(temp, "home"));
      const bootout = calls("launchctl").find((a) => a[0] === "bootout");
      expect(bootout?.[1]).toMatch(/^gui\/\d+\/dev\.nowall\.notch\.[0-9a-f]{8}$/);
      expect(bootout?.[1]?.endsWith(`/${REAL_LABEL}`)).toBe(false);
      const pkill = calls("pkill");
      expect(pkill).toHaveLength(1);
      expect(pkill[0]?.[1]).toContain("--home /Users/nobody-nowall-test/\\.config/nowall-alt");
      // Never the bare pattern that would match every notch on the machine.
      expect(pkill[0]?.[1]).not.toBe("NowallNotch.app/Contents/MacOS/NowallNotch");
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "stopNotch with a temporary NOWALL_HOME refuses to touch launchd at all",
    () => {
      const temp = mkdtempSync(join(tmpdir(), "nowall-ns-"));
      process.env.NOWALL_HOME = join(temp, "cfg");
      process.env.NOWALL_NO_LAUNCHD = "0";
      stopNotch(join(temp, "home")); // prints "Notch left alone: …" (asserted in the CLI test below)
      expect(mocked).not.toHaveBeenCalled();
      expect(calls("launchctl")).toEqual([]);
      expect(calls("pkill")).toEqual([]);
    },
  );
});

describe("notch safety: the built CLI", () => {
  beforeAll(() => {
    real.execFileSync("npx", ["tsc", "-p", "tsconfig.build.json"], { cwd: ROOT });
  }, 60_000);

  it("uninstall --global in a sandbox leaves the real label alone", () => {
    const scratch = mkdtempSync(join(tmpdir(), "nowall-ns-cli-"));
    const bin = join(scratch, "bin");
    const home = join(scratch, "home");
    const cfg = join(scratch, "cfg");
    const log = join(scratch, "calls.log");
    mkdirSync(bin);
    mkdirSync(join(home, ".claude"), { recursive: true });
    mkdirSync(cfg);
    // Fake launchctl/pkill/pgrep record what they were asked to do instead of doing it.
    for (const name of ["launchctl", "pkill", "pgrep"]) {
      writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\nexit 0\n`);
      chmodSync(join(bin, name), 0o755);
    }
    const { NOWALL_NO_LAUNCHD: _n, NOWALL_SID: _s, ...parent } = process.env;
    const env = {
      ...parent,
      PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: home,
      NOWALL_HOME: cfg,
    };
    writeFileSync(join(cfg, "config.json"), JSON.stringify({ v: 1, scope: "global" }));
    const r = real.spawnSync(process.execPath, [CLI, "uninstall", "--global"], {
      cwd: scratch,
      env,
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(r.status, r.stderr).toBe(0);
    const recorded = existsSync(log) ? readFileSync(log, "utf8") : "";
    expect(recorded).not.toContain(`/${REAL_LABEL}\n`);
    expect(recorded).not.toContain(`/${REAL_LABEL} `);
    expect(recorded).not.toMatch(/pkill -f NowallNotch\.app\/Contents\/MacOS\/NowallNotch$/m);
    // Under a temporary NOWALL_HOME nothing is sent to launchd at all.
    expect(recorded).toBe("");
    if (process.platform === "darwin") expect(r.stderr).toContain("Notch left alone");

    // `nowall notch status` names the sandbox's own label, not the user's.
    const status = real.spawnSync(process.execPath, [CLI, "notch", "status"], {
      cwd: scratch,
      env,
      encoding: "utf8",
    });
    expect(status.stdout).toMatch(/Label: {7}dev\.nowall\.notch\.[0-9a-f]{8}\n/);
  });
});
