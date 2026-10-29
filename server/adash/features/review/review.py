"""One review pass: Jira tickets, worktrees, PRs, driver state."""

import json
import os
import re
import subprocess
import threading
import time
from datetime import datetime, timezone

from adash.core.config import HERE
from adash.core.files import read_json_cached
from adash.core.git import git_at
from adash.core.jira import jira_epic
from adash.core.log import log
from adash.core.orca import orca
from adash.core.state import bump, lock
from adash.core.util import short
from adash.features.orca_runs.store import orca_state
from adash.features.review.config import JIRA_EVERY, PR_EVERY, QA_SETS, REVIEW_BASES, REVIEW_FIRST, WT_KEY
from adash.features.review.notes import note_review, project_notes, reopened_since, write_review_sha
from adash.features.review.qa import QA_STAGES, driver_worktree_repos, qa_automations, qa_config, qa_ticket
from adash.features.review.report import REPORT_TASK, report_analysis, report_launch, report_start, set_report
from adash.features.review.ship import SHIP_PROMPT, jira_stage, ship_launch, ship_state, ship_tasks
from adash.features.review.store import review_state
from adash.features.review.tickets import ticket_test, wt_repo


def retired_at(watch):
    """When the QA of a state directory was ended (qa-driver retire writes `retired`), as UTC ISO; None if it was not."""
    try:
        return datetime.fromtimestamp(os.path.getmtime(os.path.join(watch, "retired")), timezone.utc).isoformat() if watch else None
    except OSError:
        return None


def qa_sheet(qs):
    """The set's TC sheet progress as `aqa sheet` last recorded it (server/qa-sheets.json), with the sheet's link."""
    got = read_json_cached(os.path.join(HERE, "qa-sheets.json")).get(qs.get("epic"))
    return {**got, "url": qs.get("sheet")} if got or qs.get("sheet") else None


def review_pass(jira, prs, stats):
    worktrees = orca("worktree", "list", timeout=20).get("worktrees") or []
    by_key = {}
    for w in worktrees:
        m = WT_KEY.search(os.path.basename(w.get("path") or ""))
        if m and not w.get("isMainWorktree") and not w.get("isArchived") and os.path.isdir(w["path"]):
            by_key.setdefault(m.group(1), []).append(w)
    now = time.time()
    sets = []
    for qs in QA_SETS:
        epic, project = qs.get("epic"), qs.get("project")
        err = None
        if now - jira.get(epic, (0,))[0] > JIRA_EVERY:
            try:
                jira[epic] = (now, *jira_epic(epic))
            except Exception as e:  # keep the last list; say why it is old
                err = "Jira: " + short(repr(e), 160)
                jira[epic] = (now, *(jira.get(epic, (0, None, []))[1:]))
        _, epic_summary, children = jira.get(epic, (0, None, []))
        try:
            notes = project_notes(project, epic.split("-")[0] + "-") if project else {}
        except (OSError, ValueError) as e:
            notes, err = {}, (err + " · " if err else "") + "progress.json: " + short(repr(e), 120)
        try:
            ships = ship_tasks(epic) if SHIP_PROMPT else {}
        except Exception as e:
            ships, err = {}, (err + " · " if err else "") + "반출 Run: " + short(repr(e), 120)
        watch = os.path.expanduser(qs.get("watch") or "")
        driver = bool(watch) and os.path.isdir(os.path.join(watch, "tickets"))
        tickets = []
        for c in children:
            key = c["key"]
            repos = []
            qa = qa_ticket(watch, key) if watch else None
            if driver and qa and qa["worktree"] and os.path.isdir(qa["worktree"]):
                places = [(path, br, repo, None, None) for path, br, repo in driver_worktree_repos(qa["worktree"])]
            else:
                places = [(w["path"], (w.get("branch") or "").removeprefix("refs/heads/"), wt_repo(w, worktrees),
                           w.get("displayName"), w.get("comment")) for w in by_key.get(key, [])]
            for path, branch, repo, wname, wcomment in places:
                head = git_at(path, "rev-parse", "HEAD")
                pk = (path, branch)
                if now - prs.get(pk, (0,))[0] > PR_EVERY:
                    try:
                        r = subprocess.run(["gh", "pr", "list", "--head", branch, "--state", "all", "--limit", "1",
                                            "--json", "number,url,state,baseRefName"], cwd=path,
                                           capture_output=True, text=True, timeout=20)
                        lst = json.loads(r.stdout) if r.returncode == 0 and r.stdout.strip() else []
                        prs[pk] = (now, lst[0] if lst else None)
                    except (OSError, ValueError, subprocess.SubprocessError):
                        prs[pk] = (now, None)
                pr = prs[pk][1]
                if pr and pr.get("baseRefName"):
                    base, base_src = pr["baseRefName"], "PR"
                else:
                    base, base_src = REVIEW_BASES.get(repo, "main"), "설정" if repo in REVIEW_BASES else "기본"
                base_ref = next((r for r in (f"origin/{base}", base) if git_at(path, "rev-parse", "--verify", "--quiet", r)), None)
                base_sha = base_ref and git_at(path, "rev-parse", base_ref)
                sk = (path, head, base_sha)
                if head and base_sha and sk not in stats:
                    lr = (git_at(path, "rev-list", "--left-right", "--count", f"{base_sha}...{head}") or "0\t0").split()
                    ss = git_at(path, "diff", "--shortstat", f"{base_sha}...{head}") or ""
                    num = lambda pat: int((re.search(pat, ss) or [0, 0])[1])
                    stats[sk] = {"behind": int(lr[0]), "ahead": int(lr[1]), "files": num(r"(\d+) files? changed"),
                                 "ins": num(r"(\d+) insertions?"), "dels": num(r"(\d+) deletions?")}
                porcelain = git_at(path, "status", "--porcelain")
                repos.append({"repo": repo, "path": path, "branch": branch, "name": wname,
                              "comment": wcomment or None, "head": head, "base": base, "base_ref": base_ref,
                              "base_src": base_src, "pr": pr, "dirty": len(porcelain.splitlines()) if porcelain else 0,
                              **(stats.get(sk) or {})})
            repos.sort(key=lambda r: (r["repo"] not in REVIEW_FIRST, r["repo"]))
            n = notes.get(key) or {}
            fm = note_review(n["step"]) if n.get("step") else {}
            if not repos:
                review = "none"
            elif fm.get("review") != "done":
                review = "pending"
            else:
                rs = fm.get("review_sha") or {}
                same = all(r["head"] and rs.get(r["repo"]) and r["head"].startswith(rs[r["repo"]]) for r in repos)
                if reopened_since(fm, qa, n["step"]):
                    review = "reopened"
                else:
                    review = "done"
                    if not same and all(r["head"] for r in repos):
                        # A moved HEAD is mostly a rebase before push: the review follows it instead of reading
                        # 「리뷰 후 변경」. A reopen (a later round) is what sends a ticket back to review.
                        shas = {r["repo"]: r["head"][:9] for r in repos}
                        try:
                            write_review_sha(n["step"], shas)
                            fm["review_sha"] = shas
                        except (OSError, ValueError) as e:
                            log(f"review: {key} review_sha 갱신 실패 {e!r}")
            tickets.append({**c, "repos": repos, "review": review, "review_at": fm.get("review_at"),
                            "review_sha": fm.get("review_sha") or {}, "review_round": fm.get("review_round"),
                            "step": n.get("step"),
                            "step_status": fm.get("status"), "notes": n.get("notes") or [], "test": ticket_test(key),
                            "ship": ship_state(ships.get(key), ship_launch.get(key)), "qa": qa})
        # Worktrees named after a key the epic does not list (another QA, or a key typo) stay visible too.
        listed = {c["key"] for c in children}
        stray = sorted(k for k in by_key if k.startswith(epic.split("-")[0] + "-") and k not in listed)
        cfg = qa_config(watch) if watch else {}
        coord = cfg.get("QA_COORD_WORKTREE")
        sets.append({"epic": epic, "summary": epic_summary, "project": project, "error": err,
                     "tickets": tickets, "stray": stray, "watch": watch or None, "driver": driver,
                     "coord_worktree": coord if coord and os.path.isdir(coord) else None,
                     "retired": bool(watch) and os.path.exists(os.path.join(watch, "retired")),
                     "retired_at": retired_at(watch),
                     "finished": bool(children) and all(jira_stage(c) == "qa" for c in children),
                     "sheet": qa_sheet(qs), "stages": QA_STAGES})
    autos = qa_automations([s["epic"] for s in sets])
    live = {x["handle"] for x in orca_state.get("terminals") or [] if x.get("connected")}
    for s in sets:
        s["automations"] = autos.get(s["epic"], [])
        s["adopted"] = any(a["driver"] for a in s["automations"])
        for t in s["tickets"]:
            if t.get("qa"):
                t["qa"]["live"] = [h for h in t["qa"]["handles"] if h in live]
        s["report"] = set_report(s)
        if s["report"]:
            s["analysis"] = report_analysis(s)
            # the analysis is written once by itself: no report.md, never started, nothing starting now
            if not s["analysis"]["md"] and not s["analysis"]["status"] and not os.path.exists(os.path.join(s["watch"], REPORT_TASK)):
                with lock:
                    report_launch[s["epic"]] = {"at": datetime.now(timezone.utc).isoformat(), "error": None}
                s["analysis"].update(status="launching", at=report_launch[s["epic"]]["at"])
                threading.Thread(target=report_start, args=(s, next((q for q in QA_SETS if q.get("epic") == s["epic"]), None)), daemon=True).start()
    with lock:
        review_state.update(sets=sets, updated=datetime.now(timezone.utc).isoformat())
        bump()
