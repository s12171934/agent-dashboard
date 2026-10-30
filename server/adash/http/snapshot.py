"""The /api/state snapshot, built once per version, and the /events stream that announces new versions."""

import gzip
import json
import os
import threading
import time

from adash.core.state import health, lock, report_failure, sessions
from adash.core.util import short
from adash.features.decisions.store import decisions
from adash.features.designs.store import DESIGN_DIRS
from adash.features.flow.rules import FLOW_RULES, flow_check
from adash.features.orca_runs.lite import lite_orca
from adash.features.orca_runs.settled import settled_store
from adash.features.orca_runs.store import orca_state
from adash.features.plans.owners import plan_owners, plan_with_owner, resolve_plan_owner, with_plan_terms
from adash.features.plans.store import EXTERNAL_PLANS, ext_plans
from adash.features.projects.store import PROJECTS_DIRS
from adash.features.review.qa import qa_family
from adash.features.review.store import review_state
from adash.features.sessions.aliases import fold_handle_aliases
from adash.features.sessions.idle import apply_prefs
from adash.features.terminals.pending import pending_sessions
from adash.features.terminals.targets import close_tree, focus_targets
from adash.features.tests.tests import test_progress
import adash.core.config as core_config
import adash.core.state as core_state
import adash.features.designs.store as designs_store
import adash.features.plan_usage.usage as plan_usage_mod
import adash.features.projects.store as projects_store
import adash.features.terminals.targets as terminals_targets

state_cache_lock = threading.Lock()  # one /api/state build at a time; the others wait and take its bytes
state_cache = {"v": -1, "body": b"", "gz": b"", "at": 0.0, "glance": None}
STATE_CACHE_SECONDS = 5  # health.now and the age-based states move without a version bump

# Bumped when a change to /api/* or /events would break a page built for the old shape; the page compares it
# with the one it was built for and says so instead of rendering garbage.
API_VERSION = 1


def build_state(encode):
    """-> (version, encoded /api/state body)."""
    with lock:
        v = core_state.version
        # The same Codex session can exist as two files (Orca home and ~/.codex): keep the fuller copy.
        by_id = {}
        for s in sessions.values():
            cur = by_id.get((s.kind, s.id))
            if not cur or (s.offset, s.last_ts or "") > (cur.offset, cur.last_ts or ""):
                by_id[(s.kind, s.id)] = s
        # A worker whose dispatch settled is done, even if its transcript stopped mid-turn
        # (release can end the process before the closing message is written).
        # Also covers Runs that aged out of the tracked window (settled_store).
        settled = {**settled_store["tasks"],
                   **{w.get("taskId"): w.get("dispatchStatus") for w in orca_state.get("workers", [])
                      if w.get("dispatchStatus") in ("completed", "failed", "cancelled")}}
        summaries = []
        waiting = {}  # Claude session id -> its oldest pending question (decisions lists oldest first)
        for r in decisions["pending"]:
            waiting.setdefault(r.get("session_id") or None, r)
        for sess in by_id.values():
            sm = sess.summary()
            if sm["task_id"] in settled:
                sm.update(state="done", live=False, state_reason="Orca: dispatch " + settled[sm["task_id"]])
            sm["decision"] = waiting.get(sm["id"]) if sm["kind"] == "claude" else None
            summaries.append(sm)
        fold_handle_aliases(summaries)
        # Owners first (from the sessions' own terminals), then each owner takes its plans' scripts.
        plan_owners.clear()
        plan_owners.update({p: resolve_plan_owner(p, plan, summaries) for p, plan in ext_plans.items()})
        summaries = [apply_prefs(with_plan_terms(sm)) for sm in summaries]
        focus = focus_targets(summaries)
        qa_family(summaries, focus, review_state["sets"])
        terms = {t["handle"] for t in orca_state.get("terminals", []) if t.get("connected")}
        trees = {}
        for sm in summaries:
            sm["orca_focus"] = focus.get(sm["id"])
            sm["orca_close_tree"] = close_tree(sm, summaries, focus, terms) if sm["orca_focus"] else []
            if sm["orca_focus"]:
                trees[sm["orca_focus"]] = sm["orca_close_tree"]
        # Agents with no transcript yet (started without a prompt) are listed by their terminal; flow_check skips them.
        pending = pending_sessions(set(focus.values()))
        for sm in pending:
            sm["orca_focus"], sm["orca_close_tree"] = sm["id"], []
            focus[sm["id"]] = sm["id"]
        # Rebound, never edited in place: orca_terminal reads them without waiting for this lock.
        terminals_targets.focus_handles = {h: sid for sid, h in focus.items()}
        terminals_targets.close_trees = trees
        try:
            flow = flow_check(summaries, orca_state.get("tasks") or {},
                              {s.path: s.plans[-1] for s in by_id.values() if s.plans}, review_state["sets"])
        except Exception as e:  # a rule bug must not take the whole snapshot down
            report_failure("flow_check", e)
            flow = {"contracts": None, "items": [], "ok": 0, "rules": FLOW_RULES, "error": short(repr(e), 200)}
        design = designs_store.design
        body = encode({
            "version": core_state.version, "api": API_VERSION,
            "sessions": sorted(summaries + pending, key=lambda s: s["last_ts"] or "", reverse=True),
            "orca": lite_orca(orca_state),
            "ext_plans": [{**plan_with_owner(p, ext_plans[p]), "design_refs": designs_store.design_ticket_refs.get(p) or {}}
                          for p in EXTERNAL_PLANS if p in ext_plans],
            "design": {"enabled": bool(DESIGN_DIRS or design["sources"]),
                       "version": f'{design["version"]}.{designs_store.design_rev}'},
            "tests": test_progress,
            "reviews_at": review_state["updated"],
            "health": {"now": time.time(), "loops": health},
            "decisions": decisions,
            "flow": flow,
            "plan_usage": plan_usage_mod.plan_usage,
            # the vault root (--vault): the page links its notes by vault name and relative path, which a phone can open
            "vault": core_config.VAULT if os.path.isdir(core_config.VAULT) else None,
        })
    return v, body


def get_root(h, url):
    h.send_json({"name": "agent-dashboard", "api": API_VERSION})


def fresh_state(encode):
    """-> (body, gzipped body) of the current snapshot. Every open page refetches on each version tick: build it once
    per version and hand the same bytes to the rest (three tabs used to rebuild it three times, each under the lock)."""
    with state_cache_lock:
        if not (state_cache["v"] == core_state.version and time.time() - state_cache["at"] < STATE_CACHE_SECONDS):
            v, raw = build_state(encode)
            state_cache.update(v=v, body=raw, gz=gzip.compress(raw, 5), at=time.time(), glance=None)
        return state_cache["body"], state_cache["gz"]


def get_state(h, url):
    raw, gz = fresh_state(h.encode)
    h.send_body(raw, gz=gz)  # sent outside the cache lock: a slow client holds up no one


# /api/glance: what the iPhone widgets show, a few KB instead of the snapshot's megabytes (a widget has little memory
# and time). The 결정 대기 questions, the agents by state with the busiest few, and the latest test runs.
GLANCE_ORDER = ["run", "stalled", "wait", "bg"]  # the states shown, most urgent first


def glance(state):
    titles = {s["id"]: s.get("title") for s in state["sessions"]}
    pend = (state.get("decisions") or {}).get("pending") or []
    paths = {s["id"]: s.get("path") for s in state["sessions"]}
    decisions = []
    for d in pend:
        qs = d.get("questions") or [{}]
        q = qs[0]
        decisions.append({
            "id": d["id"], "title": titles.get(d.get("session_id")) or d.get("agent") or "에이전트",
            "header": q.get("header"), "question": short(q.get("question", ""), 240), "more": len(qs) - 1,
            # one single-choice question can be answered from the widget, as from a notification
            "options": [o.get("label", "") for o in q.get("options") or []] if len(qs) == 1 and not q.get("multiSelect") else [],
            "path": paths.get(d.get("session_id"))})
    # the page's own agents only (no subagents), each in the state the page shows
    agents = [s for s in state["sessions"] if s.get("role") != "sub" and not s.get("parent")]
    counts = {k: sum(1 for s in agents if s.get("state") == k) for k in GLANCE_ORDER}
    busy = sorted((s for s in agents if s.get("state") in GLANCE_ORDER), key=lambda s: s.get("last_ts") or "", reverse=True)
    busy.sort(key=lambda s: GLANCE_ORDER.index(s["state"]))  # stable: the latest first within a state
    files = (state.get("tests") or {}).get("files") or []
    tests = sorted(files, key=lambda t: (t.get("phase") != "running", -(t.get("mtime") or 0)))[:4]
    return {
        "api": API_VERSION, "now": time.time(),
        "decisions": decisions,
        "agents": {"counts": counts,
                   "busy": [{"title": s.get("title"), "state": s["state"], "model": s.get("model"), "last_ts": s.get("last_ts"),
                             "path": s.get("path")} for s in busy[:6]]},
        "tests": [{k: t.get(k) for k in ("label", "kind", "phase", "verdict", "total", "done", "passed", "failed", "eta_s",
                                          "started_at", "updated_at")} for t in tests],
    }


def get_glance(h, url):
    raw, _ = fresh_state(h.encode)
    with state_cache_lock:
        if state_cache.get("glance") is None or state_cache["body"] is not raw:
            state_cache["glance"] = h.encode(glance(json.loads(raw)))
        body = state_cache["glance"]
    h.send_json(body)


def get_events(h, url):
    h.send_response(200)
    h.send_header("Content-Type", "text/event-stream")
    h.send_header("Cache-Control", "no-cache")
    h.end_headers()
    seen = seen_projects = -1
    try:
        while True:
            # Project changes go out as a named event, so a page listening only for plain messages
            # (the /api/state refetch) is not woken by them.
            if PROJECTS_DIRS and projects_store.projects["version"] != seen_projects:
                seen_projects = projects_store.projects["version"]
                h.wfile.write(f"event: projects\ndata: {seen_projects}\n\n".encode())
            if core_state.version != seen:
                seen = core_state.version
                h.wfile.write(f"data: {seen}\n\n".encode())
            else:
                h.wfile.write(b": ping\n\n")
            h.wfile.flush()
            time.sleep(1)
    except (BrokenPipeError, ConnectionResetError):
        pass
