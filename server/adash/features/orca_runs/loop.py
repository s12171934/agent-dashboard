"""The Orca collector: run-list, tasks, workers and terminals."""

import json
import subprocess
import time

from adash.core.log import log
from adash.core.orca import orca, orca_all
from adash.core.state import bump, lock, loop_ok, report_failure, sessions
from adash.features.orca_runs.settled import record_settled, save_settled, settled_store
from adash.features.orca_runs.store import orca_state, run_coord
from adash.features.sessions.config import WAIT_SECONDS
from adash.features.sessions.usage import seconds_since


SETTLED_EVERY = 300     # a settled Run (every task finished) is re-read this often ...
SETTLED_PER_CYCLE = 4   # ... but only a few per cycle, so open Runs are never starved behind them


# Oldest point the dashboard still looks back to (epoch). It stretches past --hours while a session that
# started earlier is still active (a coordinator can run for days), so its Runs and workers stay visible.
horizon_since = None


HORIZON_MAX_HOURS = 72


def window_start(hours):
    """--hours ago, or the start of the earliest still-active coordinator if that is older, up to
    HORIZON_MAX_HOURS. The stretch keeps a coordinator that runs for ~40 hours with its Runs and workers;
    it used to follow any active session, so one interactive session open since 9/11 pulled the window back
    32 days and the server held 1,701 sessions (1,474 of them older than a day)."""
    now = time.time()
    since = now - hours * 3600
    with lock:  # issues_orchestration is set while parsing; the "coordinator" role only once summary() runs
        starts = [s.started for s in sessions.values()
                  if s.issues_orchestration and s.role != "worker" and not s.parent and s.started
                  and (seconds_since(s.last_ts) or 1e12) < WAIT_SECONDS]
    for st in starts:
        age = seconds_since(st)
        if age is not None:
            since = min(since, now - age)
    return max(since, now - max(hours, HORIZON_MAX_HOURS) * 3600)


RUNS_FULL_EVERY = 60  # seconds between full run-list pagings (3+ pages); the newest page is read every cycle
ORCA_BACKOFF_MAX = 30
ORCA_ACTION_TIMEOUT = 30  # terminal close / switch: a slow Orca often finishes between 15 and 30 seconds


def orca_loop(max_runs, hours):
    """Poll Orca. task-list needs --run, so tasks and workers are fetched per tracked Run.
    Runs with open tasks are re-read every cycle. Settled Runs are re-read when the newest page of
    worker-list shows a dispatch the cache does not know (a driver reusing its Run for the next
    checkbox), otherwise a few per cycle, stalest first. Re-reading all of them every minute made one
    cycle take minutes on a loaded machine, so new tasks showed up late."""
    prev = None
    cache = {}  # run id -> (fetched_at, tasks, workers)
    swept_at = {}  # untracked run id -> last sweep, for Runs that still had open dispatches
    open_old = set()  # Runs outside the window whose sweep found open dispatches: tracked until they settle
    global horizon_since
    # Orca's app runtime sometimes stops answering for tens of seconds; every CLI call then waits out its
    # timeout. Back off instead of queueing more calls on a stalled Orca (they also delay a 닫기 click).
    backoff, runs_all, runs_at = 0, [], 0.0
    while True:
        try:
            if time.time() - runs_at > RUNS_FULL_EVERY or not runs_all:
                runs_all, runs_at = orca_all("runs", "orchestration", "run-list"), time.time()
            else:  # newest page only; older Runs come from the last full listing
                page = orca("orchestration", "run-list").get("runs") or []
                ids = {r["id"] for r in page}
                runs_all = page + [r for r in runs_all if r["id"] not in ids]
            all_runs = runs = list(runs_all)
            run_coord.update({r["id"]: r.get("coordinator_handle") for r in all_runs if r.get("id")})
            runs.sort(key=lambda r: r.get("created_at") or "", reverse=True)
            since = window_start(hours)
            recent = [r for r in runs if (seconds_since(r.get("created_at")) or 1e12) < time.time() - since]
            runs = recent if len(recent) >= max_runs else runs[:max_runs]
            ids = {r["id"] for r in runs}
            runs += [r for r in all_runs if r["id"] in open_old and r["id"] not in ids]
            horizon_since = since
            news = {}  # run id -> dispatches on the newest worker page
            for x in orca("orchestration", "worker-list", "--limit", "100").get("workers") or []:
                news.setdefault(x.get("runId"), set()).add((x.get("dispatchId"), x.get("dispatchStatus")))
            budget = SETTLED_PER_CYCLE
            for r in sorted(runs, key=lambda r: cache.get(r["id"], (0,))[0]):  # stalest first
                at, t, w = cache.get(r["id"], (0, None, None))
                settled = bool(t) and all(x.get("status") in ("completed", "failed", "cancelled") for x in t)
                changed = bool(news.get(r["id"], set()) - {(x.get("dispatchId"), x.get("dispatchStatus")) for x in w or []})
                due = time.time() - at > SETTLED_EVERY and budget > 0
                if t is None or not settled or changed or due:
                    if t is not None and settled and not changed:
                        budget -= 1
                    t = orca("orchestration", "task-list", "--run", r["id"]).get("tasks", [])
                    w = orca_all("workers", "orchestration", "worker-list", "--run", r["id"])
                    cache[r["id"]] = (time.time(), t, w)
            tasks, workers = {}, []
            for r in runs:
                _, t, w = cache[r["id"]]
                tasks[r["id"]] = t
                workers.extend(w)
            # Drop fast-changing fields (preview, lastOutputAt) so the snapshot only changes on real updates.
            terminals = [{k: t.get(k) for k in ("handle", "title", "worktreePath", "branch", "connected", "tabId", "leafId")}
                         for t in orca("terminal", "list").get("terminals", [])]
            snapshot = {"runs": runs, "tasks": tasks, "workers": workers, "terminals": terminals, "error": None}
            dirty = record_settled(workers, [x for ts in tasks.values() for x in ts])
            # Runs outside the window are swept once (the first start backfills them all); one that still
            # had open dispatches is looked at again every 5 minutes until it settles.
            tracked = {r["id"] for r in runs}
            done_runs = set(settled_store["runs"])
            sweeps = 6  # per cycle: the first start backfills over several cycles instead of one long one
            for r in all_runs:
                rid = r["id"]
                if rid in tracked or rid in done_runs or time.time() - swept_at.get(rid, 0) < 300:
                    continue
                if not sweeps:
                    break
                sweeps -= 1
                swept_at[rid] = time.time()
                w = orca_all("workers", "orchestration", "worker-list", "--run", rid)
                t = orca("orchestration", "task-list", "--run", rid).get("tasks", [])
                dirty = record_settled(w, t) or dirty
                if all(x.get("dispatchStatus") in ("completed", "failed", "cancelled") for x in w) \
                        and all(x.get("status") in ("completed", "failed", "cancelled") for x in t):
                    settled_store["runs"].append(rid)
                    open_old.discard(rid)
                    dirty = True
                else:
                    open_old.add(rid)
            # An open old Run that settled while tracked goes back to the swept list.
            for r in runs:
                rid = r["id"]
                if rid in open_old and all(x.get("dispatchStatus") in ("completed", "failed", "cancelled")
                                           for x in cache.get(rid, (0, [], []))[2]):
                    open_old.discard(rid)
                    if rid not in done_runs:
                        settled_store["runs"].append(rid)
                        dirty = True
            if dirty:
                with lock:
                    save_settled()
                    bump()
            backoff = 0
        except Exception as e:  # orca not running, CLI changed, etc.
            report_failure("orca", e)
            snapshot = {**orca_state, "error": str(e)}
            if isinstance(e, subprocess.TimeoutExpired):
                backoff = min(ORCA_BACKOFF_MAX, max(8, backoff * 2))
                log(f"orca: no answer in {e.timeout}s, next poll in {backoff}s")
        key = json.dumps(snapshot, sort_keys=True, default=str)
        if key != prev:
            prev = key
            with lock:
                orca_state.update(snapshot, updated=time.time())
                bump()
        loop_ok("orca")  # the thread is alive; Orca's own failures are shown from orca_state["error"]
        time.sleep(backoff or 4)
