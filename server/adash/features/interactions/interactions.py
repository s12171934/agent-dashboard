"""Inter-agent messages from Orca's orchestration inbox, read on demand, plus the terminal-send log of the QA driver
and the execution logs of workflow-canvas (the canvas launches a coordinator and the coordinator reports back to it)."""

import hashlib
import json
import os

from adash.core import config
from adash.core.orca import orca
from adash.core.prefs import prefs
from adash.core.state import lock
from adash.features.orca_runs.store import orca_state, run_coord


inbox_cache = {}  # (limit, heartbeats) -> StaleWhileRefresh of (body, gzipped body); see api.get_interactions
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


CANVAS_LAUNCHES = 40  # newest launch directories read
CANVAS_BRIEF_CAP = 4000
# Coordinator events the canvas accepts through its API (workflow-canvas coordinatorEventTypes) plus registration,
# as a message type of this tab. The rest of a launch log (task status changes, results) is the canvas's own watching.
CANVAS_REPORTS = {"registered": ("status", "실행 등록"), "note": ("status", "메모"), "worker": ("status", "워커 보고"),
                  "gate": ("question", "게이트"), "error": ("escalation", "오류"), "report": ("worker_done", "마무리 보고")}
canvas_files = {}  # path -> (mtime, size, value): launch files only change by appending


def canvas_dir():
    """workflow-canvas keeps one directory per 실행 under <data dir>/.executions (its WORKFLOW_CANVAS_DATA_DIR, default
    <checkout>/.local/workflows). prefs.json canvas_data overrides where the checkout is not the vault's."""
    d = prefs.get("canvas_data") or os.environ.get("WORKFLOW_CANVAS_DATA_DIR") \
        or os.path.join(config.VAULT, "40_Tools/workflow-canvas/.local/workflows")
    return os.path.join(os.path.expanduser(d), ".executions")


def _cached(path, read):
    try:
        st = os.stat(path)
    except OSError:
        return None
    hit = canvas_files.get(path)
    if hit and hit[0] == st.st_mtime and hit[1] == st.st_size:
        return hit[2]
    try:
        v = read(path)
    except (OSError, ValueError):
        return None
    canvas_files[path] = (st.st_mtime, st.st_size, v)
    return v


def _text(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def _events(path):
    out = []
    for line in _text(path).splitlines():
        try:
            e = json.loads(line)
        except ValueError:
            continue
        if isinstance(e, dict):
            out.append(e)
    return out


def canvas_msgs():
    """Each launch as a conversation between the canvas (one address per workflow) and the coordinator it started:
    the request with its brief as an instruction, then what the coordinator reported (메모·게이트·워커 보고·오류·
    마무리 보고). A launch whose coordinator is an automation's own agent has no terminal of record; its Run's
    coordinator stands in."""
    root = canvas_dir()
    try:
        names = sorted((n for n in os.listdir(root) if n[:4].isdigit()), reverse=True)[:CANVAS_LAUNCHES]
    except OSError:
        return []
    out = []
    for name in names:
        d = os.path.join(root, name)
        meta = _cached(os.path.join(d, "meta.json"), lambda p: json.loads(_text(p)))
        if not isinstance(meta, dict) or not meta.get("workflowId"):
            continue
        coord = meta.get("coordinatorTerminal") or (meta.get("runId") and "run:" + meta["runId"])
        if not coord:
            continue
        canvas, wf = "canvas:" + meta["workflowId"], meta.get("workflowName") or meta["workflowId"]
        events = _cached(os.path.join(d, "events.jsonl"), _events) or []
        base = {"run_id": meta.get("runId"), "priority": "normal", "thread_id": "canvas_" + name, "task_id": None,
                "outcome": None, "phase": None, "question": None, "files": [], "read": True, "via": "canvas",
                "canvas_name": wf, "launch": name}

        def msg(i, e, typ, subject, body, frm, to):
            body = str(body or "")
            return {**base, "id": f"canvas_{name}_{i}", "type": typ, "subject": subject,
                    "body": body[:INBOX_BODY_CAP], "cut": len(body) > INBOX_BODY_CAP, "from": frm, "to": to,
                    "created_at": e.get("at"), "kind": e.get("type")}

        req = next((e for e in events if e.get("type") == "requested"), None)
        start = next((e for e in events if e.get("type") == "coordinator"), None)
        if req or start:
            values = "\n".join(f"- {k}: {v}" for k, v in (meta.get("values") or {}).items())
            brief = _cached(os.path.join(d, "brief.md"), _text) or ""
            body = "\n\n".join(x for x in ((req or {}).get("message"), values and "설정값\n" + values,
                                             brief[:CANVAS_BRIEF_CAP] + ("…" if len(brief) > CANVAS_BRIEF_CAP else "")) if x)
            out.append(msg("start", start or req, "dispatch", f"{wf} 실행 지시", body, canvas, coord))
        for i, e in enumerate(events):
            t = e.get("type")
            text = str(e.get("message") or "")
            if t in CANVAS_REPORTS:
                typ, label = CANVAS_REPORTS[t]
                out.append(msg(i, e, typ, f"{label} · {text.splitlines()[0][:80]}" if text else label, text, coord, canvas))
            elif t in ("coordinator-closed", "finished"):
                out.append(msg(i, e, "status", "코디네이터 종료" if t == "coordinator-closed" else "전체 종료", text, canvas, coord))
    return out


def interactions(limit, heartbeats):
    """-> {"messages": [...], "fetched": n}. limit counts the messages kept after the heartbeat filter."""
    # --full: since Orca 1.4 the default rows are a concise view (from/to, a 200-character body, payload ids only,
    # no time or thread), which left every message without its ends and its time
    raw = orca("orchestration", "inbox", "--full", "--limit", str(limit if heartbeats else limit * 3)).get("messages") or []
    with lock:
        by_dispatch = {w.get("dispatchId"): w.get("agentTerminalHandle") for w in orca_state.get("workers", [])
                       if w.get("dispatchId") and w.get("agentTerminalHandle")}
        coords = dict(run_coord)
    payloads = {}
    for m in raw:
        p = m.get("payload") or {}  # a JSON string from older Orca CLIs, an object from newer ones
        try:
            p = json.loads(p) if isinstance(p, (str, bytes)) else p
        except ValueError:
            p = {}
        payloads[m["id"]] = p if isinstance(p, dict) else {}
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
    for m in canvas_msgs():
        ft, fk = term(m["from"]) if not m["from"].startswith("canvas:") else (None, "canvas")
        tt, tk = term(m["to"]) if not m["to"].startswith("canvas:") else (None, "canvas")
        out.append({**m, "from_term": ft, "from_kind": fk, "to_term": tt, "to_kind": tk})
    out.sort(key=lambda m: m.get("created_at") or "", reverse=True)
    return {"messages": out[:limit], "fetched": len(raw)}
