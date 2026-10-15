import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync("git", args, {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  }).trimEnd();
}

function tryGit(cwd: string, args: string[]): string | null {
  try {
    return git(cwd, args);
  } catch {
    return null;
  }
}

export function repoRoot(cwd: string): string | null {
  return tryGit(cwd, ["rev-parse", "--show-toplevel"]);
}

export function headCommit(root: string): string | null {
  return tryGit(root, ["rev-parse", "--verify", "-q", "HEAD"]);
}

/**
 * Tree hash of the entire working tree (tracked + untracked, honouring .gitignore).
 * Uses a throwaway index, so the user's index and files are never touched.
 */
export function snapshotTree(root: string): string {
  const dir = mkdtempSync(join(tmpdir(), "nowall-idx-"));
  const index = join(dir, "index");
  try {
    const gitDir = git(root, ["rev-parse", "--absolute-git-dir"]);
    const real = join(gitDir, "index");
    if (existsSync(real)) copyFileSync(real, index);
    const env = { GIT_INDEX_FILE: index };
    git(root, ["add", "-A", "--", "."], env);
    // Never snapshot nowall's own data or secret-looking files, even if the repo forgot to ignore them.
    git(
      root,
      ["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", ".handoff", ...SECRET_GLOBS],
      env,
    );
    return git(root, ["write-tree"], env);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const SECRET_GLOBS = [
  ":(glob)**/.env",
  ":(glob)**/.env.*",
  ":(glob)**/*.pem",
  ":(glob)**/*.key",
  ":(glob)**/*.p12",
  ":(glob)**/*.pfx",
  ":(glob)**/id_rsa*",
  ":(glob)**/id_ed25519*",
  ":(glob)**/.npmrc",
  ":(glob)**/.netrc",
];

/** Checkpoints live outside refs/heads so `git push --all` and branch lists never include them. */
export const CHECKPOINT_PREFIX = "refs/nowall";

export interface Checkpoint {
  ref: string;
  commit: string;
  tree: string;
}

/** Commits a snapshot to refs/nowall/<sid>/<n> without moving HEAD or any branch. */
export function checkpoint(root: string, sid: string, n: number, message: string): Checkpoint {
  const tree = snapshotTree(root);
  const head = headCommit(root);
  const args = ["commit-tree", tree, "-m", message];
  if (head) args.push("-p", head);
  const commit = git(root, args);
  const ref = `${CHECKPOINT_PREFIX}/${sid}/${n}`;
  git(root, ["update-ref", ref, commit]);
  return { ref, commit, tree };
}

/**
 * Restores working-tree files from a checkpoint. Overlay mode: files that don't exist in the
 * checkpoint are left alone (never deleted), so an undo can't destroy unrelated work or secrets.
 */
export function restore(root: string, commit: string): void {
  git(root, ["restore", "--overlay", `--source=${commit}`, "--worktree", "--", "."]);
}

export function listCheckpoints(
  root: string,
  sid?: string,
): { ref: string; commit: string; subject: string }[] {
  const out = tryGit(root, [
    "for-each-ref",
    "--format=%(refname)%09%(objectname)%09%(subject)",
    sid ? `${CHECKPOINT_PREFIX}/${sid}/` : `${CHECKPOINT_PREFIX}/`,
  ]);
  if (!out) return [];
  const step = (ref: string) => Number(ref.split("/").pop());
  return out
    .split("\n")
    .map((l) => {
      const [ref = "", commit = "", subject = ""] = l.split("\t");
      return { ref, commit, subject };
    })
    .sort((a, b) => step(a.ref) - step(b.ref));
}

export function status(root: string): string {
  return tryGit(root, ["status", "--short"]) ?? "";
}

export function diffStat(root: string, from: string, to: string): string {
  return tryGit(root, ["diff", "--stat", from, to, "--", ".", ":!.handoff"]) ?? "";
}

export function shortStat(root: string, from: string, to: string): string {
  return tryGit(root, ["diff", "--shortstat", from, to, "--", ".", ":!.handoff"])?.trim() ?? "";
}

export function changedFiles(root: string, from: string, to: string): string[] {
  const out = tryGit(root, ["diff", "--name-only", from, to, "--", ".", ":!.handoff"]);
  return out ? out.split("\n").filter(Boolean) : [];
}

export function logSince(root: string, base: string): string[] {
  const head = headCommit(root);
  if (!head) return [];
  const out = tryGit(root, ["log", "--oneline", "--no-decorate", `${base}..HEAD`]);
  return out ? out.split("\n").filter(Boolean).slice(0, 30) : [];
}

/** Hides a path from git status without touching the user's .gitignore. */
export function excludeLocally(root: string, pattern: string): void {
  const infoDir = join(git(root, ["rev-parse", "--absolute-git-dir"]), "info");
  const file = join(infoDir, "exclude");
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (current.split("\n").includes(pattern)) return;
  mkdirSync(infoDir, { recursive: true });
  appendFileSync(file, `${current && !current.endsWith("\n") ? "\n" : ""}${pattern}\n`);
}
