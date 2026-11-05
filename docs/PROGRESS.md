# Progress

Last updated 2026-11-05.

## Multi-session, accounts, rings (2026-11-05)
- [x] Fixed: Cursor IDE chats never showed in the notch. User-level Cursor hooks run from `~/.cursor`, so the repo was wrong; now taken from `workspace_roots` / `CURSOR_PROJECT_DIR`. All six Cursor lifecycle events are hooked (start, prompt, edit, shell, stop, end), so a chat shows while it loads and when it finishes.
- [x] Fixed: Cursor chats that did get through were labelled "Claude" (Cursor also runs Claude-format hooks; the duplicate copy is now ignored).
- [x] Notch shows one animated glyph per session running at the same time (up to 4, then "+n"); sessions silent for 30 min are treated as idle.
- [x] Usage rings on every account icon: outer = week, inner = short window (Claude 5h / Codex window), orange past 85%. Cooldown ring unchanged.
- [x] Accounts: `nowall account add claude|codex <label>` (own profile dir + the agent's own login), `nowall account add cursor <label> --api-key` (Keychain / 0600 file). Per-account cooldowns, failover across accounts, hooks attribute limits to the right account. `nowall order` and the notch's Settings window (drag or arrows, tick to include) edit the takeover order.
- [x] Fallback verified with fake agents: Claude → Codex → Cursor, Claude → Antigravity → Qwen, Claude → Claude (work) → Cursor (API key).
- [ ] Claude usage rings need a terminal Claude Code turn (status line); the desktop app never reports usage. Cursor has no usage % to show.
- [ ] A takeover *from* a Cursor chat (Cursor hits its limit in the IDE) is not wired: Cursor's `stop` hook has no limit information.

## v0.1 build (brief §4, Phase 3)
- [x] Scaffold, CI (lint, typecheck, tests, notch build), gitleaks hook + Action
- [x] Limit detection + reset parsing (IANA zones, DST; Claude, Codex, Gemini, Qwen formats)
- [x] Cooldown tracking + next-agent selection
- [x] Journal (hooks + `nowall note`) + redaction
- [x] Handoff packet + versioned master prompt with reconciliation
- [x] Adapters: Claude Code, Cursor, Codex, Antigravity, Qwen (own key)
- [x] Supervisor: checkpoint → hand off → stop conditions → one summary
- [x] `init` / `setup` with consent; opt-in fallback with China consent; README

## Hardening (pen test, stress, journeys)
- [x] Pen test: 13 findings fixed, see [SECURITY.md](SECURITY.md)
- [x] Stress suite (`npm run stress`): 25k-file repo, 40 concurrent hooks, 60k journal lines, 21 MB of agent output
- [x] Hook latency 370 ms → ~65–100 ms (no git on the hot path); warm snapshot 5.5 s → 1.1 s
- [x] Fixed: output truncated when piped (exit before flush)
- [x] Fixed: base snapshot raced the agent's first edit
- [x] Fixed: re-running init duplicated hooks
- [x] Fixed: agents with an expired login looked signed in; failover now skips them and says how to sign in
- [x] Every CLI journey covered (`test/journeys.test.ts`), plus a real Terminal-window takeover verified from an installed tarball

## New (Ved's requests)
- [x] Works with the Claude **desktop app**: a limit there is taken over in the background
- [x] No pop-ups: background takeover by default (`nowall logs` to watch)
- [x] macOS notch: live status, who built what, task progress, needs-input, usage and reset countdowns, hover pop-outs, animations
- [x] One-command install (`install.sh` / `nowall setup`): auto-detects agents, user-level hooks, starts the notch at login
- [x] `nowall demo`: see the whole flow without spending usage

## Verified against real agents
- [x] Real Claude Code 2.1.295 accepts nowall's hook config; SessionStart and prompt hooks fire and journal correctly
- [x] Real Claude's auth-failure output captured and handled
- [x] Real Cursor CLI (2026.07.09): expired-login state detected correctly
- [x] **Full real failover (Claude → Cursor), 2026-10-20.** Claude hit its monthly spend limit mid-task in a real project; nowall took over silently in the background and Cursor finished it (14 files, +320/−36), with checkpoints and a summary.

## Not yet verified
- Cursor's exact usage-limit message (generic detection is in place)
- Antigravity's headless output (not installed here; chain verified with a fake agent only)
- Codex `exec resume` flag order (not installed here)
- A real second Claude account through `CLAUDE_CONFIG_DIR` (the mechanism is Anthropic-documented; verified with fake agents)
- A real second Cursor account through `CURSOR_API_KEY` (the Cursor CLI here is not signed in)
