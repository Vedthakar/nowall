# Security review (v0.1)

Date: 2026-10-15. Scope: everything nowall reads, writes, runs or prints. Each finding has a regression test.

## Threat model

nowall runs with the user's privileges, inside repositories the user may not fully trust (cloned code), and feeds text into coding agents that can edit files and run commands. The attacker we care about controls **repository contents** (files, names, paths, committed dotfiles) or **agent output**. Out of scope: an attacker who already runs code as the user, and the agents' own trust decisions about a repo (e.g. a repo's committed `.claude/settings.json`).

## Findings and fixes

| # | Severity | Finding | Fix | Test |
|---|---|---|---|---|
| 1 | **High** | **ReDoS in redaction.** The secret-name, URL-credential and email regexes backtracked quadratically: 200 KB of `x.x.x.` took **130 s**. Any agent output or file content could hang nowall. | Rewrote with bounded, anchored quantifiers plus a lookbehind; all adversarial inputs now finish in 2–14 ms. | `redact.test.ts` "linear time" (7 inputs, <500 ms each) |
| 2 | **High** | **Symlink write-through.** A repo could commit `.claude/settings.local.json → ~/.zshrc` (or `.handoff/journal.jsonl → anywhere`); `nowall init` and hooks would overwrite the target. | All repo writes go through `fsafe.ts`: `O_NOFOLLOW` appends, exclusive temp file + atomic rename (replaces the link, never follows it), size-capped reads. User-level dotfiles (which may legitimately be symlinks) are resolved explicitly. | `hooks-init.test.ts` "never writes through a planted symlink" |
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

## Properties that hold

- nowall never reads, stores or transmits agent credentials. Each CLI keeps its own login.
- Nothing leaves the machine except through agents the user already signed in to.
- Everything persisted (journal, packets, prompts, state, status, summaries) is redacted, including the exact values from the repo's `.env*` files.
- Hooks never fail an agent turn: they exit 0 and print nothing, except Claude's `SessionStart` context.

## Not covered (known limits)

- A repo's own committed agent config (e.g. `.claude/settings.json` hooks) is the agent's trust decision, not nowall's.
- Headless agents run with edit-only permissions by default, but they can still be prompt-injected by repository content like any coding agent. `--yolo` widens that blast radius and is opt-in.
- The notch app is ad-hoc signed, not notarized. That's fine for npm installs; a signed, notarized build is needed before distributing it as a download.
