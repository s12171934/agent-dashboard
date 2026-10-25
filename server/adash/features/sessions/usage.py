"""Token usage and cost per 5-minute slot."""

import time
from datetime import datetime

from adash.features.sessions.pricing import price_for


SLOT_SECONDS = 300                 # compare tab's finest time bucket (5 min)
HISTORY_DAYS = 7                   # its widest span; older sessions come from the history scan below
SLOT_KEEP = HISTORY_DAYS * 86400 // SLOT_SECONDS


def turn_cost(t, model):
    """USD of one turn as (input, cache_write, cache_read, output), or None without a price."""
    pr = price_for(t["model"] or model, t["ctx"])
    if not pr:
        return None
    return (t["input"] * pr[0] / 1e6, ((t["cache_write"] - t["cw_1h"]) * pr[1] + t["cw_1h"] * pr[2]) / 1e6,
            t["cache_read"] * pr[3] / 1e6, t["output"] * pr[4] / 1e6)


def turn_slots(turns, model, keep):
    """5-minute slot (epoch // 300) -> [input, cache_write, cache_read, output, cost] for slots after `keep`.
    The compare tab's time chart merges these into 5m–1h bars."""
    slots = {}
    for t in turns:
        if "slot" not in t:
            t["slot"] = epoch_slot(t["ts"])
        if t["slot"] is None or t["slot"] <= keep:
            continue
        h = slots.setdefault(t["slot"], [0, 0, 0, 0, 0.0])
        h[0] += t["input"]; h[1] += t["cache_write"]; h[2] += t["cache_read"]; h[3] += t["output"]
        h[4] += sum(turn_cost(t, model) or ())
    return {k: v[:4] + [round(v[4], 4)] for k, v in slots.items()}


def epoch_slot(ts):
    """ISO timestamp -> whole SLOT_SECONDS since the epoch, or None."""
    try:
        return int(datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp() // SLOT_SECONDS)
    except (AttributeError, ValueError):
        return None


def seconds_since(ts):
    if not ts:
        return None
    try:
        return time.time() - datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None
