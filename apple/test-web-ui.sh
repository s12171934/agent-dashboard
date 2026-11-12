#!/bin/sh
# The actual release WASM UI in WebKit, with synthetic transport and ephemeral storage.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
mkdir -p "$ROOT/.tools/apple-rust"
swiftc -parse-as-library "$ROOT/apple/Shared/PageBridge.swift" "$ROOT/apple/tests/WebUITests.swift" -o "$ROOT/.tools/apple-rust/web-ui-tests"
python3 - "$ROOT" <<'PYBRIDGE'
import sys,pathlib,textwrap
root=pathlib.Path(sys.argv[1]);s=(root/'apple/iOS/DockBridge.swift').read_text().split('static let script = """',1)[1].split('"""',1)[0]
(root/'.tools/apple-rust/dock-ui-tests.js').write_text(textwrap.dedent(s))
PYBRIDGE
exec "$ROOT/.tools/apple-rust/web-ui-tests" "${1:-http://127.0.0.1:5517/fixture.html}" "$ROOT/.tools/apple-rust/dock-ui-tests.js"
