"""Which Orca terminal a session runs in, and the terminals below it for a cascading close."""


from adash.features.orca_runs.store import orca_state
from adash.features.sessions.config import hooks


focus_handles = {}  # terminal -> session id, as the last /api/state mapped them: the only ones /api/orca/close accepts


def focus_targets(summaries):
    """Session id -> the connected Orca terminal it runs in, for 「Orca 에서 열기」. Orca's hook pane wins (it
    covers any Orca-launched Claude session); a terminal handle read from the transcript (own_handle) is the
    fallback, unless the hook places another session in that terminal. Subagents run in their parent's pane."""
    terms = {t["handle"]: t for t in orca_state.get("terminals", []) if t.get("connected")}
    by_pane = {f'{t["tabId"]}:{t["leafId"]}': h for h, t in terms.items() if t.get("tabId") and t.get("leafId")}
    out = {}
    for sm in summaries:
        h = by_pane.get((hooks.get(sm["id"]) or {}).get("pane"))
        if h and not sm["parent"]:
            out[sm["id"]] = h
    claimed = set(out.values())
    for sm in summaries:
        h = sm.get("own_handle")
        if sm["id"] not in out and not sm["parent"] and h in terms and h not in claimed:
            out[sm["id"]] = h
    return out


close_trees = {}  # terminal -> the connected terminals below it, deepest first, as the last /api/state mapped them


def close_tree(sm, summaries, focus, terms):
    """The connected Orca terminals under a session, for a cascading close: its workers' terminals (recursively,
    through sub-coordinators) and the terminals it opened (made_terms: driver/scheduler scripts, whose Run workers
    join the tree too). A terminal another session outside the tree runs in is left alone. Deepest first, so a
    coordinator never outlives the workers that report to it."""
    owners, tree, out, seen = {sm.get("own_handle"), focus.get(sm["id"])} | set(sm["made_terms"]), {sm["id"]}, [], set()
    level = list(sm["made_terms"])
    while True:
        kids = [w for w in summaries if w["role"] == "worker" and not w["parent"] and w["id"] not in tree
                and w.get("coord_handle") in owners]
        if not kids:
            break
        tree |= {w["id"] for w in kids}
        level += [focus.get(w["id"]) for w in kids]
        for w in kids:
            owners |= {w.get("own_handle"), focus.get(w["id"])} | set(w["made_terms"])
            level += w["made_terms"]
    foreign = {h for sid, h in focus.items() if sid not in tree}
    for h in reversed(level):
        if h and h in terms and h not in foreign and h not in seen and h != focus.get(sm["id"]):
            seen.add(h)
            out.append(h)
    return out
