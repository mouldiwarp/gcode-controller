#!/bin/zsh
# Builds the native 2.0 app from this checkout and installs it, so Spotlight finds it. Run it on
# each Mac (it compiles for the local CPU); the app runs it again to update itself.
#
#   scripts/build-app.sh                 install in ~/Applications
#   scripts/build-app.sh /Applications   install somewhere else
#
# Needs Xcode (or its Command Line Tools) for Swift 6.2. It never adds a login item: open the app
# yourself. Until the cut-over it's "GCode Controller 2.0", beside 1.0's "GCode Controller".
#
# The new copy is only installed if the build succeeds, so a failed update leaves the old one.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="$PWD"
NAME="${GCC_APP_NAME:-GCode Controller 2.0}"
BUNDLE_ID="${GCC_BUNDLE_ID:-io.github.mouldiwarp.gcodecontroller2}"
VERSION="2.0.0"
DEST="${1:-$HOME/Applications}"

COMMIT=$(git rev-parse HEAD 2>/dev/null || echo "")
COMMIT_TIME=$(git log -1 --format=%ct 2>/dev/null || echo "")

echo "Compiling (release)…"
swift build --package-path swift -c release --product GCodeController
BIN="$(swift build --package-path swift -c release --show-bin-path)"

STAGE="$REPO/swift/.build/app"
APP="$STAGE/$NAME.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN/GCodeController" "$APP/Contents/MacOS/GCodeController"
cp mac/AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>$NAME</string>
  <key>CFBundleDisplayName</key><string>$NAME</string>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundleExecutable</key><string>GCodeController</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>${COMMIT_TIME:-0}</string>
  <key>LSMinimumSystemVersion</key><string>26.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.utilities</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>NSLocalNetworkUsageDescription</key><string>GCode Controller links the design Mac and the machine Mac, and receives files from Swarf and Fretboard.</string>
  <key>NSBonjourServices</key><array><string>_gcodehub._tcp</string><string>_gcodehub-try._tcp</string></array>
  <key>GCCRepoPath</key><string>$REPO</string>
  <key>GCCCommit</key><string>$COMMIT</string>
  <key>GCCCommitTime</key><string>$COMMIT_TIME</string>
</dict>
</plist>
PLIST

codesign --force --sign - "$APP" >/dev/null

# Swap the new copy in. A running copy keeps running (its files stay open) until it relaunches.
mkdir -p "$DEST"
rm -rf "$DEST/$NAME.app.new"
cp -R "$APP" "$DEST/$NAME.app.new"
rm -rf "$DEST/$NAME.app"
mv "$DEST/$NAME.app.new" "$DEST/$NAME.app"
mdimport "$DEST/$NAME.app" 2>/dev/null || true
echo "Installed $DEST/$NAME.app (${COMMIT:0:7}). Open it from Spotlight: ⌘Space, then type \"GCode\"."
