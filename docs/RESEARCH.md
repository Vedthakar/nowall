# Research: feasibility of automatic agent failover

Date: 2026-10-15. **V** = Verified (source linked or observed locally on the dev machine, with structure inspected but no content copied). **U** = Unverified (secondary source, or not yet reproduced).

Local observations come from reading key names and shapes only. No real session content is in this repo.

---

## TL;DR

1. **Claude Code limit detection is solved deterministically.** The `StopFailure` hook fires with matcher `rate_limit`, the statusline JSON carries `rate_limits.{five_hour,seven_day}.resets_at`, and transcripts record `quotaLimits.resetsAt`. We don't need to scrape a TUI for the primary agent. (V)
2. **Gemini CLI stopped serving individual accounts on 2026-06-18.** Free, AI Pro, and AI Ultra individual accounts were all cut off. Only API-key and Gemini Code Assist enterprise auth still work. Google moved individuals to the **closed-source Antigravity CLI (`agy`)**. **This breaks a locked decision.** (V)
3. **The Qwen Code free OAuth tier was discontinued on 2026-04-15.** The CLI still works, but only with your own provider key. **This breaks the "free fallback" decision.** (V via the project's issue tracker, U for exact dates)
4. **Headless exit codes lie.** `claude -p` exits 0 on a rate limit with `is_error:true`, and Codex exits 1 for every failure. Detection must parse structured output, never the exit code alone. (V)
5. **Nobody ships automatic cross-vendor failover.** The neighbours either *wait for the reset* on the same agent (agent-limit-retry, unsnooze, claude-powernap), *port manually* (Skillsync), or *switch accounts* (FuelSwitch). Our differentiator is real but narrow, and it's easy for incumbents to copy. (U: absence of evidence)

---

## 1. Usage limits and reset tracking (top priority)

### 1.1 Claude Code

| Item | Finding | Status |
|---|---|---|
| Interactive limit text | `You've hit your session limit · resets 3:45pm`, plus `weekly` (`resets Mon 12:00am`), `Opus`, `Sonnet`, `monthly spend`, and `org's monthly spend` variants. [errors doc](https://code.claude.com/docs/en/errors) | V |
| Real-world format | Observed locally: `You've hit your session limit · resets 5:20pm (America/Toronto)`. The **IANA timezone suffix** and **minute-less times** (`resets 9pm`) are not in the docs. The parser must handle both. | V (local) |
| Other limit-ish errors | `API Error: Request rejected (429) …` (transient capacity, **not** a quota), `API Error: Server is temporarily limiting requests (not your usage limit)`, `Credit balance is too low`. | V |
| Hook on limit hit | **`StopFailure`** hook, matcher values include `rate_limit`, `overloaded`, `billing_error`, `authentication_failed`. Output and exit code are ignored, so it's side-effect only, which is exactly what we need. [hooks doc](https://code.claude.com/docs/en/hooks) | V |
| Remaining usage | Statusline stdin JSON: `rate_limits.five_hour.used_percentage`, `.resets_at` (epoch s), same for `seven_day`, plus `spend_limit` behind a gateway. Present only for Pro/Max and only after the first API response. [statusline doc](https://code.claude.com/docs/en/statusline) | V |
| Transcript record | `~/.claude/projects/<slug>/<session>.jsonl`. Assistant lines with `isApiErrorMessage:true`, `error:"rate_limit"`, and a `quotaLimits` object `{status, resetsAt, rateLimitType, overageStatus, …}`. | V (local) |
| Headless behaviour | `claude -p --output-format json` returns `{"type":"result","subtype":"success","is_error":true,"result":"API Error: Rate limit reached"}` and **exits 0**. Still open as of v2.1.267. [#79500](https://github.com/anthropics/claude-code/issues/79500) | V |
| Native auto-continue | v2.1.234+ waits for the reset and continues on its own in interactive mode only. Our wrapper must pre-empt that wait, or we lose the race. [agent-limit-retry README](https://github.com/error0702/agent-limit-retry) | U |
| `/usage` command | Shows reset per window (interactive only). | V |

### 1.2 OpenAI Codex CLI

| Item | Finding | Status |
|---|---|---|
| Limit text | `You've hit your usage limit…try again at <time>`; also `Your workspace is out of credits` and `You hit your spend cap`. [flow-next #515](https://github.com/gmickel/flow-next/issues/515) | U (third-party capture) |
| Exit code | `1` for every failed turn, so it's indistinguishable from other failures. | U |
| Structured signal | `codex exec --json` emits `error` and `turn.failed` events. There's no structured reset time; it lives only in the text. [non-interactive doc](https://learn.chatgpt.com/docs/non-interactive-mode) | V (events) / U (no reset field) |
| Remaining usage | Every `event_msg` with `payload.type=="token_count"` in `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` carries `rate_limits.{primary,secondary}.{used_percent, window_minutes, resets_at}` plus `plan_type` and `limit_id`. **This is the best usage source of any agent.** | V (local) |
| Hooks | 12 events (`SessionStart`, `PostToolUse`, `Stop`, …), in `~/.codex/hooks.json` or `<repo>/.codex/hooks.json`, enabled by default. **No error or rate-limit event.** [hooks doc](https://learn.chatgpt.com/docs/hooks) | V |

### 1.3 Cursor CLI (`cursor-agent`)

| Item | Finding | Status |
|---|---|---|
| Limit text / exit code | **Unknown.** No public capture exists; other projects list it as TODO ([auto-harness #795](https://github.com/jonathanong/auto-harness/issues/795)). We must capture it ourselves, and until then detect generically (`is_error` in JSON, `usage limit\|quota\|upgrade` regex). | U |
| Remaining usage | Not exposed locally. Cursor usage is dashboard-only. | U |
| Hooks | `.cursor/hooks.json`. `stop` has `status: completed\|aborted\|error`, and `sessionEnd` has `reason` and `error_message`. Documented for the IDE agent; **CLI support is not stated**. [hooks doc](https://cursor.com/docs/agent/hooks) | V (IDE) / U (CLI) |
| Auth check | `cursor-agent status --format json` returns `{isAuthenticated, hasAccessToken, …}`. | V (local, v2026.07.09) |

### 1.4 Gemini CLI → Antigravity CLI

| Item | Finding | Status |
|---|---|---|
| **Status** | On 2026-06-18 Gemini CLI stopped serving free, AI Pro, and AI Ultra **individual** accounts. API-key and Code Assist enterprise auth are unaffected. [Discussion #28017](https://github.com/google-gemini/gemini-cli/discussions/28017) | V |
| Gemini CLI limit text | 429 `RESOURCE_EXHAUSTED`, `Quota exceeded for metric: …, limit: N … Please retry in 15.0s.` `limit: 0` means the model isn't on your tier. [#13112](https://github.com/google-gemini/gemini-cli/issues/13112) | V |
| Gemini CLI exit codes | `0` ok, `1` general/API error, `42` input error, `53` turn limit. JSON output is `{response, stats, error?}`. [headless doc](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/headless.md) | V |
| Antigravity CLI (`agy`) | Closed source, single binary (`curl … /cli/install.sh \| bash`). `-p` with `--output-format text\|json\|stream-json`, `-c`/`--conversation <id>` to resume, hooks in `.agents/hooks.json`, reads `AGENTS.md` and `GEMINI.md`. The free individual plan has unpublished weekly limits. [headless doc](https://antigravity.google/docs/cli/headless/) | U (not installed here) |

### 1.5 Qwen Code

| Item | Finding | Status |
|---|---|---|
| Free tier | Qwen OAuth daily allowance went 2,000 → 1,000 → 100/day (2026-04-13), then was **discontinued 2026-04-15**. Now bring-your-own provider only. [inventivehq](https://inventivehq.com/blog/qwen-code-still-free-2026-shutdown), [#3267](https://github.com/QwenLM/qwen-code/issues/3267) | V (consistent across sources) |
| Limit text | `429 Free allocated quota exceeded` (historical). [#1742](https://github.com/QwenLM/qwen-code/issues/1742) | V |

### 1.6 How existing trackers do it

| Tool | Method | Agents |
|---|---|---|
| [ccusage](https://github.com/ryoppippi/ccusage) / `@ccusage/codex` | Parse `~/.claude/projects/**/*.jsonl` and `~/.codex/sessions/**/*.jsonl`, sum `usage` tokens, price with LiteLLM data. Token **counting** only, no limit state. | Claude, Codex |
| [tokscale](https://github.com/junhoyeo/tokscale) | Same idea (Rust), also covers Gemini `~/.gemini/tmp/*/chats`. | Many |
| [agent-limit-retry](https://github.com/error0702/agent-limit-retry) | **Closest to our approach.** Statusline tap saves `rate_limits`, the `StopFailure` hook records the hit plus reset, and it reads `quotaLimits.resetsAt` from transcripts. Then it *waits and resumes the same agent*. | Claude only (OSS) |

**Takeaway:** token counting (ccusage-style) is the wrong primitive for us. We need **limit state**, and it is directly available: Claude via statusline and `StopFailure`, Codex via rollout `rate_limits`. Track `{agent, window, used_pct, resets_at}`, not token sums.

---

## 2. Per-agent sessions, resume, context files, journaling

| | Claude Code | Codex | Cursor CLI | Antigravity (`agy`) | Gemini CLI (API key) |
|---|---|---|---|---|---|
| Sessions | `~/.claude/projects/<slug>/*.jsonl` (V) | `~/.codex/sessions/Y/M/D/rollout-*.jsonl` (V) | `~/.cursor/chats/<h>/<id>/store.db` (SQLite) + `meta.json` (V); format undocumented | unknown | `~/.gemini/tmp/<hash>/chats/` (U) |
| Headless | `-p --output-format stream-json` (V) | `exec --json` (V) | `-p --output-format stream-json --trust` (V) | `-p --output-format stream-json` (U) | `-p --output-format json` (V) |
| Resume | `--resume <id>`, `-c` (V) | `exec resume <id>\|--last` (V) | `--resume <chatId>`, `--continue` (V) | `--conversation <id>`, `-c` (U) | `--resume` (U) |
| Auto-read context | `CLAUDE.md` (V) | `AGENTS.md` (V) | `.cursor/rules`, `AGENTS.md` (U) | `AGENTS.md`, `GEMINI.md` (U) | `GEMINI.md` (V) |
| Deterministic journal hook | Yes: `PostToolUse`, `Stop` (V) | Yes: `PostToolUse`, `Stop` (V) | IDE yes, CLI unclear (U) | Yes: `.agents/hooks.json` (U) | Yes (V) |
| Auto-approve | `--permission-mode acceptEdits` / `--dangerously-skip-permissions` | `--sandbox workspace-write` | `--force` | (U) | `--yolo` |
| Auth check | `claude auth status` (U) | `codex login status` (U) | `status --format json` (V) | interactive login only (U) | env key |
| Install | `curl -fsSL https://claude.ai/install.sh \| bash` | `npm i -g @openai/codex` | `curl https://cursor.com/install -fsS \| bash` | `curl -fsSL https://antigravity.google/cli/install.sh \| bash` | `npm i -g @google/gemini-cli` |

**What's lossy across agents:** thinking blocks (Codex stores `encrypted_content`, which isn't portable), tool-call IDs and their schemas, images, and system prompts. This is exactly why our design doesn't port transcripts: **git + a small journal + reconciliation** avoids every lossy-format problem. Skillsync's "translate everything" approach is the expensive path.

**Journal mechanism decision:** Claude, Codex, and Gemini all support a deterministic `PostToolUse` hook, so the journal is written **by our hook script, not by the model**. The script records `{ts, agent, tool, files}` mechanically. The `task` and `decision` fields still need the model, either through a context-file rule asking it to append one line per completed task or through `Stop`'s `last_assistant_message`. Mechanical lines cost ~0 model tokens.

---

## 3. Competitors

| Project | What it does | Overlap |
|---|---|---|
| [Skillsync](https://yespress.io/skillsync-yc-w26) (YC W26) | Manual, lossless session translation across ~10 agents, plus team sharing | Context transfer. Manual, not automatic. |
| [agent-limit-retry](https://github.com/error0702/agent-limit-retry) | Claude limit detection, `HANDOFF.md`, wait and resume the same agent | **Same detection approach**. No cross-agent switch. |
| unsnooze, claude-powernap | Auto-resume the same agent after reset | Wait, don't switch |
| FuelSwitch AI | Usage gauges plus 1-click *account* switching | Monitoring |
| [OpenCode](https://opencode.ai) | One harness, 75+ providers; switch on rate limit | Switches **models**, not vendor CLIs; can't use Claude subscriptions |
| [parallel-code](https://github.com/johannesjo/parallel-code) | Run agents side by side in worktrees | Manual |

**Honest read:** the space is crowded at the edges, and the specific combination we're building (automatic + cross-vendor CLI + uses existing subscriptions + git-verified handoff) appears unoccupied. The risk is that Skillsync or agent-limit-retry adds an "auto" mode. Our moat is execution and trust (local-only, checkpointed, verified handoffs), not the idea.

---

## 4. Risks and changes to the plan

| # | Locked decision | Problem | Proposed fix | Severity |
|---|---|---|---|---|
| R1 | v0.1 agents include **Gemini CLI** | Dead for individual accounts since 2026-06-18 | Replace it with an **Antigravity CLI (`agy`)** adapter. Keep a Gemini CLI adapter only for API-key users (post-v0.1). Note that `agy` is closed source, but it's a headless terminal CLI with resume, hooks, and AGENTS.md, so it fits our model. (The brief's exclusion was the Antigravity *IDE*.) | **Breaks locked decision** |
| R2 | Free fallback = **Qwen Code** OAuth | Free tier discontinued 2026-04-15 | Free fallback becomes: (a) the Antigravity free individual tier (sign in with own Google account), and/or (b) Qwen Code or OpenCode pointed at the user's own **OpenRouter free models** or DeepSeek/Kimi/GLM key. All are still opt-in, and the China consent screen still applies to DeepSeek/Kimi/GLM. | **Breaks locked decision** |
| R3 | "User keeps typing `claude`" | Claude v2.1.234+ auto-waits on a limit in interactive mode, so it never exits | The wrapper reacts to the `StopFailure` signal file, not process exit. It then gracefully terminates the waiting `claude` and starts the next agent. | Design detail, not a blocker |
| R4 | Detect via exit codes | Exit codes are unreliable (Claude exits 0, Codex 1 for everything) | Layered detection: (1) hook signal file, (2) structured `is_error`/`turn.failed`, (3) text regex, (4) exit code last | Design detail |
| R5 | Cursor CLI adapter | Limit error format is unknown; hooks may not run in the CLI | Generic detector first; capture the real string when Ved hits a Cursor limit; ship Cursor as "beta" | Medium |
| R6 | Usage tracking | Cursor and Antigravity don't expose remaining usage locally | Track **observed** cooldowns (we saw a limit, parsed reset, else default backoff 5h) for those agents; use real `rate_limits` for Claude and Codex | Low |
| R7 | Dev-machine readiness | `claude` and `codex` CLIs are **not on PATH** here (data dirs exist, probably from the desktop apps). Only `cursor-agent` is installed and signed in. | Ved installs the Claude Code CLI and the Codex CLI to run the real end-to-end demo. The simulated fake-agent tests don't need them. | Blocker for the real demo only |
| R8 | Moat | Easy to copy | Ship fast; win on trust (local-only, checkpoints, verified reconciliation) | Strategic |

Everything else in the locked table holds: TypeScript/npm distribution (all target CLIs except `agy` and Cursor are npm or curl; Node is fine), the hybrid journal + git + reconciliation design, wrapper-triggered handoff, checkpoints, and zero hosting.

### Decisions taken (2026-10-15, Ved)

- **R1:** Antigravity CLI (`agy`) replaces Gemini CLI as the v0.1 Google adapter. Gemini CLI (API key) moves to the roadmap.
- **R2:** The free fallback is **own-key only**. Users bring their own provider key (OpenRouter, DeepSeek, Kimi, GLM) through Qwen Code or OpenCode. We don't depend on any hosted free tier. Off by default; the China consent screen still applies.
