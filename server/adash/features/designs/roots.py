"""Design folders and their copies in every worktree of the repository."""

import os
import time

from adash.core.git import git_in
from adash.features.designs.store import DESIGN_DIRS, DESIGN_GIT_EVERY
from adash.features.plans.store import ext_plans


_git_cache = {}  # (folder, what) -> (when, value)


def git_cached(key, fn):
    hit = _git_cache.get(key)
    if not hit or time.time() - hit[0] > DESIGN_GIT_EVERY:
        hit = _git_cache[key] = (time.time(), fn())
    return hit[1]


def worktree_copies(folder):
    """The folder, then the same folder in the other worktrees of its repository (that have it)."""
    def find():
        top = git_in(folder, "rev-parse", "--show-toplevel")
        if not top:
            return [folder]
        rel = os.path.relpath(folder, top)
        out = [folder]
        for line in (git_in(folder, "worktree", "list", "--porcelain") or "").splitlines():
            if line.startswith("worktree "):
                wt = line[len("worktree "):]
                if os.path.realpath(wt) != os.path.realpath(top) and os.path.isdir(os.path.join(wt, rel)):
                    out.append(os.path.join(wt, rel))
        return out
    return git_cached((folder, "worktrees"), find)


def repo_info(folder):
    """Where a design folder sits: repository, worktree, branch and HEAD (cached a minute)."""
    def find():
        top = git_in(folder, "rev-parse", "--show-toplevel")
        if not top:
            return {"repo": None, "worktree": None, "branch": None, "head": None, "main": True}
        common = git_in(folder, "rev-parse", "--path-format=absolute", "--git-common-dir") or os.path.join(top, ".git")
        main = os.path.dirname(common) if os.path.basename(common) == ".git" else common
        return {"repo": os.path.basename(main), "worktree": os.path.basename(top), "main": main == top,
                "branch": git_in(folder, "branch", "--show-current") or None, "head": git_in(folder, "rev-parse", "HEAD")}
    return git_cached((folder, "info"), find)


def design_roots():
    """[(folder, configured)]: each configured folder and each external plan's design folder, followed by its copies
    in the repository's other worktrees. Real paths, each once."""
    want = [(d, True) for d in DESIGN_DIRS]
    names = {os.path.basename(d) for d in DESIGN_DIRS}
    for p in list(ext_plans.values()):
        root = p.get("design_root")
        if not root:
            continue
        root = os.path.realpath(os.path.expanduser(root))
        # the ancestor named like a configured folder (…/feature-designs/<slug> → …/feature-designs), else its parent
        cur = root
        while os.path.dirname(cur) != cur and os.path.basename(cur) not in names:
            cur = os.path.dirname(cur)
        want.append((cur if os.path.basename(cur) in names else os.path.dirname(root), False))
    out, seen = [], set()
    for folder, configured in want:
        if not os.path.isdir(folder):
            continue
        for i, f in enumerate(worktree_copies(folder)):
            f = os.path.realpath(f)
            if f not in seen:
                seen.add(f)
                out.append((f, configured and i == 0))
    return out
