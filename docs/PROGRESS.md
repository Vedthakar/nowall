# Progress

Last updated 2026-10-15.

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
- [ ] **Full real failover (Claude → Cursor).** Blocked on Ved: run `cursor-agent login`. Real Claude usage limits can't be triggered on demand, so the trigger itself is covered by fixtures that match real transcripts.

## Not yet verified
- Cursor's exact usage-limit message (generic detection is in place)
- Antigravity's headless output (not installed here)
- Codex `exec resume` flag order (not installed here)
