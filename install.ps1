# nowall installer for Windows. In PowerShell:
#   irm https://raw.githubusercontent.com/Vedthakar/nowall/main/install.ps1 | iex
# Installs the nowall CLI with npm, then runs `nowall setup`, which finds your coding agents on its
# own and installs its hooks for every project. Nothing else to configure.
# Run through `iex`, so failures use `return`, not `exit`: `exit` would close the user's window.

function Install-Nowall {
  function Say($text) { Write-Host $text -ForegroundColor Cyan }

  if (-not (Get-Command node -ErrorAction SilentlyContinue) -or -not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
    Say "nowall needs Node.js 20 or newer. Install it from https://nodejs.org (or: winget install OpenJS.NodeJS.LTS), then open a new PowerShell window and run this again."
    return
  }
  $major = [int](node -p "process.versions.node.split('.')[0]")
  if ($major -lt 20) {
    Say "nowall needs Node.js 20 or newer (you have $(node -v)). Update Node, then run this again."
    return
  }
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Say "nowall needs git. Install it from https://git-scm.com/download/win (or: winget install Git.Git), then open a new PowerShell window and run this again."
    return
  }

  # NOWALL_SOURCE overrides the prebuilt release, e.g. with a local tarball.
  $src = if ($env:NOWALL_SOURCE) { $env:NOWALL_SOURCE } else { "https://github.com/Vedthakar/nowall/releases/latest/download/nowall.tgz" }
  Say "Installing nowall from $src..."
  npm.cmd install -g $src | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Say "npm could not install nowall (see the error above)."
    return
  }

  # `.cmd`, not plain `nowall`: PowerShell's default execution policy can block npm's .ps1 shim.
  Say "Setting up..."
  nowall.cmd setup
  if ($LASTEXITCODE -ne 0) {
    Say "Setup did not finish. Run it again any time with: nowall.cmd setup"
    return
  }
  Say "Done. To add extra accounts later: nowall.cmd account add <agent> <label>. To remove nowall: nowall.cmd uninstall --global"
}

Install-Nowall
Remove-Item Function:\Install-Nowall -ErrorAction SilentlyContinue
