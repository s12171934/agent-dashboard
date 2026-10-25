"""Flow deviations per session, task and ticket."""

import re
import time
from datetime import datetime, timezone

from adash.core.prefs import prefs, save_prefs
from adash.core.state import bump
from adash.core.util import short
from adash.features.flow.contracts import CHECKBOX_FLOW, flow_contracts, qa_contract
from adash.features.review.ship import jira_stage


FLOW_STALL_X = 2        # a task running longer than this many times its finished siblings' median is 정체
FLOW_SIBLINGS = 2       # ... judged only with at least this many finished siblings
FLOW_REPEAT = 3         # 구현 → 리뷰 rounds on one checkbox that count as 반복
FLOW_SLACK_S = 60       # clock slack between two records of one ordering
FLOW_OK_KEEP_S = 30 * 86400
FLOW_TASK_NAME = re.compile(r"^([A-Z]+\d+)(?:#(\d+))?\s*(.*)$")
FLOW_SETTLED = ("completed", "failed", "cancelled")
FLOW_RULES = {"order": "순서 위반", "missing": "필수 단계 누락", "stall": "정체", "repeat": "반복", "plan": "계획 미이행"}


def ts_of(ts, local=False):
    """ISO timestamp, or a zoneless "YYYY-MM-DD HH:MM:SS" (Orca's: UTC; local=True: this machine's clock, as the QA
    driver's claim lines are written) -> epoch seconds or None."""
    if not ts:
        return None
    s = str(ts).strip().replace("Z", "+00:00")
    if "T" not in s:
        s = s.replace(" ", "T", 1)
    try:
        d = datetime.fromisoformat(s)
    except ValueError:
        return None
    return (d if d.tzinfo or local else d.replace(tzinfo=timezone.utc)).timestamp()


def clock(t):
    return datetime.fromtimestamp(t).strftime("%H:%M") if t else "?"


def mins(sec):
    m = max(1, round(sec / 60))
    return f"{m}분" if m < 60 else f"{m // 60}시간 {m % 60}분" if m < 1440 else f"{m // 1440}일 {m % 1440 // 60}시간"


def task_label(t):
    return t.get("display_name") or t.get("task_title") or ""


def task_role(t):
    m = FLOW_TASK_NAME.match(task_label(t))
    return (m.group(3) or "").strip() if m else task_label(t)


def deviation(rule, severity, unit, key, reason, evidence, **ref):
    return {"id": f"{rule}|{key}", "rule": rule, "rule_name": FLOW_RULES[rule], "severity": severity, "unit": unit,
            "reason": reason, "evidence": [e for e in evidence if e], "session": None, "task_id": None, "task_ids": [],
            "ticket": None, "handles": [], **ref}


def flow_stall(summaries, tasks, sess_of, now):
    """정체: a session whose turn is open with no record (state stalled, 응답 없음), or a worker task running longer than
    FLOW_STALL_X × the median of finished sibling tasks in its run (same role when there are enough, then same model —
    the page's estIndex). A worker waiting for input is the user's time and is not judged."""
    durs = {}
    for rid, ts in tasks.items():
        for t in ts:
            w = sess_of.get(t.get("id"))
            if t.get("status") != "completed" or not w or not w.get("started"):
                continue
            end = ts_of(t.get("completed_at")) or ts_of(w.get("last_ts"))
            start = max(ts_of(w["started"]) or 0, ts_of(t.get("created_at")) or 0)
            if end and end > start:
                durs.setdefault(rid, []).append((end - start, w.get("model"), task_role(t)))
    over = {}
    for rid, ts in tasks.items():
        for t in ts:
            w = sess_of.get(t.get("id"))
            if not w or t.get("status") in FLOW_SETTLED or w.get("task_id") != t.get("id") or w.get("state") not in ("run", "bg", "stalled"):
                continue
            ds, role = durs.get(rid, []), task_role(t)
            pool = [d for d in ds if d[2] == role]
            pool, by_role = (pool, True) if len(pool) >= FLOW_SIBLINGS else (ds, False)
            same = [d for d in pool if w.get("model") and d[1] == w.get("model")]
            if len(same) >= FLOW_SIBLINGS:
                pool = same
            if len(pool) < FLOW_SIBLINGS:
                continue
            v = sorted(d[0] for d in pool)
            med = v[len(v) // 2] if len(v) % 2 else (v[len(v) // 2 - 1] + v[len(v) // 2]) / 2
            el = now - max(ts_of(w.get("started")) or now, ts_of(t.get("created_at")) or 0)
            if el > FLOW_STALL_X * med:
                over[w["path"]] = (t, el, med, len(pool), role if by_role else None)
    out = []
    for sm in summaries:
        if sm.get("parent"):
            continue
        o, stalled = over.get(sm["path"]), sm.get("state") == "stalled"
        if not o and not stalled:
            continue
        t = o[0] if o else None
        la, plan = sm.get("last_action") or {}, sm.get("plan") or {}
        ev = [f"마지막 기록 {clock(ts_of(sm.get('last_ts')))} ({mins(now - (ts_of(sm.get('last_ts')) or now))} 전)" if sm.get("last_ts") else None,
              f"마지막 동작: {la.get('text')}" if la.get("text") else None,
              f"계획 단계: {plan['cur'] + 1}/{plan['total']} {plan.get('cur_text') or ''}".strip() if plan.get("cur") is not None else None]
        if o:
            ev.insert(0, f"경과 {mins(o[1])} · 같은 Run{' · 같은 역할(' + o[4] + ')' if o[4] else ''}의 끝난 형제 {o[3]}개 중앙값 {mins(o[2])}의 {o[1] / o[2]:.1f}배")
        reason = ("응답 없음 — " + (sm.get("state_reason") or "턴이 열린 채 기록 없음")) if stalled else f"기대 시간의 {o[1] / o[2]:.1f}배 경과"
        out.append(deviation("stall", "bad" if stalled else "warn", "session", (t["id"] if t else sm["path"]), reason, ev,
                             session=sm["path"], task_id=t["id"] if t else sm.get("task_id"), task_ids=[t["id"]] if t else []))
    return out


def flow_plan(summaries, plans):
    """계획 미이행: the session ended (완료 or 유휴, the page's ENDED) while steps of its latest aplan plan are still open."""
    out = []
    for sm in summaries:
        p = plans.get(sm["path"])
        if sm.get("parent") or not p or sm.get("state") not in ("idle", "done"):
            continue
        left = [(i, x) for i, x in enumerate(p["steps"]) if x.get("st") in ("run", "todo")]
        if not left:
            continue
        ev = ["남은 단계: " + " · ".join(f"{i + 1}. {short(x.get('t') or '', 40)}" for i, x in left[:4]) + (f" 외 {len(left) - 4}" if len(left) > 4 else ""),
              f"계획 {sum(x.get('st') in ('done', 'skip') for x in p['steps'])}/{len(p['steps'])} 완료 · 세션 {'완료' if sm['state'] == 'done' else '유휴'} (마지막 기록 {clock(ts_of(sm.get('last_ts')))})"]
        out.append(deviation("plan", "warn", "session", f"{sm['path']}|{p.get('ts')}", f"세션이 끝났는데 계획 {len(left)}단계가 남음", ev,
                             session=sm["path"], task_id=sm.get("task_id")))
    return out


def flow_checkboxes(tasks, sess_of):
    """필수 단계 누락 (a 판정 passed while a review of its round, not cancelled, had no result) and 반복 (one checkbox went
    through FLOW_REPEAT or more 구현 rounds). Checkboxes are tasks named 「<ticket>#<n> <role>」, roles per CHECKBOX_FLOW."""
    work, review, verdict = set(CHECKBOX_FLOW["work"]), list(CHECKBOX_FLOW["review"]), set(CHECKBOX_FLOW["verdict"])
    out = []
    for rid, ts in tasks.items():
        boxes = {}
        for t in ts:
            m = FLOW_TASK_NAME.match(task_label(t))
            if m and m.group(2):
                boxes.setdefault(f"{m.group(1)}#{m.group(2)}", []).append(t)
        for box, items in boxes.items():
            items.sort(key=lambda t: ts_of(t.get("created_at")) or 0)
            sess = lambda t: (sess_of.get(t["id"]) or {}).get("path")
            for v in (t for t in items if task_role(t) in verdict and t.get("status") == "completed"):
                vc, vd = ts_of(v.get("created_at")), ts_of(v.get("completed_at"))
                if vc is None or vd is None:
                    continue
                lacking, seen = [], []
                for role in review:
                    before = [t for t in items if task_role(t) == role and (ts_of(t.get("created_at")) or vc + 1) <= vc]
                    if not before:
                        continue  # this checkbox never had that reviewer: nothing to judge against
                    r = before[-1]
                    rd = ts_of(r.get("completed_at"))
                    if r.get("status") == "cancelled" or (r.get("status") == "completed" and rd is not None and rd <= vd + FLOW_SLACK_S):
                        seen.append(f"{role} {'취소' if r.get('status') == 'cancelled' else '완료 ' + clock(rd)}")
                    else:
                        lacking.append((role, r))
                if not lacking:
                    continue
                ev = [f"판정 통과 {clock(vd)}"] + [f"{role}: 결과 없음 (상태 {r.get('status')} · 생성 {clock(ts_of(r.get('created_at')))})" for role, r in lacking] + seen
                out.append(deviation("missing", "bad", "task", v["id"], f"{' · '.join(x[0] for x in lacking)} 결과 없이 판정", ev,
                                     session=sess(v), task_id=v["id"], task_ids=[v["id"]] + [r["id"] for _, r in lacking], checkbox=box, run_id=rid))
            rounds = [t for t in items if task_role(t) in work]
            if len(rounds) >= FLOW_REPEAT:
                last = rounds[-1]
                verd = [t for t in items if task_role(t) in verdict]
                ev = [f"구현 {len(rounds)}회: " + " · ".join(clock(ts_of(t.get("created_at"))) for t in rounds),
                      f"판정 {len(verd)}회" + (f" · 마지막 판정 {verd[-1].get('status')}" + (f" ({verd[-1].get('outcome')})" if verd[-1].get("outcome") else "") if verd else "")]
                out.append(deviation("repeat", "warn", "checkbox", f"{rid}|{box}", f"같은 체크박스 구현→리뷰 {len(rounds)}라운드", ev,
                                     session=sess(last), task_id=last["id"], task_ids=[t["id"] for t in rounds], checkbox=box, run_id=rid))
    return out


def flow_tickets(review_sets, contract, coord_of):
    """순서 위반 on QA driver tickets: the stage after a user gate of the contract reached without the gate (승인 없이 반출),
    cleanup with a PR still open, or Jira past 개발 완료 with a PR still open.
    PR and Jira checks run only when the dashboard has read that PR / that ticket."""
    stages = contract["stages"]
    keys = [s["key"] for s in stages]
    name = lambda k: next((s["label"] for s in stages if s["key"] == k), k)
    out = []
    for st in review_sets:
        for t in st.get("tickets") or []:
            q = t.get("qa")
            if not q or q.get("ignored") or q.get("stage") not in keys:
                continue
            at, cur = q.get("at") or {}, keys.index(q["stage"])
            ref = dict(ticket=t["key"], handles=q.get("handles") or [], session=coord_of(q.get("handles") or []))
            if q.get("driver"):
                # A user gate is skipped when the stage right after it has its signal while the gate's own is missing
                # (delivered/ without approved/ = 승인 없이 반출). A ticket cleaned without ever shipping (no PR, Jira done)
                # passed no gate. Signal mtimes are last writes, not entry times (delivered/ is rewritten with every PR),
                # so the order of two present signals is not judged.
                for i, s in enumerate(stages[:-1]):
                    nxt = stages[i + 1]
                    if s["user"] and not at.get(s["key"]) and at.get(nxt["key"]) and cur > i:
                        out.append(deviation("order", "bad", "ticket", f"{t['key']}|gate|{s['key']}", f"{name(s['key'])} 없이 {name(nxt['key'])}",
                                             [f"{name(nxt['key'])} {clock(ts_of(at[nxt['key']], local=True))} · 지금 단계 {cur + 1}/{len(stages)} {name(q['stage'])}",
                                              f"{name(s['key'])} 신호 없음 ({s['signal'] or s['key']}/{t['key']}) — 계약상 {s['by']} 차례"], **ref))
            prs = [r["pr"] for r in t.get("repos") or [] if isinstance(r.get("pr"), dict) and r["pr"].get("state")]
            open_prs = [p for p in prs if p["state"] == "OPEN"]
            if q["stage"] == "cleaned" and open_prs:
                out.append(deviation("order", "bad", "ticket", f"{t['key']}|clean-open", "머지 전 정리",
                                     [f"정리 {clock(ts_of(at.get('cleaned'), local=True))}", "열린 PR: " + ", ".join(f"#{p.get('number')}" for p in open_prs)], **ref))
            if open_prs and t.get("status") and jira_stage(t) in ("dev", "ready", "qa"):
                out.append(deviation("order", "warn", "ticket", f"{t['key']}|jira-open", f"머지 전 Jira 「{t['status']}」",
                                     [f"Jira 상태 {t['status']}", "열린 PR: " + ", ".join(f"#{p.get('number')}" for p in open_prs)], **ref))
    return out


def flow_check(summaries, tasks, plans, review_sets, now=None):
    """Every rule over one snapshot. tasks: run id -> Orca tasks; plans: session path -> its latest aplan plan;
    review_sets: review_state["sets"]. Dismissed deviations (prefs flow_ok) are left out and counted."""
    now = now or time.time()
    sess_of = {}
    for sm in summaries:
        if not sm.get("parent"):
            for tid in sm.get("task_ids") or ([sm["task_id"]] if sm.get("task_id") else []):
                sess_of[tid] = sm
    handle_of = {}
    for sm in summaries:
        for h in (sm.get("own_handle"), sm.get("orca_focus")):
            if h and not sm.get("parent"):
                handle_of.setdefault(h, sm["path"])
    coord_of = lambda hs: next((handle_of[h] for h in hs if h in handle_of), None)
    items = (flow_tickets(review_sets, qa_contract(), coord_of) + flow_checkboxes(tasks, sess_of)
             + flow_stall(summaries, tasks, sess_of, now) + flow_plan(summaries, plans))
    ok = prefs.get("flow_ok") or {}
    shown = [x for x in items if x["id"] not in ok]
    return {"contracts": flow_contracts(), "items": shown, "ok": len(items) - len(shown), "rules": FLOW_RULES}


def flow_mark(fid, normal, item=None):
    """「정상으로 표시」 (normal) or undo it. Call holding `lock`."""
    ok = prefs.setdefault("flow_ok", {})
    cutoff = datetime.fromtimestamp(time.time() - FLOW_OK_KEEP_S, timezone.utc).isoformat()
    for k in [k for k, v in ok.items() if (v.get("at") or "") < cutoff]:
        del ok[k]
    if normal:
        ok[fid] = {"at": datetime.now(timezone.utc).isoformat(), **({k: short(item.get(k) or "", 200) for k in ("rule", "reason")} if item else {})}
    else:
        ok.pop(fid, None)
    save_prefs()
    bump()
