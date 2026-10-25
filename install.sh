#!/bin/sh
# nowall installer: curl -fsSL https://raw.githubusercontent.com/Vedthakar/nowall/main/install.sh | sh
# Installs the nowall CLI with npm, then runs `nowall setup`, which finds your coding agents on its
# own, installs its hooks for every project and starts the notch. Nothing else to configure.
set -eu

say() { printf '\033[1m%s\033[0m\n' "$*"; }

if ! command -v node >/dev/null 2>&1; then
  say "nowall needs Node.js 20 or newer. Install it from https://nodejs.org (or: brew install node), then run this again."
  exit 1
fi
major=$(node -p 'process.versions.node.split(".")[0]')
if [ "$major" -lt 20 ]; then
  say "nowall needs Node.js 20 or newer (you have $(node -v)). Update Node, then run this again."
  exit 1
fi

# Installs the prebuilt release (CLI + universal macOS notch; no build tools needed).
# NOWALL_SOURCE overrides it, e.g. a local tarball.
src="${NOWALL_SOURCE:-https://github.com/Vedthakar/nowall/releases/latest/download/nowall.tgz}"
say "Installing nowall from $src..."
npm install -g "$src" >/dev/null

say "Setting up..."
nowall setup --yes
