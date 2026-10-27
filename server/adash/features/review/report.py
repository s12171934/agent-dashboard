"""The closing report of an ended QA set: written once into its state directory (report.json) on the first pass that
sees it retired, so it keeps what the set looked like then — later passes lose worktrees and PR links as they are
cleaned. The page draws it inside the set's 「종료된 QA」 card."""

import json
import os
import re
from datetime import datetime, timezone

from adash.core.log import log
from adash.features.review.ship import jira_stage

REPORT = "report.json"
REPORT_VERSION = 1


def when(v):
    """An ISO time (UTC) or the driver's local "YYYY-MM-DD HH:MM:SS" -> aware datetime, else None."""
    try:
        d = datetime.fromisoformat(v)
    except (TypeError, ValueError):
        return None
    return d if d.tzinfo else d.astimezone()


def hours(a, b):
    return round((b - a).total_seconds() / 3600, 1) if a and b and b >= a else None


def build_report(s):
    """The report of a set (as review_pass builds it) -> dict."""
    T = s["tickets"]
    jira = {}
    for t in T:
        k = jira_stage(t)
        jira[k] = jira.get(k, 0) + 1
    qs = [(t, t["qa"]) for t in T if t.get("qa")]
    starts = [when(r) for _, q in qs for r in q.get("rounds") or []]
    starts = [d for d in starts if d]
    end = when(s.get("retired_at")) or datetime.now(timezone.utc)
    begin = min(starts) if starts else None
    # A ticket's lead time: its first round to the last stage it reached past the coordinator's review.
    lead = []
    for t, q in qs:
        a = when((q.get("rounds") or [None])[0])
        b = max((d for d in (when((q.get("at") or {}).get(k)) for k in ("committed", "approved", "delivered", "cleaned")) if d), default=None)
        h = hours(a, b)
        if h is not None:
            lead.append({"key": t["key"], "summary": t.get("summary"), "hours": h, "round": q.get("round") or 0})
    lead.sort(key=lambda x: -x["hours"])
    hs = sorted(x["hours"] for x in lead)
    days = {}
    for d in starts:
        k = d.astimezone().strftime("%Y-%m-%d")
        days[k] = days.get(k, 0) + 1
    # PRs per repository, from the links the driver recorded at delivery (worktrees are mostly cleaned by now)
    prs = set()
    for t in T:
        prs.update((t.get("qa") or {}).get("prs") or [])
        prs.update(r["pr"]["url"] for r in t.get("repos") or [] if (r.get("pr") or {}).get("url"))
    repos = {}
    for u in prs:
        m = re.search(r"/([^/]+)/pull/\d+", u)
        if m:
            repos[m.group(1)] = repos.get(m.group(1), 0) + 1
    rounds = sum(q.get("round") or 0 for _, q in qs)
    return {
        "version": REPORT_VERSION, "written_at": datetime.now(timezone.utc).isoformat(),
        "epic": s["epic"], "summary": s.get("summary"),
        "begin": begin.isoformat() if begin else None, "end": end.isoformat(),
        "tickets": len(T), "jira": jira, "driven": len(qs), "ignored": sum(1 for _, q in qs if q.get("ignored")),
        "rounds": rounds, "reopened": sum(1 for _, q in qs if (q.get("round") or 0) > 1),
        "shipped": sum(1 for _, q in qs if q.get("prs") or q.get("stage") in ("delivered", "cleaned")),
        "lead": {"n": len(hs), "median": hs[len(hs) // 2] if hs else None, "longest": lead[:5]},
        "most_rounds": sorted(({"key": t["key"], "summary": t.get("summary"), "round": q["round"]} for t, q in qs
                               if (q.get("round") or 0) > 1), key=lambda x: -x["round"])[:5],
        "days": [{"day": k, "rounds": v} for k, v in sorted(days.items())],
        "prs": len(prs), "repos": dict(sorted(repos.items(), key=lambda x: -x[1])),
        "left": [{"key": t["key"], "summary": t.get("summary"), "status": t.get("status")} for t in T if jira_stage(t) != "qa"],
        "blocked": [t["key"] for t, q in qs if q.get("blocked")],
    }


def set_report(s):
    """The saved report of a retired set, written first if it is missing; None for a set that is not retired."""
    if not (s.get("retired") and s.get("watch")):
        return None
    p = os.path.join(s["watch"], REPORT)
    try:
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        pass
    rep = build_report(s)
    try:
        with open(p + ".tmp", "w", encoding="utf-8") as f:
            json.dump(rep, f, ensure_ascii=False, indent=1)
        os.replace(p + ".tmp", p)
        log(f"review: {s['epic']} 종료 보고서 작성 {p}")
    except OSError as e:
        log(f"review: {s['epic']} 종료 보고서 저장 실패 {e!r}")
    return rep
