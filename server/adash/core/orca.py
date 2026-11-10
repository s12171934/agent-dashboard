"""The Orca CLI."""

import json
import os
import subprocess

from adash.core.util import short


# Without a terminal binding, list commands span every Run (the server may be started from an agent's terminal).
ORCA_ENV = {k: v for k, v in os.environ.items() if k not in ("ORCA_TERMINAL_HANDLE", "ORCA_PANE_KEY")}


# Read commands whose default rows became a concise view in Orca 1.4 (run-list keeps only id and objective, worker-list
# drops agentTerminalHandle and runId, task-list drops deps and times, inbox drops both ends' handles and the time):
# --full prints the record every reader here expects.
FULL = {("orchestration", c) for c in ("run-list", "run-show", "task-list", "worker-list", "worker-show", "inbox",
                                        "gate-list", "dispatch-show")}


def orca(*args, timeout=15):
    if tuple(args[:2]) in FULL and "--full" not in args:
        args = (*args, "--full")
    out = subprocess.run(["orca", *args, "--json"], capture_output=True, text=True, timeout=timeout, env=ORCA_ENV)
    data = json.loads(out.stdout)
    if not data.get("ok"):
        raise RuntimeError(short(out.stdout, 200))
    return data["result"]


def orca_all(key, *args):
    """Every row of a paged list command (run-list, worker-list: 100 per page, newest first)."""
    rows, cursor = [], None
    while True:
        res = orca(*args, *(["--cursor", cursor] if cursor else []))
        rows += res.get(key) or []
        cursor = (res.get("page") or {}).get("nextCursor") or res.get("nextCursor")
        if not cursor or not res.get(key):
            return rows
