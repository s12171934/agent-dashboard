#!/usr/bin/env python3
"""Fake-input checks for 「구현 ① 티켓 진행」 (server/adash/features/impl_progress): 1-map.txt 의 두 order 형식,
장부 표의 가변 열, 「완료」 마감 칸 제외, 티켓 상태와 현재 체크박스.

    python3 scripts/check-impl-progress.py

Exits 1 if any check fails. Standard library only; reads nothing outside the fixtures here.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "server"))
from adash.features.impl_progress.progress import parse_ledger, parse_map, summarize  # noqa: E402

fails = []


def check(name, got, want):
    if got != want:
        fails.append(f"{name}: got {got!r}, want {want!r}")


MAP_LAYERED = """decision: ok
order:
  0 PSD-1117 설계 (별도 실행, plang_projects PR #112)
  1 PSD-1118 R1 plang_rails develop PSD-1118-x | PSD-1121 F1 plang-front-common main PSD-1121-y
  2 PSD-1119 R2 plang_rails base=R1 PSD-1119-z
  5 PSD-1127 V (별도 실행, 저장소 없음)
chain-deps: R1→R2 계약
"""
m = parse_map(MAP_LAYERED)
check("layered keys", [t["key"] for t in m], ["PSD-1117", "PSD-1118", "PSD-1121", "PSD-1119", "PSD-1127"])
check("layered layers", [t["layer"] for t in m], [0, 1, 1, 2, 5])
check("layered repo", [t["repo"] for t in m], [None, "plang_rails", "plang-front-common", "plang_rails", None])
check("layered labels", [t["label"] for t in m], ["설계", "R1", "F1", "R2", "V"])
check("layered separate", [t["separate"] for t in m], [True, False, False, False, True])

MAP_LINES = """mismatches: none
order (§12 층 순서 그대로):
1 PSD-1100 R1 | plang_rails | origin/develop | PSD-1100-a | wt PSD-1100
11 PSD-1110 X1 | plang-test-automation (+ 대시보드 fc 핀) | origin/main | PSD-1110-b | wt PSD-1110
separate run (이 실행에서 디스패치하지 않음): PSD-1099 설계(plang_projects 슈퍼프로젝트, 설계 PR #111) · PSD-1112 V1(코드 없음)
stack-only edges: R2→R3
"""
m = parse_map(MAP_LINES)
check("lines keys", [t["key"] for t in m], ["PSD-1100", "PSD-1110", "PSD-1099", "PSD-1112"])
check("lines repo", [t["repo"] for t in m], ["plang_rails", "plang-test-automation", None, None])
check("lines labels", [t["label"] for t in m], ["R1", "X1", "설계", "V1"])
check("lines separate", [t["separate"] for t in m], [False, False, True, True])

LEDGER = """# PSD-1 장부

## 체크박스

| 번호 | 문구 | 종류 | 상태 | 커밋 해시 | 메모 |
| --- | --- | --- | --- | --- | --- |
| cb1 | test: a | 구현 | done | abc | x |
| cb2 | feat: b | 구현 | running |  |  |
| cb3 | 확인: c | verify | pending |  |  |
| cb4 | 완료 | verify | 디스패치 대상 아님 |  | 마감 |

## 체크박스 실행

- 현재 체크박스: cb2
"""
items, cur = parse_ledger(LEDGER)
check("ledger cbs", [x["cb"] for x in items], ["cb1", "cb2", "cb3", "cb4"])
check("ledger status", [x["status"] for x in items], ["done", "running", "pending", "pending"])
check("ledger kind", [x["kind"] for x in items], ["구현", "구현", "verify", "verify"])
check("ledger closing", [x["closing"] for x in items], [False, False, False, True])
check("ledger current", cur, "cb2")
s = summarize(items, cur)
check("sum done/total", (s["done"], s["total"], s["state"], s["current"]["cb"]), (1, 3, "running", "cb2"))

# 4-column table, current line without the bullet, every work item done → 완료 although 「완료」 is pending
L2 = """## 체크박스
| 번호 | 문구 | 종류 | 상태 |
| --- | --- | --- | --- |
| cb1 | a | 구현 | done |
| cb2 | 완료 | verify | pending |
| cb3 | fix: 통합 | 통합 수정 | done |
## 실행
현재 체크박스: cb3
"""
items, cur = parse_ledger(L2)
s = summarize(items, cur)
check("closing excluded", (s["done"], s["total"], s["state"]), (2, 2, "done"))

# a blocked closing checkbox makes the ticket 막힘; a stale current (done) moves to the running/blocked one
L3 = L2.replace("| cb2 | 완료 | verify | pending |", "| cb2 | 완료 | verify | blocked |").replace(
    "| cb3 | fix: 통합 | 통합 수정 | done |", "| cb3 | fix: 통합 | 통합 수정 | pending |").replace("cb3\n", "cb1\n")
items, cur = parse_ledger(L3)
s = summarize(items, cur)
check("blocked", (s["done"], s["total"], s["state"], s["current"]["cb"]), (1, 2, "blocked", "cb2"))

# a 「|」 inside the 문구 does not shift 종류·상태
L4 = "## 체크박스\n| 번호 | 문구 | 종류 | 상태 |\n| --- | --- | --- | --- |\n| cb1 | a | b | 구현 | done |\n"
items, _ = parse_ledger(L4)
check("pipe in text", (items[0]["text"], items[0]["kind"], items[0]["status"]), ("a | b", "구현", "done"))

# PSD-1101 모양: 착수 때 표를 running 으로 안 바꾼 장부 — 「체크박스 실행」 줄이 실행 중을 알린다
L5 = """## 체크박스
| 번호 | 문구 | 종류 | 상태 | 커밋 |
| --- | --- | --- | --- | --- |
| cb1 | a | 구현 | pending | |
| cb2 | b | 구현 | pending | |
## 실행
- 현재 체크박스: cb1
- 체크박스 실행: cb1 running 2026-11-11 14:52 · 1
"""
items, cur = parse_ledger(L5)
s = summarize(items, cur)
check("log running", ([x["status"] for x in items], s["state"], s["current"]["cb"]), (["running", "pending"], "running", "cb1"))

# 커밋 뒤 마감 전(committed)은 완료로 세고, 현재 체크박스가 끝났으면 마감 중인 칸을 현재로 본다
L6 = L5.replace("| cb1 | a | 구현 | pending | |", "| cb1 | a | 구현 | committed | abc |").replace("cb1 running", "cb1 running")
items, cur = parse_ledger(L6)
s = summarize(items, cur)
check("committed counts", (items[0]["status"], s["done"], s["total"], s["state"], s["current"]["cb"]), ("committed", 1, 2, "running", "cb1"))

# 표가 pending 이 아니면 실행 줄보다 표가 앞선다; fix-added·끊김 줄은 보정하지 않는다
L7 = """## 체크박스
| 번호 | 문구 | 종류 | 상태 |
| --- | --- | --- | --- |
| cb1 | a | 구현 | done |
| cb2 | b | verify | pending |
## 실행
- 체크박스 실행: cb1 running 2026-11-11 11:41
- 체크박스 실행: cb2 fix-added cb3 2026-11-11
- 체크박스 실행 끊김: cb2 1 · running x
"""
items, _ = parse_ledger(L7)
check("table wins, fix-added ignored", [x["status"] for x in items], ["done", "pending"])

if fails:
    print("\n".join(fails))
    sys.exit(1)
print("impl-progress OK")
