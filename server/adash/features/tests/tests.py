"""Long test runs (rspec, E2E, builds) for the tests area, and their archived results."""

import json
import os
import re
import time
from datetime import datetime, timezone

from adash.core.config import HERE
from adash.core.files import e2e_cache, read_json_cached, save_json
from adash.core.prefs import prefs
from adash.core.state import bump, lock
from adash.core.util import short
from adash.features.plans.store import ext_plans


# Long test runs (rspec, E2E, jest, builds) report progress for the 「테스트」 area. Two sources:
# - TEST_DIR: one JSON file per run that the worker rewrites atomically (write a temp file, then rename) —
#   {"label", "kind", "phase": building|running|done|failed, "total", "done", "passed", "failed", "pending",
#    "started_at", "updated_at", "eta_s", "failures": [{"id", "msg"}], "log", "owner", "terminal", "session_id"};
#   terminal (ORCA_TERMINAL_HANDLE) / session_id (CLAUDE_CODE_SESSION_ID) tie it to a session card, as run-tc's rows do.
#   A file untouched for TEST_KEEP_S drops out of view (the file itself is left alone).
#   Optional "cases": [{"id", "title", "status": passed|failed|skipped|..., "msg", "ms"}] — every case of the run with what it
#   checks, shown as a toggle under the run.
# - run-tc progress files ({"active", "latest", "history"}): RUN_TC_PROGRESS plus every plan ticket's e2e_progress.
#   A finished run's cases are in e2e-runs/<run>.tests.json beside the progress file ([{"tc", "title", "status", ...}]).
TEST_DIR = "/private/tmp/agent-test-progress"
TEST_KEEP_S = 24 * 3600
TEST_FIELDS = ("label", "kind", "phase", "detail", "total", "done", "passed", "failed", "pending", "started_at",
               "updated_at", "eta_s", "log", "owner", "terminal", "session_id")
RUN_TC_PROGRESS = prefs.get("run_tc_progress") or []  # run-tc progress files, listed in prefs.json
test_progress = {"files": [], "run_tc": {}, "history_n": 0, "history_at": None}
# Finished runs outlive their sources (a progress file drops out after TEST_KEEP_S, /private/tmp empties on reboot):
# each one is copied here once, keyed by source + run, and served by /api/tests for the 「테스트」 tab.
TEST_HISTORY_PATH = os.path.join(HERE, "test-history.json")
TEST_HISTORY_DAYS, TEST_HISTORY_MAX = 30, 2000
CASES_MAX = 500
TC_RE = re.compile(r"^\s*(TC-[\w.-]+)\s*[:·—-]?\s*")
try:
    with open(TEST_HISTORY_PATH) as _f:
        test_history = json.load(_f)
    if not isinstance(test_history, dict):
        test_history = {}
except (OSError, ValueError):
    test_history = {}


def finished_key(r):
    """Sort key for a kept run: its finish time as epoch seconds (sources mix "Z" and "+09:00"), 0 when unknown."""
    try:
        return datetime.fromisoformat(str(r.get("finished_at")).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return 0


def norm_cases(raw):
    """Cases as {id, title, status, msg, ms}: the case code (run-tc's "tc", else a leading "TC-…" of the title) apart from
    what the case checks."""
    out = []
    for c in (raw if isinstance(raw, list) else [])[:CASES_MAX]:
        if not isinstance(c, dict):
            continue
        title = str(c.get("title") or "")
        code = c.get("id") or c.get("tc")
        m = TC_RE.match(title)
        if m and (not code or m.group(1) == code):
            code, title = m.group(1), title[m.end():]
        out.append({"id": short(str(code or ""), 80), "title": short(title, 200), "status": c.get("status"),
                    "msg": short(str(c.get("msg") or c.get("error") or ""), 300) or None,
                    "ms": c.get("ms", c.get("duration_ms"))})
    return out


cases_cache = {}  # tests.json path -> (mtime, cases); a finished run's file is written once


def run_tc_cases(progress, run):
    p = os.path.join(os.path.dirname(progress), "e2e-runs", f"{run}.tests.json")
    try:
        mtime = os.path.getmtime(p)
    except OSError:
        return []
    hit = cases_cache.get(p)
    if not hit or hit[0] != mtime:
        try:
            with open(p) as f:
                hit = cases_cache[p] = (mtime, norm_cases(json.load(f)))
        except (OSError, ValueError):
            return hit[1] if hit else []
    return hit[1]


def archive_tests(files, run_tc):
    """Copy finished runs into test_history; True when something was added or pruned."""
    recs = {}
    for f in files:
        if f.get("phase") in ("done", "failed"):
            fin = f.get("updated_at") or datetime.fromtimestamp(f["mtime"], timezone.utc).isoformat()
            recs[f"file:{f['key']}:{f.get('started_at') or fin}"] = {
                **{k: f.get(k) for k in TEST_FIELDS}, "src": "file", "key": f["key"], "finished_at": fin,
                "failures": f["failures"], "cases": f["cases"]}
    for path, d in run_tc.items():
        latest = d.get("latest") if isinstance(d.get("latest"), dict) else {}
        for h in d.get("history") or []:
            if not isinstance(h, dict) or not h.get("run"):
                continue
            ids = h.get("ids") if isinstance(h.get("ids"), list) else []
            bad = (h.get("failed") or 0) > 0 or bool(re.search("실패|중단", str(h.get("outcome") or "")))
            recs["run-tc:" + str(h["run"])] = {
                "src": "run-tc", "key": h["run"], "kind": "e2e", "label": "E2E " + ", ".join(map(str, ids)),
                "owner": h.get("caller"), "phase": "failed" if bad else "done", "detail": h.get("outcome"),
                "passed": h.get("passed"), "failed": h.get("failed"), "started_at": h.get("started_at"),
                "finished_at": h.get("finished_at"), "updated_at": h.get("finished_at"), "log": h.get("log"),
                "cases": run_tc_cases(path, h["run"]),
                "failures": [{"id": tc, "msg": short(str(l.get("error") or ""), 300)} for tc, l in latest.items()
                             if isinstance(l, dict) and l.get("run") == h["run"] and l.get("status") == "failed"][:20]}
    changed = False
    for k, r in recs.items():
        old = test_history.get(k)
        if old is None or {**old, "archived_at": None} != {**r, "archived_at": None}:
            test_history[k] = {**r, "archived_at": (old or {}).get("archived_at") or time.time()}
            changed = True
    cutoff = time.time() - TEST_HISTORY_DAYS * 86400
    keep = sorted((k for k, r in test_history.items() if r.get("archived_at", 0) >= cutoff),
                  key=lambda k: finished_key(test_history[k]), reverse=True)[:TEST_HISTORY_MAX]
    if len(keep) != len(test_history):
        for k in set(test_history) - set(keep):
            del test_history[k]
        changed = True
    return changed


def collect_tests():
    now, files = time.time(), []
    try:
        names = sorted(n for n in os.listdir(TEST_DIR) if n.endswith(".json"))
    except OSError:
        names = []
    for n in names:
        p = os.path.join(TEST_DIR, n)
        d = read_json_cached(p)
        mtime = e2e_cache[p][0]
        if not d or not mtime or now - mtime > TEST_KEEP_S:
            continue
        if not d.get("phase") and d.get("status"):  # a hand-written file: {"status", "exit", "summary", "task"}
            st = str(d["status"])
            d = {**d, "phase": "failed" if st == "failed" or (st == "done" and d.get("exit")) else st,
                 "detail": d.get("detail") or d.get("summary"), "label": d.get("task") or d.get("label"),
                 "updated_at": d.get("updated_at") or d.get("finished_at")}
        fails = [{"id": short(str(f.get("id") or ""), 200), "msg": short(str(f.get("msg") or ""), 300)}
                 for f in (d.get("failures") or [])[:20] if isinstance(f, dict)] if isinstance(d.get("failures"), list) else []
        files.append({**{k: d.get(k) for k in TEST_FIELDS}, "key": n[:-5], "mtime": mtime, "failures": fails,
                      "cases": norm_cases(d.get("cases"))})
    for p in [p for p in e2e_cache if p.startswith(TEST_DIR + "/") and os.path.basename(p) not in names]:
        e2e_cache.pop(p, None)  # a removed run file
    paths = set(RUN_TC_PROGRESS) | {t["e2e_progress"] for plan in list(ext_plans.values())
                                    for t in plan["tickets"] if isinstance(t.get("e2e_progress"), str)}
    run_tc = {p: d for p in sorted(paths) if (d := read_json_cached(p))}
    with lock:
        archived = archive_tests(files, run_tc)
        if archived:
            save_json(TEST_HISTORY_PATH, test_history)
            test_progress.update(history_n=len(test_history), history_at=time.time())
        if archived or files != test_progress["files"] or run_tc != test_progress["run_tc"]:
            test_progress.update(files=files, run_tc=run_tc)
            bump()
