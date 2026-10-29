#!/bin/sh
# Builds the apps. Needs Xcode (27.1 or later for iPhone Duo's side strip) and xcodegen (brew install xcodegen).
#   apple/build.sh mac        the macOS app, installed into ~/Applications
#   apple/build.sh sim        the iOS app on the booted simulator (or SIM=<device name>)
#   apple/build.sh ios        the iOS app on the connected iPhone (needs a team)
#   apple/build.sh icons      the app icons again, from frontend/icons (made on the first build, kept out of git)
# Signing: by default "Sign to Run Locally" (no Apple ID), which runs on this Mac but gets no notifications. With
# ADASH_TEAM=<team> (or the id in apple/.team, kept out of the repo) it signs with that team; a free Apple ID's
# Personal Team (Xcode > Settings > Accounts) is enough, and installs on an iPhone last 7 days.
set -e
cd "$(dirname "$0")"
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
what="${1:-mac}"
team="${ADASH_TEAM:-$(cat .team 2>/dev/null || true)}"
mkdir -p build
# Xcode's derived data (~600MB of modules and products) lives outside the vault so Obsidian Sync never uploads it;
# build/ keeps only the small plists and entitlements xcodegen reads.
dd="${ADASH_DERIVED_DATA:-$HOME/Library/Developer/Xcode/DerivedData/AgentDashboard}"
# The icon sets are generated from the page's icons (tools/make-icons), not kept in the repository.
if [ "$what" = icons ] || [ ! -d iOS/Assets.xcassets ] || [ ! -d macOS/Assets.xcassets ]; then
  swiftc -o build/make-icons tools/make-icons/main.swift macOS/MacIcon.swift
  (cd .. && apple/build/make-icons)
  [ "$what" = icons ] && { echo "icons written"; exit 0; }
fi
xcodegen generate --quiet
build() { xcodebuild -project AgentDashboard.xcodeproj -configuration Release -derivedDataPath "$dd" -quiet build "$@"; }
# build, signed by the team when there is one
signed() {
  if [ -n "$team" ]; then build "$@" CODE_SIGN_STYLE=Automatic "CODE_SIGN_IDENTITY=Apple Development" DEVELOPMENT_TEAM="$team" -allowProvisioningUpdates
  else build "$@"; fi
}
case "$what" in
mac)
  signed -scheme AgentDashboard-macOS
  pkill -x "Agent Dashboard" || true
  rm -rf "$HOME/Applications/Agent Dashboard.app"
  mkdir -p "$HOME/Applications"
  cp -R "$dd/Build/Products/Release/Agent Dashboard.app" "$HOME/Applications/"
  echo "installed: $HOME/Applications/Agent Dashboard.app" ;;
sim)
  dev="${SIM:-booted}"
  build -scheme AgentDashboard-iOS -sdk iphonesimulator CODE_SIGNING_ALLOWED=NO
  xcrun simctl install "$dev" "$dd/Build/Products/Release-iphonesimulator/Agent Dashboard.app"
  xcrun simctl launch "$dev" com.s-dante.agent-dashboard
  echo "launched on simulator: $dev" ;;
ios)
  [ -n "$team" ] || { echo "a team is needed: ADASH_TEAM=<team> or apple/.team" >&2; exit 1; }
  # The connected iPhone (paired once by cable; then the same Wi-Fi is enough). Building for it registers it with the
  # team, which a free team's provisioning profile needs.
  out="$(mktemp)"
  xcrun devicectl list devices -j "$out" >/dev/null 2>&1 || true
  dev=$(python3 -c 'import json,sys
for d in json.load(open(sys.argv[1]))["result"]["devices"]:
    h = d.get("hardwareProperties", {})
    if h.get("reality") == "physical" and h.get("platform") == "iOS" and d.get("connectionProperties", {}).get("tunnelState") != "unavailable":
        print(h["udid"]); break' "$out")
  rm -f "$out"
  [ -n "$dev" ] || { echo "no iPhone connected (cable, or the same Wi-Fi after pairing once)" >&2; exit 1; }
  signed -scheme AgentDashboard-iOS -destination "id=$dev" -allowProvisioningDeviceRegistration
  app="$dd/Build/Products/Release-iphoneos/Agent Dashboard.app"
  xcrun devicectl device install app --device "$dev" "$app"
  xcrun devicectl device process launch --device "$dev" com.s-dante.agent-dashboard || echo "installed; trust the developer in Settings > General > VPN & Device Management, then open it"
  ;;
*) echo "usage: $0 mac|sim|ios" >&2; exit 2 ;;
esac
