"""Decision cards and the inbox (메일함): their state, persistence and mode."""

import json
import os
import re
import threading
import time

from adash.core.config import HERE
from adash.core.prefs import prefs, save_prefs
from adash.core.state import bump, lock


# ---- 결정 버튼: AskUserQuestion shown on the page, answered in either place ----
# decision-hook (next to this file) is a Claude Code PreToolUse hook on AskUserQuestion. It registers the question
# here (/api/decision/ask) and ends at once, so Claude opens the terminal picker as usual and the page shows the same
# question as a card. An answer in the terminal closes the card once the transcript has the tool result
# (stale_decisions). An answer from the page is typed into that picker through the session's Orca terminal
# (type_answers), one key at a time, reading the rendered screen before and after each step; when the terminal is
# unknown or the screen is not what is expected it stops and says so, and the picker stays for the terminal.
DECISION_EVERY = 1.5
DECISION_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
DECISION_KEEP_S = 7200  # a card whose question never got a result in the transcript goes after this
decisions = {"available": True, "pending": [], "inbox_mode": False, "inbox": []}  # what /api/state shows: the open
# cards, oldest first; whether 메일함 mode is on; the 메일함, newest first
decision_lock = threading.Lock()  # guards decision_store and inbox_store
decision_store = {}  # id -> {"card": the public card, "state": pending|answered|cancelled, "terminal", "busy"}
# Open cards outlive restarts too (pending.json, {id: {"card", "terminal"}}): the hook registers a question once,
# so a restart while its picker is open used to drop the card for good. sweep_decisions closes the ones answered
# or cancelled in the meantime, as it does any card.
PENDING_PATH = os.path.join(HERE, "pending.json")
try:
    with open(PENDING_PATH) as _f:
        decision_store = {d["card"]["id"]: {"card": d["card"], "state": "pending", "terminal": d.get("terminal"),
                                            "busy": False} for d in json.load(_f)["items"]}
except (OSError, ValueError, KeyError, TypeError):
    pass

# 메일함 모드 (prefs "decision_inbox", one switch for the whole server): the user is away. The hook still registers
# each question, but it is filed in the 메일함 instead of opening a card, and /api/decision/ask answers {"deny": reason};
# the hook turns that into a PreToolUse deny, so no picker opens and Claude goes on with the recommended option
# ("(Recommended)" in its label, else the first) or its own best call. The reason asks it to write its pick as one
# line "[메일함 <id>] ..."; the transcript scan keeps that line (Session.inbox_picks) and sweep_decisions copies it
# to the item. Until then the item shows the recommended options the server worked out. Choosing another answer on
# the page later sends the session a follow-up message through its Orca terminal (inbox_answer).
# Items outlive restarts (inbox.json): {id: {"card": the public item, "terminal"}}.
# While a session has an item it is held: the scan keeps it listed however old (scan_loop), a supervised worker's
# terminal is retained (retain_worker), and session-guard keeps agents from closing it (guard_command). A person
# may still close it from the page. An item whose session the scan does not know is dropped, like an orphan card.
INBOX_PATH = os.path.join(HERE, "inbox.json")
INBOX_KEEP = 200  # newest items kept ...
INBOX_KEEP_S = 14 * 86400  # ... and read ones only this long
INBOX_PICK = re.compile(r"\[메일함 (q[0-9a-f]{8,40})\][ \t]*([^\n]{1,300})")
RECOMMENDED = re.compile(r"\((?:Recommended|권장|추천)\)", re.I)
try:
    with open(INBOX_PATH) as _f:
        inbox_store = {d["card"]["id"]: d for d in json.load(_f)["items"]}
except (OSError, ValueError, KeyError, TypeError):
    inbox_store = {}


def inbox_sessions():
    """Session ids that have a 메일함 item."""
    with decision_lock:
        return {d["card"]["session_id"] for d in inbox_store.values() if d["card"]["session_id"]}


def save_inbox():
    """Call holding decision_lock."""
    tmp = INBOX_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump({"items": list(inbox_store.values())}, f, ensure_ascii=False)
    os.replace(tmp, INBOX_PATH)


def publish_decisions():
    """Copy the open cards into `decisions` for /api/state. Call holding decision_lock, not `lock`."""
    pending = sorted((d["card"] for d in decision_store.values() if d["state"] == "pending"), key=lambda c: c["created_at"])
    inbox = sorted((dict(d["card"]) for d in inbox_store.values()), key=lambda c: c["created_at"], reverse=True)
    with lock:
        mode = bool(prefs.get("decision_inbox"))
        moved = pending != decisions["pending"]
        if moved or inbox != decisions["inbox"] or mode != decisions["inbox_mode"]:
            decisions.update(pending=pending, inbox=inbox, inbox_mode=mode)
            bump()
    if moved:
        save_pending()


def save_pending():
    """Call holding decision_lock."""
    items = [{"card": d["card"], "terminal": d["terminal"]} for d in decision_store.values() if d["state"] == "pending"]
    tmp = PENDING_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump({"items": items}, f, ensure_ascii=False)
    os.replace(tmp, PENDING_PATH)


def settle_decision(rid, state):
    """pending -> answered | cancelled. False when it was not pending."""
    with decision_lock:
        d = decision_store.get(rid)
        if not d or d["state"] != "pending":
            return False
        d.update(state=state, settled=time.time())
        publish_decisions()
        return True


def set_inbox_mode(on):
    with lock:
        prefs["decision_inbox"] = on
        save_prefs()
    with decision_lock:
        publish_decisions()
