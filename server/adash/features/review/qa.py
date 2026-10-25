"""The QA driver: stages, its CLI and the Orca automations of a set."""

import json
import os
import re
import shlex
import subprocess
import sys
import time
from datetime import datetime, timezone

from adash.core.git import git_at
from adash.core.orca import orca
from adash.core.prefs import prefs
from adash.core.state import report_failure


# ---- QA driver: a set's `watch` is the qa-ticket-driver state directory (or an older watcher's) ----
# Stages follow the skill's exports/state-contract.md; the page draws them as a track per ticket. Control goes through
# the skill's CLI (prefs.json "qa_driver", default the installed skill) so the rules live in one place; the set's
# Orca automations are the ones whose prompt or precheck names the epic.
QA_DRIVER = os.path.expanduser(prefs.get("qa_driver") or "~/.claude/skills/qa-ticket-driver/bin/qa-driver")
QA_STAGES = ["selected", "worktree", "analysis", "implementing", "reviewing", "committed", "approved", "delivered", "cleaned"]
QA_AUTOMATION_EVERY = 60
qa_auto_cache = {"at": 0, "list": [], "runs": {}}


def qa_signal(watch, kind, key):
    """Signal files of a ticket in one kind: <KEY>.md or <KEY>-<name>.md (an older watcher's .roundN copies excluded)."""
    try:
        names = os.listdir(os.path.join(watch, kind))
    except OSError:
        return []
    pat = re.compile(rf"^{re.escape(key)}(?:-[^.]+)?(?:\.md)?$")
    return sorted(f for f in names if pat.match(f))


def claim_at(c):
    """When a claimed line (one per round: local time, epoch, handle, summary) started its round, as UTC ISO."""
    try:
        return datetime.fromtimestamp(int(c[1]), timezone.utc).isoformat()
    except (IndexError, ValueError):
        return c[0]


def qa_ticket(watch, key):
    """{stage, blocked, ignored, round, coordinator, workers, worktree, at{stage: iso}, prs} or None if never claimed."""
    p = lambda *a: os.path.join(watch, *a)
    try:
        claims = [l.rstrip("\n").split("\t") for l in open(p("claimed", key), encoding="utf-8") if l.strip()]
    except OSError:
        return None
    try:
        with open(p("tickets", f"{key}.json"), encoding="utf-8") as f:
            rec = json.load(f)
    except (OSError, ValueError):
        rec = {}
    mt = lambda f: datetime.fromtimestamp(os.path.getmtime(f), timezone.utc).isoformat() if os.path.exists(f) else None
    hand = [f for f in qa_signal(watch, "handoffs", key) if not f.endswith("-deliver.md")]
    done = qa_signal(watch, "done", key)
    has = lambda kind: f"{key}.md" in qa_signal(watch, kind, key)
    if os.path.exists(p("cleaned", key)):
        stage = "cleaned"
    elif has("delivered"):
        stage = "delivered"
    elif has("approved"):
        stage = "approved"
    elif has("ready"):
        stage = "committed"
    elif hand and done and len(done) >= len(hand):
        stage = "reviewing"
    elif hand:
        stage = "implementing"
    elif rec.get("coordinator") or (not rec.get("driver") and claims):
        stage = "analysis"
    else:
        stage = "worktree" if rec.get("worktree") else "selected"
    blocked = qa_signal(watch, "blocked", key)
    reason = None
    if blocked:
        try:
            reason = (open(p("blocked", blocked[0]), encoding="utf-8").read().split("\n") + [""] * 3)[2].strip() or None
        except OSError:
            pass
    prs = []
    if has("delivered"):
        try:
            prs = re.findall(r"https://\S+/pull/\d+", open(p("delivered", f"{key}.md"), encoding="utf-8").read())
        except OSError:
            pass
    first = lambda kind, names: min((mt(p(kind, n)) for n in names), default=None)
    at = {"selected": claims[-1][0] if claims else None, "worktree": (rec.get("worktree") or {}).get("created_at"),
          "analysis": (rec.get("coordinator") or {}).get("at") or (claims[-1][0] if claims else None),
          "implementing": first("handoffs", hand), "reviewing": max((mt(p("done", n)) for n in done), default=None),
          "committed": mt(p("ready", f"{key}.md")), "approved": mt(p("approved", f"{key}.md")),
          "delivered": mt(p("delivered", f"{key}.md")), "cleaned": mt(p("cleaned", key))}
    coord = (rec.get("coordinator") or {}).get("handle") or (claims[-1][2] if claims and len(claims[-1]) > 2 else None)
    return {"stage": stage, "stage_no": QA_STAGES.index(stage) + 1, "blocked": bool(blocked), "blocked_reason": reason,
            "ignored": os.path.exists(p("ignored", key)), "round": len(claims), "coordinator": coord,
            "workers": [{"name": n, **w} for n, w in (rec.get("workers") or {}).items()],
            "worktree": (rec.get("worktree") or {}).get("path"), "at": at, "prs": prs,
            "handoffs": len(hand), "done": len(done), "driver": bool(rec.get("driver")),
            "merge_at": mt(p("merge", f"{key}.md")), "rounds": [claim_at(c) for c in claims],
            "handles": list(dict.fromkeys(h for h in [c[2] for c in claims if len(c) > 2] + [coord]
                                          + [w.get("handle") for w in (rec.get("workers") or {}).values()] if h))}


def qa_config(watch):
    """KEY=value lines of a state directory's config.env (the dashboard needs only a few)."""
    out = {}
    try:
        for line in open(os.path.join(watch, "config.env"), encoding="utf-8"):
            k, sep, v = line.strip().partition("=")
            if sep and not k.startswith("#"):
                try:
                    vv = shlex.split(v, comments=True)
                except ValueError:
                    vv = []
                out[k.strip()] = vv[0] if vv else ""
    except OSError:
        pass
    return out


def driver_worktree_repos(wt):
    """(path, branch, repo) of the populated submodules of a driver ticket worktree that sit on a branch; the
    worktree itself when it has no submodules."""
    out = []
    for line in (git_at(wt, "config", "--file", ".gitmodules", "--get-regexp", r"^submodule\..*\.path$") or "").splitlines():
        sub = line.split()[-1]
        path = os.path.join(wt, sub)
        if os.path.exists(os.path.join(path, ".git")):
            br = git_at(path, "branch", "--show-current")
            if br:
                out.append((path, br, os.path.basename(sub)))
    if not out and not os.path.isfile(os.path.join(wt, ".gitmodules")):
        out.append((wt, git_at(wt, "branch", "--show-current") or "", os.path.basename(wt)))
    return out


def qa_automations(epics):
    """epic -> [{id, name, enabled, rrule, next, last, runs[{status, at, error}]}], refreshed every minute."""
    now_ = time.time()
    if now_ - qa_auto_cache["at"] > QA_AUTOMATION_EVERY:
        try:
            res = orca("automations", "list", timeout=20)
            qa_auto_cache["list"] = res.get("automations", res) if isinstance(res, dict) else res
        except Exception as e:
            report_failure("qa automations", e)
        for a in qa_auto_cache["list"]:
            try:
                rs = orca("automations", "runs", "--id", a["id"], timeout=20)
                rs = rs.get("runs", rs) if isinstance(rs, dict) else rs
                qa_auto_cache["runs"][a["id"]] = [{"status": r.get("status"), "at": r.get("startedAt") or r.get("createdAt"),
                                                   "error": r.get("error"), "trigger": r.get("trigger")} for r in rs[:8]]
            except Exception:
                pass
        qa_auto_cache["at"] = now_
    out = {}
    for e in epics:
        hit = re.compile(rf"(?<![A-Za-z0-9]){re.escape(e)}(?![0-9])")
        out[e] = [{"id": a["id"], "name": a.get("name"), "enabled": a.get("enabled"), "rrule": a.get("rrule"),
                   "driver": "qa-driver" in (a.get("prompt") or ""),
                   "next": a.get("nextRunAt"), "last": a.get("lastRunAt"), "runs": qa_auto_cache["runs"].get(a["id"], [])}
                  for a in qa_auto_cache["list"]
                  if hit.search(" ".join([a.get("name") or "", a.get("prompt") or "", (a.get("precheck") or {}).get("command") or ""]))]
    return out


def qa_cli(epic, watch, *args, timeout=600):
    """Run the qa-driver CLI for a set: -> (exit code, stdout + stderr)."""
    if not os.path.isfile(QA_DRIVER):
        return 127, f"qa-driver 가 없다: {QA_DRIVER} (prefs.json qa_driver)"
    r = subprocess.run([sys.executable, QA_DRIVER, "--home", os.path.dirname(watch), *args[:1], epic, *args[1:]],
                       capture_output=True, text=True, timeout=timeout)
    return r.returncode, (r.stdout + ("\n" if r.stdout and r.stderr else "") + r.stderr).strip()
