"""The /api/state snapshot, built once per version, and the /events stream that announces new versions."""

import collections
import gzip
import json
import os
import threading
import time
from urllib.parse import parse_qs

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
from adash.features.tests.tests import lite_test, test_progress
import adash.core.config as core_config
import adash.core.state as core_state
import adash.features.designs.store as designs_store
import adash.features.plan_usage.usage as plan_usage_mod
import adash.features.projects.store as projects_store
import adash.features.terminals.targets as terminals_targets

state_cache_lock = threading.Lock()  # one /api/state build at a time; the others wait and take its result
# v: core version built · at: when · parts/sig: the build (parts_split) · cv: content version, the core version of
# the last build that showed something new (what the page holds and sends back as ?base=) · full/gz: the whole body,
# made on demand · deltas: base -> body, for this build · glance / decisions: the small views, made on demand
state_cache = {"v": -1, "at": 0.0, "parts": None, "sig": None, "cv": 0, "full": None, "gz": None, "deltas": {},
               "glance": None, "decisions": None}
STATE_CACHE_SECONDS = 5  # health.now and the age-based states move without a version bump
SIG_KEEP = 40  # content versions a page may still hold and get a delta from
sig_history = collections.OrderedDict()  # content version -> signature, oldest first
EVENTS_BUILD_GAP = 1.5  # /events builds at most this often to see whether the content moved

# Bumped when a change to /api/* or /events would break a page built for the old shape; the page compares it
# with the one it was built for and says so instead of rendering garbage.
API_VERSION = 1

# ---------- the snapshot in parts ----------
# A part is either a whole value ("obj": its encoded bytes) or a list sent item by item ("list": [(key, bytes)]).
# Each build is summed up as a signature (a hash per obj part, a hash per list item); two builds with the same
# signature show the same thing, so the page is told about a new snapshot only when the signature moves, and a page
# that holds an earlier one gets only what changed (parts_delta).

# Lists sent item by item: their path in the snapshot -> the item's key. frontend/api.js keys them the same way
# (PART_KEYS). A list with a repeated key is sent whole.
KEYED = {
    "sessions": lambda s: f'{s.get("kind")}:{s.get("id")}',
    "ext_plans": lambda p: p.get("path"),
    "tests.files": lambda f: f.get("key"),
}
# The page sorts these itself (newest last_ts first, as the full snapshot does), so their order is never sent.
SELF_SORTED = {"sessions"}
# Parts that move on every build without anything to redraw: left out of the signature, always in a delta.
VOLATILE = ("version", "health")


def parts_split(snap, encode):
    """Snapshot dict -> {part name: ("obj", bytes) | ("list", [(key, bytes)])}. tests.files is its own part."""
    parts = {}
    for name, val in snap.items():
        if name == "tests":
            parts["tests"] = ("obj", encode({k: v for k, v in val.items() if k != "files"}))
            name, val = "tests.files", val.get("files") or []
        if name in KEYED:
            items = [(KEYED[name](x), encode(x)) for x in val]
            if len({k for k, _ in items}) == len(items):
                parts[name] = ("list", items)
                continue
            parts[name] = ("obj", b"[" + b",".join(b for _, b in items) + b"]")
        else:
            parts[name] = ("obj", encode(val))
    return parts


def parts_signature(parts):
    sig = {}
    for name, (kind, val) in parts.items():
        if name in VOLATILE:
            continue
        sig[name] = hash(val) if kind == "obj" else (hash(tuple(k for k, _ in val)), {k: hash(b) for k, b in val})
    return sig


def _list(items):
    return b"[" + b",".join(b for _, b in items) + b"]"


def _field(name, body):
    return json.dumps(name).encode() + b":" + body


def parts_full(parts):
    """The whole snapshot as one JSON object, the shape /api/state always had."""
    fields = []
    for name, (kind, val) in parts.items():
        if name == "tests.files":
            continue
        body = val if kind == "obj" else _list(val)
        if name == "tests":
            files = parts["tests.files"]
            files = files[1] if files[0] == "obj" else _list(files[1])
            body = b'{"files":' + files + (b"," + body[1:] if body != b"{}" else b"}")
        fields.append(_field(name, body))
    return b"{" + b",".join(fields) + b"}"


def parts_delta(parts, old, new, base, encode):
    """What a page holding the snapshot with signature `old` (content version `base`) needs to reach `parts`:
    {"version", "api", "base", "health", "delta": {obj part: value, list part: {"upd": [items], "del": [keys],
    "order": [keys] when the order or membership changed}}}. Parts that did not change are left out of "delta"."""
    out = []
    for name, (kind, val) in parts.items():
        if name in VOLATILE:
            continue
        if kind == "obj" or not isinstance(old.get(name), tuple):
            if old.get(name) != new[name]:
                out.append(_field(name, val if kind == "obj" else _list(val)))
            continue
        (okeys, oitems), (nkeys, nitems) = old[name], new[name]
        upd = [b for k, b in val if oitems.get(k) != nitems[k]]
        gone = [k for k in oitems if k not in nitems]
        if not upd and not gone and okeys == nkeys:
            continue
        body = b'{"upd":[' + b",".join(upd) + b'],"del":' + encode(gone)
        if okeys != nkeys and name not in SELF_SORTED:
            body += b',"order":' + encode([k for k, _ in val])
        out.append(_field(name, body + b"}"))
    head = [_field(n, parts[n][1]) for n in VOLATILE if n in parts]
    return b"{" + b",".join(head + [_field("api", parts["api"][1]), _field("base", encode(base)),
                                    b'"delta":{' + b",".join(out) + b"}"]) + b"}"


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
        snap = {
            "version": core_state.version, "api": API_VERSION,
            "sessions": sorted(summaries + pending, key=lambda s: s["last_ts"] or "", reverse=True),
            "orca": lite_orca(orca_state),
            "ext_plans": [{**plan_with_owner(p, ext_plans[p]), "design_refs": designs_store.design_ticket_refs.get(p) or {}}
                          for p in EXTERNAL_PLANS if p in ext_plans],
            "design": {"enabled": bool(DESIGN_DIRS or design["sources"]),
                       "version": f'{design["version"]}.{designs_store.design_rev}'},
            "tests": {**test_progress, "files": [lite_test(f) for f in test_progress["files"]]},
            "reviews_at": review_state["updated"],
            "health": {"now": time.time(), "loops": health},
            "decisions": decisions,
            "flow": flow,
            "plan_usage": plan_usage_mod.plan_usage,
            # the vault root (--vault): the page links its notes by vault name and relative path, which a phone can open
            "vault": core_config.VAULT if os.path.isdir(core_config.VAULT) else None,
        }
        # Encoded under the lock: tests, decisions and the Orca snapshot are the collectors' own dicts.
        parts = parts_split(snap, encode)
    return v, parts


def get_root(h, url):
    h.send_json({"name": "agent-dashboard", "api": API_VERSION})


def fresh_state(encode):
    """-> the state cache, built again when the core version moved (at most every EVENTS_BUILD_GAP: the version moves
    every second while agents write, and the page fetching what /events just announced takes that build) or it is
    older than STATE_CACHE_SECONDS. Every open page and the app read it on each change: it is built once and shared
    (three tabs used to rebuild it three times, each under the lock)."""
    with state_cache_lock:
        age = time.time() - state_cache["at"]
        if (state_cache["v"] != core_state.version and age >= EVENTS_BUILD_GAP) or age >= STATE_CACHE_SECONDS:
            v, parts = build_state(encode)
            sig = parts_signature(parts)
            if sig != state_cache["sig"]:
                state_cache["cv"] = v
                sig_history[v] = sig
                while len(sig_history) > SIG_KEEP:
                    sig_history.popitem(last=False)
                state_cache.update(glance=None, decisions=None)
            parts["version"] = ("obj", encode(state_cache["cv"]))
            state_cache.update(v=v, parts=parts, sig=sig, at=time.time(), full=None, gz=None, deltas={})
        return state_cache


def full_state(encode):
    """-> (body, gzipped body) of the whole snapshot."""
    st = fresh_state(encode)
    with state_cache_lock:
        if st["full"] is None:
            st["full"] = parts_full(st["parts"])
            st["gz"] = gzip.compress(st["full"], 5)
        return st["full"], st["gz"]


def get_state(h, url):
    """The whole snapshot, or with ?base=<version the page holds> only what changed since (parts_delta).
    A base the server no longer remembers (restarted, too old) gets the whole snapshot."""
    try:
        base = int((parse_qs(url.query).get("base") or [""])[0])
    except ValueError:
        base = None
    st = fresh_state(h.encode)
    with state_cache_lock:
        old = sig_history.get(base) if base is not None else None
        if old is not None:
            body = st["deltas"].get(base)
            if body is None:
                body = st["deltas"][base] = parts_delta(st["parts"], old, st["sig"], base, h.encode)
            return h.send_body(body)
    raw, gz = full_state(h.encode)
    h.send_body(raw, gz=gz)  # sent outside the cache lock: a slow client holds up no one


def parsed(st, name):
    """One part of the cached build as Python values."""
    kind, val = st["parts"][name]
    return json.loads(val) if kind == "obj" else [json.loads(b) for _, b in val]


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
    st = fresh_state(h.encode)
    with state_cache_lock:
        if st["glance"] is None:
            st["glance"] = h.encode(glance({"sessions": parsed(st, "sessions"), "decisions": parsed(st, "decisions"),
                                            "tests": {"files": parsed(st, "tests.files")}}))
        body = st["glance"]
    h.send_json(body)


def get_decisions(h, url):
    """What the Mac app's 결정 대기 watcher reads on each change, a few KB instead of the snapshot: {"decisions", "sessions":
    [{"path", "title", "decision"}] of the sessions holding a question}."""
    st = fresh_state(h.encode)
    with state_cache_lock:
        if st["decisions"] is None:
            st["decisions"] = h.encode({"decisions": parsed(st, "decisions"), "sessions": [
                {k: s.get(k) for k in ("path", "title", "decision")} for s in parsed(st, "sessions") if s.get("decision")]})
        body = st["decisions"]
    h.send_json(body)


def get_events(h, url):
    """data: <content version> whenever the snapshot shows something new. A core version bump alone (a collector pass,
    the 15 s tick for the age-based states) is checked by building the snapshot (fresh_state paces it) and announced
    only when the content moved."""
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
            if core_state.version != state_cache["v"]:
                fresh_state(h.encode)
            if state_cache["cv"] != seen:
                seen = state_cache["cv"]
                h.wfile.write(f"data: {seen}\n\n".encode())
            else:
                h.wfile.write(b": ping\n\n")
            h.wfile.flush()
            time.sleep(1)
    except (BrokenPipeError, ConnectionResetError):
        pass
