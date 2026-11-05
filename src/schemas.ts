export type AgentId = "claude" | "codex" | "cursor" | "antigravity" | "qwen";

export const AGENT_IDS: readonly AgentId[] = ["claude", "codex", "cursor", "antigravity", "qwen"];

export function isAgentId(value: unknown): value is AgentId {
  return typeof value === "string" && (AGENT_IDS as readonly string[]).includes(value);
}

export const ACCOUNT_LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,23}$/;

/** The agent behind an account id ("claude:work" → "claude"), or null if it isn't one. */
export function accountAgent(id: unknown): AgentId | null {
  if (typeof id !== "string") return null;
  const i = id.indexOf(":");
  const agent = i < 0 ? id : id.slice(0, i);
  const label = i < 0 ? "" : id.slice(i + 1);
  if (!isAgentId(agent)) return null;
  if (i >= 0 && !ACCOUNT_LABEL_RE.test(label)) return null;
  return agent;
}

export function accountLabel(id: string): string {
  const i = id.indexOf(":");
  return i < 0 ? "" : id.slice(i + 1);
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

/**
 * An account is one login of one agent. The default account of an agent has the agent's id
 * ("claude"); extra accounts are "<agent>:<label>" ("claude:work"). Limits, cooldowns and the
 * takeover order are all per account.
 */
export type AccountId = string;

export interface Account {
  id: AccountId;
  agent: AgentId;
  label: string;
  /** Environment that selects this login, e.g. CLAUDE_CONFIG_DIR or CODEX_HOME (a profile dir). */
  env?: Record<string, string>;
  /** A secret the user handed to nowall (Cursor API key), kept in the Keychain or a 0600 file. */
  secret?: { env: string; store: "keychain" | "file" };
}

export interface State {
  v: 1;
  /** Keyed by account id. */
  agents: Partial<Record<AccountId, AgentState>>;
}

export interface Config {
  v: 1;
  /** Takeover priority: account ids, first is tried first. Accounts not listed are off. */
  order: AccountId[];
  /** Extra logins beyond each agent's default one. */
  accounts?: Account[];
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
