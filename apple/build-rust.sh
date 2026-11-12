#!/bin/sh
# Produce a static Rust XCFramework for macOS, iPhone and iPhone Simulator.
set -eu
HERE="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
OUT="$ROOT/.tools/apple-rust"
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
mkdir -p "$OUT" "$HERE/build"
for target in aarch64-apple-darwin x86_64-apple-darwin aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios; do
  "$ROOT/server/cargo" build --release --locked --manifest-path "$ROOT/client-core/Cargo.toml" --target "$target" --target-dir "$OUT/target"
done
mkdir -p "$OUT/mac" "$OUT/sim"
lipo -create "$OUT/target/aarch64-apple-darwin/release/libagent_dashboard_client_core.a" "$OUT/target/x86_64-apple-darwin/release/libagent_dashboard_client_core.a" -output "$OUT/mac/libagent_dashboard_client_core.a"
lipo -create "$OUT/target/aarch64-apple-ios-sim/release/libagent_dashboard_client_core.a" "$OUT/target/x86_64-apple-ios/release/libagent_dashboard_client_core.a" -output "$OUT/sim/libagent_dashboard_client_core.a"
FRAMEWORK="$HERE/build/AgentDashboardCore.xcframework"
STAGING="$OUT/staging/AgentDashboardCore.xcframework"
rm -rf "$OUT/staging"
mkdir -p "$OUT/staging"
xcodebuild -create-xcframework \
  -library "$OUT/mac/libagent_dashboard_client_core.a" -headers "$HERE/RustCore/include" \
  -library "$OUT/target/aarch64-apple-ios/release/libagent_dashboard_client_core.a" -headers "$HERE/RustCore/include" \
  -library "$OUT/sim/libagent_dashboard_client_core.a" -headers "$HERE/RustCore/include" \
  -output "$STAGING"
rm -rf "$FRAMEWORK"
mv "$STAGING" "$FRAMEWORK"
