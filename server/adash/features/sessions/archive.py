"""Sessions outside the window, opened on demand from the design documents tab."""

import collections
import os

from adash.features.designs.store import design_refs, refs_lock
from adash.features.sessions.session import Session


_archived = collections.OrderedDict()  # (path, mtime, size) -> Session, the last few opened


def archived_session(path):
    """A transcript outside the live window, parsed on demand, when design-refs.json names it (the 「설계문서」 tab links
    every session that read a document, however old). Others stay unknown: this never reads an arbitrary path."""
    with refs_lock:
        known = any(m.get("path") == path for m in design_refs["sessions"].values())
    if not known:
        return None
    try:
        st = os.stat(path)
    except OSError:
        return None
    key = (path, st.st_mtime, st.st_size)
    if key not in _archived:
        s = Session(path, "codex" if os.path.basename(path).startswith("rollout-") else "claude")
        s.poll()
        _archived[key] = s
        while len(_archived) > 4:
            _archived.popitem(last=False)
    return _archived[key]
