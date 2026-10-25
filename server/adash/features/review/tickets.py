"""A ticket's test run and repositories."""

import os

from adash.features.tests.tests import test_history, test_progress


def ticket_test(key):
    """Latest kept or live test run that names the ticket in its key, label or owner."""
    runs = [r for r in list(test_history.values()) + list(test_progress.get("files") or [])
            if any(key in str(r.get(f) or "") for f in ("key", "label", "owner"))]
    runs.sort(key=lambda r: str(r.get("finished_at") or r.get("updated_at") or r.get("started_at") or ""))
    return {k: runs[-1].get(k) for k in ("label", "kind", "phase", "detail", "passed", "failed", "pending",
                                          "started_at", "finished_at", "updated_at")} if runs else None


def wt_repo(w, worktrees):
    main = next((x for x in worktrees if x.get("repoId") == w.get("repoId") and x.get("isMainWorktree")), None)
    return os.path.basename(main["path"]) if main else os.path.basename(os.path.dirname(w["path"]))
