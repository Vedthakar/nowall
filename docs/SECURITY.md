# Security review

Reviewed for v0.1 on 2026-10-15, and again for v0.3.1 on 2026-11-07 ([findings below](#review-for-v031)). Scope: everything nowall reads, writes, runs or prints. Each finding has a regression test.

## Threat model

nowall runs with the user's privileges, inside repositories the user may not fully trust (cloned code), and feeds text into coding agents that can edit files and run commands. The attacker we care about controls **repository contents** (files, names, paths, committed dotfiles) or **agent output**. Out of scope: an attacker who already runs code as the user, and the agents' own trust decisions about a repo (e.g. a repo's committed `.claude/settings.json`).

## Findings and fixes

| # | Severity | Finding | Fix | Test |
|---|---|---|---|---|
| 1 | **High** | **ReDoS in redaction.** The secret-name, URL-credential and email regexes backtracked quadratically: 200 KB of `x.x.x.` took **130 s**. Any agent output or file content could hang nowall. | Rewrote with bounded, anchored quantifiers plus a lookbehind; all adversarial inputs now finish in 2–14 ms. | `redact.test.ts` "linear time" (7 inputs, <500 ms each) |
| 2 | **High** | **Symlink write-through.** A repo could commit `.claude/settings.local.json → ~/.zshrc` (or `.handoff/journal.jsonl → anywhere`); `nowall init` and hooks would overwrite the target. | All repo writes go through `fsafe.ts`: `O_NOFOLLOW` appends, exclusive temp file + atomic rename (replaces the link, never follows it), size-capped reads. User-level dotfiles (which may legitimately be symlinks) are resolved explicitly. Windows has no `O_NOFOLLOW`, so there a link is checked just before opening, which is weaker because of the gap between the check and the open. | `hooks-init.test.ts` "never writes through a planted symlink" |
| 3 | **High** | **Planted context.** A repo that commits `.handoff/` could feed the next agent forged goals or tasks (prompt injection with edit rights). | nowall refuses repos that commit or symlink `.handoff/` (`init`, `run`, hooks, `takeover`). Per-repo mode also requires the repo to be in the user's own trusted list. | "refuses a repo that commits .handoff/", "refuses a symlinked .handoff" |
| 4 | Medium | **Prompt injection via recorded text.** Journal lines, file names or commit messages could close the `<handoff>` block or pose as instructions. | Recorded text is fenced (no `</handoff>`, one line each, length-capped), and the master prompt states that the block is data, not orders. | `packet.test.ts` |
| 5 | Medium | **Shell injection in hook commands and the Terminal script.** Paths with quotes, `$` or spaces were interpolated into `sh` command strings. | Single-quote escaping (`shq`) everywhere; the Terminal takeover passes values via exported env vars with a constant command string. | "quotes hostile repo paths…" (a path containing `$(touch PWNED)` runs nothing) |
| 6 | Medium | **Terminal escape injection.** Agent output (or repo-derived ids in the summary) could emit OSC/CSI sequences: retitle the terminal, write the clipboard, fake output. | `sanitizeTerminal()` strips OSC, CSI, ESC and C0/C1 control characters from everything printed. | "sanitizeTerminal" |
| 7 | Medium | **Secrets in snapshots.** Checkpoints include untracked files, so an un-ignored `.env` or key file would be committed to a ref, and refs under `refs/heads` are pushed by `git push --all`. | Checkpoints moved to hidden `refs/nowall/…` (never pushed, not shown as branches); `.env*`, `*.pem`, `*.key`, `id_rsa*`, `.npmrc`, `.netrc` and similar are dropped from every snapshot. | "honours .gitignore", e2e ref checks |
| 8 | Medium | **Destructive undo.** `git restore` without overlay deletes files that aren't in the checkpoint, including untracked work. | `restore --overlay`: undo never deletes files, and takes a safety checkpoint first. | "undo restores files to a checkpoint" |
| 9 | Low | **Session id injection.** `NOWALL_SID` or a repo's `session.json` could carry `../` into ref names and file paths. | Session ids are validated (`^[sc]_[A-Za-z0-9-]{1,64}$`) at every entry point. | "rejects malformed session ids" |
| 10 | Low | **Resource exhaustion.** Huge transcripts, journals or task files were read whole. | Tail reads (1–2 MB), size caps, journal rotation at 5 MB, and runaway single messages clipped in the display. | `scripts/stress.mjs` |
| 11 | Low | **Concurrent sessions** in one repo could clobber each other's session state. | Per-repo lock with PID liveness check; a second session runs without failover and says so. | "a second concurrent session…" |
| 12 | Low | **Stale task list** from an earlier session could end a new session immediately. | The previous `tasks.json` is archived at every session start. | "a stale tasks.json…" |
| 13 | Info | **Fake "signed in".** Cursor's `status --format json` reports `isAuthenticated: true` with an expired login. | Stricter detection, plus failover skips any agent that returns an auth error and tells the user the login command. | "skips an agent that isn't signed in" |

## Review for v0.3.1

Date: 2026-11-07. The review ran 50 attack checks against the CLI and notch, and 63 user journey and edge case checks from a packed install on a clean home, using stand-in agents.

| # | Severity | Finding | Fix |
|---|---|---|---|
| 14 | Medium | **Hotkeys could take over normal typing.** The recorder accepted `cmd+n` and `shift+n`, so New Window or a capital N could hand off a session, and with `yolo` on the agent could then run commands. | Letters and numbers need a safe pair of modifiers, and a saved unsafe shortcut falls back to the default. |
| 15 | Medium | **An unattended takeover could act beyond the computer.** One planned to merge and publish because the user's request asked for it. It was stopped before doing so. | The handoff prompt says pushing, merging, deploying and publishing wait for the user. This is an instruction to the agent, not enforcement: with `yolo` on it can still run them. |
| 16 | Low | **Path traversal in `nowall open --sid`.** It could read a JSON file outside the status folder and open Terminal at a path inside it. Needs local command access. | A session id can only name a file in the status folder. |
| 17 | Low | **A wrong folder could be read as a login.** Account folders were found by position, and the notch saves settings in sorted order, so a real login showed as signed out and `--purge` missed it. | `profileFolder()` asks for the folder by name, everywhere. |
| 18 | Low | **Pasted API keys could show on screen.** The setup wizard muted input through a Node private that no longer exists, and silently stopped muting. | Hidden prompts now send readline's output nowhere, with no private APIs. |

Attacks that found nothing: shell injection through repo names and status files; hostile `.handoff` symlinks; deleting folders outside `profiles`; secrets reaching the journal, prompts, logs or checkpoints; malformed, huge or looping status and config files; `/dev/zero` and FIFOs as transcript paths; and git hooks running on checkpoints. (Only `reference-transaction` runs, as it does for any ref update, and a clone can't carry hooks.)

Since v0.3, an extra Cursor account's login sits in `auth.json` in that account's folder under `profiles`, written by Cursor's CLI with its own permissions rather than kept in the Keychain. nowall doesn't read it. The folder is `0700`, and `nowall account remove <id> --purge` deletes it.

## Properties that hold

- nowall never reads, stores or transmits agent credentials. Each CLI keeps its own login.
- Nothing leaves the machine except through agents the user already signed in to.
- Everything persisted (journal, packets, prompts, state, status, summaries) is redacted, including the exact values from the repo's `.env*` files.
- Hooks never fail an agent turn: they exit 0 and print nothing, except Claude's `SessionStart` context.

## Not covered (known limits)

- A repo's own committed agent config (e.g. `.claude/settings.json` hooks) is the agent's trust decision, not nowall's.
- Headless agents run with edit-only permissions by default, but they can still be prompt-injected by repository content like any coding agent. `--yolo` widens that blast radius and is opt-in.
- The notch app is ad-hoc signed, not notarized. That's fine for npm installs; a signed, notarized build is needed before distributing it as a download.
