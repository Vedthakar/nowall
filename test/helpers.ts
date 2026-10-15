import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GIT_ENV = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};
Object.assign(process.env, GIT_ENV);

export function sh(cwd: string, cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { cwd, encoding: "utf8" }).trimEnd();
}

/** Fresh git repo with one commit containing README.md. */
export function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "nowall-repo-"));
  sh(dir, "git", ["init", "-q", "-b", "main"]);
  writeFileSync(join(dir, "README.md"), "# demo\n");
  sh(dir, "git", ["add", "."]);
  sh(dir, "git", ["commit", "-q", "-m", "init"]);
  return dir;
}
