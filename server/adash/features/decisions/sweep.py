"""Closing cards answered elsewhere, and the decision collector loop."""

import time

from adash.core.state import lock, loop_failed, loop_ok, sessions
from adash.features.decisions.store import (DECISION_EVERY, DECISION_KEEP_S, INBOX_KEEP, INBOX_KEEP_S, decision_lock,
    decision_store, decisions, inbox_store, publish_decisions, save_inbox, settle_decision)
import adash.features.sessions.scan as sessions_scan


# A question answered in the terminal, cancelled there, or ended with its session is closed by the transcript: the
# AskUserQuestion call the card came from (its tool_use_id; without one, the same session's call with the same first
# question logged within ASK_MATCH_S of the card) already has a tool result. Such cards are cancelled here, as are ones past DECISION_KEEP_S.
# So is a card no Claude session in the scan window owns (no session id, or a session the scan does not know) once
# ORPHAN_S has passed: the page could not link it to a session, and such a question has been closed.
ASK_MATCH_S = 120
ORPHAN_S = 90  # time for the scan to pick up the transcript of a session that just started


def stale_decisions(pending):
    """Ids of pending questions whose AskUserQuestion call already ended in the session's transcript."""
    by_id = {s.id: s for s in sessions.values() if s.kind == "claude"}
    out = set()
    for r in pending:
        s, qs = by_id.get(r.get("session_id")), r.get("questions")
        q0 = qs[0].get("question") if isinstance(qs, list) and qs and isinstance(qs[0], dict) else None
        if not s or not q0 or not isinstance(r.get("created_at"), (int, float)):
            continue
        if r.get("tool_use_id"):
            # Not logged yet while the picker opens; matching by question here would take an earlier identical call.
            if s.asks.get(r["tool_use_id"], [0, 0, False])[2]:
                out.add(r.get("id"))
            continue
        near = [a for a in s.asks.values() if a[0] == q0 and abs(a[1] - r["created_at"]) <= ASK_MATCH_S]
        if near and min(near, key=lambda a: abs(a[1] - r["created_at"]))[2]:
            out.add(r.get("id"))
    return out


def sweep_decisions():
    """Cancel stale, orphaned or abandoned cards and forget settled ones after a while."""
    with lock:
        pending = list(decisions["pending"])
        stale = stale_decisions(pending)
        known = {s.id for s in sessions.values() if s.kind == "claude"}
    now = time.time()
    for r in pending:
        orphan = sessions_scan.scan_ready and r.get("session_id") not in known and now - r["created_at"] > ORPHAN_S
        if r["id"] in stale or orphan or now - r["created_at"] > DECISION_KEEP_S:
            settle_decision(r["id"], "cancelled")
    with lock:
        picks = {k: v for s in sessions.values() if s.kind == "claude" for k, v in s.inbox_picks.items()}
    with decision_lock:
        for rid in [k for k, d in decision_store.items() if d["state"] != "pending" and now - d.get("settled", now) > 300]:
            del decision_store[rid]
        changed = False
        for rid, d in inbox_store.items():
            if picks.get(rid) and d["card"]["chosen"] != picks[rid]:
                d["card"]["chosen"] = picks[rid]
                changed = True
        keep = sorted(inbox_store, key=lambda k: inbox_store[k]["card"]["created_at"], reverse=True)[:INBOX_KEEP]
        orphan = lambda c: sessions_scan.scan_ready and c["session_id"] not in known and now - c["created_at"] > ORPHAN_S
        for rid in [k for k, d in inbox_store.items() if k not in keep or orphan(d["card"])
                    or (d["card"]["read"] and now - d["card"]["created_at"] > INBOX_KEEP_S)]:
            del inbox_store[rid]
            changed = True
        if changed:
            save_inbox()
        publish_decisions()


def decision_loop():
    while True:
        try:
            sweep_decisions()
            loop_ok("decision")
        except Exception as e:
            loop_failed("decision", e)
        time.sleep(DECISION_EVERY)
