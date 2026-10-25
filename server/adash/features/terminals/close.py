"""Closing Orca terminals as background jobs the page polls."""

import subprocess
import threading
import time

from adash.core.log import log
from adash.core.orca import orca
from adash.core.state import bump, lock
from adash.core.util import short
from adash.features.orca_runs.loop import ORCA_ACTION_TIMEOUT
from adash.features.orca_runs.store import orca_state
import adash.features.terminals.targets as terminals_targets


# ---- 닫기 jobs: terminal closes run off the request thread ----
close_jobs = {}  # job id -> {id, handle, total, done, closed[], failed[], state, started, finished}
jobs_lock = threading.Lock()


def terminal_open(handle):
    """True while Orca still lists the terminal as connected; None when Orca cannot say (it is stalled)."""
    try:
        return any(t.get("handle") == handle and t.get("connected")
                   for t in orca("terminal", "list", timeout=ORCA_ACTION_TIMEOUT).get("terminals", []))
    except Exception:
        return None


def close_terminal(handle):
    """-> None on success, else the reason. A timed-out close is checked against `terminal list` (it often went
    through anyway) and tried once more when the terminal is still there."""
    err = None
    for _ in range(2):
        try:
            orca("terminal", "close", "--terminal", handle, timeout=ORCA_ACTION_TIMEOUT)
            return None
        except subprocess.TimeoutExpired:
            err = f"Orca 가 {ORCA_ACTION_TIMEOUT}초 안에 응답하지 않음"
        except Exception as e:
            err = short(e, 200)
        still = terminal_open(handle)
        if still is False:
            return None
        if still is None:
            return err + " · 닫혔는지 확인 못 함"
    return err


def run_close(jid, handle, below):
    """Close the terminals below first (deepest first, as close_tree ordered them), the session's own last."""
    job = close_jobs[jid]
    for h in [*below, handle]:
        why = close_terminal(h)
        with jobs_lock:
            job["done"] += 1
            (job["failed"] if why else job["closed"]).append({"handle": h, "error": why} if why else h)
        if why:
            log(f"close {h}{' under ' + handle if h != handle else ''}: {why}")
    closed = set(job["closed"])
    with lock:  # drop them now so the buttons go on the next refresh, before orca_loop's next pass
        orca_state["terminals"] = [t for t in orca_state.get("terminals", []) if t.get("handle") not in closed]
        terminals_targets.focus_handles = {h: sid for h, sid in terminals_targets.focus_handles.items() if h not in closed}
        bump()
    with jobs_lock:
        job.update(state="done", finished=time.time())
        for k in [k for k, j in close_jobs.items() if j["state"] == "done" and time.time() - j["finished"] > 600]:
            del close_jobs[k]
