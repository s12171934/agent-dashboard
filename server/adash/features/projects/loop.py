"""The project collector."""

import os
import time

from adash.core.state import loop_failed, loop_ok
from adash.core.util import short
from adash.features.projects.progress import read_progress
from adash.features.projects.store import PROJECTS_DIRS, PROJECTS_EVERY, project_cache
import adash.features.projects.store as projects_store


def scan_projects():
    """One pass over every --projects-dir; rebinds `projects` (and bumps its version) only when something changed."""
    dirs, found = [], {}
    for base in PROJECTS_DIRS:
        try:
            names = sorted(os.listdir(base))
        except OSError as e:
            dirs.append({"dir": base, "error": short(e.strerror or e, 200)})
            continue
        dirs.append({"dir": base, "error": None})
        for name in names:
            path = os.path.join(base, name, "progress.json")
            try:
                mtime = os.path.getmtime(path)
            except OSError:
                continue  # not a project folder (or not one yet)
            cached = project_cache.get(path)
            if not cached or cached[0] != mtime:
                cached = project_cache[path] = (mtime, read_progress(path, mtime, base, name))
            found[path] = cached[1]
    for path in [p for p in project_cache if p not in found]:
        project_cache.pop(path)  # a folder removed or its progress.json deleted
    listed = list(found.values())
    if listed != projects_store.projects["list"] or dirs != projects_store.projects["dirs"]:
        projects_store.projects = {"version": projects_store.projects["version"] + 1, "dirs": dirs, "list": listed}


def projects_loop():
    while True:
        try:
            scan_projects()
            loop_ok("projects")
        except Exception as e:
            loop_failed("projects", e)
        time.sleep(PROJECTS_EVERY)
