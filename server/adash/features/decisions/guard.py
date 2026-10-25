"""Keeping sessions that hold an inbox item open (session-guard)."""

import os
import shlex

from adash.core.log import log
from adash.core.orca import orca
from adash.core.state import lock, sessions
from adash.core.util import short
from adash.features.decisions.answer import decision_terminal
from adash.features.decisions.store import decision_lock, inbox_store
from adash.features.orca_runs.store import orca_state


def worker_rows(fresh=False):
    """Supervised worker rows (dispatchId, agentTerminalHandle, ...): the tracked Runs', or Orca's newest 100."""
    rows = list(orca_state.get("workers", []))
    if fresh:
        rows += orca("orchestration", "worker-list", "--limit", "100").get("workers") or []
    return rows


def retain_worker(term):
    """A supervised worker whose session got a 메일함 item: ask Orca to keep its terminal when the Run releases it."""
    if not term:
        return
    try:
        w = next((x for x in worker_rows(fresh=True) if x.get("agentTerminalHandle") == term), None)
        if w and w.get("dispatchId"):
            orca("orchestration", "worker-retain", "--dispatch", w["dispatchId"], timeout=15)
    except Exception as e:
        log(f"worker-retain {term}: {short(e, 160)}")


def held_places():
    """(terminal handles, worktree paths) of the sessions with a 메일함 item."""
    with decision_lock:
        items = list(inbox_store.values())
    terms = {t for t in (decision_terminal(d) for d in items) if t}
    tdirs = {t.get("handle"): t.get("worktreePath") for t in orca_state.get("terminals", [])}
    with lock:
        cwd = {s.id: s.cwd for s in sessions.values() if s.kind == "claude"}
    dirs = {tdirs.get(t) for t in terms} | {cwd.get(d["card"]["session_id"]) or d["card"]["cwd"] for d in items}
    return terms, {x.rstrip("/") for x in dirs if x}


def worktree_hit(sel, dirs, own_cwd):
    """Whether an Orca worktree selector (path:, branch:, name:, id:, identity:, issue:, active/current) may name one
    of `dirs`. Loose on purpose: a wrong match only asks a person to do the close."""
    kind, _, val = sel.partition(":")
    if kind in ("active", "current") and not val:
        return any(own_cwd == d or own_cwd.startswith(d + "/") for d in dirs)
    val = val.split("::")[-1].removeprefix("refs/heads/").rstrip("/")
    if not val:
        return False
    if kind == "path":
        return any(os.path.realpath(val) == os.path.realpath(d) for d in dirs)
    return any(val in d for d in dirs)


def guard_command(command, own, own_cwd):
    """A Bash command an agent is about to run -> why it may not (it would close a held session), or None.
    Looks for `orca terminal close`, `orca worktree rm` and `orca orchestration worker-stop|worker-release|
    worker-abandon` in each simple command."""
    try:
        words = shlex.split(command, comments=True, posix=True)
    except ValueError:
        words = command.split()
    terms, dirs = held_places()
    if not terms and not dirs:
        return None
    hits = []
    cmd = []
    for w in words + [";"]:
        if w not in (";", "&&", "||", "|", "&"):
            cmd.append(w)
            continue
        i = next((k for k, x in enumerate(cmd) if os.path.basename(x) == "orca"), None)
        args = [y for x in (cmd[i + 1:] if i is not None else []) for y in (x.split("=", 1) if x.startswith("--") else [x])]
        cmd = []
        opt = lambda name: next((args[k + 1] for k, x in enumerate(args[:-1]) if x == name), None)
        sub = [x for x in args if not x.startswith("-")][:2]
        if sub == ["terminal", "close"]:
            if opt("--worktree"):
                hits += [opt("--worktree")] if worktree_hit(opt("--worktree"), dirs, own_cwd) else []
            elif (opt("--terminal") or own) in terms:
                hits.append(opt("--terminal") or own)
        elif sub == ["worktree", "rm"] and opt("--worktree") and worktree_hit(opt("--worktree"), dirs, own_cwd):
            hits.append(opt("--worktree"))
        elif sub[:1] == ["orchestration"] and any(x in args for x in ("worker-stop", "worker-release", "worker-abandon")):
            h = next((x.get("agentTerminalHandle") for x in worker_rows() if x.get("dispatchId") == opt("--dispatch")), None)
            if h in terms:
                hits.append(opt("--dispatch"))
    if not hits:
        return None
    return (f"이 명령은 메일함에 사용자가 확인할 결정이 남은 세션을 닫습니다 ({', '.join(hits)}). 사용자가 나중에 다른 답을 고르면 "
            "그 세션에 후속 메시지가 가야 하므로 에이전트·오케스트레이션은 이 세션을 닫거나 멈추거나 놓아주지 마세요. "
            "닫기가 꼭 필요하면 사용자에게 대시보드에서 직접 닫아 달라고 남기고 이 단계는 건너뛰세요.")
