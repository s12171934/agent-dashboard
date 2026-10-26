"""prefs.json: user choices made in the UI and the path settings, shared by every device."""

import json
import os

from adash.core.config import HERE


# User choices made in the UI, shared by every device: {"idle": {path: last_ts when marked}, "chars": {path: {"who",
# "boss", "pick"}}} (the person drawn for a session: picked by hand, or the first one the page drew, kept so every view
# and device draws the same).
PREFS_PATH = os.path.join(HERE, "prefs.json")
try:
    with open(PREFS_PATH) as _f:
        prefs = json.load(_f)
except (OSError, ValueError):
    prefs = {}
prefs.setdefault("idle", {})
prefs.setdefault("chars", {})


def save_prefs():
    tmp = PREFS_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(prefs, f, ensure_ascii=False, indent=1)
    os.replace(tmp, PREFS_PATH)
