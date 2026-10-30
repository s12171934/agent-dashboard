"""Feature usage log: the page reports which screens and controls are used, per environment (server/ausage reads it)."""

import json
import os
import threading
from datetime import datetime, timezone
from urllib.parse import parse_qs

from adash.features.usage.report import BY, LOG, load, tally

PAGE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "page.html")
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


def get_report(h, url):
    # ?days=30&by=both|app|form&top=15&rare=1 — the tallies server/ausage prints, plus the latest events (recent).
    q = {k: v[0] for k, v in parse_qs(url.query).items()}
    try:
        days, top, rare = int(q.get("days", 30)), int(q.get("top", 15)), int(q.get("rare", 1))
        assert 0 <= days <= 3650 and 1 <= top <= 200 and 0 <= rare <= 100 and q.get("by", "both") in BY
    except (ValueError, AssertionError):
        return h.send_json({"error": "bad request"}, 400)
    rows = load(days, q.get("by", "both"))
    return h.send_json({"log": rows is not None, **tally(rows or [], top, rare, recent=40)})


def get_page(h, url):
    # The report as a page, opened on the server's own address (no build step, no dashboard needed).
    with open(PAGE, "rb") as f:
        body = f.read()
    h.send_response(200)
    h.send_header("Content-Type", "text/html; charset=utf-8")
    h.send_header("Content-Length", str(len(body)))
    h.send_header("Cache-Control", "no-cache")
    h.send_header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'")
    h.send_header("X-Content-Type-Options", "nosniff")
    h.end_headers()
    h.wfile.write(body)
