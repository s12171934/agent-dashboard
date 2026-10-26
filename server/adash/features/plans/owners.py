"""Which session owns an external plan, and the scripts it runs."""

import os

import adash.features.sessions.scan as sessions_scan
from adash.core.files import save_json
from adash.features.orca_runs.store import orca_state
from adash.features.plans.external import PLAN_HISTORY_PATH, plan_history
from adash.features.plans.store import ext_plans


def resolve_plan_owner(path, plan, summaries):
    """(owner session id, None) or (None, why) for an external plan. The plan's own claim comes first — the session
    it names, else the one running in its coordinator terminal, else the one that opened or runs in its scheduler
    terminal — and whichever session that is, its coordinators are followed up to the top: a scheduler relaunched
    from a worker's terminal still belongs to that worker's coordinator. A resolved owner is remembered in
    plan_history, so a plan whose trail goes cold (relaunched with nohup, a reused terminal) keeps its owner.
    Until the first scan has read every transcript, a missing owner proves nothing: the remembered one stands and no
    problem is reported (a restart used to cut the scheduler loose from its coordinator for the first snapshots)."""
    top = [sm for sm in summaries if not sm["parent"]]
    by_handle = {sm["own_handle"]: sm for sm in sorted(top, key=lambda sm: sm["last_ts"] or "") if sm.get("own_handle")}
    by_id = {}
    for sm in top:
        by_id[sm["id"]] = by_id[os.path.splitext(os.path.basename(sm["path"]))[0]] = sm

    def ascend(sm):
        seen = {sm["id"]}
        while sm["role"] == "worker" and sm.get("coord_handle") in by_handle and by_handle[sm["coord_handle"]]["id"] not in seen:
            sm = by_handle[sm["coord_handle"]]
            seen.add(sm["id"])
        return sm

    sched = plan.get("scheduler_terminal")
    found = (by_id.get(plan.get("coordinator_session") or "")
             or by_handle.get(plan.get("coordinator_terminal") or "")
             or next((sm for sm in sorted(top, key=lambda sm: sm["last_ts"] or "", reverse=True) if sched and sched in sm["made_terms"]), None)
             or by_handle.get(sched or ""))
    remembered = (plan_history.get(path) or {}).get("owner")
    if found:
        owner = ascend(found)["id"]
        if owner != remembered:
            plan_history[path] = {**(plan_history.get(path) or {}), "owner": owner}
            save_json(PLAN_HISTORY_PATH, plan_history)
        return owner, None
    if remembered in by_id or not sessions_scan.scan_ready:
        return remembered, None
    if plan.get("coordinator_session"):
        return None, f"계획이 적은 코디네이터 세션 {plan['coordinator_session'][:8]} 을 찾지 못함"
    if sched:
        return None, f"스케줄러 터미널 {sched[:13]} 을 연 세션도, 그 안에서 도는 세션도 없음 (coordinator.json 없음)"
    return None, "계획에 코디네이터·스케줄러가 없음 (coordinator.json 없음)"


plan_owners = {}  # plan path -> (owner session id or None, why not), as the last /api/state resolved them


def with_plan_terms(sm):
    """A plan's coordinator session owns the plan's scheduler and per-ticket driver terminals,
    so the UI nests those scripts (and their Runs and workers) under it."""
    extra = []
    for path, plan in ext_plans.items():
        if (plan_owners.get(path) or (None,))[0] != sm["id"]:
            continue
        extra += [plan.get("scheduler_terminal")] + [t.get("driver_terminal_handle") for t in plan["tickets"]]
        extra += plan.get("driver_history") or []
        rids = set(plan.get("run_ids") or [])
        extra += [r.get("coordinator_handle") for r in orca_state["runs"] if r.get("id") in rids]
    made = list(sm["made_terms"])
    made += [h for h in dict.fromkeys(extra) if h and h not in made]
    sm["made_terms"] = made
    return sm


def plan_with_owner(path, plan):
    """The plan as the page gets it, naming the owner resolve_plan_owner found (flagged coordinator_inferred when the
    plan itself named another or none) or, without one, why not (owner_problem), so an unowned plan says so."""
    owner, why = plan_owners.get(path) or (None, None)
    if not owner:
        return {**plan, "owner_problem": why}
    return plan if owner == plan.get("coordinator_session") else {**plan, "coordinator_session": owner, "coordinator_inferred": True}
