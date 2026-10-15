import { execFile } from "node:child_process";
import type { AgentId, LimitHit } from "../schemas.js";

export type AgentEvent =
  | { kind: "session"; id: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; detail?: string; files?: string[] }
  | { kind: "error"; text: string }
  | { kind: "done"; isError: boolean; text?: string };

export interface Detection {
  installed: boolean;
  version?: string;
  signedIn: boolean | "unknown";
}

export interface HeadlessOptions {
  prompt: string;
  resumeId?: string;
  yolo: boolean;
}

export interface AgentAdapter {
  id: AgentId;
  displayName: string;
  binary: string;
  installHint: string;
  loginHint: string;
  /** "beta" = flags/format not yet verified against a real install. */
  maturity: "stable" | "beta";
  detect(run: Runner, binaryPath: string): Promise<Detection>;
  headless(opts: HeadlessOptions): { args: string[]; env?: Record<string, string> };
  parseLine(line: string): AgentEvent[];
  /** Classify error-channel text (error events, is_error results, stderr). */
  detectLimit(text: string, now: Date): LimitHit | null;
  /** Native command the user can run to continue interactively. */
  resumeCommand(sessionId?: string): string;
  /** Installs journaling hooks into the project; returns files written. */
  installHooks?(root: string, nowallCmd: string): string[];
  /** Installs the same hooks at user level (every project), for `nowall setup`. */
  installUserHooks?(home: string, nowallCmd: string): string[];
}

export type Runner = (
  cmd: string,
  args: string[],
  timeoutMs?: number,
) => Promise<{ code: number; stdout: string; stderr: string }>;

export const defaultRunner: Runner = (cmd, args, timeoutMs = 5000) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, encoding: "utf8" }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
      resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });

export async function versionOf(run: Runner, bin: string): Promise<string | null> {
  const r = await run(bin, ["--version"]);
  if (r.code !== 0) return null;
  return (r.stdout || r.stderr).trim().split("\n")[0]?.slice(0, 80) ?? "";
}
