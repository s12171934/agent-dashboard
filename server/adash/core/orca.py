"""The Orca CLI."""

import json
import os
import subprocess

from adash.core.util import short


# Without a terminal binding, list commands span every Run (the server may be started from an agent's terminal).
ORCA_ENV = {k: v for k, v in os.environ.items() if k not in ("ORCA_TERMINAL_HANDLE", "ORCA_PANE_KEY")}


def orca(*args, timeout=15):
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
