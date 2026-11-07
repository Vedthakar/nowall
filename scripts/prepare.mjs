#!/usr/bin/env node
// `npm prepare`: compile the CLI, plus the notch app on a Mac. A plain Node script so it also runs on
// Windows, which has no `sh`.
import { spawnSync } from "node:child_process";

const steps = [["npm", "run", "build"]];
if (process.platform === "darwin") steps.push(["npm", "run", "build:notch"]);
for (const [cmd, ...args] of steps) {
  const r = spawnSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
