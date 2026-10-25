"""Which repo, worktree or vault folder a session runs in."""

import os
import subprocess

import adash.core.config as core_config


_places = {}


def place_of(cwd):
    """Project (repo), worktree, branch and sub-path for a working directory, cached per directory."""
    if not cwd:
        return None
    if cwd in _places:
        return _places[cwd]

    def git(*args):
        try:
            r = subprocess.run(["git", "-C", cwd, *args], capture_output=True, text=True, timeout=3)
            return r.stdout.strip() if r.returncode == 0 else None
        except (OSError, subprocess.SubprocessError):
            return None

    top = git("rev-parse", "--show-toplevel")
    if top:
        common = git("rev-parse", "--path-format=absolute", "--git-common-dir") or os.path.join(top, ".git")
        main = os.path.dirname(common) if os.path.basename(common) == ".git" else common
        sub = os.path.relpath(cwd, top)
        p = {"project": os.path.basename(main), "worktree": os.path.basename(top), "main": main == top,
             "branch": git("branch", "--show-current") or None, "sub": None if sub == "." else sub, "path": top}
    elif cwd == core_config.VAULT or cwd.startswith(core_config.VAULT + "/"):
        sub = os.path.relpath(cwd, core_config.VAULT)
        p = {"project": "Obsidian 볼트", "worktree": None, "main": True, "branch": None,
             "sub": None if sub == "." else sub, "path": core_config.VAULT}
    elif cwd.startswith(("/private/tmp/", "/tmp/")) or "/scratch" in cwd:
        p = {"project": "임시 디렉터리", "worktree": os.path.basename(cwd), "main": True, "branch": None, "sub": None, "path": cwd}
    else:
        p = {"project": os.path.basename(cwd), "worktree": None, "main": True, "branch": None, "sub": None, "path": cwd}
    _places[cwd] = p
    return p
