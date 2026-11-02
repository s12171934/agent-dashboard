"""Registering a question from decision-hook, and the recommended answer."""

import os
import threading
import time

from adash.core.prefs import prefs
from adash.core.state import lock
from adash.core.util import short
from adash.features.decisions.guard import retain_worker
from adash.features.decisions.store import (RECOMMENDED, decision_lock, decision_store, inbox_store,
    publish_decisions, save_inbox)
from adash.features.sessions.patterns import HANDLE


def valid_questions(qs):
    return (isinstance(qs, list) and 1 <= len(qs) <= 4 and all(
        isinstance(q, dict) and isinstance(q.get("question"), str) and isinstance(q.get("options"), list)
        and all(isinstance(o, dict) and isinstance(o.get("label"), str) for o in q["options"]) for q in qs))


def add_decision(body):
    """A question from the hook -> {"id"} for a card, or {"id", "inbox": true, "deny": reason} when 메일함 mode
    filed it instead. A body with "permission" is a Bash permission prompt (add_permission)."""
    if "permission" in body:
        return add_permission(body)
    qs = body.get("questions")
    if not valid_questions(qs):
        raise ValueError("questions")
    rid = f"q{int(time.time() * 1000):x}{os.urandom(3).hex()}"
    cwd = body.get("cwd") if isinstance(body.get("cwd"), str) else ""
    term = body.get("terminal") if isinstance(body.get("terminal"), str) and HANDLE.fullmatch(body["terminal"]) else None
    card = {"id": rid, "session_id": str(body.get("session_id") or "") or None, "tool_use_id": body.get("tool_use_id"),
            "agent": os.path.basename(cwd.rstrip("/")) or "에이전트", "cwd": cwd, "created_at": time.time(),
            "questions": [{"question": q["question"], "header": q.get("header") or "", "multiSelect": bool(q.get("multiSelect")),
                           "preview": any(o.get("preview") for o in q["options"]),
                           "options": [{"label": o["label"], "description": o.get("description") or ""} for o in q["options"]]}
                          for q in qs]}
    with lock:
        away = bool(prefs.get("decision_inbox"))
    with decision_lock:
        if away:
            card.update(recommended=[recommended(q) for q in card["questions"]], chosen=None, read=False)
            inbox_store[rid] = {"card": card, "terminal": term}
            save_inbox()
            threading.Thread(target=retain_worker, args=(term,), daemon=True).start()
        else:
            decision_store[rid] = {"card": card, "state": "pending", "terminal": term, "busy": False}
        publish_decisions()
    return {"id": rid, "inbox": True, "deny": deny_reason(card)} if away else {"id": rid}


# Bash 권한 대기: decision-hook also runs as a PermissionRequest hook (matcher "Bash"). Claude Code asks it just
# before it draws the "Do you want to proceed?" prompt, so the page shows the same prompt as a card with two choices.
# 허용 / 거부 press the prompt's "Yes" / "No" row (type_permission). The event has no tool_use_id: the card is closed
# by the session's Bash call with the same command getting a result (stale_decisions). Never filed in the 메일함 —
# a permission is not something to go on without; the prompt just waits.
PERMIT, REFUSE = "허용", "거부"


def add_permission(body):
    p = body["permission"]
    cmd = p.get("command") if isinstance(p, dict) else None
    if not isinstance(cmd, str) or not cmd.strip():
        raise ValueError("permission")
    desc = p.get("description") if isinstance(p.get("description"), str) else ""
    rid = f"q{int(time.time() * 1000):x}{os.urandom(3).hex()}"
    cwd = body.get("cwd") if isinstance(body.get("cwd"), str) else ""
    term = body.get("terminal") if isinstance(body.get("terminal"), str) and HANDLE.fullmatch(body["terminal"]) else None
    card = {"id": rid, "kind": "permission", "command": cmd[:4000], "title": "이 Bash 명령을 실행할까요?",
            "context": short(desc, 200), "session_id": str(body.get("session_id") or "") or None, "tool_use_id": None,
            "agent": os.path.basename(cwd.rstrip("/")) or "에이전트", "cwd": cwd, "created_at": time.time(),
            # The question names the command so the apps and widgets, which show only questions, can tell cards apart.
            "questions": [{"question": f"Bash 실행 허용? {short(cmd, 160)}", "header": "Bash 권한", "multiSelect": False,
                           "preview": False,
                           "options": [{"label": PERMIT, "description": "이번 한 번 실행합니다 (Yes)"},
                                       {"label": REFUSE, "description": "실행하지 않습니다 (No)"}]}]}
    with decision_lock:
        decision_store[rid] = {"card": card, "state": "pending", "terminal": term, "busy": False}
        publish_decisions()
    return {"id": rid}


def recommended(q):
    labels = [o["label"] for o in q["options"]]
    return next((x for x in labels if RECOMMENDED.search(x)), labels[0] if labels else "")


def deny_reason(card):
    """What Claude reads in place of the user's answer."""
    qs, picks = card["questions"], card["recommended"]
    fmt = f"[메일함 {card['id']}] " + ("답" if len(qs) == 1 else " / ".join(f"{i + 1}) 답" for i in range(len(qs))))
    rec = "; ".join(f"{i + 1}) {short(q['question'], 80)} → {p}" for i, (q, p) in enumerate(zip(qs, picks)))
    return ("사용자가 자리를 비워 이 질문을 에이전트 대시보드 메일함에 남겼습니다(메일함 모드). AskUserQuestion 을 다시 부르지 말고, "
            "각 질문의 권장 선택지((Recommended) 가 붙은 것, 없으면 첫 번째)나 가장 합리적인 판단으로 진행하세요. "
            f"진행하기 전에 무엇을 골랐는지 정확히 이 형식의 한 줄로 남기세요: {fmt} "
            "(사용자가 나중에 다른 답을 고르면 이 세션에 후속 메시지가 옵니다. 그러니 작업이 끝나도 이 세션을 닫지 마세요). "
            f"권장 선택지: {rec}")
