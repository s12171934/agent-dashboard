"""Dispatches that settled, kept past the tracked-run window."""

import json
import os

from adash.core.config import HERE


# Settled dispatches outlive the tracked-run window: once a Run ages out, its workers leave orca_state,
# and a finished worker would fall back to its transcript (idle, or stalled when release cut the last turn).
# {"tasks": {task id: dispatch status}, "runs": [run ids already swept]}, persisted across restarts.
SETTLED_PATH = os.path.join(HERE, "settled.json")
try:
    with open(SETTLED_PATH) as _f:
        settled_store = json.load(_f)
except (OSError, ValueError):
    settled_store = {}
settled_store.setdefault("tasks", {})
settled_store.setdefault("runs", [])


def record_settled(workers, tasks=()):
    """Remember settled dispatches, and settled Tasks (a Task keeps its status even when its
    dispatch row is gone); True when something new was recorded."""
    pairs = [(w.get("taskId"), w.get("dispatchStatus")) for w in workers] + [(t.get("id"), t.get("status")) for t in tasks]
    new = {tid: st for tid, st in pairs
           if tid and st in ("completed", "failed", "cancelled") and settled_store["tasks"].get(tid) != st}
    settled_store["tasks"].update(new)
    return bool(new)


def save_settled():
    tmp = SETTLED_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(settled_store, f)
    os.replace(tmp, SETTLED_PATH)
