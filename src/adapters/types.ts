import { execFile } from "../proc.js";
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
  /** `env` selects an account (profile dir or API key); absent means the default login. */
  detect(run: Runner, binaryPath: string, env?: Record<string, string>): Promise<Detection>;
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
  env?: Record<string, string>,
) => Promise<{ code: number; stdout: string; stderr: string }>;

export const defaultRunner: Runner = (cmd, args, timeoutMs, env) =>
  new Promise((resolve) => {
    execFile(
      cmd,
      args,
      {
        timeout: timeoutMs ?? 5000,
        encoding: "utf8",
        env: env ? { ...process.env, ...env } : undefined,
      },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
        resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "" });
      },
    );
  });

export async function versionOf(
  run: Runner,
  bin: string,
  env?: Record<string, string>,
): Promise<string | null> {
  const r = await run(bin, ["--version"], undefined, env);
  if (r.code !== 0) return null;
  return (r.stdout || r.stderr).trim().split("\n")[0]?.trim().slice(0, 80) ?? "";
}
