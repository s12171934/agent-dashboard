"""Why and in which round a driver added a box after start."""

import os
import re

from adash.core.files import read_json_cached, read_text_cached
from adash.core.state import bump, lock
from adash.features.plans.store import ext_plans


# A box the driver adds after start (a fix for integration-review findings or a scene mismatch) carries only fix_source
# in plan.json. Its reason is the 「- 추가 사유: <reason> — <date>」 line the driver writes under that box in the launch
# sheet (the ticket state <package>.json beside the plan names the sheet), else the findings it was added for; a review's
# round is the 「N라운드」/「N차」 in its title. They are attached as reason_auto / round_auto; fix_reason / round written
# by the driver itself win on the page.
ROUND_RE = re.compile(r"(\d+)\s*(?:라운드|차)")
ROUND_KINDS = ("integration-review", "pr-review", "completion-review")


def sheet_reasons(text):
    """{box index: reason} from a launch sheet's 「### N. title」 blocks."""
    out, idx = {}, None
    for line in text.splitlines():
        m = re.match(r"###\s+(\d+)\.", line)
        if m:
            idx = int(m.group(1))
            continue
        m = re.match(r"-\s*추가 사유:\s*(.+?)(?:\s+—\s+\d{4}-\d{2}-\d{2})?\s*$", line)
        if m and idx is not None:
            out[idx] = m.group(1)
    return out


def round_in(*texts):
    m = next((m for t in texts if t and (m := ROUND_RE.search(t))), None)
    return int(m.group(1)) if m else None


def attach_box_notes():
    changed = False
    for plan in list(ext_plans.values()):
        base = os.path.dirname(plan["path"])
        for t in plan.get("tickets") or []:
            st = read_json_cached(os.path.join(base, f"{t['package']}.json")) if isinstance(t.get("package"), str) else {}
            boxes = {b.get("index"): b for b in st.get("checkboxes") or [] if isinstance(b, dict)}
            sheet = st.get("sheet_path")
            reasons = sheet_reasons(read_text_cached(sheet)) if isinstance(sheet, str) else {}
            sessions = [s for s in t.get("sessions") or [] if isinstance(s, dict)]
            ir = st.get("integration_review") if isinstance(st.get("integration_review"), dict) else {}
            ir_round = ir.get("round") or next((r for s in sessions if s.get("kind") == "integration-review"
                                                and (r := round_in(s.get("title"), s.get("key")))), None)
            for s in sessions:
                note = {}
                if s.get("kind") in ROUND_KINDS:
                    note["round_auto"] = round_in(s.get("title"), s.get("key")) or (ir_round if s["kind"] == "integration-review" else None)
                if s.get("fix_source"):
                    box = boxes.get(s.get("box")) or {}
                    reason = reasons.get(s.get("box"))
                    if not reason and box.get("fix_findings"):
                        n = sum(read_text_cached(p).count("\n### ") for p in box["fix_findings"] if isinstance(p, str))
                        reason = f"findings {n}건" if n else None
                    note["reason_auto"] = reason
                    note["round_auto"] = round_in(s.get("title")) or (ir_round if s["fix_source"] == "integration-review" else 1)
                if any(s.get(k) != v for k, v in note.items()):
                    with lock:
                        s.update(note)
                    changed = True
    if changed:  # one version for the pass: a re-read plan brings every box back without its notes
        with lock:
            bump()
