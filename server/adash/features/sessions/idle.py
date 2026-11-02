"""Manual idle marks on sessions (prefs.json idle), and the person drawn for each (prefs.json chars)."""


from adash.core.prefs import prefs, save_prefs
from adash.features.terminals.pending import PREFIX


def apply_prefs(sm):
    """A manual idle mark holds until the session writes something newer. char: the session's person, or None."""
    sm["char"] = prefs["chars"].get(sm["path"])
    mark = prefs["idle"].get(sm["path"])
    sm["manual_idle"] = mark is not None and (sm["last_ts"] or "") <= mark
    if sm["manual_idle"] and sm["state"] != "done":
        sm.update(state="idle", live=False, state_reason="수동으로 유휴 처리됨")
    return sm


def carry_pending_chars(summaries, pending):
    """A pending agent's person (kept under its orca-terminal: path) passes to the session that claims its terminal
    (orca_focus) once the transcript shows up, so the office does not swap the person at the first prompt. Entries for
    terminals neither pending nor claimed any more are dropped. Call after orca_focus is set."""
    chars, changed = prefs["chars"], False
    for sm in pending:
        sm["char"] = chars.get(sm["path"])
    for sm in summaries:
        old = sm.get("orca_focus") and chars.get(PREFIX + sm["orca_focus"])
        if old and not sm["char"]:
            chars[sm["path"]] = sm["char"] = old
            changed = True
    live = {sm["path"] for sm in pending}
    for path in [p for p in chars if p.startswith(PREFIX) and p not in live]:
        del chars[path]
        changed = True
    if changed:
        save_prefs()
