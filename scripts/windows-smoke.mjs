#!/usr/bin/env node
// Proves nowall on a real Windows machine (CI, after install.ps1 ran). Checks what can't be simulated
// on another OS: hooks really run under cmd.exe, PowerShell and Git Bash, the `.cmd` shim works,
// nothing is left over after a failover, and uninstall cleans up.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : `\n     ${detail}`}`);
  if (!ok) failures.push(name);
};
const run = (cmd, args, input) => {
  const r = spawnSync(cmd, args, { input, encoding: "utf8", timeout: 180_000, windowsHide: true });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};
const nowall = (...args) =>
  spawnSync(["nowall.cmd", ...args].join(" "), {
    shell: true,
    encoding: "utf8",
    timeout: 300_000,
    windowsHide: true,
  });

const version = nowall("--version");
check("nowall.cmd runs", version.status === 0, version.stderr);

const settingsPath = join(homedir(), ".claude", "settings.json");
check("setup wrote Claude's hooks", existsSync(settingsPath));
const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
const command = settings.hooks?.UserPromptSubmit?.at(-1)?.hooks?.[0]?.command ?? "";
check(
  "hook uses the shell-neutral form",
  /^nowall\.cmd hook .* NOWALL_HOOK=1$/.test(command),
  command,
);

const payload = JSON.stringify({
  hook_event_name: "UserPromptSubmit",
  cwd: process.cwd(),
  prompt: "hi",
});
const shells = [
  ["cmd.exe", ["/d", "/s", "/c", command]],
  ["powershell.exe", ["-NoProfile", "-Command", command]],
];
const bash = join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe");
if (existsSync(bash)) shells.push([bash, ["--login", "-c", command]]);
else check("Git Bash available on this machine", false, bash);
for (const [shell, args] of shells) {
  const r = run(shell, args, payload);
  check(`hook runs under ${shell}`, r.code === 0, r.out);
}

const status = settings.statusLine?.command ?? "";
check("status-line tap has no shell quoting", status !== "" && !/['"]/.test(status), status);
const tap = run("cmd.exe", ["/d", "/s", "/c", status], '{"rate_limits":{}}');
check("status-line tap runs", tap.code === 0, tap.out);

// The tray app `nowall setup` started, in the real config folder.
const trayDir = join(homedir(), ".config", "nowall", "notch");
const trayExe = () =>
  existsSync(trayDir) ? readdirSync(trayDir).find((n) => n.endsWith(".exe")) : undefined;
const trayStatus = nowall("notch", "status");
check("setup built the tray app", Boolean(trayExe()), trayStatus.stdout);
check("setup started the tray app", /Running:\s+yes/.test(trayStatus.stdout), trayStatus.stdout);
check("it starts at login", /Login item:\s+HKCU/.test(trayStatus.stdout), trayStatus.stdout);

const demo = nowall("demo");
const output = `${demo.stdout}${demo.stderr}`;
check(
  "demo fails over and finishes",
  demo.status === 0 && /Your task is done/.test(output),
  output,
);

const agents = nowall("agents");
check("nowall agents runs", agents.status === 0, agents.stderr);

const off = nowall("uninstall", "--global", "--yes");
check("uninstall runs", off.status === 0, `${off.stdout}${off.stderr}`);
const after = existsSync(settingsPath) ? readFileSync(settingsPath, "utf8") : "";
check("uninstall removed the hooks", !after.includes("NOWALL_HOOK"), after);
check("uninstall removed the tray app", !trayExe(), `${off.stdout}${off.stderr}`);
const startup = run("reg.exe", [
  "query",
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
]);
check("uninstall removed it from startup", !/dev\.nowall\.notch/.test(startup.out), startup.out);

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("\nAll Windows checks passed.");
