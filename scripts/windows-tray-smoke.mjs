#!/usr/bin/env node
// Proves the tray app on a real Windows machine (CI, after install.ps1 ran): the real compiler, the
// real registry, a real window, and status files written by nowall's real hooks and takeover. Only
// the agents are simulated. Runs in a throwaway home, so it can't touch the tray `nowall setup` started.
// Pass a folder to keep the app's own pictures of itself: node scripts/windows-tray-smoke.mjs shots
import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : `\n     ${detail}`}`);
  if (!ok) failures.push(name);
};

const shots = resolve(process.argv[2] ?? join(homedir(), "nowall-tray-shots"));
mkdirSync(shots, { recursive: true });

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// A space in the path on purpose. In the home folder, because nowall refuses a temporary one.
const sandbox = mkdtempSync(join(homedir(), "nowall tray smoke "));
const home = join(sandbox, "config");
const repo = join(sandbox, "my app");
const bin = join(sandbox, "bin");
const plan = join(sandbox, "plan.json");
for (const d of [home, repo, bin]) mkdirSync(d, { recursive: true });

const fake = join(root, "scripts", "fake-agent.mjs");
for (const [name, agent] of [
  ["claude", "claude"],
  ["cursor-agent", "cursor"],
]) {
  writeFileSync(
    join(bin, `${name}.mjs`),
    `const a = process.argv[2];
if (a === "--version") { console.log("simulated ${agent}"); process.exit(0); }
if (a === "status") { console.log('{"isAuthenticated":true}'); process.exit(0); }
if (a === "auth") { console.log('{"loggedIn":true}'); process.exit(0); }
process.argv.splice(2, 0, ${JSON.stringify(agent)});
await import(${JSON.stringify(pathToFileURL(fake).href)});
`,
  );
  writeFileSync(join(bin, `${name}.cmd`), `@node "%~dp0\\${name}.mjs" %*\r\n`);
}
// The takeover runs long enough to be cancelled from the panel.
writeFileSync(
  plan,
  JSON.stringify({
    cursor: [{ text: "Working on it.", sleepMs: 180_000 }],
    claude: [{ text: "Working on it.", sleepMs: 180_000 }],
  }),
);
writeFileSync(join(home, "config.json"), JSON.stringify({ v: 1, order: ["claude", "cursor"] }));

const cli = join(root, "dist", "cli.js");
const env = {
  ...process.env,
  PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
  USERPROFILE: sandbox, // `uninstall --global` below must not reach the real ~/.claude
  NOWALL_HOME: home,
  FAKE_PLAN: plan,
  FAKE_NOWALL: `"${process.execPath}" "${cli}"`,
  GIT_AUTHOR_NAME: "nowall smoke",
  GIT_AUTHOR_EMAIL: "smoke@nowall.invalid",
  GIT_COMMITTER_NAME: "nowall smoke",
  GIT_COMMITTER_EMAIL: "smoke@nowall.invalid",
};
const opts = { encoding: "utf8", windowsHide: true, timeout: 180_000, env };
const nowall = (args, input, cwd = repo) => {
  const r = spawnSync(process.execPath, [cli, ...args], { ...opts, cwd, input });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};
const git = (...args) => spawnSync("git", args, { ...opts, cwd: repo, stdio: "ignore" });

const hook = (name, sessionId, extra = {}) =>
  nowall(
    ["hook", name, "--agent", "claude"],
    JSON.stringify({ session_id: sessionId, cwd: repo, ...extra }),
  );

const trayFolder = join(home, "notch");
const exe = () => {
  const name = existsSync(trayFolder)
    ? readdirSync(trayFolder).find((n) => /^NowallTray-[0-9a-f]{8}\.exe$/.test(n))
    : undefined;
  return name ? join(trayFolder, name) : null;
};
const tray = (...args) => {
  const r = spawnSync(exe() ?? "missing", args, opts);
  return { code: r.status, out: r.stdout ?? "", err: `${r.stderr ?? ""}${r.error ?? ""}` };
};
// Output goes to a file: a takeover started by the click inherits the app's handles, and spawnSync
// would wait on a pipe for as long as that takeover runs.
const click = (key) => {
  const file = join(sandbox, "click.txt");
  const fd = openSync(file, "w");
  const r = spawnSync(exe() ?? "missing", ["--click", key], {
    ...opts,
    stdio: ["ignore", fd, fd],
    timeout: 120_000,
  });
  closeSync(fd);
  return { code: r.status, out: readFileSync(file, "utf8") };
};
const dump = (...args) => {
  const r = tray("--dump", ...args);
  try {
    return JSON.parse(r.out);
  } catch {
    check("--dump prints JSON", false, `${r.out}\n${r.err}`);
    return { sessions: [], accounts: [], tray: {} };
  }
};
const session = (d, sid) => d.sessions.find((s) => s.sid === sid);
const wait = async (what, test, ms = 60_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (test()) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  check(what, false, "timed out");
  return false;
};
const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const loginItems = () =>
  spawnSync("reg.exe", ["query", RUN_KEY], { encoding: "utf8", windowsHide: true }).stdout ?? "";
const ourLoginItem = () =>
  loginItems()
    .split(/\r?\n/)
    .find((l) => l.includes(trayFolder));

try {
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "# my app\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  check("nowall init", nowall(["init", "--yes"]).code === 0);

  // --- real status files -------------------------------------------------------------------------
  const WORKING = "11111111-1111-4111-8111-111111111111";
  const ASKING = "22222222-2222-4222-8222-222222222222";
  const FLEET = "33333333-3333-4333-8333-333333333333";
  hook("session-start", WORKING);
  hook("prompt", WORKING, { prompt: "add a health endpoint" });
  hook("post-tool", WORKING, { tool_name: "Write", tool_input: { file_path: "src/health.ts" } });
  hook("session-start", ASKING);
  hook("prompt", ASKING, { prompt: "rename the module" });
  hook("notification", ASKING, { message: "Claude needs your permission to use Bash" });
  hook("session-start", FLEET);
  hook("prompt", FLEET, { prompt: "review everything" });
  hook("subagent-start", FLEET, { agent_id: "a1", agent_type: "explore" });

  // Usage arrives the real way: Claude's status line pipes it to `nowall statusline`.
  const resets = Math.floor(Date.now() / 1000) + 3600;
  const tap = nowall(
    ["statusline"],
    JSON.stringify({
      rate_limits: {
        five_hour: { used_percentage: 42, resets_at: resets },
        seven_day: { used_percentage: 91, resets_at: resets },
      },
    }),
  );
  check("statusline accepts usage", tap.code === 0, tap.out);
  const agents = nowall(["agents", "--write"]);
  check("agents --write", agents.code === 0, agents.out);
  // Files the app must shrug off, in the folder it reads.
  writeFileSync(join(home, "status", "garbage.json"), "{ not json");
  writeFileSync(join(home, "status", "half.json"), '{"sid":"x"}');

  // --- start, the way `nowall notch` does it ---------------------------------------------------
  const started = Date.now();
  const start = nowall(["notch"]);
  console.log(`     build and start took ${Date.now() - started} ms: ${start.out.trim()}`);
  check("nowall notch starts it", /system tray/.test(start.out), start.out);
  check("the source compiled on this machine", exe() !== null);
  if (exe()) console.log(`     exe is ${Math.round(statSync(exe()).size / 1024)} KB`);
  check("the tray reports running", tray("--running").code === 0);
  check("startup entry written", Boolean(ourLoginItem()), loginItems());
  const status = nowall(["notch", "status"]);
  check("notch status says running", /Running:\s+yes/.test(status.out), status.out);
  check(
    "launch.txt has the CLI",
    readFileSync(join(trayFolder, "launch.txt"), "utf8").includes(cli),
  );
  const again = spawnSync(exe(), [], { ...opts, timeout: 15_000 });
  check("a second copy exits at once", again.status === 0, String(again.error ?? again.status));
  check("the first copy keeps running", tray("--running").code === 0);

  // --- what it shows ------------------------------------------------------------------------------
  const d = dump();
  console.log(JSON.stringify(d, null, 1));
  const working = session(d, `c_${WORKING}`);
  check("working session shown", working?.phase === "working", JSON.stringify(working));
  check("its label names the agent", working?.label === "Claude working");
  check("its detail comes from the hook", /health/.test(working?.detail ?? ""), working?.detail);
  check("it can be switched", working?.canSwitch === true);
  const asking = session(d, `c_${ASKING}`);
  check("waiting session shown", asking?.phase === "needs-input", JSON.stringify(asking));
  check("what needs you comes first", d.sessions[0]?.sid === `c_${ASKING}`);
  check("the tray icon calls for attention", d.tray.state === "needs-input");
  check("the tooltip counts it", /1 needs you/.test(d.tray.tooltip), d.tray.tooltip);
  const fleet = session(d, `c_${FLEET}`);
  check("subagents shown", /1 subagent.*explore/.test(fleet?.subagents ?? ""), fleet?.subagents);
  check("odd files are ignored", !d.sessions.some((s) => s.sid === "x"));
  const claude = d.accounts.find((a) => a.id === "claude");
  check("Claude's usage shown", /42% of 5h/.test(claude?.line ?? ""), JSON.stringify(claude));
  check("usage has both windows", claude?.usage?.length === 2, JSON.stringify(claude?.usage));
  check(
    "the other account shown",
    d.accounts.some((a) => a.id === "cursor"),
    JSON.stringify(d),
  );
  const later = dump("--now", new Date(Date.now() + 7 * 3600_000).toISOString());
  check("old sessions drop off", later.sessions.length === 0, JSON.stringify(later.sessions));

  const panel = join(shots, "panel.png");
  const shot = tray("--screenshot", panel);
  check("draws the panel", shot.code === 0 && existsSync(panel), shot.err);
  check("the picture isn't empty", existsSync(panel) && statSync(panel).size > 3000);
  const desktop = join(shots, "desktop.png");
  const onScreen = tray("--desktop-shot", desktop);
  check("shows on a real desktop", onScreen.code === 0 && existsSync(desktop), onScreen.err);

  // --- the buttons, pressed in the real panel ------------------------------------------------------
  const sid = `c_${WORKING}`;
  const none = click("cancel:no-such-session");
  check("an unknown button is refused", none.code === 2, none.out);
  tray("--icon-shot", join(shots, "icon-needs-input.png"));
  const before = Date.now();
  const pressed = click(`switch:${sid}:cursor`);
  check("Switch runs nowall switch", pressed.code === 0, pressed.out);
  console.log(`     ${pressed.out.trim()}`);
  check("it says who took over", /Cursor/.test(pressed.out), pressed.out);
  // The takeover inherits the app's pipes, and sleeps far longer than this.
  check("the button doesn't wait for the takeover", Date.now() - before < 60_000);
  await wait("the takeover shows up", () => session(dump(), sid)?.canCancel === true);
  check("no second switch while it runs", session(dump(), sid)?.canSwitch === false);
  tray("--screenshot", join(shots, "panel-takeover.png"));

  // "Switching" shows a moment before the takeover process is up. Until then cancel has nothing
  // to stop and says so, so press again like a person would.
  let stopped = click(`cancel:${sid}`);
  const giveUp = Date.now() + 60_000;
  while (stopped.code !== 0 && /no takeover is running/.test(stopped.out) && Date.now() < giveUp) {
    await new Promise((r) => setTimeout(r, 500));
    stopped = click(`cancel:${sid}`);
  }
  check("Cancel switch runs nowall cancel", stopped.code === 0, stopped.out);
  console.log(`     ${stopped.out.trim()}`);
  check("the takeover is over", session(dump(), sid)?.canCancel !== true);
  const failed = click(`cancel:${sid}`);
  check("nothing left to cancel means no button", failed.code === 2, failed.out);
  tray("--screenshot", join(shots, "panel-after.png"));

  // --- off, on, and out ---------------------------------------------------------------------------
  check("still running after all that", tray("--running").code === 0);
  check("nowall notch off", nowall(["notch", "off"]).code === 0);
  check("off quits it", tray("--running").code === 1);
  check("off removes the startup entry", !ourLoginItem(), loginItems());
  const on = nowall(["notch", "on"]);
  check("on starts it again", /system tray/.test(on.out), on.out);
  check("and adds the startup entry back", Boolean(ourLoginItem()));

  const off = nowall(["uninstall", "--global", "--yes"]);
  check("uninstall runs", off.code === 0, off.out);
  check("uninstall removes the startup entry", !ourLoginItem(), loginItems());
  check("uninstall removes the built app", !existsSync(trayFolder), off.out);
  const verified = /tray app for .*gone/.test(off.out);
  check("uninstall reports it gone", verified, off.out);
} finally {
  if (exe()) tray("--quit");
  const leftover = ourLoginItem();
  if (leftover) {
    const name = leftover.trim().split(/\s+/)[0];
    spawnSync("reg.exe", ["delete", RUN_KEY, "/v", name, "/f"], { stdio: "ignore" });
  }
  try {
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch {
    // CI's machine is thrown away; a file still in use here isn't a failure of the app
  }
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("\nAll tray checks passed.");
