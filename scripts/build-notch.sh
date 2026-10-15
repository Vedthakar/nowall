#!/bin/sh
# Builds the macOS notch app (universal arm64 + x86_64) into notch/build/NowallNotch.app.
# Skips quietly on non-macOS or when the Swift toolchain is missing.
set -eu
cd "$(dirname "$0")/.."
if [ "$(uname)" != "Darwin" ] || ! command -v swiftc >/dev/null 2>&1; then
  echo "build-notch: skipped (needs macOS + Xcode command line tools)"
  exit 0
fi
OUT=notch/build/NowallNotch.app
mkdir -p "$OUT/Contents/MacOS" notch/build/tmp
for arch in arm64 x86_64; do
  swiftc -O -swift-version 5 -parse-as-library -target "$arch-apple-macos13.0" \
    notch/NowallNotch.swift -o "notch/build/tmp/NowallNotch-$arch"
done
lipo -create notch/build/tmp/NowallNotch-arm64 notch/build/tmp/NowallNotch-x86_64 -output "$OUT/Contents/MacOS/NowallNotch"
cat > "$OUT/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>dev.nowall.notch</string>
  <key>CFBundleName</key><string>nowall</string>
  <key>CFBundleExecutable</key><string>NowallNotch</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
PLIST
codesign --force --sign - "$OUT" >/dev/null 2>&1 || true
echo "build-notch: built $OUT"
