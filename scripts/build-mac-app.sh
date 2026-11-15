#!/bin/zsh
# Builds "GCode Controller.app" for this Mac and installs it in ~/Applications,
# so Spotlight finds it. Run it on each Mac (it compiles for the local CPU):
#
#   scripts/build-mac-app.sh
#
# Needs the Command Line Tools (xcode-select --install), which git already uses.
# The app runs the hub or agent from this checkout, so keep the repo where it is
# (or use Server ▸ Choose Folder… in the app after moving it).
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="$PWD"
NAME="GCode Controller"
DEST="${1:-$HOME/Applications}"
BUILD="$REPO/mac/build"
APP="$BUILD/$NAME.app"
VERSION=$(node -p 'require("./package.json").version' 2>/dev/null || echo 0.1.0)

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

echo "Compiling…"
swiftc -O -target "$(uname -m)-apple-macos12.0" -o "$APP/Contents/MacOS/GCodeController" mac/GCodeController/main.swift

if [[ ! -f mac/AppIcon.icns ]]; then
  echo "Drawing the icon…"
  rm -rf "$BUILD/AppIcon.iconset"
  swift mac/make-icon.swift "$BUILD/AppIcon.iconset"
  iconutil -c icns -o mac/AppIcon.icns "$BUILD/AppIcon.iconset"
fi
cp mac/AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>$NAME</string>
  <key>CFBundleDisplayName</key><string>$NAME</string>
  <key>CFBundleIdentifier</key><string>io.github.mouldiwarp.gcodecontroller</string>
  <key>CFBundleExecutable</key><string>GCodeController</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.utilities</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
  <key>GCCRepoPath</key><string>$REPO</string>
</dict>
</plist>
PLIST

codesign --force --sign - "$APP" >/dev/null

mkdir -p "$DEST"
rm -rf "$DEST/$NAME.app"
cp -R "$APP" "$DEST/"
mdimport "$DEST/$NAME.app" 2>/dev/null || true
echo "Installed $DEST/$NAME.app. Launch it from Spotlight: ⌘Space, then type \"GCode\"."
