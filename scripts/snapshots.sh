#!/bin/sh
# Renders the README's notch images from a synthetic nowall home under /tmp (never the real one).
#   sh scripts/snapshots.sh [OUT_DIR]        default OUT_DIR: docs/images
#   SNAP_NO_BUILD=1 sh scripts/snapshots.sh  skip the Swift build (use the app already in notch/build)
# Writes notch-tab.png (collapsed), notch-card.png (hover card) and notch-settings.png, all at 2x.
# The clock is pinned (--now) so countdowns and "back in 1h 42m" render the same every run.
set -eu
cd "$(dirname "$0")/.."
OUT=${1:-docs/images}
if [ "$(uname)" != "Darwin" ]; then
  echo "snapshots: macOS only (the notch is a Swift app)"
  exit 0
fi
[ "${SNAP_NO_BUILD:-}" = "1" ] || sh scripts/build-notch.sh
APP=notch/build/NowallNotch.app/Contents/MacOS/NowallNotch
[ -x "$APP" ] || { echo "snapshots: $APP missing (needs Xcode command line tools)"; exit 1; }

TMP=$(mktemp -d /tmp/nowall-snap.XXXXXX)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/status" "$OUT"

# Pinned "now" and a few timestamps relative to it.
NOW=2026-11-05T15:00:00.000Z
T_20S_AGO=2026-11-05T14:59:40.000Z
T_2M_AGO=2026-11-05T14:58:00.000Z
T_3M_AGO=2026-11-05T14:57:00.000Z
T_40M_AGO=2026-11-05T14:20:00.000Z
T_1H_AGO=2026-11-05T14:00:00.000Z
RESET_5H=2026-11-05T17:30:00.000Z
RESET_WEEK=2026-11-09T09:00:00.000Z
COOLDOWN=2026-11-05T16:42:00.000Z

cat > "$TMP/config.json" <<EOF
{
  "v": 1,
  "order": ["claude", "claude:work", "codex", "cursor"],
  "enabled": { "claude": true, "codex": true, "cursor": true, "antigravity": false, "qwen": false },
  "accounts": [
    { "id": "claude:work", "agent": "claude", "label": "work" },
    { "id": "cursor:team", "agent": "cursor", "label": "team", "secret": { "env": "CURSOR_API_KEY" } }
  ]
}
EOF

cat > "$TMP/agents.json" <<EOF
{
  "v": 1,
  "updatedAt": "$T_2M_AGO",
  "agents": [
    { "id": "claude", "name": "Claude Code", "installed": true, "signedIn": true, "enabled": true,
      "usage": [ { "label": "5h", "usedPct": 62, "resetsAt": "$RESET_5H" }, { "label": "week", "usedPct": 41, "resetsAt": "$RESET_WEEK" } ],
      "loginHint": "claude", "installHint": "npm i -g @anthropic-ai/claude-code" },
    { "id": "codex", "name": "Codex", "installed": true, "signedIn": true, "enabled": true,
      "usage": [ { "label": "5h", "usedPct": 88, "resetsAt": "$RESET_5H" }, { "label": "week", "usedPct": 30, "resetsAt": "$RESET_WEEK" } ],
      "loginHint": "codex login", "installHint": "npm i -g @openai/codex" },
    { "id": "cursor", "name": "Cursor", "installed": true, "signedIn": true, "enabled": true,
      "loginHint": "cursor-agent login", "installHint": "curl https://cursor.com/install -fsS | bash" },
    { "id": "antigravity", "name": "Antigravity", "installed": false, "signedIn": false, "enabled": false,
      "loginHint": "antigravity login", "installHint": "see antigravity.google" },
    { "id": "qwen", "name": "Qwen Code", "installed": false, "signedIn": false, "enabled": false,
      "loginHint": "qwen", "installHint": "npm i -g @qwen-code/qwen-code" }
  ],
  "accounts": [
    { "id": "claude", "agent": "claude", "name": "Claude Code", "label": "", "signedIn": true, "active": true,
      "usage": [ { "label": "5h", "usedPct": 62, "resetsAt": "$RESET_5H" }, { "label": "week", "usedPct": 41, "resetsAt": "$RESET_WEEK" } ] },
    { "id": "claude:work", "agent": "claude", "name": "Claude Code (work)", "label": "work", "signedIn": true, "active": true,
      "cooldownUntil": "$COOLDOWN", "limitMessage": "You've hit your limit · resets 4:42pm",
      "usage": [ { "label": "5h", "usedPct": 100, "resetsAt": "$COOLDOWN" }, { "label": "week", "usedPct": 77, "resetsAt": "$RESET_WEEK" } ] },
    { "id": "codex", "agent": "codex", "name": "Codex", "label": "", "signedIn": true, "active": true,
      "usage": [ { "label": "5h", "usedPct": 88, "resetsAt": "$RESET_5H" }, { "label": "week", "usedPct": 30, "resetsAt": "$RESET_WEEK" } ] },
    { "id": "cursor", "agent": "cursor", "name": "Cursor", "label": "", "signedIn": true, "active": true },
    { "id": "cursor:team", "agent": "cursor", "name": "Cursor (team)", "label": "team", "signedIn": false, "active": false }
  ]
}
EOF

# A Cursor chat that delegated to two subagents: its own turn ended, the children are still running.
cat > "$TMP/status/c_7f3a9c1e.json" <<EOF
{ "v": 1, "sid": "c_7f3a9c1e", "repo": "/Users/you/code/nowall", "repoName": "nowall", "phase": "working",
  "agent": "cursor", "detail": "↳ Running npm test", "turnEnded": true,
  "children": [ { "id": "sa_01", "type": "explore", "startedAt": "$T_2M_AGO" },
                { "id": "sa_02", "type": "generalPurpose", "startedAt": "$T_2M_AGO" } ],
  "startedAt": "$T_40M_AGO", "updatedAt": "$T_20S_AGO" }
EOF
# One of those subagents, as its own session. Hidden: it has parentSid.
cat > "$TMP/status/c_sa_01.json" <<EOF
{ "v": 1, "sid": "c_sa_01", "repo": "/Users/you/code/nowall", "repoName": "nowall", "phase": "working",
  "agent": "cursor", "parentSid": "c_7f3a9c1e", "detail": "Running npm test",
  "startedAt": "$T_2M_AGO", "updatedAt": "$T_20S_AGO" }
EOF
# A terminal Claude Code session with a task list.
cat > "$TMP/status/s_claude_api.json" <<EOF
{ "v": 1, "sid": "s_claude_api", "repo": "/Users/you/code/api-server", "repoName": "api-server", "phase": "working",
  "agent": "claude", "detail": "Editing src/routes/users.ts", "tasks": { "done": 3, "total": 7 },
  "shares": [ { "agent": "claude", "lines": 412 } ],
  "startedAt": "$T_1H_AGO", "updatedAt": "$T_2M_AGO" }
EOF
# A finished task that two agents built (Claude hit its limit, Cursor finished).
cat > "$TMP/status/s_billing.json" <<EOF
{ "v": 1, "sid": "s_billing", "repo": "/Users/you/code/billing", "repoName": "billing", "phase": "done",
  "agent": "cursor", "detail": "Task complete", "tasks": { "done": 5, "total": 5 },
  "shares": [ { "agent": "claude", "lines": 640 }, { "agent": "cursor", "lines": 310 } ],
  "startedAt": "$T_1H_AGO", "updatedAt": "$T_3M_AGO" }
EOF

"$APP" --snapshot "$OUT/notch-tab.png" --home "$TMP" --now "$NOW"
"$APP" --snapshot "$OUT/notch-card.png" --expanded --home "$TMP" --now "$NOW"
"$APP" --snapshot "$OUT/notch-settings.png" --settings --home "$TMP" --now "$NOW"
# Trim the empty canvas around the right-edge notch (2x pixels: height width, then y x offset).
sips --cropToHeightWidth 460 240 --cropOffset 410 440 "$OUT/notch-tab.png" >/dev/null
sips --cropToHeightWidth 1040 680 --cropOffset 120 0 "$OUT/notch-card.png" >/dev/null
for f in notch-tab notch-card notch-settings; do
  size=$(wc -c < "$OUT/$f.png" | tr -d ' ')
  [ "$size" -gt 5000 ] || { echo "snapshots: $OUT/$f.png is only $size bytes"; exit 1; }
  echo "snapshots: $OUT/$f.png ($size bytes)"
done
