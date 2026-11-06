import { randomBytes } from "node:crypto";
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * File I/O for anything nowall writes inside a repository the user may not fully trust.
 * - never follows a symlink at the final path component (a repo could plant
 *   `.claude/settings.local.json -> ~/.zshrc`)
 * - writes are atomic (exclusive temp file + rename, which replaces a link instead of following it)
 * - reads are size-capped so a huge or hostile file can't exhaust memory
 */

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
// Opening a FIFO (or a device) read-only blocks until a writer shows up; non-blocking opens
// return at once and fstat then tells us it isn't a regular file. Harmless for regular files.
const NONBLOCK = constants.O_NONBLOCK ?? 0;
const READ_FLAGS = constants.O_RDONLY | NOFOLLOW | NONBLOCK;

/** Directory mode for a file we create: private (0700) when the file itself is private (0600). */
const dirMode = (fileMode: number) => ((fileMode & 0o077) === 0 ? 0o700 : 0o755);

export function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Reads at most the last `maxBytes` of a regular file (tail), or null. */
export function readTail(path: string, maxBytes: number): string | null {
  let fd: number;
  try {
    fd = openSync(path, READ_FLAGS);
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return null;
    const len = Math.min(st.size, maxBytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, st.size - len);
    let text = buf.toString("utf8");
    if (st.size > len) text = text.slice(text.indexOf("\n") + 1); // drop the partial first line
    return text;
  } finally {
    closeSync(fd);
  }
}

/** Reads a whole small file; null if missing, not a regular file, a symlink, or over `maxBytes`. */
export function readSmall(path: string, maxBytes = 1024 * 1024): string | null {
  let fd: number;
  try {
    fd = openSync(path, READ_FLAGS);
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > maxBytes) return null;
    const buf = Buffer.alloc(st.size);
    readSync(fd, buf, 0, st.size, 0);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

export function readJsonSafe<T>(path: string, maxBytes?: number): T | null {
  const raw = readSmall(path, maxBytes);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** Atomic write: exclusive temp file in the same directory, then rename over the target. */
export function writeAtomic(path: string, text: string, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true, mode: dirMode(mode) });
  const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
  const fd = openSync(
    tmp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
    mode,
  );
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** Appends without following a symlink at `path`. Rotates the file past `rotateBytes`. */
export function appendSafe(path: string, text: string, rotateBytes = 5 * 1024 * 1024): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  rotateIfLarge(path, rotateBytes);
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | NOFOLLOW,
    0o600,
  );
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
}

/**
 * Moves `path` to `path.1` once it is over `rotateBytes`. Concurrent writers (40 hooks at once)
 * all see the big file at the same moment; without a guard each of them would rename in turn and
 * the later renames would move the fresh, nearly empty file over the rotated one, losing lines.
 * One writer claims the rotation with an exclusive marker, re-checks the size, and the rest skip.
 */
function rotateIfLarge(path: string, rotateBytes: number): void {
  try {
    if (statSync(path).size <= rotateBytes || isSymlink(path)) return;
  } catch {
    return; // missing file: nothing to rotate
  }
  const marker = `${path}.rotating`;
  let fd: number;
  try {
    fd = openSync(marker, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  } catch {
    // Another writer is rotating right now (or a crash left a marker behind; clear it if old).
    try {
      if (Date.now() - statSync(marker).mtimeMs > 60_000) rmSync(marker, { force: true });
    } catch {
      // gone already
    }
    return;
  }
  closeSync(fd);
  try {
    if (statSync(path).size > rotateBytes) renameSync(path, `${path}.1`);
  } catch {
    // someone else won after all
  } finally {
    rmSync(marker, { force: true });
  }
}

/** Single-quotes a string for POSIX sh (safe for any path, including quotes and `$`). */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// Control characters are the point of these patterns.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matches terminal escape sequences
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g; // titles, hyperlinks, clipboard writes
// biome-ignore lint/suspicious/noControlCharactersInRegex: matches terminal escape sequences
const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g; // colors, cursor moves, screen clears
// biome-ignore lint/suspicious/noControlCharactersInRegex: matches terminal escape sequences
const ESC = /\x1b[@-_]?/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: matches control characters
const CTRL = /[\x00-\x08\x0b-\x1f\x7f\x80-\x9f]/g;

/** Strips terminal control sequences so agent/repo text can't rewrite the user's terminal. */
export function sanitizeTerminal(s: string): string {
  return s.replace(OSC, "").replace(CSI, "").replace(ESC, "").replace(CTRL, "");
}
