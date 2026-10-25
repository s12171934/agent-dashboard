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
    filed it instead."""
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
