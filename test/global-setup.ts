import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

/** Builds dist/ once before any test file runs; the end-to-end tests drive the real CLI. */
export default function setup(): void {
  execFileSync("npx", ["tsc", "-p", "tsconfig.build.json"], { cwd: resolve(__dirname, "..") });
}
