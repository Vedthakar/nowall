import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ADAPTERS } from "./adapters/index.js";
import { shortStat } from "./git.js";
import { agentName } from "./prompt.js";
import type { Session, StopReason } from "./session.js";
import { handoffDir } from "./session.js";
import { fmtTime } from "./supervisor.js";

const HEADLINE: Record<StopReason, string> = {
  complete: "Your task is done.",
  stalled: "Stopped: the agent stopped making changes.",
  "max-turns": "Stopped: reached the maximum number of turns.",
  "max-time": "Stopped: reached the time limit.",
  "all-limited": "Paused: every available agent is at its usage limit.",
  error: "Stopped: the agent kept failing.",
  interrupted: "Stopped by you.",
};

const WINDOW: Record<string, string> = {
  session: "session limit",
  weekly: "weekly limit",
  model: "model limit",
  spend: "spend limit",
  credits: "credits",
  daily: "daily quota",
  "per-minute": "rate limit",
  unknown: "usage limit",
};

/** The one message the user sees at the end: who built what, and why we switched. */
export function renderSummary(root: string, session: Session): string {
  const reason = session.finished?.reason ?? "complete";
  const segs = session.segments;
  const lines = [HEADLINE[reason]];

  const last = segs.at(-1);
  const prev = segs.at(-2);
  if (last && prev?.endReason === "limit" && prev.limit) {
    const reset = prev.limit.resetsAt ? ` (resets ${fmtTime(prev.limit.resetsAt)})` : "";
    lines[0] += ` The last part was built by ${agentName(last.agent)} because ${agentName(prev.agent)} hit its ${WINDOW[prev.limit.window] ?? "usage limit"}${reset}.`;
  }

  if (segs.length > 1) {
    lines.push("");
    let from = session.baseCommit;
    segs.forEach((s, i) => {
      const stat = s.checkpoint ? shortStat(root, from, s.checkpoint) : "";
      if (s.checkpoint) from = s.checkpoint;
      const why =
        s.endReason === "limit" ? `hit ${WINDOW[s.limit?.window ?? "unknown"]}` : "finished";
      lines.push(`  ${i + 1}. ${agentName(s.agent)}: ${stat || "no file changes"} (${why})`);
    });
    lines.push("");
    lines.push(
      "Every step is checkpointed: `nowall undo <step>` rolls files back to the end of that step (0 = before any of it).",
    );
    if (last?.mode === "headless") {
      lines.push(
        `Keep going interactively: ${ADAPTERS[last.agent].resumeCommand(last.agentSessionId)}`,
      );
    }
  }
  return lines.join("\n");
}

export function writeSummary(root: string, session: Session): string {
  const text = renderSummary(root, session);
  writeFileSync(join(handoffDir(root), `summary-${session.sid}.md`), `${text}\n`);
  return text;
}
