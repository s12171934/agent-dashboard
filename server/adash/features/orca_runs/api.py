"""Orca run endpoint: one Run with its tasks and workers in full."""

from urllib.parse import parse_qs

from adash.core.state import lock
from adash.features.orca_runs.store import orca_state


def get_run(h, url):
    rid = parse_qs(url.query).get("id", [""])[0]
    with lock:
        run = next((r for r in orca_state.get("runs", []) if r.get("id") == rid), None)
        body = run and h.encode({"run": run, "tasks": orca_state.get("tasks", {}).get(rid, []),
                                 "workers": [w for w in orca_state.get("workers", []) if w.get("runId") == rid]})
    if not body:
        return h.send_json({"error": "not found"}, 404)
    h.send_body(body)
