#!/usr/bin/env python3
"""Fake-input checks for how a coordinator finds its own Orca terminal (own_handle), which ties its workers to it.

    python3 scripts/check-own-handle.py

Covers run-create (receipt names coordinator_handle, or a filtered receipt + Orca's hook pane, or the Run record),
worker-start/dispatch with no run-create (the guide's default recipe: the first worker-start binds a new Run), and
driver scripts acting `--from` another terminal (never this session's own). Exits 1 if any check fails.
Standard library only; reads no real transcript.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "server"))
from adash.features.orca_runs.store import orca_state  # noqa: E402
from adash.features.sessions.config import hooks  # noqa: E402
from adash.features.sessions.session import Session  # noqa: E402

results = []
ME = "term_aaaaaaaa-0000-0000-0000-000000000001"
DRIVER = "term_bbbbbbbb-0000-0000-0000-000000000002"
WORKER = "term_cccccccc-0000-0000-0000-000000000003"
PANE = "tab1:leaf1"


def check(name, cond, got):
    results.append((name, bool(cond)))
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else f"\n     got: {got}"))


def world(pane=True, runs=()):
    """Orca's state: this session's hook pane (if live) is terminal ME; runs are (id, coordinator_handle)."""
    hooks.clear()
    if pane:
        hooks["sid"] = {"pane": PANE}
    orca_state["terminals"] = [{"handle": ME, "connected": True, "tabId": "tab1", "leafId": "leaf1"}]
    orca_state["runs"] = [{"id": r, "coordinator_handle": h} for r, h in runs]


def own(*calls):
    """calls: (command, output). Returns the session's summary()."""
    s = Session("/tmp/sid.jsonl", "claude")
    s.id = "sid"
    for i, (cmd, out) in enumerate(calls):
        s.check_command(cmd)
        s.note_call(f"c{i}", cmd)
        s.note_result(f"c{i}", out)
    return s.summary()


WS_RECEIPT = ('{"taskId": "task_b4a472891c97", "dispatchId": "ctx_17234416d565", "runId": "run_40484a1898ca", '
              f'"terminal": "{WORKER}", "handle": null}}')
WS_FILTERED = f"{{'taskId': 'task_6cc37b12d042', 'dispatchId': 'ctx_c40c151b6c63', 'terminal': '{WORKER}'}}"

# --- worker-start only (no run-create): the case this check was written for ---
world()
s = own(("orca orchestration worker-start --spec-file b.md --worktree current --agent claude --json", WS_RECEIPT),
        ("orca orchestration worker-start --spec-file c.md --run run_40484a1898ca --agent claude --json | python3 -c ...", WS_FILTERED))
check("worker-start 만 쓴 코디네이터: hook pane 이 own_handle", s["own_handle"] == ME and s["role"] == "coordinator", s)

world(pane=False, runs=[("run_40484a1898ca", ME)])
s = own(("orca orchestration worker-start --spec-file b.md --agent claude --json", WS_RECEIPT))
check("worker-start 만 + pane 닫힘: receipt 의 runId → Run 기록의 coordinator_handle", s["own_handle"] == ME, s)

world()
s = own(("orca orchestration dispatch --task task_1 --agent claude --json", WS_RECEIPT))
check("dispatch(--from 없음)도 own-run 호출", s["own_handle"] == ME, s)

world()
s = own(("orca orchestration worker-start --help", "Usage: orca orchestration worker-start ..."))
check("worker-start --help 는 세지 않음", s["own_handle"] is None and s["role"] == "solo", s)

# --- driver scripts acting for another terminal (--from) must not claim it ---
world(pane=False, runs=[("run_40484a1898ca", DRIVER)])
s = own((f"orca orchestration worker-start --from {DRIVER} --spec x --agent claude --json", WS_RECEIPT))
check("worker-start --from <driver>: 드라이버의 Run 을 제 것으로 잡지 않음", s["own_handle"] is None, s)

world()
s = own((f"orca orchestration worker-start --from {DRIVER} --spec x --agent claude --json", WS_RECEIPT))
check("worker-start --from <driver> + pane: pane 폴백도 하지 않음", s["own_handle"] is None, s)

# --- the existing run-create paths stay as they were ---
world(pane=False)
s = own(("orca orchestration run-create --json", f'{{"id": "run_111111111111", "coordinator_handle": "{ME}"}}'))
check("run-create receipt 의 coordinator_handle", s["own_handle"] == ME, s)

world()
s = own(("orca orchestration run-create --json | grep '\"id\"'", '"id": "run_111111111111"'))
check("run-create 출력이 걸러짐: hook pane", s["own_handle"] == ME, s)

world(pane=False, runs=[("run_111111111111", ME)])
s = own(("orca orchestration run-create --json | grep '\"id\"'", '"id": "run_111111111111"'))
check("run-create 걸러짐 + pane 닫힘: Run 기록", s["own_handle"] == ME, s)

world(pane=False, runs=[("run_111111111111", DRIVER)])
s = own((f"orca orchestration run-use --from {DRIVER} run_111111111111", '{"id": "run_111111111111"}'))
check("run-use --from <driver>: Run 기록으로 잡지 않음", s["own_handle"] is None, s)

print(f"\n{sum(ok for _, ok in results)}/{len(results)} 통과")
sys.exit(0 if all(ok for _, ok in results) else 1)
