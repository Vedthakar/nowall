import { constants, accessSync, realpathSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { AgentId } from "../schemas.js";
import { claude } from "./claude.js";
import { codex } from "./codex.js";
import { antigravity, cursor, qwen } from "./others.js";
import type { AgentAdapter } from "./types.js";

export const ADAPTERS: Record<AgentId, AgentAdapter> = { claude, codex, cursor, antigravity, qwen };

/**
 * Finds the real binary on PATH, skipping anything that resolves to nowall itself
 * (so a `claude` shim pointing at us can never recurse).
 */
export function resolveBinary(name: string, self?: string): string | null {
  const selfReal = self ? safeReal(self) : null;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
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
