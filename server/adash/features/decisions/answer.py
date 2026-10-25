"""Answering a card or an inbox item from the page."""

import json
import os
import re
import time

from adash.core.config import HERE
from adash.core.orca import orca
from adash.core.state import report_failure
from adash.core.util import short
from adash.features.decisions.picker import PickerError, PickerGone, TYPED, check_answers, type_answers
from adash.features.decisions.store import (decision_lock, decision_store, inbox_store, publish_decisions,
    save_inbox, settle_decision)
import adash.features.terminals.targets as terminals_targets


def decision_terminal(d):
    """The Orca terminal a card's session runs in: the hook's ORCA_TERMINAL_HANDLE, else the session's terminal as
    the last /api/state mapped it (focus_targets). None outside Orca."""
    if d["terminal"]:
        return d["terminal"]
    sid = d["card"]["session_id"]
    return next((h for h, s in terminals_targets.focus_handles.items() if s == sid), None)


DECISION_LOG = os.path.join(HERE, "decision.log")


def log_decision_failure(rid, card, handle, error):
    """One JSON line in decision.log per answer the page could not put in, with the screen the terminal shows
    afterwards: the card reports only the error, and the picker that caused it is gone by the time anyone looks."""
    entry = {"at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "id": rid, "terminal": handle, "error": error,
             "questions": [q["question"][:80] for q in card["questions"]] if card else None}
    if handle:
        try:
            t = orca("terminal", "read", "--terminal", handle, "--screen", timeout=10)["terminal"]
            entry["screen"] = (t["tail"] if isinstance(t["tail"], list) else str(t["tail"]).splitlines())[-40:]
        except Exception as e:
            entry["screen"] = f"(읽지 못함: {short(e, 160)})"
    try:
        with open(DECISION_LOG, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except OSError as e:
        report_failure("decision", e)


def answer_decision(rid, answers):
    """An answer from the page -> (http status, body). Types it into the session's terminal picker. 410 {closed}:
    the terminal shows no picker, so the card is closed (PickerGone); that is logged too, with the screen."""
    status, out, card, handle = answer_decision_once(rid, answers)
    if status != 200:
        log_decision_failure(rid, card, handle, out["error"])
    return status, out


def answer_decision_once(rid, answers):
    """answer_decision's work -> (status, body, the card or None, the terminal handle or None)."""
    with decision_lock:
        d = decision_store.get(rid)
        if not d or d["state"] != "pending":
            return 409, {"error": "이미 답했거나 닫힌 질문입니다"}, d and d["card"], None
        if d["busy"]:
            return 409, {"error": "이 질문의 답을 터미널에 입력하는 중입니다"}, d["card"], None
        answers = check_answers(d["card"], answers)
        if isinstance(answers, str):
            return 400, {"error": answers}, d["card"], None
        handle = decision_terminal(d)
        if not handle:
            return 409, {"error": "이 세션의 Orca 터미널을 찾지 못했습니다 — 터미널에서 답하세요"}, d["card"], None
        d["busy"] = True
    try:
        type_answers(handle, d["card"], answers)
    except PickerGone as e:
        settle_decision(rid, "cancelled")
        return 410, {"error": str(e), "closed": True}, d["card"], handle
    except PickerError as e:
        return 409, {"error": f"{e} — 터미널에서 답하세요"}, d["card"], handle
    except Exception as e:
        return 502, {"error": f"터미널에 입력하지 못했습니다 ({short(e, 160)}) — 터미널에서 답하세요"}, d["card"], handle
    finally:
        with decision_lock:
            d["busy"] = False
    settle_decision(rid, "answered")
    return 200, {"ok": True}, d["card"], handle


def followup_text(card, answers):
    """The message a later answer sends to the session: one line, so --enter submits it whole."""
    went = card["chosen"] or " / ".join(card["recommended"])
    chose = "; ".join(f"「{short(q['question'], 80)}」에 {', '.join(a) if isinstance(a, list) else a}"
                      for q, a in zip(card["questions"], answers) if a is not None)
    return re.sub(r"\s+", " ", f"[대시보드 메일함 {card['id']}] 앞서 {went} (으)로 진행했지만 사용자는 {chose} 를 골랐습니다. 반영하세요.")


def inbox_answer(rid, action, answers):
    """read | unread | delete | answer from the page -> (http status, body). answer: answers in question order, null
    for a question left as it went; sends followup_text to the session's Orca terminal and, once sent, drops the
    item (its session is no longer held). delete: drops it unsent (the page offers it after an error)."""
    with decision_lock:
        d = inbox_store.get(rid)
        if not d:
            return 404, {"error": "메일함에 없는 항목입니다"}
        if action == "delete":
            del inbox_store[rid]
        elif action != "answer":
            d["card"]["read"] = action == "read"
        if action != "answer":
            save_inbox()
            publish_decisions()
            return 200, {"ok": True}
        qs = d["card"]["questions"]
        ok = len(answers) == len(qs) and any(a is not None for a in answers) and all(
            a is None or (isinstance(a, list) and q["multiSelect"] and a and all(isinstance(x, str) and TYPED.match(x) for x in a))
            or (isinstance(a, str) and not q["multiSelect"] and TYPED.match(a)) for q, a in zip(qs, answers))
        if not ok:
            return 400, {"error": "고른 답이 없거나 보낼 수 없는 답입니다"}
        went = [d["card"]["chosen"]] if d["card"]["chosen"] and len(qs) == 1 else None if d["card"]["chosen"] else d["card"]["recommended"]
        if went and all(a is None or a == w or a == [w] for a, w in zip(answers, went)):
            return 400, {"error": "에이전트가 진행한 답과 같습니다 — 바꿀 것이 없으면 「확인」을 누르세요"}
        handle = decision_terminal(d)
        if not handle:
            return 409, {"error": "이 세션의 Orca 터미널을 찾지 못했습니다 — 세션에 직접 알려 주세요"}
        text = followup_text(d["card"], answers)
    try:
        orca("terminal", "send", "--terminal", handle, "--text", text, "--enter", timeout=15)
    except Exception as e:
        return 502, {"error": f"터미널에 보내지 못했습니다 ({short(e, 160)}) — 세션에 직접 알려 주세요"}
    with decision_lock:
        inbox_store.pop(rid, None)
        save_inbox()
        publish_decisions()
    return 200, {"ok": True, "text": text}
