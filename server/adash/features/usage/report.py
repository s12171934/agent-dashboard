"""Tallies of server/usage.jsonl per environment: shared by GET /api/usage/report (the /usage page) and server/ausage."""

import json
import os
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone

from adash.core.config import HERE

LOG = os.path.join(HERE, "usage.jsonl")
# Every screen route() knows (frontend/app.js), so a screen nobody opens still shows up as 0.
VIEWS = ["home", "agents", "session", "run", "driver", "compare", "talk", "tests", "worktrees", "trees", "decide",
         "chars", "usage", "projects", "designs"]
BY = ("app", "form", "both")


def load(days, by):
    """The rows of the last `days` days (0: all), each with `env` set as `by` says; None when there is no log yet."""
    if not os.path.exists(LOG):
        return None
    since = datetime.now(timezone.utc) - timedelta(days=days) if days else None
    rows = []
    with open(LOG, encoding="utf-8") as f:
        for line in f:
            try:
                r = json.loads(line)
                if since and datetime.fromisoformat(r["ts"]) < since:
                    continue
                r["env"] = r["app"] if by == "app" else r["form"] if by == "form" else f"{r['app']}/{r['form']}"
            except (ValueError, KeyError, TypeError):
                continue
            rows.append(r)
    return rows


def tally(rows, top=15, rare=1, recent=0):
    envs = sorted({r["env"] for r in rows})
    clicks = {e: Counter() for e in envs}
    opens = {e: Counter() for e in envs}
    stay = {e: Counter() for e in envs}
    devs = defaultdict(set)
    for r in rows:
        e = r["env"]
        if r.get("dev"):
            devs[e].add(r["dev"])
        if r["feat"] == "open":
            opens[e][r["view"]] += 1
        elif r["feat"] == "stay":
            stay[e][r["view"]] += r.get("secs", 0)
        else:
            clicks[e][f"{r['view']} · {r['feat']}"] += 1
    every = Counter()
    for c in clicks.values():
        every.update(c)
    views = VIEWS + sorted({v for o in (*opens.values(), *stay.values()) for v in o} - set(VIEWS))
    out = {
        "rows": len(rows),
        "envs": [{"env": e, "devices": len(devs[e]), "clicks": sum(clicks[e].values()),
                  "screen_secs": sum(stay[e].values())} for e in envs],
        "screens": [{"view": v, **{e: {"opens": opens[e][v], "secs": stay[e][v],
                                       "share": stay[e][v] / (sum(stay[e].values()) or 1)} for e in envs}}
                    for v in views],
        "top": {e: clicks[e].most_common(top) for e in envs},
        # used somewhere else at least 3 times, here at most `rare`
        "rare_here": {e: sorted(((f, clicks[e][f], every[f] - clicks[e][f]) for f in every
                                 if clicks[e][f] <= rare and every[f] - clicks[e][f] >= 3), key=lambda x: -x[2])[:top]
                      for e in envs},
        "rare_everywhere": sorted((f, n) for f, n in every.items() if n <= rare),
    }
    if recent:
        out["recent"] = [{k: r.get(k) for k in ("ts", "env", "view", "feat", "secs")} for r in rows[-recent:]][::-1]
    return out
