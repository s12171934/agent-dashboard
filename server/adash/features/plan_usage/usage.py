"""Claude plan usage: the 5-hour session and weekly buckets, and extra usage credits, from the account's OAuth API."""

import json
import os
import pwd
import subprocess
import time
import urllib.error
import urllib.request
from datetime import datetime

from adash.core.state import bump, lock, loop_failed, loop_ok
from adash.core.util import short

# ---- 플랜 사용량: GET /api/oauth/usage with the token Claude Code keeps fresh ----
# The token is read on every pass (Claude Code refreshes it) from the keychain first, then ~/.claude/.credentials.json,
# which Claude Code may stop updating; an expired candidate is skipped. The token is never logged or sent to the page.
# Calls close together get 429, so the pass runs every few minutes and waits longer after a 429.
USAGE_API = "https://api.anthropic.com/api/oauth/usage"
USAGE_EVERY = 300
USAGE_BACKOFF = 900
REAL_HOME = pwd.getpwuid(os.getuid()).pw_dir  # an Aside shell remaps $HOME
BUCKET_NAMES = {"session": "5시간 세션", "weekly_all": "주간 전체", "weekly_scoped": "주간"}
plan_usage = {"available": False}  # rebound whole, so readers need no lock


def load_token():
    """-> (token, source) of the first unexpired candidate; raises when there is none."""
    candidates = []
    try:
        out = subprocess.run(["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"],
                             capture_output=True, text=True, timeout=10)
        if out.returncode == 0:
            candidates.append(("keychain", json.loads(out.stdout)))
    except (OSError, ValueError, subprocess.TimeoutExpired):
        pass
    try:
        with open(os.path.join(REAL_HOME, ".claude", ".credentials.json")) as f:
            candidates.append(("credentials.json", json.load(f)))
    except (OSError, ValueError):
        pass
    for source, data in candidates:
        oauth = data.get("claudeAiOauth") or {}
        tok, exp = oauth.get("accessToken"), oauth.get("expiresAt")
        if tok and (exp is None or exp / 1000 > time.time()):
            return tok, source
    raise RuntimeError("유효한 Claude Code 토큰 없음 — Claude Code 를 한 번 실행하면 갱신됩니다")


def epoch(iso):
    return iso and datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()


def interpret(raw, source):
    """API response -> what the page draws. Credits come in cents."""
    ex = raw.get("extra_usage") or {}
    limits = []
    for b in raw.get("limits") or []:
        model = ((b.get("scope") or {}).get("model") or {}).get("display_name")
        name = BUCKET_NAMES.get(b.get("kind"), b.get("kind") or "?")
        limits.append({"kind": b.get("kind"), "name": f"{name} · {model}" if model else name, "percent": b.get("percent"),
                       "severity": b.get("severity"), "active": bool(b.get("is_active")), "resets_at": epoch(b.get("resets_at"))})
    cents = lambda v: None if v is None else round(v / 100, 2)
    return {"available": True, "at": time.time(), "source": source, "error": None, "limits": limits,
            "extra": {"used_usd": cents(ex.get("used_credits")), "limit_usd": cents(ex.get("monthly_limit")),
                      "reached": bool(ex.get("spend_limit_reached"))} if ex else None}


def fetch_usage():
    global plan_usage
    tok, source = load_token()
    req = urllib.request.Request(USAGE_API, headers={"Authorization": f"Bearer {tok}", "anthropic-beta": "oauth-2025-04-20"})
    with urllib.request.urlopen(req, timeout=20) as r:
        cur = interpret(json.load(r), source)
    with lock:
        plan_usage = cur
        bump()


def plan_usage_loop():
    global plan_usage
    while True:
        wait = USAGE_EVERY
        try:
            fetch_usage()
            loop_ok("plan_usage")
        except Exception as e:
            if isinstance(e, urllib.error.HTTPError) and e.code == 429:
                wait = USAGE_BACKOFF
            # The last good figures stay on screen, marked with what went wrong.
            with lock:
                plan_usage = {**plan_usage, "error": short(f"HTTP {e.code}" if isinstance(e, urllib.error.HTTPError) else str(e), 200)}
            loop_failed("plan_usage", e)
        time.sleep(wait)
