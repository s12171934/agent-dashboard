"""A coordinator that was resumed (reboot, closed pane) runs in a new Orca terminal. Workers it dispatched
before name the old terminal and workers after name the new one; the page nests by own_handle == coord_handle,
so one session would split into a coordinator and a set of loose workers."""


def fold_handle_aliases(summaries):
    """Point workers that name one of a coordinator's other terminals (own_aliases) at its own_handle, and add
    those terminals to its made_terms so the Runs bound to them nest under it like a driver's. A terminal another
    top session holds as own_handle, or that two sessions claim, stays as it is."""
    top = [sm for sm in summaries if not sm["parent"]]
    owned = {sm["own_handle"] for sm in top if sm.get("own_handle")}
    claims = {}
    for sm in top:
        for h in sm.get("own_aliases") or []:
            if h not in owned:
                claims.setdefault(h, []).append(sm)
    to_primary = {h: sms[0] for h, sms in claims.items() if len(sms) == 1}
    for sm in top:
        coord = to_primary.get(sm.get("coord_handle"))
        if sm["role"] == "worker" and coord and coord is not sm:
            sm["coord_alias"] = sm["coord_handle"]
            sm["coord_handle"] = coord["own_handle"]
    for h, sm in to_primary.items():
        if h not in sm["made_terms"]:
            sm["made_terms"] = [*sm["made_terms"], h]
