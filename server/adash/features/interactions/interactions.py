"""Inter-agent messages from Orca's orchestration inbox, read on demand, plus the terminal-send log of the QA driver."""

import hashlib
import json
import os

from adash.core.orca import orca
from adash.core.prefs import prefs
from adash.core.state import lock
from adash.features.orca_runs.store import orca_state, run_coord


inbox_cache = {"at": 0, "key": None, "body": None}
INBOX_TTL = 3
INBOX_BODY_CAP = 6000
TELL_TYPES = {"question", "escalation", "status", "dispatch"}  # the rest (answer, handoff, ...) read as status


def told(limit):
    """Messages typed into another agent's terminal through `qa-driver tell`: log/tell.jsonl in each QA set's state
    directory (prefs.json qa_sets[].watch). Orca keeps no record of terminal input, so this is the only trace."""
    out = []
    for qs in prefs.get("qa_sets") or []:
        path = os.path.join(os.path.expanduser(qs.get("watch") or ""), "log", "tell.jsonl")
        try:
            with open(path, encoding="utf-8") as f:
                lines = f.readlines()[-limit:]
        except OSError:
            continue
        for line in lines:
            try:
                r = json.loads(line)
            except ValueError:
                continue
            if not isinstance(r, dict) or not r.get("to"):
                continue
            out.append({**r, "id": "tell_" + hashlib.sha1(line.encode()).hexdigest()[:12]})
    return out


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
    for r in told(limit):
        body = str(r.get("body") or "")
        ft, fk = term(r.get("from"))
        tt, tk = term(r.get("to"))
        out.append({"id": r["id"], "run_id": None, "type": r.get("type") if r.get("type") in TELL_TYPES else "status",
                    "priority": "normal", "thread_id": None, "subject": r.get("subject") or "",
                    "body": body[:INBOX_BODY_CAP], "cut": len(body) > INBOX_BODY_CAP,
                    "from": r.get("from"), "from_term": ft, "from_kind": fk, "to": r.get("to"), "to_term": tt, "to_kind": tk,
                    "task_id": None, "outcome": None, "phase": None, "question": None, "files": [],
                    "read": True, "created_at": r.get("at"), "via": "terminal", "kind": r.get("type"),
                    "key": r.get("key") or None, "failed": r.get("ok") is False})
    out.sort(key=lambda m: m.get("created_at") or "", reverse=True)
    return {"messages": out[:limit], "fetched": len(raw)}
