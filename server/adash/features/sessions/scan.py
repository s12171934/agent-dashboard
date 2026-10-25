"""The transcript collector: finds session logs, tails them and prunes the ones past the window."""

import glob
import json
import os
import time

from adash.core.config import HOME
from adash.core.state import bump, lock, loop_failed, loop_ok, sessions
from adash.features.decisions.store import inbox_sessions
from adash.features.history.history import history, lite_of
from adash.features.sessions.config import CLAUDE_GLOB, CODEX_GLOBS, hooks
from adash.features.sessions.hooks import load_hooks
from adash.features.sessions.session import Session
from adash.features.sessions.usage import HISTORY_DAYS
import adash.features.orca_runs.loop as orca_runs_loop


# ---- watchers ----
PLAN_STORES = [os.path.join(HOME, ".agent-plans"), "/tmp/agent-plans"]


plan_pending = []  # store lines whose session is not discovered yet (new transcripts are globbed every 10 s)


def read_plan_stores(known, offsets):
    """Apply new aplan store lines to their sessions. Runs after transcripts are polled, so the
    instruction that a plan answers is already parsed when the plan arrives."""
    by_id = {s.id: s for s in known.values()}
    by_term = {s.own_handle: s for s in known.values() if s.own_handle and not s.parent}
    changed = False
    retry, plan_pending[:] = plan_pending[:], []
    lines = [(rec, t) for rec, t in retry if time.time() - t < 600]
    for d in PLAN_STORES:
        for path in glob.glob(os.path.join(d, "*.jsonl")):
            try:
                size = os.path.getsize(path)
                if size <= offsets.get(path, 0):
                    continue
                with open(path, "rb") as f:
                    f.seek(offsets.get(path, 0))
                    data = f.read()
            except OSError:
                continue
            end = data.rfind(b"\n") + 1  # leave a partial last line for the next tick
            offsets[path] = offsets.get(path, 0) + end
            for raw in data[:end].splitlines():
                try:
                    lines.append((json.loads(raw), time.time()))
                except ValueError:
                    continue
    for rec, t in lines:
        s = by_id.get(rec.get("session")) or by_term.get(rec.get("terminal"))
        if s and isinstance(rec.get("event"), dict):
            s.apply_plan(rec["event"], rec["event"].get("ts"))
            changed = True
        elif not s:
            plan_pending.append((rec, t))
    return changed


PRUNE_EVERY = 60


def prune_sessions(known, cutoff, held=frozenset()):
    """Drop sessions whose transcript has not changed since `cutoff`, the same test that keeps a file out at
    discovery, so a long-running server holds what a fresh start would (it held every session it ever saw:
    944 after a day, 10 of them live, with /api/state growing to 2.9MB). A dropped session moves to the
    history cache so the 7-day compare keeps it; prefs (idle) are keyed by path and survive.
    Sessions in `held` (ids with a 메일함 item, inbox_sessions) stay whatever their age. Returns the dropped paths."""
    gone = []
    for path, s in list(known.items()):
        if s.id in held:
            continue
        try:
            st = os.stat(path)
        except OSError:
            st = None
        if st and st.st_mtime >= cutoff:
            continue
        del known[path]
        gone.append(path)
        with lock:
            sessions.pop(path, None)
            if st and st.st_mtime >= time.time() - HISTORY_DAYS * 86400:
                history["files"][path] = {"v": [st.st_mtime, st.st_size], "s": lite_of(s)}
    return gone


scan_ready = False  # scan_loop has read every transcript once: a session it does not know by now does not exist


def scan_loop(hours):
    global scan_ready
    known = {}
    plan_offsets = {}
    pruned = set()  # paths dropped by prune_sessions, in case one comes back to life
    last_glob = last_tick = last_prune = 0
    while True:
        now = time.time()
        try:
            cutoff = min(now - hours * 3600, orca_runs_loop.horizon_since or now)
            held = inbox_sessions()  # a 메일함 item keeps its session listed, however old
            if now - last_prune > PRUNE_EVERY:
                last_prune = now
                gone = prune_sessions(known, cutoff, held)
                pruned.update(gone)
                if gone:
                    with lock:
                        bump()
            if now - last_glob > 10:
                last_glob = now
                for pattern, kind in [(CLAUDE_GLOB, "claude")] + [(g, "codex") for g in CODEX_GLOBS]:
                    for path in glob.glob(pattern, recursive=True):
                        path = os.path.realpath(path)  # the Orca Codex home may link to ~/.codex
                        if path in known:
                            continue
                        try:
                            if os.path.getmtime(path) < cutoff and os.path.splitext(os.path.basename(path))[0] not in held:
                                continue
                        except OSError:
                            continue
                        known[path] = Session(path, kind)
                        if path in pruned:
                            # A resumed session is parsed from scratch; reread the aplan stores so its plan
                            # events come back too (events are keyed by id, so the others are not doubled).
                            pruned.discard(path)
                            plan_offsets.clear()
            changed = False
            with lock:
                before = dict(hooks)
                load_hooks()
                changed = before != hooks
            for path, s in list(known.items()):
                # A record the parser does not expect fails only its own file: poll() advanced the offset before
                # parsing, so the next pass resumes after the batch instead of failing on it forever.
                try:
                    if path not in sessions:
                        # Not visible to request threads yet: parse its first (possibly huge) read outside the
                        # lock. After a restart every transcript lands here, and parsing them under the lock
                        # held every request for 6-55 s at a time.
                        if s.poll():
                            with lock:
                                sessions[path] = s
                            changed = True
                        continue
                    with lock:
                        if s.poll():
                            sessions[path] = s
                            changed = True
                except Exception as e:
                    loop_failed("scan", e, where=os.path.basename(path))
                    with lock:
                        sessions[path] = s
            with lock:
                changed = read_plan_stores(known, plan_offsets) or changed
            if changed or now - last_tick > 15:  # state also changes as time passes (stall/idle thresholds)
                last_tick = now
                with lock:
                    bump()
            scan_ready = True
            loop_ok("scan")
        except Exception as e:
            loop_failed("scan", e)
        time.sleep(1)
