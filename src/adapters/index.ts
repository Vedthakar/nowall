import { constants, accessSync, realpathSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { AgentId } from "../schemas.js";
import { loadConfig } from "../state.js";
import { claude } from "./claude.js";
import { codex } from "./codex.js";
import { antigravity, cursor, qwen } from "./others.js";
import type { AgentAdapter } from "./types.js";

export const ADAPTERS: Record<AgentId, AgentAdapter> = { claude, codex, cursor, antigravity, qwen };

/**
 * Finds the real binary on PATH, skipping anything that resolves to nowall itself
 * (so a `claude` shim pointing at us can never recurse). Also searches the shell PATH saved by
 * `nowall setup`: background processes (the notch, launchd, GUI apps' hooks) get a bare PATH
 * that misses ~/.local/bin, Homebrew, nvm and friends.
 */
export function resolveBinary(name: string, self?: string): string | null {
  const selfReal = self ? safeReal(self) : null;
  const dirs = [
    ...(process.env.PATH ?? "").split(delimiter),
    ...(loadConfig().path ?? "").split(delimiter),
  ];
  for (const dir of new Set(dirs)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
    } catch {
      continue;
    }
    if (selfReal && safeReal(candidate) === selfReal) continue;
    return candidate;
  }
  return null;
}

function safeReal(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

export type { AgentAdapter, AgentEvent } from "./types.js";
