"""Manual idle marks on sessions (prefs.json idle)."""


from adash.core.prefs import prefs


def apply_prefs(sm):
    """A manual idle mark holds until the session writes something newer."""
    mark = prefs["idle"].get(sm["path"])
    sm["manual_idle"] = mark is not None and (sm["last_ts"] or "") <= mark
    if sm["manual_idle"] and sm["state"] != "done":
        sm.update(state="idle", live=False, state_reason="수동으로 유휴 처리됨")
    return sm
