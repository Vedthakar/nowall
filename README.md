# nowall

**Stay in the tools you already use. We handle the wall.**

You work in Claude Code like always. When it hits its usage limit mid-task, nowall quietly hands the work to the next coding agent you have (Codex, Cursor, Antigravity) with the full context of what was being built. When the job is done, you get one message:

```
Your task is done. The last part was built by Codex because Claude Code hit its session limit (resets 11:59 PM).

  1. Claude Code: 3 files changed, 120 insertions(+) (hit session limit)
  2. Codex: 2 files changed, 64 insertions(+) (finished)

Every step is checkpointed: `nowall undo <step>` rolls files back to the end of that step (0 = before any of it).
Keep going interactively: codex resume 019a...
```

Runs entirely on your machine. No account, no server, and nowall never touches your credentials.

> Status: v0.1, private alpha. Claude Code → other agents is the supported path. See [docs/PROGRESS.md](docs/PROGRESS.md).

## Install

```bash
npm i -g nowall
```

```bash
cd your-project && nowall init
```

`init` shows exactly what it will write, checks which agents you have installed and signed in, installs small journaling hooks, and optionally adds a `claude` shell function so you keep typing `claude` as normal. Without the alias, start sessions with `nowall run claude`.

## How it works

1. **Journal.** While you work, agent hooks append tiny lines to `.handoff/journal.jsonl`: your requests, files edited, commands run, and one line per finished task. That costs about 100–300 tokens per session, and secrets are redacted before anything is written.
2. **Detect.** Claude Code's `StopFailure` hook fires on a rate limit. nowall reads the exact reset time, stops the waiting session, and records a cooldown. For other agents it parses their structured output, because exit codes are unreliable: `claude -p` exits 0 on a limit.
3. **Checkpoint.** It snapshots your working tree to `refs/heads/nowall/<session>/<n>`. Your branch, index and files are untouched.
4. **Hand off.** It picks the next agent in your order that is installed, signed in and not cooling down, and starts it with a handoff packet: your goal, decisions, claimed-done tasks, remaining tasks, and the git diff since the session began.
5. **Reconcile.** The new agent's first job is to check every "done" claim against `git diff` (git is the source of truth; the journal is only a hint), write a verified `.handoff/tasks.json`, and then keep working.
6. **Stop.** It stops when no tasks remain, nothing changed for N turns, or it hits max turns or max time. If every agent is limited it pauses and tells you the earliest reset.

## Supported agents

| Agent | Role | Limit detection | Status |
|---|---|---|---|
| Claude Code | Primary (interactive) + destination | `StopFailure` hook + transcript reset time | Stable |
| Codex CLI | Destination | `codex exec --json` error events | Beta |
| Cursor CLI | Destination | stream-json `is_error` + text patterns | Beta (limit text not yet captured) |
| Antigravity CLI (`agy`) | Destination | stream-json + text patterns | Beta |
| Qwen Code (own key) | Opt-in fallback | stream-json + text patterns | Beta, off by default |

Gemini CLI stopped serving individual Google accounts on 2026-06-18; Antigravity replaces it. See [docs/RESEARCH.md](docs/RESEARCH.md).

## Commands

| Command | What it does |
|---|---|
| `nowall init [--alias] [--fallback] [--yolo]` | Set up the current repo |
| `nowall run claude [args]` | Run Claude Code under nowall (the alias does this) |
| `nowall status` | Agents, sign-in, cooldowns, last session, checkpoints |
| `nowall undo [n]` | List checkpoints or restore files to one (a safety checkpoint is taken first) |
| `nowall note --task "..."` | Used by agents to log a finished task |
| `nowall uninstall` | Remove hooks and the alias; your data stays |

## Privacy and safety

- **Local only.** Nothing is sent anywhere by nowall. Work continues only through agents you have installed and signed in to yourself.
- **No credentials.** nowall never reads, stores, or asks for agent logins or API keys. Each CLI handles its own login.
- **Redaction.** API keys, tokens, JWTs, private keys, URL credentials, and the values in your `.env` files are stripped from the journal, handoff packets, prompts, and state.
- **Undoable.** Every handoff is checkpointed to a git ref. Nothing is committed to your branch.
- **Safe defaults.** Headless agents can't show approval prompts, so they run edit-only (Claude `acceptEdits`, Codex `workspace-write` sandbox, Cursor without `--force`). Full auto-approve needs `nowall init --yolo`.
- **China-hosted models** (DeepSeek, Kimi, GLM via Qwen Code) are off by default and need an explicit "yes" after a clear notice.

## Configuration

`~/.config/nowall/config.json`:

```json
{
  "v": 1,
  "order": ["claude", "codex", "cursor", "antigravity", "qwen"],
  "yolo": false,
  "stop": { "maxTurns": 30, "maxMinutes": 120, "noDiffTurns": 3 },
  "defaultCooldownMinutes": 300
}
```

## Development

```bash
npm install
```

```bash
npm test
```

Tests never touch real agents. `scripts/fake-agent.mjs` plays Claude, Codex, and Cursor with their real output formats and limit errors, and it fires the hooks that `init` installs.

## License

MIT
