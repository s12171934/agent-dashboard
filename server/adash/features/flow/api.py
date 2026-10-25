"""Flow check endpoint: 「정상으로 표시」."""

import json

from adash.core.state import lock
from adash.features.flow.rules import flow_mark


def post_ok(h, url):
    # 「정상으로 표시」: {"id": deviation id, "ok": true} keeps that deviation out of /api/state; "ok": false undoes it.
    try:
        body = json.loads(h.rfile.read(min(int(h.headers.get("Content-Length") or 0), 65536)))
        fid, normal = body["id"], body.get("ok", True)
        assert isinstance(fid, str) and 0 < len(fid) <= 600 and isinstance(normal, bool)
    except (ValueError, KeyError, AssertionError, TypeError):
        return h.send_json({"error": "bad request"}, 400)
    item = body.get("item") if isinstance(body.get("item"), dict) else None
    with lock:
        flow_mark(fid, normal, item)
    return h.send_json({"ok": True})
