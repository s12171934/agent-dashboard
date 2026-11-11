"""Workflow-canvas decisions as 결정 대기 cards: the user decisions a workflow run waits on, answered here as on the canvas.

workflow-canvas (40_Tools/workflow-canvas) lists every user decision open now — a gate the coordinator asks, a branch
judged by the user, a gate the worker before it asks in its terminal — at GET /api/decisions. canvas_sweep reads it
and keeps each one as a card in canvas_store, shaped like a hook question (kind "canvas", one question whose options
are the decision's outputs), so the page, the alert strip, notifications and the widget show it with the rest. A pick
here posts the decision to the canvas (by "user", via "대시보드"), exactly what the canvas's own card does; the
coordinator, which never waits on the user, takes it on its next check. A decision taken anywhere else leaves the
canvas's list, and the card goes on the next sweep. The canvas not running means no cards, not an error.
"""

import hashlib
import json
import time
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

from adash.features.canvas.canvas import PORT, up
from adash.features.decisions.store import canvas_store, decision_lock, publish_decisions

BASE = f"http://127.0.0.1:{PORT}"
CANVAS_EVERY = 3.0
_last = {"at": 0.0}


def card_id(d):
    key = "\n".join(str(d.get(k)) for k in ("workflowId", "executionId", "node"))
    return "c" + hashlib.sha1(key.encode()).hexdigest()[:20]


def to_card(d, created_at):
    """A canvas PendingDecision -> a 결정 대기 card."""
    outputs = [o for o in d.get("outputs") or [] if isinstance(o, dict) and isinstance(o.get("id"), str)]
    label = d.get("label") or d.get("node") or "결정"
    asked = (d.get("askedBy") or {}).get("label")
    context = f"{d.get('workflowName') or d.get('workflowId')} · {d.get('executionLabel') or d.get('executionId')}"
    if asked:
        context += f" · 「{asked}」 워커 터미널에서도 묻고 있습니다"
    return {"id": card_id(d), "kind": "canvas", "session_id": None, "tool_use_id": None,
            "agent": d.get("workflowName") or "워크플로", "cwd": "", "created_at": created_at, "context": context,
            "questions": [{"question": d.get("question") or label, "header": label, "multiSelect": d.get("mode") != "exclusive",
                           "preview": False, "options": [{"label": o.get("label") or o["id"], "description": ""} for o in outputs]}],
            "canvas": {"workflow": d.get("workflowId"), "execution": d.get("executionId"), "node": d.get("node"),
                       "outputs": [o["id"] for o in outputs], "task": d.get("taskId"), "run": d.get("runId")}}


def fetch():
    """The canvas's open decisions ([] when it is not running), or None when it did not answer."""
    if not up():
        return []
    try:
        with urlopen(Request(BASE + "/api/decisions"), timeout=8) as res:
            items = json.load(res).get("decisions")
    except (OSError, URLError, ValueError, AttributeError):
        return None
    return [d for d in items if isinstance(d, dict)] if isinstance(items, list) else None


def canvas_sweep():
    """Reconcile canvas_store with the canvas's list (at most every CANVAS_EVERY s). A failed read keeps the cards."""
    if time.time() - _last["at"] < CANVAS_EVERY:
        return
    _last["at"] = time.time()
    items = fetch()
    if items is None:
        return
    now = time.time()
    with decision_lock:
        seen = set()
        for d in items:
            rid = card_id(d)
            seen.add(rid)
            kept = canvas_store.get(rid)
            card = to_card(d, kept["card"]["created_at"] if kept else now)
            canvas_store[rid] = {"card": card, "hidden": bool(kept and kept["hidden"])}
        for rid in [k for k in canvas_store if k not in seen]:
            del canvas_store[rid]
        publish_decisions()


def canvas_answer(rid, answers):
    """A pick from the page -> (http status, body). answers: [label] for one output, [[labels]] for several."""
    with decision_lock:
        d = canvas_store.get(rid)
        if not d or d["hidden"]:
            return 409, {"error": "이미 결정했거나 닫힌 결정입니다"}
        card = d["card"]
        q = card["questions"][0]
        labels = {o["label"]: oid for o, oid in zip(q["options"], card["canvas"]["outputs"])}
        a = answers[0] if len(answers) == 1 else None
        picked = a if isinstance(a, list) and q["multiSelect"] else [a] if isinstance(a, str) and not q["multiSelect"] else None
        if not picked or not all(isinstance(x, str) and x in labels for x in picked):
            return 400, {"error": "선택지에 있는 출력만 고를 수 있습니다"}
        c = card["canvas"]
    url = f"{BASE}/api/workflows/{quote(c['workflow'], safe='')}/executions/{quote(c['execution'], safe='')}/decisions"
    body = json.dumps({"node": c["node"], "outputs": [labels[x] for x in picked], "by": "user", "via": "대시보드"}).encode()
    try:
        with urlopen(Request(url, data=body, headers={"Content-Type": "application/json"}, method="POST"), timeout=20):
            pass
    except HTTPError as e:
        try:
            why = json.load(e).get("error")
        except (ValueError, AttributeError):
            why = None
        if e.code == 409:  # decided already (on the canvas, by the coordinator): the card goes
            canvas_close(rid)
            return 410, {"error": why or "이미 결정된 단계입니다", "closed": True}
        return (400 if e.code == 400 else 502), {"error": why or f"캔버스가 거절했습니다 ({e.code})"}
    except (OSError, URLError) as e:
        return 502, {"error": f"캔버스에 보내지 못했습니다 ({e}) — 캔버스에서 고르세요"}
    canvas_close(rid)
    return 200, {"ok": True}


def canvas_close(rid):
    """Take a card off the page until the canvas's list no longer has it (answered, or dismissed by the user)."""
    with decision_lock:
        d = canvas_store.get(rid)
        if not d or d["hidden"]:
            return False
        d["hidden"] = True
        publish_decisions()
        return True
