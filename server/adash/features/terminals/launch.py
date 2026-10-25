"""Starting agents from the page: a new Orca worktree with its agent, or a fresh agent in a worktree that exists, and
sending a prompt to an agent's terminal. Launches run off the request thread like closes (setup hooks take a while)."""

import re
import threading
import time

from adash.core.log import log
from adash.core.orca import orca
from adash.core.state import bump, lock
from adash.core.util import short
from adash.features.orca_runs.store import orca_state
from adash.features.terminals.close import close_jobs, jobs_lock
import adash.features.terminals.targets as terminals_targets


AGENTS = ("claude", "codex")
EFFORTS = ("low", "medium", "high", "xhigh", "max")
NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,59}")  # the worktree slug Orca turns into a branch name
MODEL = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:\[\]-]{0,79}")  # forwarded to the agent's CLI as is
PROMPT_MAX = 20000
LAUNCH_TIMEOUT = 300  # worktree create runs the repo's setup hook before the agent starts
PLACES_EVERY = 15
places_cache = {"at": 0, "value": None}
launched = set()  # agent terminals this server started: send accepts them before the scan maps them to a session


def places(fresh=False):
    """{repos[{id, name, path}], worktrees[{id, repo, name, path, branch, main}]} as Orca lists them (archived left out)."""
    if fresh or time.time() - places_cache["at"] > PLACES_EVERY or not places_cache["value"]:
        repos = orca("repo", "list").get("repos") or []
        wts = orca("worktree", "list").get("worktrees") or []
        places_cache["value"] = {
            "repos": [{"id": r["id"], "name": r.get("displayName") or r.get("path"), "path": r.get("path")}
                      for r in repos if r.get("kind", "git") == "git"],
            "worktrees": [{"id": w["id"], "repo": w.get("repoId"), "name": w.get("displayName") or w.get("path"),
                           "path": w.get("path"), "branch": (w.get("branch") or "").removeprefix("refs/heads/"),
                           "main": bool(w.get("isMainWorktree"))}
                          for w in wts if not w.get("isArchived")]}
        places_cache["at"] = time.time()
    return places_cache["value"]


def check_launch(body):
    """The page's form -> (orca args, tab label, where it goes) or raises ValueError with what is wrong (shown to the user)."""
    kind, agent = body.get("kind"), body.get("agent") or "claude"
    model, effort = body.get("model") or "", body.get("effort") or ""
    prompt, title = (body.get("prompt") or "").strip(), (body.get("title") or "").strip()
    if kind not in ("worktree", "agent") or agent not in AGENTS:
        raise ValueError("잘못된 요청입니다")
    if not isinstance(prompt, str) or len(prompt) > PROMPT_MAX or not isinstance(title, str) or len(title) > 60:
        raise ValueError(f"프롬프트는 {PROMPT_MAX}자, 탭 이름은 60자까지입니다")
    if model and not (isinstance(model, str) and MODEL.fullmatch(model)):
        raise ValueError("모델 id 에 쓸 수 없는 문자가 있습니다")
    if effort and (effort not in EFFORTS or not model):
        raise ValueError("effort 는 모델을 고른 때만 줄 수 있습니다")
    p = places(fresh=True)
    if kind == "worktree":
        name = body.get("name") or ""
        if not (isinstance(name, str) and NAME.fullmatch(name)):
            raise ValueError("워크트리 이름은 영문·숫자·.-_ 로 60자까지입니다 (브랜치 이름이 됩니다)")
        repo = next((r for r in p["repos"] if r["id"] == body.get("repo")), None)
        if not repo:
            raise ValueError("Orca 에 등록된 저장소가 아닙니다")
        if any(w["repo"] == repo["id"] and w["name"] == name for w in p["worktrees"]):
            raise ValueError(f"「{name}」 워크트리가 이미 있습니다 — 「기존 워크트리」에서 에이전트를 띄우세요")
        # Independent top-level work on the repo's default base, its setup hook run (house rule for Orca worktrees).
        args = ["worktree", "create", "--repo", "id:" + repo["id"], "--name", name, "--no-parent", "--setup", "run"]
        where = f"{repo['name']} / {name}"
    else:
        wt = next((w for w in p["worktrees"] if w["id"] == body.get("worktree")), None)
        if not wt:
            raise ValueError("Orca 에 있는 워크트리가 아닙니다")
        args = ["agent", "launch", "--worktree", "id:" + wt["id"]]
        name, where = wt["name"], wt["name"]
    # A terminal, not a chat: the page follows agents by their terminal and sends prompts there.
    args += ["--agent", agent, "--surface", "terminal"]
    if prompt:
        args += ["--prompt", prompt]
    if model:
        args += ["--model", model] + (["--effort", effort] if effort else [])
    return args, title or name, where


def run_launch(jid, args, label):
    job = close_jobs[jid]
    handle, error, note = None, None, None
    try:
        res = orca(*args, timeout=LAUNCH_TIMEOUT)
        launch = res.get("launch") or res  # worktree create nests the launch; agent launch is one
        handle = (launch.get("outcome") or {}).get("handle") or res.get("agentTerminalHandle") \
            or (res.get("startupTerminal") or {}).get("handle")
        sent = ((launch.get("prompt") or {}).get("outcome"))
        if "--prompt" in args and sent and sent not in ("journaled", "handed-to-terminal"):
            note = f"프롬프트 전달 상태: {sent}"
        if handle:
            launched.add(handle)
            try:  # the tab says what the agent owns (house rule), not an opaque handle
                orca("terminal", "rename", "--terminal", handle, "--title", label, timeout=15)
            except Exception as e:
                note = "탭 이름을 바꾸지 못함: " + short(e, 120)
    except Exception as e:
        error = short(e, 300)
        log(f"launch {label}: {error}")
    places_cache["at"] = 0
    with jobs_lock:
        job.update(state="done", finished=time.time(), done=1, handle=handle, note=note,
                   **({"failed": [{"handle": None, "error": error}]} if error else {"closed": [handle] if handle else []}))
    with lock:
        bump()


def start_launch(args, label, where):
    jid = f"launch-{int(time.time() * 1000)}"
    with jobs_lock:
        close_jobs[jid] = {"id": jid, "kind": "launch", "label": label, "where": where, "total": 1, "done": 0,
                           "closed": [], "failed": [], "state": "running", "started": time.time()}
    threading.Thread(target=run_launch, args=(jid, args, label), daemon=True).start()
    return jid


def sendable(handle):
    """A connected terminal the page may type into: one the last snapshot mapped to a session, or one launched here."""
    known = {t["handle"] for t in orca_state.get("terminals", []) if t.get("connected")}
    return handle in known and (handle in terminals_targets.focus_handles or handle in launched)


def send_prompt(handle, text):
    """-> True once the agent's turn was seen to start, False when the input was only accepted (the agent is busy and
    reads it after its turn). Raises on Orca failure. Never resent: a second send would type the prompt twice."""
    res = orca("terminal", "send", "--terminal", handle, "--text", text, "--enter", "--wait-submit", "5", timeout=25)
    send = res.get("send") or res
    return "turn_started" in ((send.get("prompt") or {}).get("stages") or [])
