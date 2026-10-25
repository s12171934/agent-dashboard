"""The external plan collector: reads the plan files, their history and E2E progress."""

import glob
import json
import os
import re
import time

from adash.core.config import HERE
from adash.core.files import read_json_cached, save_json
from adash.core.state import bump, lock, loop_failed, loop_ok
from adash.core.util import short
from adash.features.plans.box_notes import attach_box_notes
from adash.features.plans.store import EXTERNAL_PLANS, ext_plans
from adash.features.tests.tests import collect_tests


SUPERSEDED_RUN = re.compile(r"-(run_[0-9a-f]+)\.superseded\.json$")
# path -> {"coordinator_session", "driver_history", "owner"}, persisted across restarts (owner: see plan_owners)
PLAN_HISTORY_PATH = os.path.join(HERE, "plan-history.json")
try:
    with open(PLAN_HISTORY_PATH) as _f:
        plan_history = json.load(_f)
except (OSError, ValueError):
    plan_history = {}


def ext_plan_loop():
    """Reload each external plan file when its mtime changes; a missing or broken file becomes an error entry."""
    seen = {}
    while True:
        clean = True
        for path in EXTERNAL_PLANS:
            try:
                mtime = os.path.getmtime(path)
            except OSError:
                mtime = None
            if path in seen and seen[path] == mtime:
                continue
            seen[path] = mtime  # a plan that fails to load is retried when the file changes, not every 2 s
            try:
                entry = read_ext_plan(path, mtime)
            except Exception as e:  # e.g. a ticket that is not an object
                loop_failed("ext_plan", e, where=os.path.basename(path))
                clean = False
                entry = {"path": path, "project": None, "generated_at": None, "tickets": [], "run_ids": [],
                         "driver_history": [], "error": "계획 파일을 해석하지 못함: " + short(repr(e), 200)}
            with lock:
                ext_plans[path] = entry
                bump()
        try:
            attach_e2e_progress()
        except Exception as e:
            loop_failed("ext_plan", e, where="e2e progress")
            clean = False
        try:
            attach_box_notes()
        except Exception as e:
            loop_failed("ext_plan", e, where="box notes")
            clean = False
        try:
            collect_tests()
        except Exception as e:
            loop_failed("ext_plan", e, where="test progress")
            clean = False
        if clean:
            loop_ok("ext_plan")
        time.sleep(2)


def read_ext_plan(path, mtime):
    entry = {"path": path, "project": None, "generated_at": None, "tickets": [], "extra_worktrees": [], "error": None}
    if mtime is None:
        entry["error"] = "파일 없음"
    else:
        try:
            with open(path) as f:
                data = json.load(f)
            entry.update({k: data.get(k) for k in ("project", "driver", "generated_at", "design_root", "design_commit",
                                                   "coordinator_session", "coordinator_terminal", "scheduler_terminal")},
                         tickets=data.get("tickets") or [], extra_worktrees=data.get("extra_worktrees") or [])
        except (OSError, ValueError) as e:
            entry["error"] = short(e, 200)
        # A re-driven ticket gets a new driver terminal and the plan forgets the old one; its earlier
        # Runs are still listed beside the plan (run-<ticket>[-<run>.superseded].json), so keep them too.
        # A superseded file names its Run, and that name wins over a body overwritten by a later restore.
        entry["run_ids"] = []
        for rf in sorted(glob.glob(os.path.join(os.path.dirname(path), "run-*.json"))):
            named = SUPERSEDED_RUN.search(os.path.basename(rf))
            if named:
                entry["run_ids"].append(named.group(1))
            try:
                with open(rf) as f:
                    rid = json.load(f).get("run_id")
            except (OSError, ValueError, AttributeError):
                continue
            if rid:
                entry["run_ids"].append(rid)
        entry["run_ids"] = list(dict.fromkeys(entry["run_ids"]))
        # Driver terminals the plan has forgotten are kept on disk, so a dashboard restart keeps them too.
        prev = ext_plans.get(path) or plan_history.get(path) or {}
        hist = (prev.get("driver_history") or []) if prev.get("coordinator_session") == entry.get("coordinator_session") else []
        entry["driver_history"] = list(dict.fromkeys(hist + [t.get("driver_terminal_handle") for t in entry["tickets"]
                                                             if t.get("driver_terminal_handle")]))
        if not entry["error"] and entry["driver_history"] != (plan_history.get(path) or {}).get("driver_history"):
            plan_history[path] = {**(plan_history.get(path) or {}), "coordinator_session": entry.get("coordinator_session"),
                                  "driver_history": entry["driver_history"]}
            save_json(PLAN_HISTORY_PATH, plan_history)
    return entry


def attach_e2e_progress():
    for plan in list(ext_plans.values()):
        # Drivers still on old code rewrite plan.json without tc_plan/e2e_progress, so the new driver also writes them to
        # e2e-tc-plan.json beside it ({package: {tc_plan, e2e_progress}}); plan.json values win when present.
        side = read_json_cached(os.path.join(os.path.dirname(plan["path"]), "e2e-tc-plan.json"))
        for t in plan.get("tickets") or []:
            extra = side.get(t.get("package")) if isinstance(side.get(t.get("package")), dict) else {}
            for key in ("tc_plan", "e2e_progress"):
                if not t.get(key) and extra.get(key):
                    with lock:
                        t[key] = extra[key]
                        bump()
            if not t.get("e2e_progress"):
                continue
            # run-tc replaces the progress file atomically, so a failed read is transient: the last state is kept
            data = read_json_cached(t["e2e_progress"])
            if t.get("e2e") is not data:
                with lock:
                    t["e2e"] = data
                    bump()
