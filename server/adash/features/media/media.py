"""Recordings published to the page: a few videos the record skills left in ~/Movies, picked by name.

The ego-record and aside-record skills write <case> <YYYYmmdd-HHMMSS>.mp4 (ego-record also a .timeline.txt beside it)
into fixed folders under ~/Movies, and their timeline notes point at them with file:// links, which open only on this
Mac. A device on the tailnet sees a video only when it is listed in media.json (the data folder) — {"published": ["ego-record/<file
name>.mp4", ...]} — and sits directly in one of ROOTS. Nothing else on disk is reachable through this feature.
"""

import json
import os
import re
import unicodedata

import adash.core.config as core_config

MOVIES = os.path.join(core_config.HOME, "Movies")
ROOTS = {"ego-record": os.path.join(MOVIES, "ego-record"), "aside-record": os.path.join(MOVIES, "aside-record")}
PUBLISHED = os.path.join(core_config.DATA, "media.json")
STAMP = re.compile(r"\s(\d{8}-\d{6})(?:-\d+)?$")  # the first frame's time ends the name; a repeat adds -2, -3
LINE = re.compile(r"^(?:(\d+):)?(\d{1,2}):(\d{2})\s+(\S+)\s+(.*)$")  # MM:SS or H:MM:SS, kind, text


def published():
    """-> the "<root>/<file name>" entries in media.json, in its order; a missing or broken file publishes nothing."""
    try:
        with open(PUBLISHED, encoding="utf-8") as f:
            names = json.load(f).get("published") or []
    except (OSError, ValueError, AttributeError):
        return []
    return [n for n in names if isinstance(n, str)]


def resolve(rel):
    """"<root>/<file name>.mp4" -> its absolute path when it is published and really lives in that root, else None."""
    nfc = lambda x: unicodedata.normalize("NFC", x)  # macOS keeps Hangul names decomposed; a URL brings them composed
    rel = next((n for n in published() if nfc(n) == nfc(rel)), None)
    if not rel:
        return None
    root, _, name = rel.partition("/")
    base = ROOTS.get(root)
    if not base or not name.endswith(".mp4") or "/" in name or name.startswith("."):
        return None
    full = os.path.realpath(os.path.join(base, name))
    if os.path.dirname(full) != os.path.realpath(base) or not os.path.isfile(full):
        return None
    return full


def timeline(full):
    """The ego-record draft beside the video (<name>.timeline.txt): [{t (seconds), kind, text}], or []."""
    try:
        with open(full[:-4] + ".timeline.txt", encoding="utf-8", errors="replace") as f:
            lines = f.read().splitlines()
    except OSError:
        return []
    out = []
    for ln in lines:
        m = LINE.match(ln.strip())
        if m:
            out.append({"t": int(m[1] or 0) * 3600 + int(m[2]) * 60 + int(m[3]), "kind": m[4], "text": m[5].strip()})
    return out


def media_list():
    """{published: [{path, root, name, started, size, mtime, timeline}]}; names in media.json that no longer resolve
    are listed under missing so the page can say so."""
    videos, missing = [], []
    for rel in published():
        full = resolve(rel)
        if not full:
            missing.append(rel)
            continue
        stem = os.path.basename(full)[:-4]
        m = STAMP.search(stem)
        st = os.stat(full)
        videos.append({"path": rel, "root": rel.split("/")[0], "name": stem[:m.start()] if m else stem,
                       "started": m and f"{m[1][:4]}-{m[1][4:6]}-{m[1][6:8]} {m[1][9:11]}:{m[1][11:13]}:{m[1][13:]}",
                       "size": st.st_size, "mtime": st.st_mtime, "timeline": timeline(full)})
    return {"videos": videos, "missing": missing}
