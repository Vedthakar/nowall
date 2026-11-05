# Design: Cursor chats in the notch, concurrent sessions, usage rings, accounts and a priority queue

Date: 2026-11-05. Status: implemented in this change set.

## What was wrong (root causes, all reproduced)

1. **Cursor IDE chats never appeared.** `nowall setup` installs only an `afterFileEdit` hook in
   `~/.cursor/hooks.json`. Cursor runs *user-level* hooks with the working directory `~/.cursor`
   (documented), and `handleHook` used `input.cwd ?? process.cwd()` to find the repo. `~/.cursor` is
   not a git repo, so every Cursor hook returned early and wrote nothing. The payload does carry
   `workspace_roots` and `session_id`, and the env carries `CURSOR_PROJECT_DIR`; none were read.
   (PATH was not the problem: Cursor's hook environment includes the user's shell PATH.)
   Found while verifying live: Cursor *also* runs the Claude-format hooks in
   `~/.claude/settings.json`, so every Cursor event reached nowall a second time as
   `--agent claude` about 0.4 s later and overwrote the status as "Claude". That is why the few
   Cursor chats that did get through (via `CLAUDE_PROJECT_DIR`) looked like Claude Code sessions.
   `handleHook` now ignores Cursor-shaped payloads (`conversation_id`, `workspace_roots`,
   camelCase `hook_event_name`) unless they arrive as `--agent cursor`.
2. **Only one session at a time.** The collapsed notch rendered `store.primary` (the single most
   recently updated session). Two agents working at once collapsed into one glyph.
3. **No usage rings.** Agent icons only drew a ring while cooling down. Claude (5h + 7-day) and
   Codex (5h + week) usage windows were already collected but only shown as a bar in the card.
4. **No accounts.** `order` was a list of agent ids; one login per agent.

## Decisions

- **"Chats" means Cursor IDE agent chats.** Evidence: zero Cursor status files ever written; the
  Claude desktop app's sessions (including Cowork scratch workspaces) already appear.
- **Accounts are profiles, not stored logins.** nowall still never reads an agent's own credentials.
  An extra account is a separate login the user does once, in an isolated profile:
  - Claude Code: `CLAUDE_CONFIG_DIR=~/.config/nowall/profiles/claude-<label>` (documented by
    Anthropic for multiple accounts; the Keychain entry is keyed to that directory).
  - Codex: `CODEX_HOME=~/.config/nowall/profiles/codex-<label>`.
  - Cursor CLI: its login lives in one Keychain item with no profile support, so extra Cursor
    accounts use an API key (`CURSOR_API_KEY`, created at cursor.com → Settings). The key is the one
    secret nowall keeps, and only because the user hands it over explicitly: it goes in the macOS
    Keychain under service `nowall` (a `0600` file on Linux) and is passed to `cursor-agent` only as
    an environment variable.
  - Antigravity / Qwen: no verified profile mechanism; extra accounts are not offered.
- **The priority queue is a list of account ids.** `config.order` becomes `string[]` of account ids:
  the default account of an agent is just `"claude"`, extras are `"claude:work"`. Existing configs
  (agent ids only) are valid as-is. Cooldowns and limits are tracked per account id in `state.json`.
- **Daily ring = the agent's short window.** Claude and Codex expose a rolling 5-hour window and a
  7-day window; there is no daily window. Inner ring = short window, outer ring = weekly.
  Cursor exposes no usage windows to the CLI or hooks, so its icon has no usage ring (it still gets
  the cooldown ring when it hits a limit).
- **Priority queue UI lives in the notch.** Right-click → *Settings…* opens a small window with the
  accounts in order, ▲/▼ and drag to reorder, and a checkbox to include each account. It rewrites only
  `order` in `config.json` (other keys preserved). Adding an account needs a terminal login, so the
  window shows the exact `nowall account add …` command instead of trying to log in itself.

## Changes

### Hooks (`src/hooks.ts`, `src/adapters/others.ts`)
- Repo lookup order: `input.cwd` → `input.workspace_roots[0]` → `env.CURSOR_PROJECT_DIR` →
  `env.CLAUDE_PROJECT_DIR` → `process.cwd()`.
- Cursor user and project hooks: `sessionStart`, `beforeSubmitPrompt`, `afterFileEdit`,
  `afterShellExecution`, `stop`, `sessionEnd`. Cursor's `stop` maps to `your-turn`
  (`status: error` → detail says so). Cursor's `beforeSubmitPrompt` answers `{"continue":true}` and
  `sessionStart` answers `{"additional_context": …}` (Claude keeps its own output format).
- The hook attributes the event to an account: the agent's profile env var in the hook's environment
  (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`) is matched against configured accounts; otherwise the default.

### Accounts (`src/accounts.ts`, `src/schemas.ts`, `src/state.ts`, `src/supervisor.ts`)
- `Config.accounts?: { id, agent, label, env?, secret? }[]`; `Config.order: string[]` of account ids.
- `State.agents` keyed by account id. `recordLimit`, `isCoolingDown`, `pickNext`, `earliestReset`
  take account ids. `pickNext` requires the account's agent to be enabled and available.
- Supervisor segments record `account`; headless turns run with the account's env (secret resolved
  at spawn time, never written anywhere). Summary names the account when it is not the default.
- `refreshAgents` writes `accounts: [...]` into `agents.json` (one entry per account, in order,
  with sign-in, cooldown and usage). Claude sign-in uses `claude auth status --json` per profile.
- CLI: `nowall account add <agent> <label> [--api-key]`, `nowall account list`,
  `nowall account remove <id>`, `nowall order [ids…]`.

### Notch (`notch/NowallNotch.swift`)
- Collapsed: one `PhaseGlyph` per active session (working / needs-input / handing-off), newest
  first, up to four, each in its agent's colour; a session stuck in `working` with no update for
  30 minutes is treated as idle. Below: one icon per account in priority order.
- `AgentIcon` draws two concentric arcs from `usage`: inner = short window, outer = weekly. Orange
  past 85 %. The cooldown ring replaces both while an account is limited.
- Expanded card lists up to five sessions and every account with label and status.
- Settings window: reorder and include/exclude accounts; writes `config.json`.

## Not in this change
- Reading Claude's usage without the status line. Claude only reports 5h/7-day usage to the status
  line, which runs in terminal sessions (Pro/Max/Ultra). Querying it otherwise means reading Claude's
  OAuth token, which nowall does not do. Rings fill in as soon as any terminal Claude Code turn runs.
- Cursor usage percentages (not exposed outside the Cursor dashboard).
- Taking over *from* Cursor on a Cursor usage limit (no limit signal in Cursor hooks yet).

## Testing
- Unit: Cursor payload shapes (cwd from `workspace_roots`, `session_id`), account parsing and
  migration of old configs, `pickNext` over accounts, per-account cooldowns.
- E2E with fake agents: Claude → Claude (second account, different `CLAUDE_CONFIG_DIR`) → Cursor,
  plus the existing Codex and Antigravity paths.
- Notch: built with `scripts/build-notch.sh`; snapshots rendered from a synthetic home.
