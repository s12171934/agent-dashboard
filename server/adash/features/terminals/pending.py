"""Agents Orca runs that have no transcript yet. Claude Code writes its transcript only with the first prompt, so an
agent started without one (「새 에이전트」 with the prompt left empty, a tab opened in Orca) has no session to list. Its
terminal does say which agent runs there (agentIdentity, cleared when the agent exits): such a terminal no session
maps to is listed as a session waiting for its first prompt, until the transcript shows up and takes its place."""

import time
from datetime import datetime, timezone

from adash.features.orca_runs.store import orca_state
from adash.features.sessions.config import CLAUDE_CTX_WINDOW
from adash.features.sessions.places import place_of


PREFIX = "orca-terminal:"  # path of a pending session; no transcript has it
first_seen = {}  # terminal -> when a snapshot first found its agent without a session
models = {}  # terminal -> the model the page launched it with
pending = {}  # path -> summary, as the last /api/state listed them (rebound, never edited in place)


def iso(t):
    return datetime.fromtimestamp(t, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def summary(t, seen):
    ts = iso(seen)
    return {
        "role": "solo", "coord_handle": None, "task_id": None, "task_ids": [], "own_handle": t["handle"],
        "coordinates": False, "cost": 0.0, "cost_parts": None, "id": t["handle"], "path": PREFIX + t["handle"],
        "kind": t["agentIdentity"], "title": t.get("title") or "새 에이전트", "cwd": t.get("worktreePath"),
        "model": models.get(t["handle"]), "parent": None, "started": ts, "last_ts": ts,
        "state": "wait", "state_reason": "첫 프롬프트 대기 (아직 대화 기록 없음)", "live": False, "bg_tasks": 0,
        "turns": 0, "ctx_now": 0, "ctx_peak": 0, "ctx_avg": 0,
        "ctx_window": CLAUDE_CTX_WINDOW if t["agentIdentity"] == "claude" else None, "compactions": 0, "tool_calls": 0,
        "skills": 0, "skill_kinds": 0, "skill_use": {}, "mcp_use": {}, "use_tok": {}, "last_action": None,
        "plan": None, "place": place_of(t.get("worktreePath")), "made_terms": [], "slots": {},
        "tokens": {"input": 0, "cache_read": 0, "cache_write": 0, "output": 0},
        "manual_idle": False, "decision": None, "pending": True,
    }


def pending_sessions(claimed):
    """Summaries for the connected agent terminals outside `claimed` (the terminals sessions were mapped to)."""
    global pending
    now, out = time.time(), {}
    for t in orca_state.get("terminals", []):
        h = t.get("handle")
        if t.get("connected") and t.get("agentIdentity") in ("claude", "codex") and h not in claimed:
            out[PREFIX + h] = summary(t, first_seen.setdefault(h, now))
    for h in [h for h in first_seen if PREFIX + h not in out]:
        del first_seen[h]
    pending = out
    return list(out.values())


def pending_detail(path):
    """/api/session for a pending session: its summary with an empty history."""
    sm = pending.get(path)
    return sm and {**sm, "turn_list": [], "compaction_turns": [], "by_tool": {}, "log": [], "cats": {}, "plans": []}
