"""The Orca snapshot (runs, tasks, workers, terminals) the collector keeps."""


orca_state = {"runs": [], "tasks": {}, "workers": [], "terminals": [], "error": None, "updated": 0}

# Lookups each session's summary makes over the snapshot, built once per snapshot. A snapshot build summarises a
# couple of thousand sessions; scanning thousands of workers and tasks for each of them took most of a core.
_index = {"workers": None, "tasks": None}


def orca_index():
    """-> {"wt_by_task": task id -> worktree id of its first worker that names one, "by_handle": terminal handle ->
    [(position in the worker list, worker)] of the workers with a task, "created": task id -> created_at}.
    Rebuilt when the collector puts new lists in orca_state (orca_state.update rebinds them, never edits them in place);
    the lists themselves are held, so a new list can never pass for the old one by reusing its id."""
    workers, tasks = orca_state.get("workers"), orca_state.get("tasks")
    idx = _index
    if "created" not in idx or idx["workers"] is not workers or idx["tasks"] is not tasks:
        wt_by_task, by_handle = {}, {}
        for i, w in enumerate(workers or []):
            tid = w.get("taskId")
            if not tid:
                continue
            wt = ((w.get("resource") or {}).get("worktreeId") or "").split("::", 1)[-1]
            if wt:
                wt_by_task.setdefault(tid, wt)
            by_handle.setdefault(w.get("agentTerminalHandle"), []).append((i, w))
        created = {t["id"]: t.get("created_at") or "" for ts in (tasks or {}).values() for t in ts}
        idx = {"workers": workers, "tasks": tasks, "wt_by_task": wt_by_task, "by_handle": by_handle, "created": created}
        globals()["_index"] = idx
    return idx


# Orca has no cancelled task status (task-update takes pending, ready, dispatched, completed, failed, blocked), so a
# task dropped on purpose is closed as failed with a result starting 「취소」. It is shown as cancelled, not as a failure.
def as_cancelled(t):
    if t.get("status") == "failed" and str(t.get("result") or "").lstrip().startswith("취소"):
        return {**t, "status": "cancelled", "orca_status": "failed"}
    return t


# ---- 상호작용 (inter-agent messages) ----
# Orca keeps every orchestration message (send/ask/reply/worker_done/heartbeat) in its inbox. The 상호작용 tab
# reads it on demand: addresses are rewritten to terminal handles so the page can name the sessions on each end.
run_coord = {}  # run id -> coordinator terminal handle, for every Run run-list returns
