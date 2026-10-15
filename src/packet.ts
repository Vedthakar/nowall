import { changedFiles, diffStat, logSince, status } from "./git.js";
import { redactDeep } from "./redact.js";
import type { AgentId, HandoffPacket, JournalLine, LimitHit, TaskList } from "./schemas.js";
import { readJournal, readTasks } from "./session.js";

export interface PacketInput {
  root: string;
  sid: string;
  baseCommit: string;
  /** Commit of the checkpoint taken just before this handoff. */
  checkpoint: { ref: string; commit: string };
  from: AgentId;
  to: AgentId;
  limit: LimitHit;
  now: Date;
  envValues?: string[];
}

/** Builds the portable packet from the journal (hints) and git (ground truth). Always redacted. */
export function buildPacket(input: PacketInput): HandoffPacket {
  const journal = readJournal(input.root, input.sid);
  const tasks = readTasks(input.root);
  const hints = journalHints(journal, tasks);
  const touched = new Set([
    ...changedFiles(input.root, input.baseCommit, input.checkpoint.commit),
    ...journal.flatMap((j) => j.files ?? []),
  ]);
  const packet: HandoffPacket = {
    v: 1,
    sessionId: input.sid,
    createdAt: input.now.toISOString(),
    from: { agent: input.from, reason: "limit", message: input.limit.message },
    to: input.to,
    goal: hints.goal,
    decisions: hints.decisions,
    filesTouched: [...touched].slice(0, 100),
    claimedDone: hints.claimedDone,
    remaining: hints.remaining,
    git: {
      baseRef: input.baseCommit,
      headRef: input.checkpoint.commit,
      checkpointRef: input.checkpoint.ref,
      status: status(input.root).split("\n").slice(0, 50).join("\n"),
      diffStat: diffStat(input.root, input.baseCommit, input.checkpoint.commit)
        .split("\n")
        .slice(-40)
        .join("\n"),
      log: logSince(input.root, input.baseCommit),
    },
    lastError: input.limit.message,
  };
  if (input.limit.resetsAt) packet.from.resetsAt = input.limit.resetsAt;
  return redactDeep(packet, { knownValues: input.envValues ?? [] });
}

export function journalHints(
  journal: JournalLine[],
  tasks: TaskList | null,
): { goal: string[]; decisions: string[]; claimedDone: string[]; remaining: string[] } {
  const goal = journal.filter((j) => j.kind === "goal").map((j) => j.text);
  const decisions = journal.filter((j) => j.kind === "decision").map((j) => j.text);
  // Latest status wins per task text.
  const taskStatus = new Map<string, string>();
  for (const j of journal) if (j.kind === "task") taskStatus.set(j.text, j.status ?? "done");
  const claimedDone = new Set([...taskStatus].filter(([, s]) => s === "done").map(([t]) => t));
  const remaining = new Set([...taskStatus].filter(([, s]) => s !== "done").map(([t]) => t));
  for (const t of tasks?.tasks ?? []) {
    if (t.status === "done") claimedDone.add(t.title);
    else if (!claimedDone.has(t.title)) remaining.add(t.title);
  }
  return {
    goal: dedupe(goal).slice(-5),
    decisions: dedupe(decisions).slice(-15),
    claimedDone: [...claimedDone].slice(-30),
    remaining: [...remaining].filter((t) => !claimedDone.has(t)).slice(-30),
  };
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)];
}
