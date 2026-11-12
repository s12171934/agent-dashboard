#!/bin/sh
# Run the actual Swift↔Rust ABI and injected network checks on this Mac, without installing an app.
set -eu
HERE="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
OUT="$ROOT/.tools/apple-rust"
[ -f "$OUT/mac/libagent_dashboard_client_core.a" ] || {
  echo "Rust core is missing: run apple/build-rust.sh first" >&2
  exit 1
}
arch="$(uname -m)"
case "$arch" in arm64) target=arm64-apple-macosx14.0 ;; x86_64) target=x86_64-apple-macosx14.0 ;; *) exit 1 ;; esac
swiftc -parse-as-library -target "$target" -I "$HERE/RustCore/include" \
  -L "$OUT/mac" -lagent_dashboard_client_core \
  "$HERE/Shared/DecisionCore.swift" "$HERE/Shared/DecisionWatcher.swift" "$HERE/Shared/PageRecovery.swift" "$HERE/Shared/PageBridge.swift" \
  "$HERE/tests/ClientCoreTests.swift" "$HERE/tests/PageRecoveryTests.swift" -o "$OUT/client-core-tests"
exec "$OUT/client-core-tests"
