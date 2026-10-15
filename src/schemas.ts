export type AgentId = "claude" | "codex" | "cursor" | "antigravity" | "qwen";

export const AGENT_IDS: readonly AgentId[] = ["claude", "codex", "cursor", "antigravity", "qwen"];

export function isAgentId(value: unknown): value is AgentId {
  return typeof value === "string" && (AGENT_IDS as readonly string[]).includes(value);
}

/** Which limit window was hit, when the message tells us. */
export type LimitWindow =
  | "session"
  | "weekly"
  | "model"
  | "spend"
  | "credits"
  | "daily"
  | "per-minute"
  | "unknown";

export interface LimitHit {
  kind: "quota" | "transient";
  window: LimitWindow;
  message: string;
  /** ISO timestamp; absent when the message carries no reset time. */
  resetsAt?: string;
}

export type JournalKind = "goal" | "edit" | "cmd" | "task" | "decision" | "limit" | "handoff";

export interface JournalLine {
  v: 1;
  ts: string;
  sid: string;
  agent: AgentId;
  kind: JournalKind;
  text: string;
  files?: string[];
  status?: "done" | "wip" | "todo";
}

export interface TaskItem {
  id: string;
  title: string;
  status: "done" | "todo" | "blocked";
  evidence?: string;
}

export interface TaskList {
  v: 1;
  updatedAt: string;
  updatedBy: string;
  tasks: TaskItem[];
}

export interface HandoffPacket {
  v: 1;
  sessionId: string;
  createdAt: string;
  from: { agent: AgentId; reason: "limit"; resetsAt?: string; message?: string };
  to: AgentId;
  goal: string[];
  decisions: string[];
  filesTouched: string[];
  claimedDone: string[];
  remaining: string[];
  git: {
    baseRef: string;
    headRef: string;
    checkpointRef?: string;
    status: string;
    diffStat: string;
    log: string[];
  };
  lastError?: string;
}

export interface AgentState {
  cooldownUntil?: string;
  lastLimit?: { window: LimitWindow; message: string; resetsAt?: string; observedAt: string };
}

export interface State {
  v: 1;
  agents: Partial<Record<AgentId, AgentState>>;
}

export interface Config {
  v: 1;
  order: AgentId[];
  enabled: Partial<Record<AgentId, boolean>>;
  yolo: boolean;
  stop: { maxTurns: number; maxMinutes: number; noDiffTurns: number };
  defaultCooldownMinutes: number;
  /**
   * When an agent nowall didn't launch (e.g. Claude desktop app) hits its limit: continue silently
   * in the background (default), in a new Terminal window, or not at all.
   */
  takeover: "background" | "terminal" | "off";
  /** "global" (via `nowall setup`): every git repo is covered. "repo": only repos that ran `nowall init`. */
  scope: "repo" | "global";
  /** The user's shell PATH, saved at setup so background takeovers can find agent CLIs. */
  path?: string;
  /** false after `nowall notch off`: setup won't start it again until `nowall notch on`. */
  notch?: boolean;
  fallback: {
    enabled: boolean;
    chinaConsent: boolean;
    provider?: "openrouter" | "deepseek" | "kimi" | "glm";
  };
}

export const DEFAULT_CONFIG: Config = {
  v: 1,
  order: ["claude", "codex", "cursor", "antigravity", "qwen"],
  enabled: { claude: true, codex: true, cursor: true, antigravity: true, qwen: false },
  yolo: false,
  stop: { maxTurns: 30, maxMinutes: 120, noDiffTurns: 3 },
  defaultCooldownMinutes: 300,
  takeover: "background",
  scope: "repo",
  fallback: { enabled: false, chinaConsent: false },
};

export function isTaskList(value: unknown): value is TaskList {
  if (typeof value !== "object" || value === null) return false;
  const tasks = (value as { tasks?: unknown }).tasks;
  return (
    Array.isArray(tasks) &&
    tasks.every(
      (t) =>
        typeof t === "object" &&
        t !== null &&
        typeof (t as TaskItem).title === "string" &&
        ["done", "todo", "blocked"].includes((t as TaskItem).status),
    )
  );
}
