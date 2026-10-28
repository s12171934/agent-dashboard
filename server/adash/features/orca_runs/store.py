"""The Orca snapshot (runs, tasks, workers, terminals) the collector keeps."""


orca_state = {"runs": [], "tasks": {}, "workers": [], "terminals": [], "error": None, "updated": 0}


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
