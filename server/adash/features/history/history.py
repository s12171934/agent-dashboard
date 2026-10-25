"""Usage history for the compare tab: a week of transcripts reduced to per-slot usage, cached on disk."""

import glob
import json
import os
import time

from adash.core.config import HERE
from adash.core.files import save_json
from adash.core.state import lock, loop_failed, loop_ok, sessions
from adash.features.sessions.config import CLAUDE_GLOB, CODEX_GLOBS
from adash.features.sessions.session import Session
from adash.features.sessions.usage import HISTORY_DAYS, SLOT_KEEP, SLOT_SECONDS, turn_slots


# ---- usage history: sessions older than --hours, for the compare tab's 7-day time chart ----
# Only the usage per 5-minute slot is kept (no logs, plans or tools), so a week of transcripts stays cheap.
# Parsed once per file version and cached on disk; live sessions (the `sessions` dict) are left to scan_loop.
HISTORY_PATH = os.path.join(HERE, "history-cache.json")
HISTORY_EVERY = 300
history = {"files": {}, "updated": 0, "scanning": False}  # path -> {"v": [mtime, size], "s": lite session}
try:
    with open(HISTORY_PATH) as _f:
        history["files"] = json.load(_f)
except (OSError, ValueError):
    pass


def history_lite(path, kind):
    s = Session(path, kind)
    s.poll()
    return lite_of(s)


def lite_of(s):
    return {"id": s.id, "kind": s.kind, "path": s.path, "title": s.title or s.id[:8], "model": s.model,
            "parent": s.parent, "started": s.started, "last_ts": s.last_ts, "slots": turn_slots(s.turns, s.model, 0)}


def history_loop():
    time.sleep(15)  # let scan_loop load the live window first
    while True:
        try:
            history_pass()
            loop_ok("history")
        except Exception as e:
            with lock:
                history["scanning"] = False
            loop_failed("history", e)
        time.sleep(HISTORY_EVERY)


def history_pass():
    since = time.time() - HISTORY_DAYS * 86400
    with lock:
        live = set(sessions)
        history["scanning"] = True
    files, dirty = {}, False
    for pattern, kind in [(CLAUDE_GLOB, "claude")] + [(g, "codex") for g in CODEX_GLOBS]:
        for path in glob.glob(pattern, recursive=True):
            path = os.path.realpath(path)
            if path in live or path in files:
                continue
            try:
                st = os.stat(path)
            except OSError:
                continue
            if st.st_mtime < since:
                continue
            v = [st.st_mtime, st.st_size]
            old = history["files"].get(path)
            if old and old["v"] == v:
                files[path] = old
                continue
            try:
                files[path] = {"v": v, "s": history_lite(path, kind)}
                dirty = True
            except Exception as e:  # one unreadable transcript must not stop the scan
                print("history:", path, e, flush=True)
    dirty = dirty or len(files) != len(history["files"])
    with lock:
        history.update(files=files, updated=time.time(), scanning=False)
    if dirty:
        save_json(HISTORY_PATH, files)


def history_payload():
    """Sessions outside the live window with their slots from the last HISTORY_DAYS; one copy per session id."""
    keep = int(time.time() // SLOT_SECONDS) - SLOT_KEEP
    with lock:
        live = {(x.kind, x.id) for x in sessions.values()}
        files = list(history["files"].values())
        meta = {"updated": history["updated"], "scanning": history["scanning"], "days": HISTORY_DAYS}
    by_id = {}
    for f in files:
        x = f["s"]
        if (x["kind"], x["id"]) in live:
            continue
        slots = {k: v for k, v in x["slots"].items() if int(k) > keep}
        if not slots:
            continue
        cur = by_id.get((x["kind"], x["id"]))
        if not cur or len(slots) > len(cur["slots"]):  # the same Codex session can exist as two files
            by_id[(x["kind"], x["id"])] = {**x, "slots": slots}
    return {**meta, "sessions": list(by_id.values())}
