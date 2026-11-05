"""Worktrees a ticket had and no longer has, shown by their PR's size.

A worktree's diff stat is read from its checkout, so once the worktree is removed that number is gone and would be
stale anyway. Its PR outlives it, and a merged PR's additions/deletions are the change's final size. The PRs seen on
a ticket's worktree rows are remembered in review-gone.json (the data folder) ({key: {pr url: {repo, branch}}}); a driver
ticket's delivered/ file lists its PRs too. Whatever of those no live row of the ticket carries is listed as gone.
"""

import json
import os
import subprocess
import time

from adash.core.config import DATA
from adash.core.files import read_json_cached, save_json
from adash.core.log import log
from adash.features.review.config import PR_EVERY

GONE_PATH = os.path.join(DATA, "review-gone.json")


def remember(seen):
    """Merge {key: {url: {repo, branch}}} into the file; written only when something is new."""
    have = read_json_cached(GONE_PATH)
    if all(u in have.get(k, {}) for k, urls in seen.items() for u in urls):
        return
    data = {k: dict(v) for k, v in have.items()}
    for k, urls in seen.items():
        data.setdefault(k, {}).update(urls)
    try:
        save_json(GONE_PATH, data)
    except OSError as e:
        log(f"review: {GONE_PATH} 기록 실패 {e!r}")


def pr_size(url, cache, now):
    """gh pr view's size of a PR -> dict or None; a merged or closed PR is not asked again."""
    got = cache.get(url)
    if got and (got[1] and got[1].get("state") in ("MERGED", "CLOSED") or now - got[0] <= PR_EVERY):
        return got[1]
    try:
        r = subprocess.run(["gh", "pr", "view", url, "--json",
                            "number,url,state,baseRefName,headRefName,additions,deletions,changedFiles,mergedAt"],
                           capture_output=True, text=True, timeout=20)
        val = json.loads(r.stdout) if r.returncode == 0 and r.stdout.strip() else (got[1] if got else None)
    except (OSError, ValueError, subprocess.SubprocessError):
        val = got[1] if got else None
    cache[url] = (now, val)
    return val


def gone_rows(key, live_urls, driver_prs, cache):
    """The ticket's PRs no live worktree row carries, with their size, repos sorted."""
    known = dict(read_json_cached(GONE_PATH).get(key) or {})
    for u in driver_prs or []:
        known.setdefault(u, {})
    now, rows = time.time(), []
    for url, meta in known.items():
        if url in live_urls:
            continue
        p = pr_size(url, cache, now)
        parts = url.rstrip("/").split("/")
        rows.append({"repo": meta.get("repo") or (parts[-3] if len(parts) >= 3 else "?"),
                     "branch": meta.get("branch") or (p or {}).get("headRefName") or "",
                     "pr": {"number": (p or {}).get("number") or (int(parts[-1]) if parts[-1].isdigit() else None),
                            "url": url, "state": (p or {}).get("state")},
                     "base": (p or {}).get("baseRefName"), "merged_at": (p or {}).get("mergedAt"),
                     **({"files": p["changedFiles"], "ins": p["additions"], "dels": p["deletions"]} if p else {})})
    return sorted(rows, key=lambda r: (r["repo"], r["pr"]["number"] or 0))
