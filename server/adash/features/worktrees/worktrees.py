"""Every git worktree on this Mac, for the 「워크트리」 tab: each repo Orca knows, with all of its worktrees as git lists
them (`git worktree list`), not only the ones Orca made, so worktrees made by hand or by Claude Code show too. A
submodule's own worktrees (a submodule checked out inside a worktree, with a worktree of its own) are not in any repo
Orca knows, so the git dirs under each repo's .git are walked for them and each such submodule shows as a repo of its
own. Orca's name and comment ride along where Orca has the path. Read on request, cached for a short while.

Each worktree can carry a note written on the page, kept by path in server/worktree-notes.json (the dashboard's own:
Orca's comment field is left to the tools that write it, and worktrees outside Orca have none)."""

import json
import os
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from adash.core.config import HERE
from adash.core.files import StaleWhileRefresh, save_json
from adash.core.git import git_at
from adash.core.orca import ORCA_ENV, orca
from adash.core.util import short

EVERY = 20
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


def nested_gitdirs(gd):
    """Git dirs under gd (its modules/, and the modules/ of each of its linked worktrees' git dirs, to any depth) that
    have linked worktrees of their own: the submodules with worktrees. gd itself is not one of them."""
    found = []

    def walk(d, depth):
        try:
            names = os.listdir(d)
        except OSError:
            return
        if "HEAD" in names and ("objects" in names or "commondir" in names):
            if d != gd and "commondir" not in names and os.path.isdir(os.path.join(d, "worktrees")) \
                    and os.listdir(os.path.join(d, "worktrees")):
                found.append(d)
            for sub in ("modules", "worktrees"):
                if sub in names:
                    walk(os.path.join(d, sub), depth + 1)
        elif depth < 16:  # a submodule's name may hold slashes: modules/a/b/<git dir>
            for n in names:
                p = os.path.join(d, n)
                if os.path.isdir(p) and not os.path.islink(p):
                    walk(p, depth + 1)

    walk(gd, 0)
    return found


def _rows(r, rows, top, by_path):
    """r's worktrees as listed, its main checkout first; a main checkout git names by its git dir takes top."""
    for i, w in enumerate(rows):
        w["main"] = i == 0
        if i == 0 and top and "/.git/" in w["path"] + "/":
            w["path"] = top
        o = by_path.get(os.path.realpath(w["path"]))
        w["orca"] = bool(o)
        w["name"] = (o or {}).get("displayName") or os.path.basename(w["path"])
        w["comment"] = (o or {}).get("comment") or ""
    return {"name": r["name"], "path": r["path"], "error": None, "worktrees": rows}


def _repo(r, by_path):
    """One repo's worktrees, its main checkout first. A submodule lists its main worktree as the git dir under the
    parent's .git/modules, so that row takes the checkout's own path."""
    out = git_at(r["path"], "worktree", "list", "--porcelain")
    if out is None:
        return {"name": r["name"], "path": r["path"], "error": "git worktree list 실패", "worktrees": []}
    return _rows(r, _porcelain(out), git_at(r["path"], "rev-parse", "--show-toplevel"), by_path)


def _module(gd, by_path):
    """A submodule's worktrees, read from its git dir; its checkout (core.worktree) is the main row. Named after the
    checkout and the folder it sits in, e.g. 「plang_rails · prd-31-writing」."""
    try:
        out = subprocess.run(["git", "--git-dir", gd, "worktree", "list", "--porcelain"], capture_output=True,
                             text=True, timeout=10)
        rel = subprocess.run(["git", "--git-dir", gd, "config", "core.worktree"], capture_output=True, text=True,
                             timeout=5)
    except (OSError, subprocess.SubprocessError):
        return {"name": os.path.basename(gd), "path": gd, "error": "git worktree list 실패", "worktrees": []}
    top = os.path.normpath(os.path.join(gd, rel.stdout.strip())) if rel.returncode == 0 and rel.stdout.strip() else None
    r = {"name": f"{os.path.basename(top)} · {os.path.basename(os.path.dirname(top))}" if top else os.path.basename(gd),
         "path": top or gd}
    if out.returncode:
        return {**r, "error": "git worktree list 실패", "worktrees": []}
    return _rows(r, _porcelain(out.stdout), top, by_path)


def collect():
    repos = [{"name": r.get("displayName") or os.path.basename(r["path"]), "path": r["path"]}
             for r in orca("repo", "list").get("repos") or [] if r.get("kind", "git") == "git" and r.get("path")]
    wts = orca("worktree", "list", timeout=20).get("worktrees") or []
    by_path = {os.path.realpath(w["path"]): w for w in wts if w.get("path")}
    with ThreadPoolExecutor(8) as ex:
        out = list(ex.map(lambda r: _repo(r, by_path), repos))
        # submodules with worktrees of their own, found under each repo's git dir; one that is itself a repo Orca
        # knows (its git dir is that repo's) is already listed
        common = set(filter(None, ex.map(lambda r: git_at(r["path"], "rev-parse", "--path-format=absolute",
                                                          "--git-common-dir"), repos)))
        mods = {os.path.realpath(m) for g in common for m in nested_gitdirs(g)} - {os.path.realpath(g) for g in common}
        out += list(ex.map(lambda gd: _module(gd, by_path), sorted(mods)))
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


_listing = StaleWhileRefresh("worktrees", lambda: collect(), EVERY)  # collect takes seconds over many worktrees


def worktrees(fresh=False):
    """The cached list with each worktree's note as it is now (notes are not cached: a save shows at once)."""
    v = _listing.get(fresh)
    notes = _notes()
    return {**v, "repos": [{**rp, "worktrees": [{**w, "note": notes.get(w["path"])} for w in rp["worktrees"]]}
                           for rp in v["repos"]]}


def known(path, fresh=False):
    """(repo, worktree) listed at this path (from the cached list, re-read once when it is not there), or None."""
    hit = lambda v: next(((rp, w) for rp in v["repos"] for w in rp["worktrees"] if w["path"] == path), None)
    return (not fresh and hit(worktrees())) or hit(worktrees(fresh=True))


def blockers(w):
    """Why removing w would lose something: uncommitted changes, a lock, worktrees of a submodule inside it (their git
    dirs live in w's and go with it), commits in its submodules that no remote has (also kept only in w's git dir).
    Empty when nothing is lost, and then git's refusal of a worktree with submodules is overridden."""
    if w["missing"] or w["prunable"]:
        return []
    out = [f"커밋하지 않은 변경 {w['dirty']}개가 있습니다"] if w["dirty"] else []
    if w["locked"]:
        out.append("잠긴 워크트리입니다 (git worktree lock)")
    gd = git_at(w["path"], "rev-parse", "--absolute-git-dir")
    n = sum(len(os.listdir(os.path.join(m, "worktrees"))) for m in nested_gitdirs(gd)) if gd else 0
    if n:
        out.append(f"안의 서브모듈에 딸린 워크트리 {n}개가 함께 못 쓰게 됩니다 (그것부터 지우세요)")
    if os.path.isfile(os.path.join(w["path"], ".gitmodules")):
        sm = git_at(w["path"], "submodule", "foreach", "--recursive", "--quiet",
                    'test -z "$(git rev-list -1 HEAD --branches --not --remotes)" || echo "$displaypath"', timeout=30)
        if sm:
            out.append("원격에 없는 커밋이 있는 서브모듈: " + ", ".join(sm.splitlines()))
    return out


def remove(rp, w, force):
    """Take a linked worktree off disk and out of git: Orca's own through Orca (it also drops the branch when it can
    prove the branch merged), any other with `git worktree remove` (the branch stays). One already gone from disk is
    pruned. Without force git refuses uncommitted changes and submodules (see blockers). Returns an error message, or
    None."""
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
    _listing.drop()  # the next read lists again, and waits for it
    return None
