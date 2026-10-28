"""Every git worktree on this Mac, for the 「워크트리」 tab: each repo Orca knows, with all of its worktrees as git lists
them (`git worktree list`), not only the ones Orca made, so worktrees made by hand or by Claude Code show too. Orca's
name and comment ride along where Orca has the path. Read on request, cached for a short while.

Each worktree can carry a note written on the page, kept by path in server/worktree-notes.json (the dashboard's own:
Orca's comment field is left to the tools that write it, and worktrees outside Orca have none)."""

import json
import os
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from adash.core.config import HERE
from adash.core.files import save_json
from adash.core.git import git_at
from adash.core.orca import ORCA_ENV, orca
from adash.core.util import short

EVERY = 20
_cache = {"at": 0, "value": None}
_lock = threading.Lock()
NOTES = os.path.join(HERE, "worktree-notes.json")  # {path: {"text", "at"}}
NOTE_MAX = 4000
_notes_lock = threading.Lock()


def _porcelain(text):
    """`git worktree list --porcelain` -> [{path, head, branch, detached, locked, prunable, bare}]."""
    rows = []
    for block in text.strip().split("\n\n"):
        w = {"path": None, "head": None, "branch": None, "detached": False, "locked": False, "prunable": False, "bare": False}
        for ln in block.splitlines():
            k, _, v = ln.partition(" ")
            if k == "worktree":
                w["path"] = v
            elif k == "HEAD":
                w["head"] = v[:9]
            elif k == "branch":
                w["branch"] = v.removeprefix("refs/heads/")
            elif k in ("detached", "locked", "prunable", "bare"):
                w[k] = True
        if w["path"]:
            rows.append(w)
    return rows


def _status(w):
    """Changed files and the last commit's time, for a worktree that is on disk."""
    if not os.path.isdir(w["path"]) or w["bare"]:
        return {**w, "missing": not w["bare"], "dirty": None, "committed": None, "subject": None}
    st = git_at(w["path"], "status", "--porcelain", "--untracked-files=normal")
    last = git_at(w["path"], "log", "-1", "--format=%ct%x09%s") or ""
    ts, _, subject = last.partition("\t")
    return {**w, "missing": False, "dirty": None if st is None else len([x for x in st.splitlines() if x]),
            "committed": int(ts) if ts.isdigit() else None, "subject": short(subject, 120) or None}


def _repo(r, by_path):
    """One repo's worktrees, its main checkout first. A submodule lists its main worktree as the git dir under the
    parent's .git/modules, so that row takes the checkout's own path."""
    out = git_at(r["path"], "worktree", "list", "--porcelain")
    if out is None:
        return {"name": r["name"], "path": r["path"], "error": "git worktree list 실패", "worktrees": []}
    rows = _porcelain(out)
    top = git_at(r["path"], "rev-parse", "--show-toplevel")
    for i, w in enumerate(rows):
        w["main"] = i == 0
        if i == 0 and top and "/.git/" in w["path"] + "/":
            w["path"] = top
        o = by_path.get(os.path.realpath(w["path"]))
        w["orca"] = bool(o)
        w["name"] = (o or {}).get("displayName") or os.path.basename(w["path"])
        w["comment"] = (o or {}).get("comment") or ""
    return {"name": r["name"], "path": r["path"], "error": None, "worktrees": rows}


def collect():
    repos = [{"name": r.get("displayName") or os.path.basename(r["path"]), "path": r["path"]}
             for r in orca("repo", "list").get("repos") or [] if r.get("kind", "git") == "git" and r.get("path")]
    wts = orca("worktree", "list", timeout=20).get("worktrees") or []
    by_path = {os.path.realpath(w["path"]): w for w in wts if w.get("path")}
    with ThreadPoolExecutor(8) as ex:
        out = list(ex.map(lambda r: _repo(r, by_path), repos))
        # a repo listed twice (or the same checkout under two names) shows once
        seen, rows = set(), []
        for rp in out:
            rp["worktrees"] = [w for w in rp["worktrees"] if os.path.realpath(w["path"]) not in seen]
            seen.update(os.path.realpath(w["path"]) for w in rp["worktrees"])
            rows += [(rp, i) for i in range(len(rp["worktrees"]))]
        for (rp, i), w in zip(rows, ex.map(lambda x: _status(x[0]["worktrees"][x[1]]), rows)):
            rp["worktrees"][i] = w
    return {"repos": out, "at": time.time()}


def _notes():
    try:
        with open(NOTES) as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def set_note(path, text):
    """Write (or, with blank text, remove) the note on a worktree. Returns the stored note or None."""
    with _notes_lock:
        d = _notes()
        text = text.strip()
        if text:
            d[path] = {"text": text[:NOTE_MAX], "at": time.time()}
        else:
            d.pop(path, None)
        save_json(NOTES, d)
        return d.get(path)


def worktrees(fresh=False):
    """The cached list with each worktree's note as it is now (notes are not cached: a save shows at once)."""
    with _lock:
        if fresh or not _cache["value"] or time.time() - _cache["at"] > EVERY:
            _cache["value"] = collect()
            _cache["at"] = time.time()
        v = _cache["value"]
    notes = _notes()
    return {**v, "repos": [{**rp, "worktrees": [{**w, "note": notes.get(w["path"])} for w in rp["worktrees"]]}
                           for rp in v["repos"]]}


def known(path, fresh=False):
    """(repo, worktree) listed at this path (from the cached list, re-read once when it is not there), or None."""
    hit = lambda v: next(((rp, w) for rp in v["repos"] for w in rp["worktrees"] if w["path"] == path), None)
    return (not fresh and hit(worktrees())) or hit(worktrees(fresh=True))


def remove(rp, w, force):
    """Take a linked worktree off disk and out of git: Orca's own through Orca (it also drops the branch when it can
    prove the branch merged), any other with `git worktree remove` (the branch stays). One already gone from disk is
    pruned. Without force git refuses uncommitted changes and submodules. Returns an error message, or None."""
    main = next((x["path"] for x in rp["worktrees"] if x["main"]), rp["path"])
    if w["missing"] or w["prunable"]:
        cmd = ["git", "-C", main, "worktree", "prune"]
    elif w["orca"]:
        cmd = ["orca", "worktree", "rm", "--worktree", "path:" + w["path"], *(["--force"] if force else []), "--json"]
    else:
        cmd = ["git", "-C", main, "worktree", "remove", *(["--force", "--force"] if force else []), w["path"]]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=120, env=ORCA_ENV)
    except subprocess.TimeoutExpired:
        return "2분 안에 끝나지 않았습니다"
    if r.returncode:
        return short(r.stderr or r.stdout, 400) or f"종료 코드 {r.returncode}"
    if os.path.isdir(w["path"]) and not (w["missing"] or w["prunable"]):
        return "명령은 끝났지만 폴더가 남아 있습니다"
    with _notes_lock:
        d = _notes()
        if d.pop(w["path"], None):
            save_json(NOTES, d)
    with _lock:
        _cache["at"] = 0  # the next read lists again
    return None
