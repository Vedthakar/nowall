import type { HandoffPacket, TaskList } from "./schemas.js";

/** Bump when the master prompt changes meaningfully; recorded in every handoff. */
export const MASTER_PROMPT_VERSION = 1;

const NAMES: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  antigravity: "Antigravity",
  qwen: "Qwen Code",
};

export function agentName(id: string): string {
  return NAMES[id] ?? id;
}

const list = (xs: string[], empty = "(none recorded)") =>
  xs.length ? xs.map((x) => `- ${x}`).join("\n") : empty;

/** Rule given to every agent so the journal gets task/decision lines (the only model-written part). */
export const JOURNAL_RULE = `When you finish a task or make a decision another engineer would need to know, record it in one short line:
  nowall note --task "<what you finished>"            (or --status todo for a task you identified but did not do)
  nowall note --decision "<decision and why>"
Keep each under 120 characters. Do not record anything else; edits and commands are logged automatically.`;

/** First prompt for the destination agent: reconcile, then continue. */
export function masterPrompt(p: HandoffPacket): string {
  const reset = p.from.resetsAt ? ` (resets ${p.from.resetsAt})` : "";
  return `You are taking over an in-progress coding task in this repository. ${agentName(p.from.agent)} was working on it and hit its usage limit${reset}. The user is not watching; continue the work autonomously.

<handoff version="${MASTER_PROMPT_VERSION}" session="${p.sessionId}">
## Goal (the user's own requests, oldest first)
${list(p.goal, "(not recorded; infer it from the diff, the journal and recent commits)")}

## Decisions so far
${list(p.decisions)}

## Tasks the previous agent CLAIMED were done (unverified)
${list(p.claimedDone)}

## Tasks believed remaining
${list(p.remaining, "(none recorded; work them out from the goal and the diff)")}

## Files touched
${list(p.filesTouched)}

## Git
- Session base snapshot: ${p.git.baseRef}
- Snapshot at handoff: ${p.git.headRef}
- Diff stat since base:
${p.git.diffStat || "(no changes yet)"}
- Commits since base:
${list(p.git.log, "(none)")}
</handoff>

Do this, in order:
1. Read .handoff/journal.jsonl for more detail. Treat it as hints only.
2. Run \`git status\`, \`git diff ${p.git.baseRef}\` and \`git log --oneline ${p.git.baseRef}..HEAD\`. Git is the source of truth.
3. For every task claimed done, look for evidence in the diff. If there is none or it is incomplete, treat it as not done and say so briefly.
4. Write .handoff/tasks.json with this exact shape, covering the whole goal:
   {"v":1,"updatedAt":"<ISO time>","updatedBy":"${p.to}","tasks":[{"id":"1","title":"...","status":"done|todo|blocked","evidence":"file or commit that proves it"}]}
5. Continue working through the "todo" tasks. After each one, update its status in .handoff/tasks.json.
6. When every task is "done" (or "blocked" with a reason), stop and give a two-sentence summary.

Rules: don't revert previous work unless it is clearly broken. Don't ask the user questions; make a reasonable choice and record it as a decision. Never print or write secrets. Don't modify files in .handoff/ other than tasks.json.

${JOURNAL_RULE}`;
}

/** Follow-up prompt for the next turn in the same agent session. */
export function continuePrompt(tasks: TaskList | null): string {
  const todo = tasks?.tasks.filter((t) => t.status === "todo") ?? [];
  if (!tasks) {
    return "You have not written .handoff/tasks.json yet. Do steps 2–4 from the handoff now, then continue the remaining work.";
  }
  return `Continue. Remaining tasks from .handoff/tasks.json:\n${list(todo.map((t) => `[${t.id}] ${t.title}`))}\nUpdate .handoff/tasks.json as you finish each one. Stop when none remain.`;
}
