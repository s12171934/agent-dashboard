"""The normal flow, read from the QA driver's state contract."""

import os
import re

from adash.core.prefs import prefs
from adash.features.review.qa import QA_STAGES


# ---- Flow check: does each agent follow its contract? ----
# The normal flow is read from contracts, not written into the page: the QA driver's stage order and approval gates from
# its state contract (qa-ticket-driver exports/state-contract.md), the checkbox roles 구현 → 리뷰 codex · 리뷰 claude → 판정
# from CHECKBOX_FLOW (prefs.json "checkbox_flow" overrides it), and each session's own aplan plan for its steps.
# flow_check() turns them into deviations, one {id, rule, severity, reason, evidence, ...} per session / task / checkbox /
# ticket, carried on /api/state. A rule whose evidence is missing (no PR state, no finished sibling, no Jira) stays
# silent rather than guessing. 「정상으로 표시」 stores the deviation id in prefs.json flow_ok, and it does not come back.
QA_CONTRACT = os.path.expanduser(prefs.get("qa_contract") or "~/.claude/skills/qa-ticket-driver/exports/state-contract.md")
CHECKBOX_FLOW = prefs.get("checkbox_flow") or {
    "roles": ["구현", "리뷰 codex", "리뷰 claude", "판정"],  # one round, in order
    "work": ["구현"],                                          # a new one of these starts another round
    "review": ["리뷰 codex", "리뷰 claude"],                    # each needs a result (or a cancel) before 판정 passes
    "verdict": ["판정"],
}


_qa_contract = {"mtime": None, "value": None}


def parse_qa_contract(text):
    """The state contract's two tables -> stages in order, each with who writes its signal (a user gate when that is
    사용자) and the signal directory when the stage is one file. None if the stage table is not there."""
    writer = {}
    for m in re.finditer(r"^\|\s*`(\w+)/[^`]*`[^|]*\|\s*([^|]+?)\s*\|", text, re.M):
        writer.setdefault(m.group(1), m.group(2))
    stages = []
    for m in re.finditer(r"^\|\s*(\d+)\s*\|\s*`(\w+)`\s*([^|]*?)\s*\|\s*(.*?)\s*\|\s*$", text, re.M):
        no, key, label, cond = int(m.group(1)), m.group(2), m.group(3).strip(), m.group(4)
        sig = re.fullmatch(r"`(\w+)/<KEY>(?:\.md)?`", cond.strip())
        first = re.search(r"`(\w+)/", cond)
        by = writer.get(first.group(1), "") if first else ""
        stages.append({"no": no, "key": key, "label": label, "by": by, "user": "사용자" in by,
                       "signal": sig.group(1) if sig else None})
    if not stages:
        return None
    stages.sort(key=lambda x: x["no"])
    return stages


def qa_contract():
    """The QA stage contract, re-read when the file changes; QA_STAGES (no gates known) when it cannot be read."""
    try:
        mtime = os.path.getmtime(QA_CONTRACT)
    except OSError:
        mtime = None
    if mtime != _qa_contract["mtime"] or _qa_contract["value"] is None:
        stages = None
        if mtime is not None:
            try:
                with open(QA_CONTRACT, encoding="utf-8") as f:
                    stages = parse_qa_contract(f.read())
            except OSError:
                stages = None
        _qa_contract.update(mtime=mtime, value={
            "source": QA_CONTRACT if stages else None,
            "stages": stages or [{"no": i + 1, "key": k, "label": k, "by": "", "user": False, "signal": None}
                                 for i, k in enumerate(QA_STAGES)]})
    return _qa_contract["value"]


def flow_contracts():
    return {"qa": qa_contract(), "checkbox": {**CHECKBOX_FLOW, "source": "prefs.json checkbox_flow" if prefs.get("checkbox_flow") else "server.py CHECKBOX_FLOW"}}
