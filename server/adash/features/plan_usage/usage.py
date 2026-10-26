"""Plan usage of every subscription account on this Mac: Claude (5-hour session, weekly, extra usage credits) and Codex
(ChatGPT rate-limit windows), each from its provider's usage API with the token the CLI or Orca keeps."""

import base64
import hashlib
import json
import os
import pwd
import subprocess
import time
import urllib.error
import urllib.request
from datetime import datetime

from adash.core.config import HERE
from adash.core.state import bump, lock, loop_failed, loop_ok
from adash.core.util import short

# ---- 플랜 사용량: one card per account, wherever its token lives ----
# Claude: the host login (keychain `Claude Code-credentials`, then ~/.claude/.credentials.json) and the accounts Orca
# switches between (keychain `Orca Claude Code Managed Credentials`, one item per Orca account id). The host token's
# account is learned once per token from /api/oauth/profile, so an Orca account that is the host login right now is
# one card, read with whichever token is still valid.
# Codex: ~/.codex/auth.json and Orca's codex-accounts/*/home/auth.json, one card per ChatGPT account id.
# Tokens are only read: never refreshed (that would rotate the copy the CLI or Orca holds), logged or sent to the page.
# An account with no valid token keeps its last figures (plan-usage.json) and says why they are not moving.
# Calls close together get 429: each account is read at most once per USAGE_EVERY, also across restarts (the last
# call time is kept in plan-usage.json), and a 429 or 401 pushes the next call out, doubling up to USAGE_BACKOFF_MAX
# (a Retry-After longer than that wins). The profile call is made once per new host token.
CLAUDE_USAGE = "https://api.anthropic.com/api/oauth/usage"
CLAUDE_PROFILE = "https://api.anthropic.com/api/oauth/profile"
CODEX_USAGE = "https://chatgpt.com/backend-api/wham/usage"
USAGE_EVERY = 300
USAGE_BACKOFF = 900
USAGE_BACKOFF_MAX = 3600
REAL_HOME = pwd.getpwuid(os.getuid()).pw_dir  # an Aside shell remaps $HOME
ORCA = os.path.join(REAL_HOME, "Library/Application Support/orca")
CACHE = os.path.join(HERE, "plan-usage.json")
BUCKET_NAMES = {"session": "5시간 세션", "weekly_all": "주간 전체", "weekly_scoped": "주간"}
CLAUDE_PLANS = {"claude_team": "Team", "claude_enterprise": "Enterprise", "claude_max": "Max", "claude_pro": "Pro"}
plan_usage = {"available": False, "accounts": []}  # rebound whole, so readers need no lock
profiles = {}  # sha256 of a host token -> {uuid, email, plan}: which account that login is
next_at = {}  # account key -> earliest time to call its usage API again
backoff = {}  # account key -> the wait after its last 429/401, doubled on each one in a row


def keychain(service, account=None):
    try:
        out = subprocess.run(["security", "find-generic-password", "-s", service, *(["-a", account] if account else []), "-w"],
                             capture_output=True, text=True, timeout=10)
        return json.loads(out.stdout) if out.returncode == 0 else None
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return None


def read_json(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def jwt_claims(tok):
    try:
        p = tok.split(".")[1]
        return json.loads(base64.urlsafe_b64decode(p + "=" * (-len(p) % 4)))
    except (IndexError, ValueError, AttributeError):
        return {}


def get_json(url, headers):
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=20) as r:
        return json.load(r)


def claude_headers(tok):
    return {"Authorization": f"Bearer {tok}", "anthropic-beta": "oauth-2025-04-20"}


def epoch(iso):
    return iso and datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()


def claude_tokens():
    """-> [(source, token, expires_at or None, known account {uuid, email, plan} or None)]."""
    out = []
    for source, data in (("keychain", keychain("Claude Code-credentials")),
                         ("credentials.json", read_json(os.path.join(REAL_HOME, ".claude", ".credentials.json")))):
        o = (data or {}).get("claudeAiOauth") or {}
        if o.get("accessToken"):
            out.append((source, o["accessToken"], o.get("expiresAt") and o["expiresAt"] / 1000, None))
    root = os.path.join(ORCA, "claude-accounts")
    for oid in sorted(os.listdir(root)) if os.path.isdir(root) else []:
        acct = read_json(os.path.join(root, oid, "auth", "oauth-account.json")) or {}
        if not acct.get("accountUuid"):
            continue
        o = (keychain("Orca Claude Code Managed Credentials", oid) or {}).get("claudeAiOauth") or {}
        out.append(("orca", o.get("accessToken"), o.get("expiresAt") and o["expiresAt"] / 1000,
                    {"uuid": acct["accountUuid"], "email": acct.get("emailAddress"),
                     "plan": CLAUDE_PLANS.get(acct.get("organizationType"), acct.get("organizationType"))}))
    return out


def codex_tokens():
    """-> [(source, access token, expires_at, {uuid, email, plan}, account id)]."""
    paths = [("~/.codex", os.path.join(REAL_HOME, ".codex", "auth.json"))]
    root = os.path.join(ORCA, "codex-accounts")
    paths += [("orca", os.path.join(root, d, "home", "auth.json")) for d in (sorted(os.listdir(root)) if os.path.isdir(root) else [])]
    out = []
    for source, path in paths:
        t = (read_json(path) or {}).get("tokens") or {}
        if not t.get("access_token") or not t.get("account_id"):
            continue
        c = jwt_claims(t.get("id_token") or "")
        plan = (c.get("https://api.openai.com/auth") or {}).get("chatgpt_plan_type")
        plan = plan and plan.removeprefix("self_serve_").replace("_", " ").title()
        out.append((source, t["access_token"], jwt_claims(t["access_token"]).get("exp"),
                    {"uuid": t["account_id"], "email": c.get("email"), "plan": plan}, t["account_id"]))
    return out


def claude_usage(raw):
    ex = raw.get("extra_usage") or {}
    limits = []
    for b in raw.get("limits") or []:
        model = ((b.get("scope") or {}).get("model") or {}).get("display_name")
        name = BUCKET_NAMES.get(b.get("kind"), b.get("kind") or "?")
        limits.append({"kind": b.get("kind"), "name": f"{name} · {model}" if model else name, "percent": b.get("percent"),
                       "active": bool(b.get("is_active")), "resets_at": epoch(b.get("resets_at"))})
    cents = lambda v: None if v is None else round(v / 100, 2)
    extra = {"used_usd": cents(ex.get("used_credits")), "limit_usd": cents(ex.get("monthly_limit")),
             "reached": bool(ex.get("spend_limit_reached"))} if ex else None
    return limits, extra


def window_name(sec):
    return "5시간" if sec == 18000 else "주간" if sec == 604800 else f"{round(sec / 3600)}시간" if sec else "?"


def codex_usage(raw):
    rl = raw.get("rate_limit") or {}
    limits = [{"kind": k, "name": window_name(w.get("limit_window_seconds")), "percent": w.get("used_percent"),
               "active": bool(rl.get("limit_reached")), "resets_at": w.get("reset_at")}
              for k in ("primary_window", "secondary_window") if (w := rl.get(k))]
    for extra in raw.get("additional_rate_limits") or []:  # per-model windows, when the plan has them
        for k in ("primary_window", "secondary_window"):
            if (w := (extra.get("rate_limit") or {}).get(k)):
                limits.append({"kind": k, "name": f'{window_name(w.get("limit_window_seconds"))} · {extra.get("limit_name") or "?"}',
                               "percent": w.get("used_percent"), "active": False, "resets_at": w.get("reset_at")})
    cr = raw.get("credits") or {}
    credits = {"has": bool(cr.get("has_credits")), "unlimited": bool(cr.get("unlimited")), "balance": cr.get("balance"),
               "reached": bool(cr.get("overage_limit_reached"))} if cr else None
    return limits, credits


def error_text(e):
    if isinstance(e, urllib.error.HTTPError):
        return {401: "토큰 만료·폐기", 403: "권한 없음", 429: "요청 한도(잠시 뒤 다시)"}.get(e.code, f"HTTP {e.code}")
    return short(str(e), 160)


def collect(prev):
    """-> the account cards: this pass's reads, laid over the previous figures."""
    now = time.time()
    cards = {}  # key -> card; key is provider:account uuid

    def card(provider, who):
        key = f"{provider}:{who['uuid']}"
        c = cards.get(key)
        if not c:
            old = prev.get(key) or {}
            c = cards[key] = {**old, "key": key, "provider": provider, "tokens": [], "note": None, "stale": bool(old.get("at"))}
        for f in ("email", "plan"):
            c[f] = who.get(f) or c.get(f)
        return c

    for source, tok, exp, who in claude_tokens():
        if who is None:  # the host login: ask once per token which account it is
            if exp and exp <= now:
                continue
            h = hashlib.sha256(tok.encode()).hexdigest()
            if h not in profiles:
                try:
                    p = get_json(CLAUDE_PROFILE, claude_headers(tok))
                except urllib.error.HTTPError:
                    continue
                org = p.get("organization") or {}
                profiles[h] = {"uuid": (p.get("account") or {}).get("uuid"), "email": (p.get("account") or {}).get("email"),
                               "plan": CLAUDE_PLANS.get(org.get("organization_type"), org.get("organization_type"))}
            who = profiles[h]
            if not who.get("uuid"):
                continue
        card("claude", who)["tokens"].append((source, tok, exp))
    for source, tok, exp, who, acct in codex_tokens():
        card("codex", who)["tokens"].append((source, tok, exp, acct))

    for key, c in cards.items():
        live = [t for t in c.pop("tokens") if t[1] and not (t[2] and t[2] <= now)]
        if not live:
            c["note"] = ("토큰 만료 — Orca 에서 이 계정으로 전환해 쓰면 다시 읽힙니다" if c["provider"] == "claude"
                         else "토큰 만료 — Codex 를 한 번 실행하면 다시 읽힙니다")
            continue
        if now < next_at.setdefault(key, c.get("checked", 0) + USAGE_EVERY):
            c["stale"] = bool(c.get("error"))
            continue
        source, tok = live[0][0], live[0][1]
        next_at[key] = now + USAGE_EVERY
        c["checked"], c["source"] = now, source
        try:
            if c["provider"] == "claude":
                c["limits"], c["extra"] = claude_usage(get_json(CLAUDE_USAGE, claude_headers(tok)))
            else:
                c["limits"], c["credits"] = codex_usage(get_json(CODEX_USAGE, {
                    "Authorization": f"Bearer {tok}", "ChatGPT-Account-Id": live[0][3], "User-Agent": "codex-cli"}))
            c["at"], c["error"], c["stale"] = now, None, False
            backoff.pop(key, None)
        except Exception as e:
            if isinstance(e, urllib.error.HTTPError) and e.code in (401, 429):
                wait = backoff[key] = min(USAGE_BACKOFF_MAX, backoff.get(key, USAGE_BACKOFF // 2) * 2)
                try:
                    wait = max(wait, float(e.headers.get("Retry-After") or 0))
                except ValueError:
                    pass
                next_at[key] = now + wait
            c["error"], c["stale"] = error_text(e), bool(c.get("at"))
    return cards


def save(cards):
    try:
        tmp = CACHE + ".tmp"
        with open(tmp, "w") as f:
            json.dump(cards, f, ensure_ascii=False)
        os.replace(tmp, CACHE)
    except OSError:
        pass


def plan_usage_loop():
    global plan_usage
    prev = read_json(CACHE) or {}
    while True:
        try:
            cards = collect(prev)
            for key, old in prev.items():  # an account whose token is gone from this Mac keeps its last card
                cards.setdefault(key, {**old, "stale": True, "note": "이 Mac 에서 토큰을 찾지 못함"})
            prev = cards
            save(cards)
            order = {"claude": 0, "codex": 1}
            with lock:
                plan_usage = {"available": bool(cards), "accounts": sorted(cards.values(), key=lambda c: (order.get(c["provider"], 9), bool(c.get("note")), c.get("email") or ""))}
                bump()
            loop_ok("plan_usage")
        except Exception as e:
            loop_failed("plan_usage", e)
        time.sleep(60)  # each account is read every USAGE_EVERY; this pass only notices a switched login sooner
