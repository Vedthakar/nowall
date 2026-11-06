# nowall

Automatic failover for AI coding agents, with a live status notch for macOS.

When Claude Code hits its usage limit mid-task, nowall saves your work and continues the task in the next coding agent you're signed in to, with the full context. A small notch on the edge of your screen shows what each agent is doing.

<p align="center">
  <img src="docs/images/notch-tab.png" alt="The collapsed nowall notch on the right edge of the screen" height="340">
  &nbsp;&nbsp;
  <img src="docs/images/notch-card.png" alt="The nowall notch expanded on hover, showing the active session and each account" height="340">
</p>

When the task finishes, you get one summary:

```
Your task is done. The last part was built by Cursor because Claude Code hit its session limit (resets 11:59 PM).

  1. Claude Code: 3 files changed, 120 insertions(+) (hit session limit)
  2. Cursor: 2 files changed, 64 insertions(+) (finished)
```

nowall runs entirely on your computer. It has no account, server or telemetry, and each agent keeps its own login.

## Requirements

- **Node.js 20 or newer** and **git**
- **macOS 13 or newer** for the notch (Apple Silicon or Intel)
- **Linux:** failover and all commands work, but there is no notch yet
- **Windows:** not supported yet
- **A git repository:** nowall works inside git repos and ignores other folders
- **At least two agents** for failover, for example Claude Code and the Cursor CLI

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/Vedthakar/nowall/main/install.sh | sh
```

The installer downloads the prebuilt release, finds your agents, adds its hooks, and starts the notch. There is nothing to configure per project.

To review each step yourself, run the same install by hand:

```bash
npm install -g https://github.com/Vedthakar/nowall/releases/latest/download/nowall.tgz
```

```bash
nowall setup
```

Run on its own, `nowall setup` also offers to add extra accounts.

If setup reports an agent that isn't signed in, run the login command it prints. nowall never signs in for you and never handles your agent logins.

To let Claude Code do the install, paste this prompt:

> Install nowall on this computer: run `curl -fsSL https://raw.githubusercontent.com/Vedthakar/nowall/main/install.sh | sh`. Then run `nowall agents` and tell me which coding agents it found, and the exact command for any agent I still need to sign in to.

### Try it first

To see a full failover without using any real agent or usage, run this after installing:

```bash
nowall demo
```

## Supported tools

| Tool | Shown in the notch | Limit starts a failover | Can take over a task | Tested against |
|---|---|---|---|---|
| Claude Code (desktop app) | Yes | Yes | No (needs the CLI) | Real app |
| Claude Code (CLI) | Yes | Yes | Yes | Real CLI |
| Cursor (`cursor-agent`) | Yes | Only while taking over | Yes | Real CLI |
| Cursor (IDE chats) | Yes | No | No | Real app |
| Codex CLI | Yes | Only while taking over | Yes | Simulated |
| Antigravity CLI (`agy`) | While taking over | Only while taking over | Yes | Simulated |
| Qwen Code, with your own key | While taking over | Only while taking over | Yes (opt-in) | Simulated |

"Simulated" means the tool's documented formats are covered by automated tests, but it has not yet run against a real install. Reports are welcome.

Gemini CLI stopped serving personal Google accounts in June 2026. Antigravity CLI replaces it for those accounts.

## The notch

The notch is a small black tab on the right edge of your screen. It shows one symbol per active session, then one icon per account.

| Symbol | Meaning |
|---|---|
| Bouncing dots | An agent is working |
| Wiggling speech bubble | An agent needs your input |
| Rotating arrows | Switching agents |
| Check mark | Finished |
| Rings around an account icon | Usage: outer ring is weekly, inner ring is the short window. Orange past 85% |
| Single ring refilling | The account is cooling down until its limit resets |

- **Hover** to see each session's repo and current activity, who built what, task progress, and every account's status.
- **Right-click** for Settings (takeover order), refresh, hide for an hour, or quit.
- **`nowall notch off`** hides it until you run `nowall notch on`. Failover keeps working either way.

Clicks outside the notch pass through to whatever is underneath.

Claude Code only reports usage through its terminal status line, so the desktop app's rings stay empty until you run a terminal `claude` turn. Cursor doesn't expose usage locally. Limits are still detected either way.

## How failover works

1. **Record.** Hooks add short lines to `.handoff/journal.jsonl` in each repo: your requests, files edited, commands run, and finished tasks. This costs roughly 100–300 tokens per session. The folder is git-ignored and secrets are redacted.
2. **Detect.** Claude Code's `StopFailure` hook reports the limit and its reset time. Agents that are taking over are watched through their structured output.
3. **Checkpoint.** Your files are saved to a hidden git ref (`refs/nowall/…`). Your branches, index and files aren't touched, and these refs aren't pushed by `git push` or `git push --all`.
4. **Hand off.** The next account that is installed, signed in and not cooling down receives the goal, decisions, task list, and the diff since the session began.
5. **Verify.** Its first job is to check each "done" claim against `git diff` and write a verified task list. Then it keeps working in the background.
6. **Stop.** It stops when no tasks remain, nothing has changed for a few turns, or it reaches the turn or time limit. If every account is limited, it pauses and shows the earliest reset.

Leave the original Claude session idle until the takeover finishes, so that two agents don't edit the same files. `nowall logs -f` shows live progress.

### What a takeover can do

Agents that take over run unattended, so they get edit-only permissions by default. They can change files in the repo, but may not be able to run commands, tests or commits. To give them full access, opt in:

```bash
nowall setup --yolo
```

With `--yolo`, an unattended agent can run any command on your computer. Use it only with repositories you trust.

## Multiple accounts

If you have more than one subscription, nowall can move through your accounts before it switches tools:

```bash
nowall account add claude work
```

```bash
nowall account add cursor team --api-key
```

```bash
nowall order claude claude:work cursor cursor:team codex
```

- Claude Code and Codex accounts get their own profile folder, and you sign in to them yourself.
- Cursor allows one login per computer, so a second Cursor account uses an API key. It's stored in the macOS Keychain (a `0600` file elsewhere) and is only passed to `cursor-agent`.
- Limits are tracked per account, so `claude:work` stays available while `claude` is cooling down.

## Commands

| Command | Description |
|---|---|
| `nowall setup` | Turn nowall on for every repo, find agents, start the notch |
| `nowall tour` | Show how to read the notch, plus the main commands |
| `nowall demo` | Run a simulated failover with no real usage |
| `nowall agents` | List agents with sign-in, cooldown and usage details |
| `nowall status` | Show accounts, the last session and its checkpoints |
| `nowall logs [-f]` | Show or follow a background takeover in this repo |
| `nowall undo [n]` | List checkpoints, or restore files to one. Never deletes files |
| `nowall order [id ...]` | Show or set the takeover order |
| `nowall account add\|list\|remove\|login\|verify` | Manage extra accounts |
| `nowall notch [on\|off\|status]` | Show, hide or diagnose the notch |
| `nowall run <agent>` | Run an agent under nowall in this terminal (optional) |
| `nowall init` | Set up a single repo instead of all of them |
| `nowall uninstall --global` | Remove nowall from this computer |

## Configuration

Settings live in `~/.config/nowall/config.json`. The notch's Settings window and `nowall order` edit the order for you.

```json
{
  "order": ["claude", "cursor", "codex", "antigravity"],
  "takeover": "background",
  "yolo": false,
  "stop": { "maxTurns": 30, "maxMinutes": 120, "noDiffTurns": 3 }
}
```

| Key | Description |
|---|---|
| `order` | Accounts in takeover order. Any account left out is off |
| `takeover` | `background` (silent, the default), `terminal` (opens a Terminal window) or `off` |
| `yolo` | Give agents that take over full access. Off by default |
| `stop` | Limits on how long an unattended takeover can run |

## Privacy and security

- **Local only.** nowall sends nothing anywhere. Your code goes only to the agents you already use, under their terms.
- **Credentials.** nowall doesn't read or store agent logins. The one exception is a Cursor API key you add on purpose.
- **Redaction.** API keys, tokens, private keys, URL credentials and the values in your `.env` files are stripped from everything nowall writes.
- **Snapshots.** Files matched by `.gitignore`, plus files such as `.env*`, `*.pem` and `*.key`, are left out of checkpoints.
- **Untrusted repos.** nowall refuses repos that commit or symlink a `.handoff/` folder. Like any coding agent, an agent that takes over can still be influenced by what a repo contains.
- **China-hosted models** (DeepSeek, Kimi, GLM through Qwen Code) stay off unless you confirm a clear notice.

The security review is in [docs/SECURITY.md](docs/SECURITY.md).

## Uninstall

Remove the hooks and the notch, and keep your settings for a later reinstall:

```bash
nowall uninstall --global
```

Remove everything, including settings, extra account profiles and Keychain items, plus the handoff history in your repos and the npm package:

```bash
nowall uninstall --global --purge --repos --npm
```

Add `--dry-run` to either command to see what would change. Your own hooks and status line are left as they were.

## Known limitations

- Failover starts from Claude Code. A limit inside the Cursor IDE or an interactive Codex session doesn't start one yet.
- A takeover runs in the background, and you can't type to it. Run the resume command in the summary to continue interactively.
- The original Claude session isn't closed by a background takeover, so it can resume after its limit resets.
- The notch isn't available on Linux or Windows yet.

See the [roadmap](docs/ROADMAP.md) for what's planned.

## Development

```bash
npm install
```

```bash
npm run lint && npm run typecheck && npm test
```

```bash
npm run stress
```

Tests never use real agents: `scripts/fake-agent.mjs` reproduces their output formats, limit errors and expired logins. `npm run build:notch` builds the macOS app and needs the Xcode command line tools.

Bug reports and pull requests are welcome through [GitHub issues](https://github.com/Vedthakar/nowall/issues).

## License

[MIT](LICENSE)
