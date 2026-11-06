#!/bin/sh
# nowall installer: curl -fsSL https://raw.githubusercontent.com/Vedthakar/nowall/main/install.sh | sh
# Installs the nowall CLI with npm, then runs `nowall setup`, which finds your coding agents on its
# own, installs its hooks for every project and starts the notch. Nothing else to configure.
set -eu

say() { printf '\033[1m%s\033[0m\n' "$*"; }

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  say "nowall needs Node.js 20 or newer. Install it from https://nodejs.org (or: brew install node), then run this again."
  exit 1
fi
major=$(node -p 'process.versions.node.split(".")[0]')
if [ "$major" -lt 20 ]; then
  say "nowall needs Node.js 20 or newer (you have $(node -v)). Update Node, then run this again."
  exit 1
fi
if ! command -v git >/dev/null 2>&1; then
  say "nowall needs git. Install it (on macOS: xcode-select --install), then run this again."
  exit 1
fi
case "$(uname)" in
  Darwin) ;;
  Linux) say "Linux: failover works, but the notch is macOS only for now." ;;
  *)
    say "nowall supports macOS and Linux only for now."
    exit 1
    ;;
esac

# Installs the prebuilt release (CLI + universal macOS notch; no build tools needed).
# NOWALL_SOURCE overrides it, e.g. a local tarball.
src="${NOWALL_SOURCE:-https://github.com/Vedthakar/nowall/releases/latest/download/nowall.tgz}"
say "Installing nowall from $src..."
if ! npm install -g "$src" >/dev/null; then
  say "npm could not install nowall (see the error above)."
  say "If it says EACCES, your global npm folder needs admin rights. Don't use sudo: install Node with"
  say "nvm or Homebrew, or see https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally"
  exit 1
fi

say "Setting up..."
nowall setup --yes

say "Done. To add extra accounts later: nowall account add <agent> <label>. To remove nowall: nowall uninstall --global"
