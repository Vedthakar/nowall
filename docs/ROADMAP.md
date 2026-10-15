# Roadmap (not in v0.1)

- **Proactive handoff:** read Claude's statusline `rate_limits` and hand off at ~95% instead of waiting for the wall.
- **Codex as primary:** watch `~/.codex/sessions/**/rollout-*.jsonl` `rate_limits` for interactive Codex sessions.
- **Return to Claude** automatically when its cooldown ends (for long tasks).
- **Gemini CLI adapter** for API-key / Code Assist users.
- **Capture real Cursor and Antigravity limit messages** and add exact patterns plus fixtures.
- **Fixture generator** that produces synthetic session files matching each agent's schema (for parser regression tests).
- **New terminal window** for the destination agent (macOS `osascript`), as an option.
- **Homebrew formula**; Linux CI; Windows later.
- **Launch:** README GIF, Show HN, etc. (Phase 4).
