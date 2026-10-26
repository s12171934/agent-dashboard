"""Session endpoints: one session's detail, its conversation, the plans of several, and manual idle marks."""

import json
import re
from urllib.parse import parse_qs

from adash.core.prefs import prefs, save_prefs
from adash.core.state import bump, lock, sessions
from adash.core.util import short
from adash.features.designs.service import session_design_refs
from adash.features.designs.store import design_bases
from adash.features.plans.owners import with_plan_terms
from adash.features.sessions.archive import archived_session
from adash.features.sessions.idle import apply_prefs
from adash.features.terminals.pending import pending_detail
from adash.features.vault.vault import vault_notes
import adash.features.vault.vault as vault_vault


def get_session(h, url):
    path = parse_qs(url.query).get("path", [""])[0]
    with lock:
        s = sessions.get(path)
        waiting = not s and pending_detail(path)  # an agent with no transcript yet
    if waiting:
        return h.send_json(waiting)
    extra = {}
    if not s:
        s = archived_session(path)  # a session the 「설계문서」 tab links to, outside --hours
        extra["archived"] = True
    if s and design_bases:
        extra["design_refs"] = session_design_refs(s.id)  # the sections it (and its subagents) read
    with lock:
        body = s and h.encode({**apply_prefs(with_plan_terms({**s.detail(), "vault_on": vault_vault.vault["on"],
                                                              "vault_notes": vault_notes(s)})), **extra})
    if not body:
        return h.send_json({"error": "not found"}, 404)
    h.send_body(body)


def get_chat(h, url):
    # The conversation alone (prompts and replies at full length, up to CHAT_CHARS), for the chat on a card or the detail.
    path = parse_qs(url.query).get("path", [""])[0]
    with lock:
        s = sessions.get(path)
        chat = list(s.chat) if s else [] if pending_detail(path) else None
    if chat is None:
        s = archived_session(path)
        chat = s and list(s.chat)
    if chat is None:
        return h.send_json({"error": "not found"}, 404)
    h.send_json({"chat": chat})


def get_plans(h, url):
    # The 진행 타임라인: each listed session's aplan plans with step times (the snapshot carries counts only).
    out = {}
    with lock:
        for path in parse_qs(url.query).get("p", [])[:200]:
            s = sessions.get(path)
            if s:
                out[path] = [{"ts": p["ts"], "prompt": short(p["prompt"] or "", 120), "steps": p["steps"]} for p in s.plans[-8:]]
        body = h.encode({"plans": out})
    h.send_body(body)


def post_pref(h, url):
    """{"action": idle|unidle, "paths"}: mark sessions idle by hand, or undo it.
    {"action": "char", "paths", "who", "boss", "pick"}: keep the person drawn for sessions (who null forgets it)."""
    try:
        body = json.loads(h.rfile.read(min(int(h.headers.get("Content-Length") or 0), 65536)))
        action, paths = body["action"], body["paths"]
        assert action in ("idle", "unidle", "char") and isinstance(paths, list)
        who = body.get("who")
        assert action != "char" or who is None or isinstance(who, str) and re.fullmatch(r"[a-z0-9-]{1,40}", who)
    except (ValueError, KeyError, AssertionError, TypeError):
        return h.send_json({"error": "bad request"}, 400)
    with lock:
        for path in paths:
            s = sessions.get(path)
            if not s:
                continue
            if action == "char":
                if who:
                    prefs["chars"][path] = {"who": who, "boss": bool(body.get("boss")), "pick": bool(body.get("pick"))}
                else:
                    prefs["chars"].pop(path, None)
            elif action == "idle":
                prefs["idle"][path] = s.last_ts or ""
            else:
                prefs["idle"].pop(path, None)
        save_prefs()
        bump()
    h.send_json({"ok": True})
