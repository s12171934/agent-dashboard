"""The rest of /api/glance: one small summary per page screen the snapshot does not carry (QA 워크트리 리뷰, 상호작용,
설계문서, 워크트리, 비교) and 홈's 내 차례. Each reads a cache its own endpoint keeps, so a widget never waits on git or
the Orca CLI except on the server's first read."""

from datetime import datetime

from adash.core.files import StaleWhileRefresh
from adash.core.state import lock
from adash.core.util import short
from adash.features.designs.service import design_list
from adash.features.interactions.interactions import INBOX_TTL, interactions
from adash.features.review.store import review_state
from adash.features.worktrees.worktrees import worktrees

GLANCE_TALK = 40  # messages read for the 상호작용 widget (heartbeats left out)
TALK_TYPES = ("question", "escalation", "worker_done", "status", "dispatch")  # the page's default 상호작용 filter
_talk = StaleWhileRefresh("glance-talk", lambda: interactions(GLANCE_TALK, False), max(INBOX_TTL, 30))


def qa_summary():
    """The running QA sets: tickets per driver stage, the blocked ones and the ones waiting for 반출 승인 (홈's 내 차례)."""
    with lock:
        sets = [s for s in review_state["sets"] if not s.get("retired")]
    out = []
    for s in sets:
        ts = s.get("tickets") or []
        stages, blocked, approve = {}, [], []
        for t in ts:
            qa = t.get("qa") or {}
            if not qa or qa.get("ignored"):
                continue
            stages[qa.get("stage")] = stages.get(qa.get("stage"), 0) + 1
            row = {"key": t.get("key"), "summary": short(t.get("summary") or "", 80), "stage": qa.get("stage")}
            if qa.get("blocked"):
                blocked.append({**row, "reason": short(qa.get("blocked_reason") or "", 120)})
            elif qa.get("stage") == "committed" and t.get("repos"):
                approve.append(row)
        out.append({"epic": s.get("epic"), "summary": short(s.get("summary") or "", 60), "tickets": len(ts),
                    "reopened": sum(1 for t in ts if t.get("review") == "reopened"),
                    "stages": stages, "blocked": blocked[:4], "approve": approve[:4]})
    return out


def talk_summary(names):
    """The latest messages between agents, each end named by the session on its terminal."""
    try:
        msgs = _talk.get().get("messages") or []
    except Exception:
        return None
    def end(term, kind):
        return names.get(term) or {"run": "코디네이터", "dispatch": "워커"}.get(kind) or "에이전트"
    msgs = sorted((m for m in msgs if m.get("type") in TALK_TYPES), key=lambda m: m.get("created_at") or "", reverse=True)
    return [{"type": m.get("type"), "from": end(m.get("from_term"), m.get("from_kind")), "to": end(m.get("to_term"), m.get("to_kind")),
             "subject": short(m.get("subject") or "", 80), "body": short(" ".join((m.get("body") or "").split()), 140),
             "at": m.get("created_at")} for m in msgs[:6]]


def designs_summary():
    """설계문서: how many, the latest edited and the most read."""
    d = design_list()
    if not d.get("enabled"):
        return None
    docs = d.get("docs") or []
    row = lambda e: {"key": e["key"], "title": e.get("title") or e["key"].rsplit("/", 1)[-1], "kind": e.get("kind"),
                     "mtime": e.get("mtime"), "sessions": e.get("sessions") or 0}
    return {"docs": len(docs), "sources": len(d.get("sources") or []),
            "recent": [row(e) for e in sorted(docs, key=lambda e: -(e.get("mtime") or 0))[:5]],
            "read": [row(e) for e in sorted(docs, key=lambda e: -(e.get("sessions") or 0)) if e.get("sessions")][:5]}


def trees_summary():
    """워크트리: per repo how many, and the ones with uncommitted changes, the latest commit first."""
    try:
        v = worktrees()
    except Exception:
        return None
    repos, dirty = [], []
    for rp in v.get("repos") or []:
        ws = [w for w in rp.get("worktrees") or [] if not w.get("bare")]
        repos.append({"name": rp.get("name"), "worktrees": len(ws), "dirty": sum(1 for w in ws if w.get("dirty"))})
        dirty += [{"repo": rp.get("name"), "name": w.get("name"), "branch": w.get("branch"), "dirty": w.get("dirty"),
                   "committed": w.get("committed")} for w in ws if w.get("dirty")]
    dirty.sort(key=lambda w: -(w.get("committed") or 0))
    return {"repos": sorted(repos, key=lambda r: -r["worktrees"]), "dirty": dirty[:6]}


def cost_summary(sessions):
    """비교: today's cost by hour (every session's, subagents too) and the agents that spent the most today, from the
    sessions' 5-minute slots."""
    midnight = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0).timestamp()
    hours, per = [0.0] * 24, {}
    for s in sessions:
        c = 0.0
        for k, v in (s.get("slots") or {}).items():
            at = int(k) * 300
            if at >= midnight and len(v) > 4:
                hours[min(23, int((at - midnight) // 3600))] += v[4]
                c += v[4]
        if c and s.get("role") != "sub" and not s.get("parent"):  # subagents count in the total, not in the list
            per[s.get("path")] = (c, s)
    top = sorted(per.values(), key=lambda x: -x[0])[:5]
    return {"total": round(sum(hours), 2), "hours": [round(h, 2) for h in hours], "now_hour": datetime.now().hour,
            "top": [{"title": s.get("title"), "model": s.get("model"), "cost": round(c, 2), "path": s.get("path")} for c, s in top]}


def terminal_names(sessions):
    """Orca terminal handle -> the title of the session on it, for naming a message's ends."""
    names = {}
    for s in sessions:
        for h in (s.get("orca_focus"), s.get("own_handle")):
            if h and s.get("title"):
                names.setdefault(h, s["title"])
    return names


def screens(names):
    """The summaries read from the other endpoints' caches, made per request outside the snapshot lock; one that fails
    is left out (null) rather than failing the glance."""
    out = {}
    for k, f in (("qa", qa_summary), ("talk", lambda: talk_summary(names)), ("designs", designs_summary), ("trees", trees_summary)):
        try:
            out[k] = f()
        except Exception:
            out[k] = None
    return out
