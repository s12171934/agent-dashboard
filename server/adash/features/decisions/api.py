"""Decision endpoints: questions from decision-hook, answers and inbox actions from the page, session-guard checks."""

import json

from adash.core.prefs import prefs
from adash.core.state import lock
from adash.features.decisions.answer import answer_decision, inbox_answer
from adash.features.decisions.ask import add_decision
from adash.features.decisions.guard import guard_command
from adash.features.decisions.store import DECISION_ID, set_inbox_mode, settle_decision


def get_wait(h, url):
    # A decision-hook from before the hook stopped waiting may still poll after an update: let it step aside
    # (the terminal picker opens), since this server no longer holds questions for it.
    h.send_json({"state": "gone"})


def get_mode(h, url):
    with lock:
        h.send_json({"inbox": bool(prefs.get("decision_inbox"))})


def post_decision(h, url):
    """ask {session_id, tool_use_id, cwd, terminal, questions} from the hook -> {id}, or with 메일함 mode on
    {id, inbox, deny} (add_decision). answer {id, answers} from the page: types them into the session's terminal
    picker (answer_decision); 200 done, 400 an answer missing or one the picker cannot take, 409 no longer open or
    the terminal not usable, 502 Orca failed. release {id}: the old page's 「터미널에서 답하기」; the picker is
    already open, so nothing to do. dismiss {id}: take a card off the page (the terminal picker stays); the page
    offers it after an error. mode {inbox: bool}: 메일함 mode on or off. inbox {id, action read|unread|delete|answer,
    answers}: a 메일함 item (inbox_answer). guard {command, terminal, cwd} from session-guard -> {deny} when the
    command would close a session with a 메일함 item (guard_command), else {}."""
    action = url.path.rsplit("/", 1)[1]
    try:
        body = json.loads(h.rfile.read(min(int(h.headers.get("Content-Length") or 0), 262144)))
        assert isinstance(body, dict)
        if action == "ask":
            return h.send_json(add_decision(body))
        if action == "guard":
            assert isinstance(body["command"], str)
            own, cwd = body.get("terminal"), body.get("cwd")
            why = guard_command(body["command"], own if isinstance(own, str) else None, cwd if isinstance(cwd, str) else "")
            return h.send_json({"deny": why} if why else {})
        if action == "mode":
            assert isinstance(body["inbox"], bool)
            set_inbox_mode(body["inbox"])
            return h.send_json({"ok": True, "inbox": body["inbox"]})
        rid = body["id"]
        assert isinstance(rid, str) and DECISION_ID.match(rid)
        assert action != "answer" or isinstance(body["answers"], list)
        assert action != "inbox" or body["action"] in ("read", "unread", "delete", "answer")
        assert action != "inbox" or body["action"] != "answer" or isinstance(body["answers"], list)
    except (ValueError, KeyError, AssertionError, TypeError):
        return h.send_json({"error": "bad request"}, 400)
    if action == "answer":
        status, out = answer_decision(rid, body["answers"])
        return h.send_json(out, status)
    if action == "inbox":
        status, out = inbox_answer(rid, body["action"], body.get("answers") or [])
        return h.send_json(out, status)
    if action == "dismiss":
        if not settle_decision(rid, "cancelled"):
            return h.send_json({"error": "이미 답했거나 닫힌 질문입니다"}, 409)
        return h.send_json({"ok": True})
    h.send_json({"ok": True})
