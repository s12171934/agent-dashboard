"""The rest of /api/glance: one small summary per page screen the snapshot does not carry (QA 워크트리 리뷰, 상호작용,
설계문서, 워크트리, 비교) and 홈's 내 차례. Each reads a cache its own endpoint keeps, so a widget never waits on git or
the Orca CLI except on the server's first read."""

import re
import time
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


HM_STALE = 24 * 3600  # a 막힘 older than this counts at its stage, not as the user's turn (frontend/app.js HM_STALE)
# the page's 워크트리 리뷰 tile groups, in the order a ticket is taken
QA_GROUPS = [("blocked", None), ("approve", {"committed"}), ("working", {"analysis", "implementing", "reviewing", "approved"}),
             ("waiting", {"selected", "worktree"}), ("delivered", {"delivered"})]


def jira_stage(t):
    """The page's jiraStage: Jira's status by name (보류, QA 준비, 개발 완료, QA 완료), else by its category."""
    n = re.sub(r"\s", "", t.get("status") or "")
    if re.search(r"hold|홀딩|보류", n, re.I):
        return "hold"
    if "QA준비" in n:
        return "ready"
    if "개발완료" in n:
        return "dev"
    if "QA완료" in n or t.get("cat") == "done":
        return "qa"
    return "todo" if t.get("cat") == "new" else "prog"


def stage_age(qa, now):
    at = (qa.get("at") or {}).get(qa.get("stage"))
    try:
        return now - datetime.strptime(at, "%Y-%m-%d %H:%M:%S").timestamp() if at else float("inf")
    except ValueError:
        try:
            return now - datetime.fromisoformat(at).timestamp()
        except ValueError:
            return float("inf")


def qa_summary():
    """The running QA sets counted as the page's 워크트리 리뷰 tile does: the tickets still in the pipeline (not 정리, not
    ignored, not parked at Jira 보류, not a 커밋 완료 left with no worktree), each in one group — 막힘 (under a day),
    승인 대기, 작업 중, 대기, 반출됨."""
    with lock:
        sets = [s for s in review_state["sets"] if not s.get("retired")]
    now, out = time.time(), []
    for s in sets:
        groups = {k: [] for k, _ in QA_GROUPS}
        for t in s.get("tickets") or []:
            qa = t.get("qa") or {}
            if not qa or qa.get("ignored") or qa.get("stage") == "cleaned" or jira_stage(t) == "hold":
                continue
            if qa.get("stage") == "committed" and not t.get("repos"):
                continue
            stuck = qa.get("blocked") and stage_age(qa, now) < HM_STALE
            for k, stages in QA_GROUPS:
                if (k == "blocked" and stuck) or (k != "blocked" and qa.get("stage") in stages):
                    groups[k].append({"key": t.get("key"), "summary": short(t.get("summary") or "", 80), "stage": qa.get("stage"),
                                      "reason": short(qa.get("blocked_reason") or "", 120) if stuck else None})
                    break
        out.append({"epic": s.get("epic"), "summary": short(s.get("summary") or "", 60),
                    "open": sum(len(v) for v in groups.values()), "counts": {k: len(v) for k, v in groups.items()},
                    "blocked": groups["blocked"][:4], "approve": groups["approve"][:4]})
    return out


def with_mine(g):
    """홈's 내 차례 (the page's hmMine): questions waiting, agents stopped at a step that asks for the person, QA tickets
    blocked under a day and QA work waiting for 반출 승인, oldest kind first."""
    qa = g.get("qa") or []
    items = ([{"kind": "dec", "title": d["title"], "detail": d.get("header") or d["question"], "path": d.get("path")} for d in g["decisions"]]
             + [{"kind": "ask", **a} for a in g.get("asks") or []]
             + [{"kind": "blocked", "title": t["key"], "detail": t.get("reason") or t["summary"], "path": None} for s in qa for t in s["blocked"]]
             + [{"kind": "approve", "title": t["key"], "detail": t["summary"], "path": None} for s in qa for t in s["approve"]])
    counts = {k: sum(1 for i in items if i["kind"] == k) for k in ("dec", "ask", "blocked", "approve")}
    # the per-set lists stop at four: count the QA ones from the set totals
    counts["blocked"] = sum(s["counts"]["blocked"] for s in qa)
    counts["approve"] = sum(s["counts"]["approve"] for s in qa)
    return {**g, "mine": {"total": sum(counts.values()), "counts": counts, "items": items[:6]}}


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
