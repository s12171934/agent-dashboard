"""Inter-agent messages from Orca's orchestration inbox, read on demand."""

import json

from adash.core.orca import orca
from adash.core.state import lock
from adash.features.orca_runs.store import orca_state, run_coord


inbox_cache = {"at": 0, "key": None, "body": None}
INBOX_TTL = 3
INBOX_BODY_CAP = 6000


def interactions(limit, heartbeats):
    """-> {"messages": [...], "fetched": n}. limit counts the messages kept after the heartbeat filter."""
    raw = orca("orchestration", "inbox", "--limit", str(limit if heartbeats else limit * 3)).get("messages") or []
    with lock:
        by_dispatch = {w.get("dispatchId"): w.get("agentTerminalHandle") for w in orca_state.get("workers", [])
                       if w.get("dispatchId") and w.get("agentTerminalHandle")}
        coords = dict(run_coord)
    payloads = {}
    for m in raw:
        try:
            payloads[m["id"]] = json.loads(m.get("payload") or "{}") or {}
        except ValueError:
            payloads[m["id"]] = {}
        d = payloads[m["id"]].get("dispatchId")  # a worker's own message names its dispatch: learn the mapping
        if d and str(m.get("from_handle", "")).startswith("term_"):
            by_dispatch.setdefault(d, m["from_handle"])

    def term(addr):
        addr = addr or ""
        if addr.startswith("run:"):
            return coords.get(addr[4:]), "run"
        if addr.startswith("dispatch:"):
            return by_dispatch.get(addr[9:]), "dispatch"
        return (addr, "term") if addr.startswith("term_") else (None, "other")

    out = []
    for m in raw:
        if m.get("type") == "heartbeat" and not heartbeats:
            continue
        p, (ft, fk), (tt, tk) = payloads[m["id"]], term(m.get("from_handle")), term(m.get("to_handle"))
        body = m.get("body") or ""
        out.append({"id": m["id"], "run_id": m.get("run_id"), "type": m.get("type"), "priority": m.get("priority"),
                    "thread_id": m.get("thread_id"), "subject": m.get("subject"),
                    "body": body[:INBOX_BODY_CAP], "cut": len(body) > INBOX_BODY_CAP,
                    "from": m.get("from_handle"), "from_term": ft, "from_kind": fk,
                    "to": m.get("to_handle"), "to_term": tt, "to_kind": tk,
                    "task_id": p.get("taskId"), "outcome": p.get("outcome"), "phase": p.get("phase"),
                    "question": p.get("question"), "files": p.get("filesModified") or [],
                    "read": bool(m.get("read")), "created_at": m.get("created_at")})
        if len(out) >= limit:
            break
    return {"messages": out, "fetched": len(raw)}
