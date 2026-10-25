"""The /api/state form of the Orca snapshot."""

import json
import re


TICKET_RE = re.compile(r"\b([A-Z]{2,}-\d+)\b", re.ASCII)
PLACE_RE = re.compile(r"(?:^|\n)\s*(?:배치|워크트리|worktree|placement)\s*[:：]\s*([^\n]+)", re.I)


def lite_task(t):
    """Snapshot form of a task: spec and result stay on /api/run, their few derived values come along."""
    spec = t.get("spec") or ""
    place = PLACE_RE.search(spec)
    ticket = TICKET_RE.search(spec)
    try:
        outcome = (json.loads(t.get("result") or "null") or {}).get("outcome")
    except (ValueError, AttributeError):
        outcome = None
    return {**{k: t.get(k) for k in ("id", "run_id", "task_title", "display_name", "status", "deps",
                                      "created_at", "completed_at")},
            "place_hint": place.group(1).strip() if place else None,
            "ticket_key": ticket.group(1) if ticket else None,
            "outcome": outcome}


def lite_orca(o):
    prov = lambda w: (w.get("projection") or {}).get("provider") or {}
    return {"runs": [{k: r.get(k) for k in ("id", "objective", "coordinator_handle", "created_at")} for r in o.get("runs", [])],
            "tasks": {rid: [lite_task(t) for t in ts] for rid, ts in o.get("tasks", {}).items()},
            "workers": [{"taskId": w.get("taskId"), "runId": w.get("runId"), "dispatchStatus": w.get("dispatchStatus"),
                         "model": prov(w).get("model") or prov(w).get("id")} for w in o.get("workers", [])],
            "terminals": o.get("terminals", []), "error": o.get("error"), "updated": o.get("updated")}
