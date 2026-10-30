"""JSON and text files read again only when their mtime moves, atomic JSON writes, and slow values served from cache
while they are recomputed."""

import json
import os
import threading
import time

from adash.core.state import report_failure


def save_json(p, data):
    tmp = p + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f)
    os.replace(tmp, p)


# A ticket's "e2e_progress" names a progress file run-tc rewrites every few seconds (active runs, latest result per TC,
# history); it is re-read on mtime change and attached as ticket["e2e"]. A missing file attaches an empty state.
e2e_cache = {}  # progress path -> (mtime, data)


def read_json_cached(p):
    """(data or {}) for a JSON file, re-read only when its mtime changes; a failed read keeps the last good data."""
    try:
        mtime = os.path.getmtime(p)
    except OSError:
        mtime = None
    cached = e2e_cache.get(p)
    if not cached or cached[0] != mtime:
        data = {}
        if mtime is not None:
            try:
                with open(p) as f:
                    data = json.load(f)
            except (OSError, ValueError):
                data = cached[1] if cached else {}
        cached = e2e_cache[p] = (mtime, data if isinstance(data, dict) else {})
    return cached[1]


text_cache = {}  # path -> (mtime, text)


def read_text_cached(p):
    try:
        mtime = os.path.getmtime(p)
    except OSError:
        return ""
    cached = text_cache.get(p)
    if not cached or cached[0] != mtime:
        try:
            with open(p, encoding="utf-8") as f:
                cached = text_cache[p] = (mtime, f.read())
        except (OSError, ValueError):
            return cached[1] if cached else ""
    return cached[1]

# A slow value (git over every worktree, the Orca message history) served from cache while it is recomputed.
class StaleWhileRefresh:
    """compute() is cached; once the value is older than `every` seconds the next read starts a recompute on a
    background thread and still gets the old value, so a request never waits on it. Only the first read, or
    get(fresh=True), waits."""

    def __init__(self, name, compute, every):
        self.name, self.compute, self.every = name, compute, every
        self.value, self.at = None, 0.0
        self._lock = threading.Lock()  # one compute at a time
        self._running = False

    def _refresh(self):
        try:
            v = self.compute()
            self.value, self.at = v, time.time()
        except Exception as e:
            report_failure(self.name, e)
        finally:
            self._running = False

    def get(self, fresh=False):
        if fresh or self.value is None:
            with self._lock:
                if fresh or self.value is None:
                    self.value, self.at = self.compute(), time.time()
            return self.value
        if time.time() - self.at > self.every and not self._running:
            self._running = True
            threading.Thread(target=lambda: self._locked(self._refresh), daemon=True).start()
        return self.value

    def drop(self):
        """Forget the value: the next read computes it again and waits (after a change the old value would hide)."""
        with self._lock:
            self.value, self.at = None, 0.0

    def _locked(self, f):
        with self._lock:
            f()
