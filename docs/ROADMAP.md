# Roadmap

- **Notch for Linux.** The macOS notch is native SwiftUI and the Windows tray app is C#/WinForms (see [ARCHITECTURE](ARCHITECTURE.md#windows-tray-app)). Linux needs its own, reading the same `~/.config/nowall/status` files.
- **Windows tray app:** hotkeys, a Settings window, chat titles, and opening a chat from its row.
- **Publish:** claim `nowall` on npm, make the repo public, and sign + notarize the notch app for downloads.
- **Proactive handoff:** use Claude's 5h/weekly usage (statusline) to hand off at ~95% instead of at the wall.
- **Return to Claude** automatically when its cooldown ends, for long tasks.
- **Codex as primary** (watch its rollout `rate_limits` live).
- **Gemini CLI adapter** for API-key / Code Assist users.
- **Capture real Cursor and Antigravity limit messages** and add exact patterns.
- **Notch:** click a session to open its log, a setting for its position, and launch animations.
- **Homebrew formula.**
- **Launch materials** (Phase 4).
