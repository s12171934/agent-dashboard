#!/usr/bin/env python3
"""Fake-input checks for the server's flow rules (server/adash/features/flow) (흐름 이탈 판정): each rule once where it fires and once where it must not.

    python3 scripts/check-flow.py

Exits 1 if any check fails. Standard library only; never writes prefs.json.
"""
import os
import sys
import tempfile
import time
from datetime import datetime, timezone

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "server"))
from adash.core.prefs import prefs  # noqa: E402
from adash.features.flow import contracts, rules  # noqa: E402
from adash.features.review.qa import QA_STAGES  # noqa: E402

prefs.clear()
prefs["idle"] = {}
rules.save_prefs = lambda: None  # never touch a prefs.json from a test
REAL_CONTRACT = contracts.QA_CONTRACT
# The rules read the QA stage contract's two tables; a copy of their shape keeps the checks independent of the skill.
FIXTURE = """
| 경로 | 쓰는 쪽 | 내용 |
| --- | --- | --- |
| `tickets/<KEY>.json` | 드라이버 | 기록 |
| `handoffs/<KEY>-<이름>.md` | 코디네이터 | 인계 |
| `ready/<KEY>.md` | 코디네이터 | 검토 완료 |
| `approved/<KEY>.md` | 사용자(대시보드) | 반출 승인 |
| `delivered/<KEY>.md` | 코디네이터 | PR 주소 |
| `cleaned/<KEY>` | 드라이버 | 정리 |

| 순서 | 단계 | 조건 |
| --- | --- | --- |
| 9 | `cleaned` 정리됨 | `cleaned/<KEY>` |
| 8 | `delivered` 반출됨 | `delivered/<KEY>.md` |
| 7 | `approved` 반출 승인 | `approved/<KEY>.md` |
| 6 | `committed` 검토 완료 | `ready/<KEY>.md` |
| 5 | `reviewing` 검토 중 | `handoffs/` 수 ≤ `done/` 수 |
| 4 | `implementing` 구현 중 | `handoffs/` 에 이 티켓 파일 |
| 3 | `analysis` 분석 중 | `tickets/<KEY>.json` 의 `coordinator` |
| 2 | `worktree` 워크트리 준비 | `tickets/<KEY>.json` 에 `worktree` 만 |
| 1 | `selected` 선별됨 | 그 밖 |
"""
_tmp = tempfile.NamedTemporaryFile("w", suffix=".md", delete=False, encoding="utf-8")
_tmp.write(FIXTURE)
_tmp.close()
contracts.QA_CONTRACT = _tmp.name

NOW = 1_800_000_000.0
iso = lambda t: datetime.fromtimestamp(t, timezone.utc).isoformat().replace("+00:00", "Z")
orca_ts = lambda t: datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%d %H:%M:%S")  # Orca's form (UTC, no zone)
M = 60
results = []


def check(name, cond, got):
    results.append((name, bool(cond)))
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else f"\n     got: {got}"))


def sess(path, state="run", **kw):
    return {"path": path, "id": path, "parent": None, "state": state, "state_reason": kw.pop("reason", ""), "task_id": kw.get("task_id"),
            "task_ids": [kw["task_id"]] if kw.get("task_id") else [], "started": iso(kw.pop("started", NOW - 60 * M)),
            "last_ts": iso(kw.pop("last", NOW - M)), "model": kw.pop("model", "opus"), "last_action": None, "plan": kw.pop("plan", None),
            "own_handle": kw.pop("own_handle", None), "orca_focus": None, **kw}


def task(tid, title, status="completed", created=0, done=None, rid="run_a"):
    return {"id": tid, "run_id": rid, "task_title": title, "display_name": title, "status": status,
            "created_at": orca_ts(created) if created else None, "completed_at": orca_ts(done) if done else None, "deps": "[]"}


def items(res, rule=None, **match):
    return [x for x in res["items"] if (rule is None or x["rule"] == rule) and all(x.get(k) == v for k, v in match.items())]


# ---------- 정체 ----------
# 정체 is 응답 없음 only: a long-running worker or one waiting for input is not judged
S = [sess("w1", "run", task_id="tw1", started=NOW - 300 * M), sess("w3", "wait", task_id="tw3", started=NOW - 40 * M),
     sess("z", "stalled", reason="턴이 열린 채 기록 없음", last=NOW - 20 * M)]
T = [task("tw1", "S1#4 구현", status="dispatched", created=NOW - 300 * M), task("tw3", "S1#6 구현", status="dispatched", created=NOW - 40 * M)]
r = rules.flow_check(S, {"run_a": T}, {}, [], now=NOW)
check("정체: 오래 실행 중인 워커는 걸리지 않음(기대 시간 판정 없음)", not items(r, "stall", session="w1"), r["items"])
check("정체: 입력 대기 워커는 판정하지 않음", not items(r, "stall", session="w3"), r["items"])
check("정체: 응답 없음(stalled) 세션은 bad", items(r, "stall", session="z", severity="bad"), r["items"])

# ---------- 계획 미이행 ----------
plan = lambda *st: {"ts": iso(NOW - 50 * M), "steps": [{"t": f"단계 {i + 1}", "st": x, "ts0": None, "ts1": None} for i, x in enumerate(st)]}
S2 = [sess("a", "idle", last=NOW - 7 * 60 * M), sess("b", "idle"), sess("c", "run"), sess("d", "done"),
      sess("e", "idle", own_handle="term_e", orca_focus="term_e", last=NOW - 90 * M),  # coordinator waiting in its open Orca terminal
      sess("f", "idle", own_handle="term_f", last=NOW - 40 * M),                       # its Orca terminal is closed
      sess("g", "idle", last=NOW - 40 * M),                                            # no Orca terminal, quiet only 40 min
      sess("h", "idle", last=NOW - 7 * 60 * M, decision={"id": "q"}),                  # waiting on a pending question
      sess("i", "idle", manual_idle=True, own_handle="term_i", orca_focus="term_i")]   # the user marked it 유휴
left = plan("done", "run", "todo")
r = rules.flow_check(S2, {}, {"a": left, "b": plan("done", "done"), "c": plan("done", "run"), "d": plan("done", "skip", "todo"),
                              "e": left, "f": left, "g": left, "h": left, "i": left}, [], now=NOW)
check("계획 미이행: Orca 밖 유휴 세션이 6시간 넘게 기록 없음 → warn", items(r, "plan", session="a"), r["items"])
check("계획 미이행: Orca 터미널이 열린 채 기다리는 코디네이터는 안 걸림", not items(r, "plan", session="e"), r["items"])
check("계획 미이행: Orca 터미널이 닫힌 유휴 세션 → warn", items(r, "plan", session="f"), r["items"])
ru = rules.flow_check(S2[5:6], {}, {"f": left}, [], now=NOW, terms_known=False)
check("계획 미이행: Orca 터미널 목록을 아직 못 읽었으면 닫힘으로 보지 않음", not items(ru, "plan", session="f"), ru["items"])
check("계획 미이행: Orca 밖 유휴 세션이 6시간 안쪽이면 안 걸림", not items(r, "plan", session="g"), r["items"])
check("계획 미이행: 답을 기다리는 질문이 있으면 안 걸림", not items(r, "plan", session="h"), r["items"])
check("계획 미이행: 수동으로 유휴 처리한 세션 → warn", items(r, "plan", session="i"), r["items"])
check("계획 미이행: 모두 완료면 안 걸림", not items(r, "plan", session="b"), r["items"])
check("계획 미이행: 실행 중 세션은 안 걸림", not items(r, "plan", session="c"), r["items"])
check("계획 미이행: 완료(done) 워커에 남은 단계 → warn", items(r, "plan", session="d"), r["items"])

# ---------- 필수 단계 누락 ----------
def box(cb, codex_status, codex_done=None, with_codex=True):
    b = NOW - 100 * M
    ts = [task(f"{cb}i", f"S2#{cb} 구현", created=b, done=b + 20 * M, rid="run_b"),
          task(f"{cb}rc", f"S2#{cb} 리뷰 claude", created=b + 21 * M, done=b + 27 * M, rid="run_b"),
          task(f"{cb}v", f"S2#{cb} 판정", created=b + 22 * M, done=b + 30 * M, rid="run_b")]
    if with_codex:
        ts.append(task(f"{cb}rx", f"S2#{cb} 리뷰 codex", status=codex_status, created=b + 21 * M, done=codex_done, rid="run_b"))
    return ts
T3 = box(1, "dispatched") + box(2, "cancelled") + box(3, "completed", NOW - 100 * M + 25 * M) + box(4, "completed", NOW - 100 * M + 50 * M) + box(5, None, with_codex=False)
r = rules.flow_check([], {"run_b": T3}, {}, [], now=NOW)
check("필수 단계 누락: 리뷰 codex 결과 없이 판정 → bad", items(r, "missing", task_id="1v", severity="bad"), r["items"])
check("필수 단계 누락: 리뷰 codex 취소면 안 걸림", not items(r, "missing", task_id="2v"), r["items"])
check("필수 단계 누락: 판정 전에 리뷰 완료면 안 걸림", not items(r, "missing", task_id="3v"), r["items"])
check("필수 단계 누락: 리뷰가 판정 뒤에 끝났으면 걸림", items(r, "missing", task_id="4v"), r["items"])
check("필수 단계 누락: 그 리뷰어가 아예 없으면 판정하지 않음", not items(r, "missing", task_id="5v"), r["items"])

# ---------- 반복 ----------
b = NOW - 300 * M
T4 = [task(f"r{i}", "S3#1 구현", created=b + i * 30 * M, done=b + i * 30 * M + 10 * M, rid="run_c") for i in range(3)] + \
     [task(f"q{i}", "S3#2 구현", created=b + i * 30 * M, done=b + i * 30 * M + 10 * M, rid="run_c") for i in range(2)]
r = rules.flow_check([], {"run_c": T4}, {}, [], now=NOW)
check("반복: 같은 체크박스 구현 3라운드 → warn", items(r, "repeat", checkbox="S3#1"), r["items"])
check("반복: 2라운드는 안 걸림", not items(r, "repeat", checkbox="S3#2"), r["items"])

# ---------- 순서 위반 (QA 계약) ----------
def ticket(key, stage, at, driver=True, repos=(), status=None):
    return {"key": key, "status": status, "cat": None, "repos": list(repos),
            "qa": {"stage": stage, "driver": driver, "ignored": False, "at": at, "handles": ["term_x"]}}
A = {"committed": iso(NOW - 50 * M), "approved": iso(NOW - 40 * M), "delivered": iso(NOW - 30 * M)}
pr = lambda st: {"repo": "web", "pr": {"number": 7, "state": st}}
sets = [{"tickets": [
    ticket("Q-1", "delivered", {k: v for k, v in A.items() if k != "approved"}),
    ticket("Q-2", "delivered", A),
    ticket("Q-3", "delivered", {k: v for k, v in A.items() if k != "approved"}, driver=False),
    ticket("Q-4", "approved", {"committed": iso(NOW - 10 * M), "approved": iso(NOW - 40 * M)}),
    ticket("Q-5", "cleaned", {**A, "cleaned": iso(NOW - 5 * M)}, repos=[pr("OPEN")]),
    ticket("Q-6", "cleaned", {**A, "cleaned": iso(NOW - 5 * M)}),
    ticket("Q-7", "delivered", A, repos=[pr("OPEN")], status="개발 완료"),
    ticket("Q-8", "delivered", A, repos=[pr("MERGED")], status="개발 완료"),
    ticket("Q-9", "delivered", A, repos=[pr("OPEN")], status=None),
    ticket("Q-10", "cleaned", {"selected": "2026-10-22 12:20:26", "cleaned": iso(NOW - 5 * M)}),
]}]
S5 = [sess("coord", "run", own_handle="term_x")]
r = rules.flow_check(S5, {}, {}, sets, now=NOW)
contract = contracts.qa_contract()
check("계약 읽기: 상태 계약의 두 표에서 9단계와 사용자 관문(반출 승인)을 읽음",
      contract["source"] and len(contract["stages"]) == 9 and [s["key"] for s in contract["stages"] if s["user"]] == ["approved"], contract)
if os.path.exists(REAL_CONTRACT):  # the skill's own contract, when this machine has it
    real = contracts.parse_qa_contract(open(REAL_CONTRACT, encoding="utf-8").read()) or []
    check("계약 읽기: 이 기기의 qa-ticket-driver state-contract.md 도 같은 모양", [s["key"] for s in real] == QA_STAGES and [s["key"] for s in real if s["user"]] == ["approved"], real)
check("순서 위반: 승인 없이 반출 → bad, 코디네이터 세션에 연결", items(r, "order", ticket="Q-1", severity="bad", session="coord"), r["items"])
check("순서 위반: 승인 기록 있으면 안 걸림", not items(r, "order", ticket="Q-2"), r["items"])
check("순서 위반: 드라이버가 아닌 옛 워처 티켓은 관문 판정 안 함", not items(r, "order", ticket="Q-3"), r["items"])
check("순서 위반: 신호 파일 시각(mtime)의 앞뒤는 판정 안 함 — 재기록과 구분 불가", not items(r, "order", ticket="Q-4"), r["items"])
check("순서 위반: 반출 없이 정리된 티켓(PR 없음)은 승인 관문 판정 안 함", not items(r, "order", ticket="Q-10"), r["items"])
check("순서 위반: 열린 PR 이 있는데 정리 → bad", any("정리" in x["reason"] for x in items(r, "order", ticket="Q-5")), r["items"])
check("순서 위반: PR 상태를 모르면(저장소 정보 없음) 정리 판정 안 함", not items(r, "order", ticket="Q-6"), r["items"])
check("순서 위반: 머지 전 Jira 개발 완료 → warn", items(r, "order", ticket="Q-7"), r["items"])
check("순서 위반: PR 머지 뒤 Jira 개발 완료는 안 걸림", not items(r, "order", ticket="Q-8"), r["items"])
check("순서 위반: Jira 상태가 없으면 판정 안 함", not items(r, "order", ticket="Q-9"), r["items"])

# ---------- 정상으로 표시 ----------
fid = items(r, "order", ticket="Q-1")[0]["id"]
prefs["flow_ok"] = {fid: {"at": iso(time.time())}}
r2 = rules.flow_check(S5, {}, {}, sets, now=NOW)
check("정상으로 표시: 기각한 이탈은 다시 뜨지 않고 ok 로 셈", not [x for x in r2["items"] if x["id"] == fid] and r2["ok"] == 1, r2)
rules.flow_mark(fid, False)
r3 = rules.flow_check(S5, {}, {}, sets, now=NOW)
check("정상으로 표시 되돌리기: 다시 뜸", [x for x in r3["items"] if x["id"] == fid], r3["ok"])
check("이탈 항목 모양: {rule, severity, reason, evidence}", all({"rule", "severity", "reason", "evidence"} <= set(x) for x in r["items"]), r["items"][:1])

os.unlink(_tmp.name)
print(f"\n{sum(ok for _, ok in results)}/{len(results)} 통과")
sys.exit(0 if all(ok for _, ok in results) else 1)
