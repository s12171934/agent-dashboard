"""The shared snapshot: the big lock, the change counter the page polls, the session table, collector health."""

import sys
import threading
import time
import traceback

from adash.core.log import log
from adash.core.util import short


class TimedLock:
    """threading.Lock that logs a hold or a wait longer than SLOW_LOCK seconds with the holder's call site,
    so a section that stalls every request (they all take this lock) shows up in server.log."""
    SLOW_LOCK = 2.0

    def __init__(self):
        self._l = threading.Lock()
        self._t = 0.0
        self._where = None

    def __enter__(self):
        t0 = time.monotonic()
        self._l.acquire()
        self._t = time.monotonic()
        f = sys._getframe(1)
        self._where = f"{f.f_code.co_name}:{f.f_lineno}"
        if self._t - t0 > self.SLOW_LOCK:
            log(f"lock: waited {self._t - t0:.1f}s at {self._where}")
        return self

    def __exit__(self, *exc):
        held, where = time.monotonic() - self._t, self._where
        self._l.release()
        if held > self.SLOW_LOCK:
            log(f"lock: held {held:.1f}s at {where}")


lock = TimedLock()


version = 0
sessions = {}  # path -> Session


def bump():
    global version
    version += 1


# Collector loops run on daemon threads, where one uncaught exception used to end the thread for good: the page
# kept its SSE pings (「실시간」) while that part of the data silently froze until a restart. Each pass is now
# guarded, and the outcome lands here so the UI can tell a stalled collector from a quiet one.
health = {}  # loop name -> {"ok": last clean pass, "error": last failure, "at": when it failed}
_reported = set()  # (where, repr) already printed with a traceback, so a repeating failure logs once


def report_failure(where, e):
    key = (where, repr(e))
    if key not in _reported:
        _reported.add(key)
        log(f"{where}: {e!r}")
        traceback.print_exc()


def loop_failed(name, e, where=None):
    """Call outside `lock`."""
    report_failure(where or name, e)
    with lock:
        health.setdefault(name, {}).update(error=short(f"{where + ': ' if where else ''}{e!r}", 240), at=time.time())
        bump()


def loop_ok(name):
    with lock:
        health.setdefault(name, {})["ok"] = time.time()
