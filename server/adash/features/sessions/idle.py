"""Manual idle marks on sessions (prefs.json idle), and the person drawn for each (prefs.json chars)."""


from adash.core.prefs import prefs


def apply_prefs(sm):
    """A manual idle mark holds until the session writes something newer. char: the session's person, or None."""
    sm["char"] = prefs["chars"].get(sm["path"])
    mark = prefs["idle"].get(sm["path"])
    sm["manual_idle"] = mark is not None and (sm["last_ts"] or "") <= mark
    if sm["manual_idle"] and sm["state"] != "done":
        sm.update(state="idle", live=False, state_reason="수동으로 유휴 처리됨")
    return sm
