"""Feature usage log: the page reports which screens and controls are used, per environment (server/ausage reads it)."""

import json
import os
import threading
from datetime import datetime, timezone

from adash.core.config import HERE

LOG = os.path.join(HERE, "usage.jsonl")
_write = threading.Lock()
ENV_KEYS = ("app", "form", "pointer", "dev")


def _short(v, n):
    return isinstance(v, str) and 0 < len(v) <= n


def post_usage(h, url):
    # {"env": {app, form, pointer, dev}, "events": [{"t": ms epoch, "v": view, "f": feature, "m": form then?,
    # "d": seconds on screen?}]} — appended one line per event to server/usage.jsonl. Names only, never values (the
    # page strips ids and paths before sending). An event's m overrides env.form: a Duo unfolds mid-batch.
    try:
        body = json.loads(h.rfile.read(min(int(h.headers.get("Content-Length") or 0), 65536)))
        env, events = body["env"], body["events"]
        assert isinstance(env, dict) and isinstance(events, list) and len(events) <= 500
        env = {k: env[k] for k in ENV_KEYS if _short(env.get(k), 40)}
        assert env.get("app") and env.get("form")
        rows = []
        for e in events:
            assert isinstance(e, dict) and _short(e.get("v"), 40) and _short(e.get("f"), 120) and isinstance(e.get("t"), (int, float))
            ts = datetime.fromtimestamp(e["t"] / 1000, timezone.utc).isoformat(timespec="seconds")
            row = {"ts": ts, **env, "view": e["v"], "feat": e["f"]}
            if _short(e.get("m"), 40):
                row["form"] = e["m"]
            if isinstance(e.get("d"), int) and 0 < e["d"] <= 86400:
                row["secs"] = e["d"]
            rows.append(json.dumps(row, ensure_ascii=False))
    except (ValueError, KeyError, AssertionError, TypeError, OverflowError, OSError):
        return h.send_json({"error": "bad request"}, 400)
    if rows:
        with _write, open(LOG, "a", encoding="utf-8") as f:
            f.write("\n".join(rows) + "\n")
    return h.send_json({"ok": True, "n": len(rows)})
