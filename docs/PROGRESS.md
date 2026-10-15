# Progress

Last updated 2026-10-15.

## Setup (brief §2)
- [x] Project folder `~/Documents/Personal Coding/nowall`
- [x] Private GitHub repo, `main` branch
- [x] Sole authorship verified after every commit; attribution off in `.claude/settings.json`
- [x] `.gitignore`, `.env.example`, gitleaks pre-commit hook (tested with a fake key) + GitHub Action
- [x] Naming check → `docs/NAMING.md`

## Phase 1–2
- [x] Research → `docs/RESEARCH.md` (Gemini CLI → Antigravity; own-key fallback, both decided by Ved)
- [x] Architecture → `docs/ARCHITECTURE.md`

## Phase 3 (v0.1 build)
- [x] 1. Scaffold: TypeScript, Biome, Vitest, CI
- [x] 2. Limit detection + reset-time parsing (IANA zones, DST, Claude/Codex/Gemini/Qwen formats)
- [x] 3. Cooldown state + next-agent selection
- [x] 4. Journal (hooks + `nowall note`) + redaction
- [x] 5. Handoff packet + versioned master prompt
- [x] 6. Adapters: Claude Code, Codex, Cursor, Antigravity, Qwen
- [x] 7. Supervisor: hook signal → stop agent → checkpoint → hand off → stop conditions
- [x] 8. End-of-task summary
- [x] 9. `init` with consent screen, hook install, optional shell alias; `uninstall`
- [x] 10. Opt-in own-key fallback (Qwen Code), China consent, off by default
- [x] 11. README

## Definition of done (brief §5)
- [x] `init` sets up a repo (tested with fake agents)
- [x] Simulated limit hit → automatic continuation with context (e2e tests)
- [x] Destination writes a verified task list and keeps going until a stop condition
- [x] Every handoff checkpointed and undoable (`nowall undo`)
- [x] End summary names who built what
- [x] gitleaks clean; all fixtures synthetic
- [x] Every commit authored by Ved only
- [x] Private repo with clean history
- [ ] **Real-agent run on a fresh Mac.** Blocked on Ved: install the Claude Code CLI and the Codex CLI (only `cursor-agent` is on PATH today).

## Unverified against real installs (needs a live check)
- Codex `exec resume` flag placement
- Cursor CLI usage-limit message text, and whether its hooks run in the CLI
- Antigravity headless stream format and resume flag
- Whether killing an interactive Claude session that is waiting on a limit restores the terminal cleanly
