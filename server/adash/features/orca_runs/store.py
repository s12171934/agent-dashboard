"""The Orca snapshot (runs, tasks, workers, terminals) the collector keeps."""


orca_state = {"runs": [], "tasks": {}, "workers": [], "terminals": [], "error": None, "updated": 0}


# ---- 상호작용 (inter-agent messages) ----
# Orca keeps every orchestration message (send/ask/reply/worker_done/heartbeat) in its inbox. The 상호작용 tab
# reads it on demand: addresses are rewritten to terminal handles so the page can name the sessions on each end.
run_coord = {}  # run id -> coordinator terminal handle, for every Run run-list returns
