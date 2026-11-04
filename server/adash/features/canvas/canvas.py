"""Where the page frames workflow-canvas (40_Tools/workflow-canvas) from: the address depends on who asks.

The canvas listens on 127.0.0.1 only (WORKFLOW_CANVAS_PORT, default 4318). A page on this Mac's loopback opens it as it
is. A device on the tailnet reached this server through tailscale serve, so it gets the https address that tailscale
serve relays to the canvas port, read from `tailscale serve status --json` (cached briefly). Without such an entry
the answer says how to add one.
"""

import json
import os
import shutil
import socket
import subprocess
import threading
import time

PORT = int(os.environ.get("WORKFLOW_CANVAS_PORT") or 4318)
TAILSCALE = shutil.which("tailscale") or "/usr/local/bin/tailscale"
SERVE_HINT = f"tailscale serve --bg --https={PORT} http://127.0.0.1:{PORT}"
TTL = 30
_cache = {"at": 0.0, "url": None}
_lock = threading.Lock()


def up():
    """The canvas answers on its port."""
    try:
        with socket.create_connection(("127.0.0.1", PORT), timeout=0.5):
            return True
    except OSError:
        return False


def _serve_url():
    """The https address tailscale serve relays to the canvas, or None."""
    try:
        r = subprocess.run([TAILSCALE, "serve", "status", "--json"], capture_output=True, text=True, timeout=5)
        web = (json.loads(r.stdout or "{}") or {}).get("Web") or {}
    except (OSError, subprocess.SubprocessError, ValueError):
        return None
    targets = {f"http://127.0.0.1:{PORT}", f"http://localhost:{PORT}"}
    for hostport, conf in web.items():
        proxy = (((conf or {}).get("Handlers") or {}).get("/") or {}).get("Proxy", "").rstrip("/")
        if proxy in targets:
            return "https://" + (hostport[:-4] if hostport.endswith(":443") else hostport) + "/"
    return None


def serve_url():
    with _lock:
        if time.time() - _cache["at"] > TTL:
            _cache["url"], _cache["at"] = _serve_url(), time.time()
        return _cache["url"]


def info(local):
    """{url, up, error}: url is None when this device cannot reach the canvas; error then says why."""
    if local:
        return {"url": f"http://127.0.0.1:{PORT}/", "up": up(), "error": None}
    url = serve_url()
    return {"url": url, "up": up(), "error": None if url else f"tailscale serve 에 캔버스가 없습니다. 이 Mac 에서 `{SERVE_HINT}` 를 실행하세요"}
