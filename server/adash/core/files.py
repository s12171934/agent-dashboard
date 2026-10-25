"""JSON and text files read again only when their mtime moves, and atomic JSON writes."""

import json
import os


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
