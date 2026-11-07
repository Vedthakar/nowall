import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

/** Builds dist/ once before any test file runs; the end-to-end tests drive the real CLI. */
export default function setup(): void {
  const root = resolve(__dirname, "..");
  const tsc = resolve(root, "node_modules", "typescript", "bin", "tsc");
  execFileSync(process.execPath, [tsc, "-p", "tsconfig.build.json"], { cwd: root });
}
