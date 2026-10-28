"""Shipping a ticket through an Orca worker."""

import os
import re
from datetime import datetime, timezone

from adash.core.jira import JIRA_SITE
from adash.core.orca import orca, orca_all
from adash.core.prefs import prefs
from adash.core.state import lock
from adash.core.util import short
from adash.features.orca_runs.store import as_cancelled
from adash.features.review.config import WT_KEY
from adash.features.review.store import review_kick
import adash.core.config as core_config


# ---- Ship: 「PR 후 머지」 hands a 진행 중 ticket to a supervised Orca worker ----
# prefs.json "ship_prompt" is the prompt template (absolute path, {{name}} slots filled from the ticket below) and each
# QA set's "ship_place" the Orca worktree path the worker starts in — outside the ticket's worktrees, which the worker
# removes at the end. One Run per set, found again by its objective, holds every ship Task; nobody coordinates it, so
# the prompt has the worker stop and report failure instead of asking. A Task's title starts with the ticket key.
SHIP_PROMPT = os.path.expanduser(prefs.get("ship_prompt") or "")
SHIP_AGENT, SHIP_MODEL = prefs.get("ship_agent") or "claude", prefs.get("ship_model") or "opus"
SHIP_SETTLED = ("completed", "failed", "cancelled", "launch_failed")
ship_runs = {}    # epic -> run id
ship_launch = {}  # key -> {"at", "error"} while worker-start runs, and why it failed


def jira_stage(t):
    """Same split as the page's jiraStage: 보류, 개발 완료 and QA 준비 완료 share 진행 중's category, so they go by name."""
    n = re.sub(r"\s", "", t.get("status") or "")
    return ("hold" if re.search(r"hold|홀딩|보류", n, re.I) else "ready" if "QA준비" in n else "dev" if "개발완료" in n else "qa" if "QA완료" in n or t.get("cat") == "done"
            else "todo" if t.get("cat") == "new" else "prog")


def ship_objective(epic):
    return f"{epic} 티켓 반출 (대시보드)"


def ship_run(epic, create=False):
    if epic not in ship_runs:
        rid = next((r["id"] for r in orca_all("runs", "orchestration", "run-list")
                    if r.get("objective") == ship_objective(epic)), None)
        if not rid and create:
            rid = orca("orchestration", "run-create", "--objective", ship_objective(epic), timeout=30)["run"]["id"]
        if not rid:
            return None
        ship_runs[epic] = rid
    return ship_runs[epic]


def ship_tasks(epic):
    """key -> latest ship Task of the set's Run {status, task_id, at}."""
    rid = ship_run(epic)
    out = {}
    for x in (orca("orchestration", "task-list", "--run", rid).get("tasks") or []) if rid else []:
        m = WT_KEY.match(x.get("task_title") or "")
        if m and str(x.get("created_at") or "") >= str((out.get(m.group(1)) or {}).get("at") or ""):
            out[m.group(1)] = {"status": as_cancelled(x).get("status"), "task_id": x.get("id"), "run_id": rid, "at": x.get("created_at")}
    return out


BASE_SRC = {"PR": "기존 PR 의 base", "설정": "설정", "기본": "설정 없음 → main"}


def ship_state(task, launch):
    """The Task, unless a launch started after it: then 'launching', or 'launch_failed' with why."""
    if launch and (not task or str(task.get("at") or "") < launch["at"]):
        return {"status": "launch_failed" if launch["error"] else "launching", "error": launch["error"], "at": launch["at"]}
    return task


def ship_spec(t, qs):
    lines = []
    for r in t["repos"]:
        pr = r.get("pr") or {}
        lines.append(f"- {r['repo']} — 워크트리 `{r['path']}`, 브랜치 `{r['branch']}`, 베이스 `{r['base']}` "
                     f"({BASE_SRC.get(r['base_src'], r['base_src'])}), PR {pr.get('url') or '없음'}"
                     f"{' (' + pr['state'] + ')' if pr.get('state') else ''}, 앞선 커밋 {r.get('ahead', '?')} · "
                     f"뒤처진 커밋 {r.get('behind', '?')}{', 미커밋 ' + str(r['dirty']) if r.get('dirty') else ''}")
    vals = {"key": t["key"], "summary": t.get("summary") or "", "jira_url": f"{JIRA_SITE}/browse/{t['key']}",
            "jira_status": t.get("status") or "", "assignee": t.get("assignee") or "없음", "epic": qs["epic"],
            "project": os.path.join(core_config.VAULT, qs.get("project") or ""), "vault": core_config.VAULT, "step_note": t.get("step") or "없음",
            "notes": ", ".join(t.get("notes") or []) or "없음", "repos": "\n".join(lines)}
    with open(SHIP_PROMPT, encoding="utf-8") as f:
        return re.sub(r"\{\{(\w+)\}\}", lambda m: str(vals.get(m.group(1), m.group(0))), f.read())


def ship_start(t, qs):
    key = t["key"]
    try:
        spec = ship_spec(t, qs)
        rid = ship_run(qs["epic"], create=True)
        res = orca("orchestration", "worker-start", "--run", rid, "--spec", spec, "--task-title", f"{key} 반출",
                   "--worktree", "path:" + os.path.expanduser(qs["ship_place"]), "--agent", SHIP_AGENT,
                   "--model", SHIP_MODEL, timeout=240)
        handle = res.get("agentTerminalHandle") or (res.get("startupTerminal") or {}).get("handle")
        if handle:
            try:
                orca("terminal", "rename", "--terminal", handle, "--title", f"{key} 반출", timeout=15)
            except Exception:
                pass  # the Task row still names the ticket
        with lock:
            ship_launch.pop(key, None)
    except Exception as e:
        with lock:
            ship_launch[key] = {"at": datetime.now(timezone.utc).isoformat(), "error": short(str(e), 300)}
    review_kick.set()
