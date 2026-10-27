"""The closing report of an ended QA set, in two parts kept in its state directory. report.json: the figures, written
once on the first pass that sees the set retired, so they keep what the set looked like then (later passes lose
worktrees and PR links as they are cleaned). report.md: the analysis — issue types, how much was fixed, why tickets
reopened, proposals to need less QA next time — written by a headless claude the server starts once (and again from
「보고서 다시 작성」), from report-input.json, the tickets' vault notes and their PRs. The page draws both inside the
set's 「종료된 QA」 card."""

import json
import os
import re
import shutil
import subprocess
from datetime import datetime, timezone

from adash.core.log import log
from adash.core.prefs import prefs
from adash.core.state import lock
from adash.core.util import short
from adash.features.review.ship import jira_stage
from adash.features.review.store import review_kick
import adash.core.config as core_config

REPORT = "report.json"
REPORT_VERSION = 1
# prefs.json "qa_report_prompt" overrides the prompt template ({{name}} slots filled below)
REPORT_PROMPT = os.path.expanduser(prefs.get("qa_report_prompt") or os.path.join(os.path.dirname(__file__), "report_prompt.md"))
REPORT_MD, REPORT_INPUT, REPORT_TASK, REPORT_LOG = "report.md", "report-input.json", "report-task.json", "report.log"
REPORT_MODEL = prefs.get("qa_report_model") or "opus"
report_launch = {}  # epic -> {"at", "error"} while it starts, and why it failed
report_procs = {}   # epic -> the worker's Popen (this server's own)


def when(v):
    """An ISO time (UTC) or the driver's local "YYYY-MM-DD HH:MM:SS" -> aware datetime, else None."""
    try:
        d = datetime.fromisoformat(v)
    except (TypeError, ValueError):
        return None
    return d if d.tzinfo else d.astimezone()


def hours(a, b):
    return round((b - a).total_seconds() / 3600, 1) if a and b and b >= a else None


def build_report(s):
    """The report of a set (as review_pass builds it) -> dict."""
    T = s["tickets"]
    jira = {}
    for t in T:
        k = jira_stage(t)
        jira[k] = jira.get(k, 0) + 1
    qs = [(t, t["qa"]) for t in T if t.get("qa")]
    starts = [when(r) for _, q in qs for r in q.get("rounds") or []]
    starts = [d for d in starts if d]
    end = when(s.get("retired_at")) or datetime.now(timezone.utc)
    begin = min(starts) if starts else None
    # A ticket's lead time: its first round to the last stage it reached past the coordinator's review.
    lead = []
    for t, q in qs:
        a = when((q.get("rounds") or [None])[0])
        b = max((d for d in (when((q.get("at") or {}).get(k)) for k in ("committed", "approved", "delivered", "cleaned")) if d), default=None)
        h = hours(a, b)
        if h is not None:
            lead.append({"key": t["key"], "summary": t.get("summary"), "hours": h, "round": q.get("round") or 0})
    lead.sort(key=lambda x: -x["hours"])
    hs = sorted(x["hours"] for x in lead)
    days = {}
    for d in starts:
        k = d.astimezone().strftime("%Y-%m-%d")
        days[k] = days.get(k, 0) + 1
    # PRs per repository, from the links the driver recorded at delivery (worktrees are mostly cleaned by now)
    prs = set()
    for t in T:
        prs.update((t.get("qa") or {}).get("prs") or [])
        prs.update(r["pr"]["url"] for r in t.get("repos") or [] if (r.get("pr") or {}).get("url"))
    repos = {}
    for u in prs:
        m = re.search(r"/([^/]+)/pull/\d+", u)
        if m:
            repos[m.group(1)] = repos.get(m.group(1), 0) + 1
    rounds = sum(q.get("round") or 0 for _, q in qs)
    return {
        "version": REPORT_VERSION, "written_at": datetime.now(timezone.utc).isoformat(),
        "epic": s["epic"], "summary": s.get("summary"),
        "begin": begin.isoformat() if begin else None, "end": end.isoformat(),
        "tickets": len(T), "jira": jira, "driven": len(qs), "ignored": sum(1 for _, q in qs if q.get("ignored")),
        "rounds": rounds, "reopened": sum(1 for _, q in qs if (q.get("round") or 0) > 1),
        "shipped": sum(1 for _, q in qs if q.get("prs") or q.get("stage") in ("delivered", "cleaned")),
        "lead": {"n": len(hs), "median": hs[len(hs) // 2] if hs else None, "longest": lead[:5]},
        "most_rounds": sorted(({"key": t["key"], "summary": t.get("summary"), "round": q["round"]} for t, q in qs
                               if (q.get("round") or 0) > 1), key=lambda x: -x["round"])[:5],
        "days": [{"day": k, "rounds": v} for k, v in sorted(days.items())],
        "prs": len(prs), "repos": dict(sorted(repos.items(), key=lambda x: -x[1])),
        "left": [{"key": t["key"], "summary": t.get("summary"), "status": t.get("status")} for t in T if jira_stage(t) != "qa"],
        "blocked": [t["key"] for t, q in qs if q.get("blocked")],
    }


def set_report(s):
    """The saved report of a retired set, written first if it is missing; None for a set that is not retired."""
    if not (s.get("retired") and s.get("watch")):
        return None
    p = os.path.join(s["watch"], REPORT)
    try:
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        pass
    rep = build_report(s)
    try:
        with open(p + ".tmp", "w", encoding="utf-8") as f:
            json.dump(rep, f, ensure_ascii=False, indent=1)
        os.replace(p + ".tmp", p)
        log(f"review: {s['epic']} 종료 보고서 작성 {p}")
    except OSError as e:
        log(f"review: {s['epic']} 종료 보고서 저장 실패 {e!r}")
    return rep


def report_input(s, facts):
    """What the worker reads first: the figures and, per ticket, what the dashboard knows of it."""
    return {"facts": facts, "tickets": [
        {"key": t["key"], "summary": t.get("summary"), "status": t.get("status"), "assignee": t.get("assignee"),
         "round": (t.get("qa") or {}).get("round"), "ignored": (t.get("qa") or {}).get("ignored"),
         "blocked_reason": (t.get("qa") or {}).get("blocked_reason"),
         "notes": [n for n in [t.get("step"), *(t.get("notes") or [])] if n],
         "prs": sorted(set((t.get("qa") or {}).get("prs") or []) | {r["pr"]["url"] for r in t.get("repos") or [] if (r.get("pr") or {}).get("url")})}
        for t in s["tickets"]]}


def report_start(s, qs):
    """Starts the analysis worker of a retired set: report-input.json, then a headless `claude -p` in the state
    directory that may read anything, run `gh pr view`/`gh api` and write only there (its output in report.log)."""
    epic, watch = s["epic"], s["watch"]
    try:
        facts = set_report(s) or build_report(s)
        with open(os.path.join(watch, REPORT_INPUT), "w", encoding="utf-8") as f:
            json.dump(report_input(s, facts), f, ensure_ascii=False, indent=1)
        vals = {"epic": epic, "summary": s.get("summary") or "", "out": os.path.join(watch, REPORT_MD),
                "input": os.path.join(watch, REPORT_INPUT), "watch": watch, "vault": core_config.VAULT,
                "project": os.path.join(core_config.VAULT, (qs or {}).get("project") or "")}
        with open(REPORT_PROMPT, encoding="utf-8") as f:
            spec = re.sub(r"\{\{(\w+)\}\}", lambda m: str(vals.get(m.group(1), m.group(0))), f.read())
        claude = shutil.which("claude") or os.path.expanduser("~/.local/bin/claude")
        allow = ["Read", "Glob", "Grep", "Bash(gh pr view:*)", "Bash(gh api:*)", "Bash(ls:*)",
                 f"Edit(/{watch}/**)"]  # "//abs/path" is an absolute rule ("/x" would be project-relative); Edit covers Write
        log_f = open(os.path.join(watch, REPORT_LOG), "w", encoding="utf-8")
        proc = subprocess.Popen([claude, "-p", spec, "--model", REPORT_MODEL, "--permission-mode", "dontAsk",
                                 "--allowedTools", *allow, "--add-dir", core_config.VAULT],
                                cwd=watch, stdin=subprocess.DEVNULL, stdout=log_f, stderr=subprocess.STDOUT, start_new_session=True)
        log_f.close()
        with open(os.path.join(watch, REPORT_TASK), "w", encoding="utf-8") as f:
            json.dump({"pid": proc.pid, "at": datetime.now(timezone.utc).isoformat()}, f)
        with lock:
            report_launch.pop(epic, None)
            report_procs[epic] = proc
        log(f"review: {epic} 종료 보고서 워커 기동 pid={proc.pid}")
    except Exception as e:
        with lock:
            report_launch[epic] = {"at": datetime.now(timezone.utc).isoformat(), "error": short(str(e), 300)}
        log(f"review: {epic} 종료 보고서 워커 기동 실패 {e!r}")
    review_kick.set()


def report_analysis(s):
    """{md, md_at, status, at, error} of a retired set's analysis: the report.md text and the worker's state —
    launching, launch_failed, running, completed or failed (exit code, else whether it left report.md)."""
    watch = s["watch"]
    out = {"md": None, "md_at": None, "status": None, "at": None, "error": None}
    p = os.path.join(watch, REPORT_MD)
    try:
        with open(p, encoding="utf-8") as f:
            out["md"] = f.read()
        out["md_at"] = datetime.fromtimestamp(os.path.getmtime(p), timezone.utc).isoformat()
    except OSError:
        pass
    try:
        with open(os.path.join(watch, REPORT_TASK), encoding="utf-8") as f:
            task = json.load(f)
    except (OSError, ValueError):
        task = None
    launch = report_launch.get(s["epic"])
    if launch and (not task or task.get("at", "") < launch["at"]):
        return {**out, "status": "launch_failed" if launch["error"] else "launching", "at": launch["at"], "error": launch["error"]}
    if not task:
        return out
    out["at"] = task.get("at")
    proc = report_procs.get(s["epic"])
    code = proc.poll() if proc and proc.pid == task.get("pid") else None
    if proc and proc.pid == task.get("pid") and code is None:
        out["status"] = "running"
    elif not proc or proc.pid != task.get("pid"):  # started before this server: alive or not is all there is
        try:
            os.kill(task["pid"], 0)
            out["status"] = "running"
        except (OSError, KeyError, TypeError):
            code = 0 if out["md_at"] and out["md_at"] >= task.get("at", "") else 1
    if out["status"] is None:
        done = code == 0 and out["md_at"] and out["md_at"] >= task.get("at", "") and not (out["md"] or "").lstrip().startswith("> 미완성")
        out["status"] = "completed" if done else "failed"
        if not done:
            out["error"] = f"종료 코드 {code} · {os.path.join(watch, REPORT_LOG)}" if code else "보고서가 미완성이거나 새로 쓰이지 않았습니다"
    return out


def report_busy(a):
    """Whether the analysis worker is starting or running (so no second one is started)."""
    return (a or {}).get("status") in ("launching", "running")
