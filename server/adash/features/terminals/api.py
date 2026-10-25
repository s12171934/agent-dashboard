"""Orca terminal endpoints: focus one, close one (with what runs below it) as a background job, and the job's state."""

import json
import subprocess
import threading
import time
from urllib.parse import parse_qs

from adash.core.orca import orca
from adash.core.util import short
from adash.features.orca_runs.loop import ORCA_ACTION_TIMEOUT
from adash.features.orca_runs.store import orca_state
from adash.features.sessions.patterns import HANDLE
from adash.features.terminals.close import close_jobs, jobs_lock, run_close
import adash.features.terminals.targets as terminals_targets


def get_job(h, url):
    jid = parse_qs(url.query).get("id", [""])[0]
    with jobs_lock:
        job = close_jobs.get(jid)
        body = job and h.encode(job)
    if not body:
        return h.send_json({"error": "not found"}, 404)
    h.send_body(body)


def post_terminal(h, url):
    """{"handle"} -> focus: `orca terminal switch` and raise the Orca window, for any connected terminal the
    page offers (sessions and script drivers). close: `orca terminal close`, ending the agent's process (the
    transcript stays, so `claude --resume` can pick it up); only a terminal the last snapshot mapped to a
    session is accepted, never a driver script or an arbitrary handle. A running session may be closed too
    (the user's call); the page's confirm dialog warns about it. {"cascade": true} first closes the terminals
    the server itself mapped under that session (close_trees: workers and the scripts it opened), never a list
    the page sends. One failing below does not stop the rest; the session's own terminal closes last."""
    action = url.path.rsplit("/", 1)[1]
    try:
        body = json.loads(h.rfile.read(min(int(h.headers.get("Content-Length") or 0), 65536)))
        handle, cascade = body["handle"], body.get("cascade", False)
        assert isinstance(handle, str) and HANDLE.fullmatch(handle) and isinstance(cascade, bool)
    except (ValueError, KeyError, AssertionError, TypeError, AttributeError):
        return h.send_json({"error": "bad request"}, 400)
    # No lock: these are whole objects swapped in by their writers, and build_state can hold the lock for
    # seconds, which used to delay every click before Orca was even asked.
    known = {t["handle"] for t in orca_state.get("terminals", []) if t.get("connected")}
    if action == "close":
        known &= set(terminals_targets.focus_handles)
    below = list(terminals_targets.close_trees.get(handle, [])) if action == "close" and cascade else []
    if handle not in known:
        return h.send_json({"error": "Orca 에 연결된 세션 터미널이 아닙니다"}, 404)
    if action == "close":
        # Each close takes ~2.5s even when Orca is healthy, so a coordinator with its workers ran past any
        # sensible request time. Answer at once; the page polls /api/orca/job for the outcome.
        jid = f"close-{int(time.time() * 1000)}"
        with jobs_lock:
            close_jobs[jid] = {"id": jid, "handle": handle, "total": len(below) + 1, "done": 0, "closed": [],
                               "failed": [], "state": "running", "started": time.time()}
        threading.Thread(target=run_close, args=(jid, handle, below), daemon=True).start()
        return h.send_json({"ok": True, "job": jid, "total": len(below) + 1}, 202)
    try:
        orca("terminal", "switch", "--terminal", handle, timeout=ORCA_ACTION_TIMEOUT)
    except subprocess.TimeoutExpired:
        return h.send_json({"error": f"Orca 가 {ORCA_ACTION_TIMEOUT}초 안에 응답하지 않았습니다 (Orca 가 바쁜 상태). 잠시 뒤 다시 눌러 주세요"}, 504)
    except Exception as e:
        return h.send_json({"error": "Orca 전환 실패: " + short(e, 200)}, 502)
    # switch changes the tab inside Orca; bring the window itself forward too (the click asked for it)
    subprocess.run(["open", "-a", "Orca"], capture_output=True, timeout=5)
    h.send_json({"ok": True})
