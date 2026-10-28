#!/usr/bin/env python3
"""Fake-input checks for how a session is named (세션 제목): /rename (custom-title) > ai-title > first prompt.

    python3 scripts/check-session-title.py

Exits 1 if any check fails. Standard library only; reads no real transcript.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "server"))
from adash.features.designs.refs import DesignReads  # noqa: E402
from adash.features.sessions.session import Session  # noqa: E402

results = []


def check(name, cond, got):
    results.append((name, bool(cond)))
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else f"\n     got: {got}"))


PROMPT = {"type": "user", "message": {"role": "user", "content": "첫 프롬프트로 시작"}}
AI = {"type": "ai-title", "aiTitle": "설계문서 기반 구현"}
CUSTOM = {"type": "custom-title", "customTitle": "PRD-19 코디네이터", "sessionId": "x"}  # as Claude Code writes it


def claude_title(*recs):
    s = Session("/tmp/x.jsonl", "claude")
    for r in recs:
        s.parse_claude(r, None)
    return s.title


def refs_title(*recs):
    d = DesignReads("/tmp/x.jsonl", "claude")
    for r in recs:
        d.feed(r, None)
    return d.title


for label, title in (("Session", claude_title), ("DesignReads", refs_title)):
    check(f"{label}: 첫 프롬프트만 있으면 그것", title(PROMPT) == "첫 프롬프트로 시작", title(PROMPT))
    check(f"{label}: ai-title 이 첫 프롬프트보다 앞섬", title(PROMPT, AI) == "설계문서 기반 구현", title(PROMPT, AI))
    check(f"{label}: /rename 이 ai-title 보다 앞섬", title(PROMPT, AI, CUSTOM) == "PRD-19 코디네이터", title(PROMPT, AI, CUSTOM))
    check(f"{label}: /rename 뒤에 새 ai-title 이 와도 /rename 유지", title(PROMPT, CUSTOM, AI) == "PRD-19 코디네이터", title(PROMPT, CUSTOM, AI))
    renamed = dict(CUSTOM, customTitle="다시 바꾼 이름")
    check(f"{label}: 다시 /rename 하면 마지막 이름", title(CUSTOM, AI, renamed) == "다시 바꾼 이름", title(CUSTOM, AI, renamed))

print(f"\n{sum(ok for _, ok in results)}/{len(results)} 통과")
sys.exit(0 if all(ok for _, ok in results) else 1)
