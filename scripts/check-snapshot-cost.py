#!/usr/bin/env python3
"""Fake-input checks for the caches that keep the /events snapshot build cheap (server/adash/http/snapshot.py).

    python3 scripts/check-snapshot-cost.py

- orca_index: a session's worktree (work_dir) and tasks (orca_tasks) read through it equal the old scan over every
  worker and task, on random Orca snapshots; it follows orca_state when the collector rebinds the lists.
- lite_orca: the same object while orca_state holds the same lists, a new one equal to a fresh build once one is rebound.
- collect_tests: an unchanged progress file keeps its entry (not normalised again), a rewritten one gets a new entry;
  lite_test is reused for the same entry and made again for a new one.
- parts_split reuses the Orca part's bytes while lite_orca hands back the same object.
- save_json writes what json.dump wrote.
Exits 1 if any check fails. Standard library only; touches only a temporary folder.
"""
import json
import os
import random
import sys
import tempfile
import time

TMP = tempfile.mkdtemp(prefix="check-snapshot-cost-")
os.environ["ADASH_DATA"] = TMP  # before adash is imported: the test history must not be the real one
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "server"))
from adash.core.files import save_json  # noqa: E402
from adash.features.orca_runs import lite  # noqa: E402
from adash.features.orca_runs.store import orca_index, orca_state  # noqa: E402
from adash.features.sessions.session import Session  # noqa: E402
import adash.features.tests.tests as tests  # noqa: E402

results = []


def check(name, cond, got=""):
    results.append((name, bool(cond)))
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else f"\n     got: {got}"))


# ---------- the old per-session scans, as they were before orca_index ----------
def old_work_dir(s):
    if s.task_id:
        for w in orca_state.get("workers") or []:
            if w.get("taskId") == s.task_id:
                wt = ((w.get("resource") or {}).get("worktreeId") or "").split("::", 1)[-1]
                if wt:
                    return wt
    return s.launch_cwd


def old_orca_tasks(s):
    ids = [*s.prior_tasks, s.task_id] if s.task_id else []
    cur = s.task_id
    handles = {h for h in [s.own_handle, *s.prior_handles] if h}
    if handles:
        ds = [w for w in orca_state.get("workers") or [] if w.get("agentTerminalHandle") in handles and w.get("taskId")]
        for w in ds:
            if w["taskId"] not in ids:
                ids.append(w["taskId"])
        open_ = [w["taskId"] for w in ds if w.get("dispatchStatus") not in ("completed", "failed", "cancelled")]
        if open_:
            cur = open_[-1]
        elif len(ids) > 1:
            created = {t["id"]: t.get("created_at") or "" for ts in (orca_state.get("tasks") or {}).values() for t in ts}
            cur = max(ids, key=lambda i: (created.get(i) or "", ids.index(i)))
    return cur, ids


rnd = random.Random(7)
HANDLES = [f"term_{i}" for i in range(6)]
TASKS = [f"task_{i}" for i in range(14)]
STATUSES = ["completed", "failed", "cancelled", "dispatched", None]


def random_orca():
    """New lists every time, as orca_loop's orca_state.update does."""
    workers = []
    for _ in range(rnd.randint(0, 30)):
        w = {"taskId": rnd.choice(TASKS + [None]), "agentTerminalHandle": rnd.choice(HANDLES + [None]),
             "dispatchStatus": rnd.choice(STATUSES)}
        if rnd.random() < 0.6:
            w["resource"] = {"worktreeId": rnd.choice(["repo::/wt/a", "/wt/b", "", "repo::"])}
        workers.append(w)
    tasks = {}
    for t in TASKS:
        if rnd.random() < 0.8:
            tasks.setdefault(rnd.choice(["run_1", "run_2"]), []).append(
                {"id": t, "created_at": rnd.choice(["2026-11-01T00:00:00Z", "2026-11-02T00:00:00Z", None])})
    orca_state.update(workers=workers, tasks=tasks)


def random_session():
    s = Session("/tmp/x.jsonl", "claude")
    s.task_id = rnd.choice(TASKS + [None])
    s.prior_tasks = rnd.sample(TASKS, rnd.randint(0, 2)) if s.task_id else []
    s.own_handle = rnd.choice(HANDLES + [None])
    s.prior_handles = rnd.sample(HANDLES, rnd.randint(0, 2))
    s.launch_cwd = "/launch"
    return s


bad = []
for _ in range(400):
    random_orca()
    for _ in range(8):
        s = random_session()
        if (s.work_dir(), s.orca_tasks()) != (old_work_dir(s), old_orca_tasks(s)):
            bad.append((s.task_id, s.own_handle, s.prior_handles, s.work_dir(), old_work_dir(s), s.orca_tasks(), old_orca_tasks(s)))
check("orca_index: work_dir·orca_tasks 가 전체를 훑던 옛 계산과 같음 (무작위 400 스냅숏)", not bad, bad[:2])

orca_state.update(workers=[{"taskId": "t1", "resource": {"worktreeId": "r::/wt/one"}}], tasks={})
first = orca_index()
check("orca_index: 리스트가 그대로면 같은 색인", orca_index() is first)
orca_state.update(workers=[{"taskId": "t1", "resource": {"worktreeId": "r::/wt/two"}}], tasks={})
check("orca_index: 수집기가 리스트를 바꿔 끼우면 새 색인", orca_index()["wt_by_task"] == {"t1": "/wt/two"}, orca_index())

# ---------- lite_orca ----------
o = {"runs": [{"id": "run_1", "objective": "x", "coordinator_handle": "term_0", "created_at": "c", "extra": 1}],
     "tasks": {"run_1": [{"id": "t1", "spec": "배치: wt-a\nPAY-123 고치기", "result": '{"outcome": "ok"}', "status": "completed"}]},
     "workers": [{"taskId": "t1", "runId": "run_1", "dispatchStatus": "completed", "projection": {"provider": {"model": "m"}}}],
     "terminals": [{"handle": "term_0"}], "error": None, "updated": 1.5}
a = lite.lite_orca(o)
check("lite_orca: 같은 값이면 같은 객체(태스크 spec 을 다시 훑지 않음)", lite.lite_orca(dict(o)) is a)
check("lite_orca: 결과가 캐시 없는 계산과 같음", a == lite._lite_orca(o), a)
check("lite_orca: spec 에서 뽑는 값", a["tasks"]["run_1"][0]["place_hint"] == "wt-a" and a["tasks"]["run_1"][0]["ticket_key"] == "PAY-123"
      and a["tasks"]["run_1"][0]["outcome"] == "ok", a["tasks"])
o2 = {**o, "tasks": {"run_1": [{**o["tasks"]["run_1"][0], "status": "failed"}]}, "updated": 2.5}
b = lite.lite_orca(o2)
check("lite_orca: 리스트가 바뀌면 새로 만듦", b is not a and b["tasks"]["run_1"][0]["status"] == "failed", b)
o3 = {**o2, "terminals": [{"handle": "term_9"}]}  # terminals/close.py rebinds only the terminals
check("lite_orca: terminals 만 바꿔 끼워도 새로 만듦", lite.lite_orca(o3)["terminals"] == [{"handle": "term_9"}])

# ---------- parts_split: the Orca part's bytes ----------
from adash.http import snapshot  # noqa: E402

enc_calls = []


def encode(v):
    enc_calls.append(v)
    return json.dumps(v, ensure_ascii=False, default=str).encode()


lo = lite.lite_orca(o3)
p1 = snapshot.parts_split({"orca": lo, "flow": {"x": 1}}, encode)
n1 = len(enc_calls)
p2 = snapshot.parts_split({"orca": lo, "flow": {"x": 1}}, encode)
check("parts_split: 같은 lite_orca 객체면 Orca 바이트를 다시 인코딩하지 않음", p2["orca"] == p1["orca"] and len(enc_calls) == n1 + 1
      and json.loads(p2["orca"][1]) == json.loads(json.dumps(lo)), len(enc_calls) - n1)
p3 = snapshot.parts_split({"orca": {**lo, "error": "x"}, "flow": {"x": 1}}, encode)
check("parts_split: 다른 객체면 새로 인코딩", json.loads(p3["orca"][1])["error"] == "x")

# ---------- collect_tests / lite_test ----------
tests.TEST_DIR = os.path.join(TMP, "progress")
os.makedirs(tests.TEST_DIR)
tests.RUN_TC_PROGRESS = []


def write_run(name, phase, cases, at):
    p = os.path.join(tests.TEST_DIR, name + ".json")
    with open(p, "w") as f:
        json.dump({"label": name, "kind": "rspec", "phase": phase, "judged": True, "cases": cases,
                   "started_at": "2026-11-12T00:00:00Z", "updated_at": "2026-11-12T00:01:00Z"}, f)
    os.utime(p, (at, at))


now = time.time()
write_run("run-a", "done", [{"title": "TC-A-1: 하나", "status": "passed"},
                            {"id": "c2", "title": "둘", "status": "failed"}], now - 60)
write_run("run-b", "running", [{"id": "c1", "title": "x", "status": "running"}], now - 30)
tests.collect_tests()
first = {f["key"]: f for f in tests.test_progress["files"]}
calls = []
real_norm = tests.norm_cases
tests.norm_cases = lambda raw: calls.append(raw) or real_norm(raw)
tests.collect_tests()
again = {f["key"]: f for f in tests.test_progress["files"]}
check("collect_tests: 그대로인 파일은 같은 항목을 다시 씀(케이스를 다시 정리하지 않음)",
      not calls and all(again[k] is first[k] for k in first), (calls, list(again)))
check("collect_tests: 케이스 정리 결과는 그대로", again["run-a"]["cases"][0] == {"id": "TC-A-1", "title": "하나", "status": "passed",
                                                                     "msg": None, "ms": None}, again["run-a"]["cases"])
write_run("run-b", "done", [{"id": "c1", "title": "x", "status": "passed"}], now - 5)
tests.collect_tests()
third = {f["key"]: f for f in tests.test_progress["files"]}
check("collect_tests: 다시 쓰인 파일만 새 항목", third["run-b"] is not first["run-b"] and third["run-b"]["phase"] == "done"
      and third["run-a"] is first["run-a"] and len(calls) == 1, (third["run-b"], len(calls)))
tests.norm_cases = real_norm

la = tests.lite_test(third["run-a"])
check("lite_test: 끝난 실행은 케이스 대신 수", "cases" not in la and la["case_counts"] == {"n": 2, "bad": 1, "ok": 1}, la)
check("lite_test: 같은 항목이면 같은 결과 객체", tests.lite_test(third["run-a"]) is la)
fresh = {**third["run-a"], "cases": [{"id": "c1", "status": "passed"}]}
check("lite_test: 새 항목이면 새로 계산", tests.lite_test(fresh)["case_counts"] == {"n": 1, "bad": 0, "ok": 1})
os.remove(os.path.join(tests.TEST_DIR, "run-a.json"))
tests.collect_tests()
check("collect_tests: 사라진 실행의 lite_test 캐시를 지움", "run-a" not in tests.lite_tests, list(tests.lite_tests))

# ---------- save_json ----------
data = {"한글": [1, 2.5, None, True], "nested": {"k": "v\n\"q\""}}
p = os.path.join(TMP, "x.json")
save_json(p, data)
with open(p) as f:
    written = f.read()
check("save_json: json.dump 과 같은 내용", written == json.dumps(data) and json.loads(written) == data, written)

failed = [n for n, ok in results if not ok]
print(f"\n{len(results) - len(failed)}/{len(results)} passed")
sys.exit(1 if failed else 0)
