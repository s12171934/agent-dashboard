"""Validating progress.json and deriving status, spans and counts from it."""

import json
import os
import re
from datetime import datetime

from adash.core.util import short


STEP_STATES = ("scheduling", "pending", "active", "done", "failed")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
DATETIME_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-](\d{2}):(\d{2}))$")


def valid_date(v):
    try:
        return isinstance(v, str) and bool(DATE_RE.match(v)) and bool(datetime.strptime(v, "%Y-%m-%d"))
    except ValueError:
        return False


def valid_datetime(v):
    m = isinstance(v, str) and DATETIME_RE.match(v)
    return bool(m) and valid_date(m.group(1)) and int(m.group(2)) < 24 and int(m.group(3)) < 60 \
        and int(m.group(4)) < 61 and (m.group(5) is None or (int(m.group(5)) < 24 and int(m.group(6)) < 60))


def progress_problems(d, folder):
    """Schema violations of a parsed progress.json, as short messages ([] when it conforms)."""
    def text(v):
        return isinstance(v, str) and len(v) >= 1

    def number(v):
        return isinstance(v, int) and not isinstance(v, bool)

    if not isinstance(d, dict):
        return ["최상위가 객체가 아님"]
    out = [f"알 수 없는 키 {k}" for k in d if k not in ("schemaVersion", "project", "template", "generatedAt", "stages")]
    out += [f"{k} 없음" for k in ("schemaVersion", "project", "stages") if k not in d]
    if "schemaVersion" in d and not (number(d["schemaVersion"]) and d["schemaVersion"] == 1):
        out.append(f"지원하지 않는 schemaVersion {d['schemaVersion']!r}")
    if "project" in d:
        if not text(d["project"]):
            out.append("project 가 비어 있지 않은 문자열이 아님")
        elif d["project"] != folder:  # the schema: "as the project folder is named; the project's identity"
            out.append(f"project {d['project']!r} 가 폴더 이름과 다름")
    if "template" in d and not text(d["template"]):
        out.append("template 이 비어 있지 않은 문자열이 아님")
    if "generatedAt" in d and not valid_datetime(d["generatedAt"]):
        out.append(f"generatedAt {d['generatedAt']!r} 가 date-time 이 아님")
    stages = d.get("stages")
    if "stages" in d and not (isinstance(stages, list) and stages):
        out.append("stages 가 비어 있지 않은 배열이 아님")
        stages = []
    nos, paths = set(), set()
    for i, st in enumerate(stages or []):
        where = f"stages[{i}]"
        if not isinstance(st, dict):
            out.append(f"{where} 가 객체가 아님")
            continue
        out += [f"{where}: 알 수 없는 키 {k}" for k in st if k not in ("no", "name", "steps")]
        out += [f"{where}: {k} 없음" for k in ("no", "name", "steps") if k not in st]
        if "no" in st:
            if not (number(st["no"]) and st["no"] >= 1):
                out.append(f"{where}: no 가 1 이상의 정수가 아님")
            elif st["no"] in nos:
                out.append(f"{where}: no {st['no']} 중복")
            else:
                nos.add(st["no"])
        if "name" in st and not text(st["name"]):
            out.append(f"{where}: name 이 비어 있지 않은 문자열이 아님")
        if "steps" in st and not isinstance(st["steps"], list):
            out.append(f"{where}: steps 가 배열이 아님")
            continue
        for j, sp in enumerate(st.get("steps") or []):
            at = f"{where}.steps[{j}]"
            if not isinstance(sp, dict):
                out.append(f"{at} 가 객체가 아님")
                continue
            out += [f"{at}: 알 수 없는 키 {k}" for k in sp if k not in ("path", "date", "endDate", "status")]
            out += [f"{at}: {k} 없음" for k in ("path", "status") if k not in sp]
            if "path" in sp:
                if not text(sp["path"]):
                    out.append(f"{at}: path 가 비어 있지 않은 문자열이 아님")
                elif sp["path"] in paths:
                    out.append(f"{at}: path {sp['path']!r} 중복")
                else:
                    paths.add(sp["path"])
            if "status" in sp and sp["status"] not in STEP_STATES:
                out.append(f"{at}: status {sp['status']!r} 가 {'·'.join(STEP_STATES)} 가 아님")
            for k in ("date", "endDate"):
                if k in sp and not valid_date(sp[k]):
                    out.append(f"{at}: {k} {sp[k]!r} 가 date(YYYY-MM-DD) 가 아님")
            if sp.get("status") == "scheduling":
                if "date" in sp or "endDate" in sp:
                    out.append(f"{at}: scheduling 인데 날짜가 있음")
            elif "status" in sp and "date" not in sp:
                out.append(f"{at}: {sp['status']} 인데 date 없음")
    return out


def flow_status(counts):
    """Status of a group of steps (a stage, or the whole project) from its per-status counts.
    empty: no steps. done: all done. failed: all finished (done/failed), some failed. active: a step in progress, or
    some finished while others are still to come. pending: none started, some scheduled. scheduling: all undated."""
    total = sum(counts.values())
    finished = counts["done"] + counts["failed"]
    if not total:
        return "empty"
    if counts["done"] == total:
        return "done"
    if finished == total:
        return "failed"
    if counts["active"] or finished:
        return "active"
    return "pending" if counts["pending"] else "scheduling"


def tally(steps):
    counts = dict.fromkeys(STEP_STATES, 0)
    for sp in steps:
        counts[sp["status"]] += 1
    total = sum(counts.values())
    return {"status": flow_status(counts), "total": total, "counts": counts,
            "ratio": round(counts["done"] / total, 4) if total else None}


def span(steps):
    """(start, end) over the dated steps: earliest date, latest endDate (a one-day item ends on its date).
    Planned dates of pending steps count too."""
    dated = [sp for sp in steps if sp.get("date")]
    if not dated:
        return None, None
    return min(sp["date"] for sp in dated), max(sp.get("endDate") or sp["date"] for sp in dated)


def current_stage(stages):
    """The earliest active stage; with none active, the first stage still to start (pending/scheduling) after the
    last one with any finished step (the first such stage when nothing has finished); None when nothing is left."""
    active = [st for st in stages if st["status"] == "active"]
    if active:
        return active[0]
    worked = [i for i, st in enumerate(stages) if st["counts"]["done"] or st["counts"]["failed"]]
    rest = stages[worked[-1] + 1:] if worked else stages
    return next((st for st in rest if st["status"] in ("pending", "scheduling")), None)


def derive_progress(d):
    """Parsed, schema-valid progress.json -> the derived view: stages in flow order with status, span and counts,
    plus the project's totals and current stage."""
    stages = []
    for st in sorted(d["stages"], key=lambda st: st["no"]):
        steps = [{**sp, "title": os.path.splitext(os.path.basename(sp["path"]))[0]} for sp in st["steps"]]
        start, end = span(steps)
        stages.append({"no": st["no"], "name": st["name"], **tally(steps), "start": start, "end": end,
                       "steps": sorted(steps, key=lambda sp: (sp.get("date") or "9999", sp["path"]))})
    every = [sp for st in stages for sp in st["steps"]]
    start, end = span(every)
    cur = current_stage(stages)
    return {**tally(every), "start": start, "end": end, "template": d.get("template"),
            "generated_at": d.get("generatedAt"), "stage_count": len(stages),
            "current": cur and {"no": cur["no"], "name": cur["name"], "status": cur["status"]}, "stages": stages}


def read_progress(path, mtime, base, name):
    entry = {"name": name, "dir": base, "path": path, "mtime": mtime, "error": None}
    try:
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
    except (OSError, ValueError) as e:
        return {**entry, "error": "읽지 못함: " + short(e, 200)}
    problems = progress_problems(d, name)
    if problems:
        return {**entry, "error": f"스키마 불일치 ({len(problems)}건): " + short("; ".join(problems[:5]), 400),
                "problems": problems[:50]}
    return {**entry, **derive_progress(d)}
