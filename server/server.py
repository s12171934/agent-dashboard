#!/usr/bin/env python3
"""Local agent dashboard metrics server — REST + SSE for Claude/Codex sessions and Orca runs.

Stdlib only. Tails session logs incrementally and pushes change notices over SSE. The page itself lives in
../frontend and is served elsewhere (Cloudflare Pages); this process only answers /api/* and /events.

    python3 server.py [--port 8787] [--hours 24] [--host 127.0.0.1] [--origin https://<project>.pages.dev]
                      [--projects-dir <folder of project folders>]

There is no authentication: any client that reaches a bound address (loopback, the tailnet) is trusted.
Requests whose Host header is not one of those addresses are refused, which stops DNS rebinding, and a
browser request from an Origin outside --origin is refused, so other web pages cannot read or act through it.
"""
import argparse
import collections
import glob
import gzip
import base64
import json
import os
import re
import subprocess
import sys
import threading
import time
import traceback
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlparse
from urllib.request import Request, urlopen

HOME = os.path.expanduser("~")
CLAUDE_GLOB = os.path.join(HOME, ".claude/projects/**/*.jsonl")
CODEX_GLOBS = [
    os.path.join(HOME, "Library/Application Support/orca/**/sessions/**/rollout-*.jsonl"),
    os.path.join(HOME, ".codex/sessions/**/rollout-*.jsonl"),
]
CLAUDE_CTX_WINDOW = 200_000  # assumed; Claude logs do not record the window
# Models seen past 200k in any session run with a 1M window here, so their other sessions get 1M too
# (otherwise a fresh session would read 200k until it happens to cross it).
LONG_CTX_MODELS = set()
# Run state comes from turn boundaries in the transcript, not from how recent the last line is.
STALL_SECONDS = 15 * 60   # a turn left open this long without any record is reported as stalled
WAIT_SECONDS = 30 * 60    # a finished turn counts as "waiting for input" for this long, then idle
HOOK_STATUS = os.path.join(HOME, "Library/Application Support/orca/agent-hooks/last-status.json")
hooks = {}  # provider session id -> Orca hook status (Orca-managed Claude panes only)
LOG_LIMIT = 600
HERE = os.path.dirname(os.path.abspath(__file__))

# USD per 1M tokens: input, 5m cache write, 1h cache write, cache read, output.
# Claude rates: claude-api skill (cached 2026-09-25). GPT rates: OpenAI Standard tier,
# developers.openai.com/api/docs/pricing (checked 2026-10-06); OpenAI has one cache-write rate, used for both slots.
# Override or add models via pricing.json ({"model": [in, w5m, w1h, read, out], ...}).
PRICING = {
    "gpt-6.1-sol": (2, 2.5, 2.5, 0.10, 10),
    "gpt-6-astra": (10, 12.5, 12.5, 1.00, 50),
    "claude-opus-5-5": (4, 5, 8, 0.20, 20),
    "claude-opus-5": (5, 6.25, 10, 0.50, 25),
    "claude-opus-4-8": (5, 6.25, 10, 0.50, 25),
    "claude-fable-5-1": (10, 12.5, 20, 0.25, 50),
    "claude-fable-5": (10, 12.5, 20, 1.00, 50),
    "claude-sonnet-5-5": (2, 2.5, 4, 0.20, 10),
    "claude-sonnet-5": (2, 2.5, 4, 0.20, 10),
    "claude-haiku-4-5": (1, 1.25, 2, 0.10, 5),
}
# OpenAI bills a whole request at long-context rates once its prompt exceeds the threshold.
LONG_CONTEXT = {
    "gpt-6.1-sol": (272_000, (4, 5, 5, 0.20, 15)),
    "gpt-6-astra": (272_000, (20, 25, 25, 2.00, 75)),
}
try:
    with open(os.path.join(HERE, "pricing.json")) as _f:
        PRICING.update({k: tuple(v) for k, v in json.load(_f).items()})
except (OSError, ValueError):
    pass


def price_for(model, prompt_tokens=0):
    if not model:
        return None
    long = LONG_CONTEXT.get(model)
    if long and prompt_tokens > long[0]:
        return long[1]
    if model in PRICING:
        return PRICING[model]
    for name in sorted(PRICING, key=len, reverse=True):  # e.g. "claude-opus-5-5[1m]"
        if model.startswith(name):
            return PRICING[name]
    return None


BRIEF_COORD = re.compile(r"Your coordinator's terminal handle is:\s*(term_[0-9a-f-]{36})")
BRIEF_TASK = re.compile(r"Your task ID is:\s*(task_[0-9a-f]{12})")
COORD_CMD = re.compile(r"(?:^|[;&|\n(\"'/]\s*)orca orchestration (?:run-create|run-use|dispatch|worker-start)(?![\w-])")  # not dispatch-show etc.
HANDLE = re.compile(r"term_[0-9a-f-]{36}")
# Tool calls are counted by what they are for, not by tool name: a skill load, an MCP server, sub-agents,
# orchestration, shell, files, web. Codex has no Skill tool, so a read of .../skills/<name>/SKILL.md counts.
SKILL_PATH = re.compile(r"skills/([A-Za-z0-9_.-]+)/SKILL\.md")
ORCA_USE = re.compile(r"\borca\s+(?:orchestration|terminal|worktree|skills)\b")
SHELL_TOOLS = {"Bash", "exec", "exec_command", "local_shell_call", "shell", "Monitor", "BashOutput", "KillShell", "js"}
FILE_TOOLS = {"Read", "Write", "Edit", "MultiEdit", "Grep", "Glob", "LS", "NotebookEdit", "apply_patch"}
AGENT_TOOLS = {"Agent", "Task", "TaskStop", "SendMessage", "spawn_agent", "followup_task", "wait_agent",
               "send_message", "list_agents", "interrupt_agent"}
WEB_TOOLS = {"WebFetch", "WebSearch"}


def classify_tool(name, inp):
    """-> (category, skill names, MCP server)"""
    name = name or "?"
    text = inp if isinstance(inp, str) else json.dumps(inp, ensure_ascii=False) if inp else ""
    if name == "Skill" and isinstance(inp, dict):
        return "스킬", [inp.get("skill") or "?"], None
    if name.startswith("mcp__"):
        return "MCP", [], name.split("__")[1]
    skills = sorted(set(SKILL_PATH.findall(text)))
    if skills:
        return "스킬", skills, None
    if name in AGENT_TOOLS:
        return "서브에이전트", [], None
    if name in SHELL_TOOLS:
        return ("오케스트레이션" if ORCA_USE.search(text) else "셸"), [], None
    if name in FILE_TOOLS:
        return "파일", [], None
    if name in WEB_TOOLS:
        return "웹", [], None
    return "기타", [], None
# Task plans: the aplan CLI echoes APLAN:<base64 json> into its own tool result.
APLAN_TOKEN = re.compile(r"APLAN:([A-Za-z0-9_=-]+)")
# Claude Code background work: the launching tool's result names the task id, and a <task-notification> carrying
# the same id and a final <status> (or a Monitor expiry) ends it. TaskStop ends it from the session's side.
# Only the launching call's own result is read: the same phrases inside any other output (a grep over transcripts)
# would otherwise start phantom tasks.
# A foreground Bash past its timeout is moved to the background too.
BG_START = {"Bash": re.compile(r"^(?:Command running in background with ID: |Command did not complete within its \d+s timeout and was moved to the background \(ID: )(\w+)\)?\. Output is being written to: "),
            "Monitor": re.compile(r"Monitor started \(task (\w+)"),
            "Agent": re.compile(r"Async agent launched.*?agentId: (\w+)", re.S)}
BG_KIND = {"Bash": "Bash", "Monitor": "Monitor", "Agent": "에이전트"}
BG_NOTE = re.compile(r"<task-id>(\w+)</task-id>")
BG_END = re.compile(r"<status>(?:completed|failed|killed|stopped|cancelled|error)</status>|Monitor (?:expired|stopped|ended)")
BG_MAX_SECONDS = 6 * 3600  # a task whose end was never recorded (session killed, notice lost) stops counting
APLAN_CMD = re.compile(r"\baplan\b")
# Only a Run this session created or bound names its own terminal; run-list etc. echo other coordinators.
# A real `terminal create` call, however orca is invoked (orca, a full path, or a shell variable like $O),
# including inside $(...); a mention in text or a --help call does not count.
TERM_CREATE = re.compile(r"(?:^|[;&|\n(]\s*|\$\(\s*)(?:\S*/orca|orca|\$\{?\w+\}?) terminal create\b(?![^;&|\n]*--help)")
TERM_HANDLE_STR = re.compile(r'"handle\\*"\s*:\s*\\*"(term_[0-9a-f-]{36})')
OWN_RUN_CMD = re.compile(r"orchestration (?:run-create|run-use)(?![\w-])")
RUN_CREATE = re.compile(r"orchestration run-create(?![\w-])(?![^\n|;&]*--help)")
RUN_ID = re.compile(r"\brun_[0-9a-f]{12}\b")
COORD_HANDLE_STR = re.compile(r'coordinator_handle\\*"\s*:\s*\\*"(term_[0-9a-f-]{36})')


# No token: every client that reaches a bound address is trusted (the user's choice, 2026-10-13; the addresses are
# loopback and the tailnet). The Host check below only stops DNS rebinding, i.e. a web page in the user's own
# browser reaching this server under a domain it controls.
ALLOWED_HOSTS = {"127.0.0.1", "localhost", "::1"}  # main() adds every --host


def host_allowed(header):
    """Bound addresses, single-label MagicDNS names and *.ts.net names: no outside party can point those at us."""
    host = (header or "").strip().lower()
    if host.startswith("["):  # [::1]:8787
        host = host[1:host.find("]")]
    elif host.count(":") == 1:  # name:8787
        host = host.split(":")[0]
    return bool(host) and (host in ALLOWED_HOSTS or "." not in host or host.endswith(".ts.net"))


# The page is served from another origin (Cloudflare Pages), so browsers need CORS. Only these origins get it, and a
# browser request from any other Origin is refused outright: without this, any page the user opens could read the
# session logs or close terminals through their browser. main() adds every --origin; an origin also covers its
# subdomains, i.e. Pages preview deployments (<hash>.<project>.pages.dev).
ALLOWED_ORIGINS = set()
LOCAL_ORIGIN = re.compile(r"http://(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?")  # a local copy of ../frontend


def origin_allowed(origin):
    origin = origin.rstrip("/").lower()
    if LOCAL_ORIGIN.fullmatch(origin):
        return True
    for o in ALLOWED_ORIGINS:
        scheme, _, host = o.partition("://")
        if origin == o or (origin.startswith(scheme + "://") and origin.endswith("." + host)):
            return True
    return False


def log(msg):
    """server.log line with the local time, so a stall can be matched against Orca's daemon.log."""
    print(f"{time.strftime('%m-%d %H:%M:%S')} {msg}", flush=True)


class TimedLock:
    """threading.Lock that logs a hold or a wait longer than SLOW_LOCK seconds with the holder's call site,
    so a section that stalls every request (they all take this lock) shows up in server.log."""
    SLOW_LOCK = 2.0

    def __init__(self):
        self._l = threading.Lock()
        self._t = 0.0
        self._where = None

    def __enter__(self):
        t0 = time.monotonic()
        self._l.acquire()
        self._t = time.monotonic()
        f = sys._getframe(1)
        self._where = f"{f.f_code.co_name}:{f.f_lineno}"
        if self._t - t0 > self.SLOW_LOCK:
            log(f"lock: waited {self._t - t0:.1f}s at {self._where}")
        return self

    def __exit__(self, *exc):
        held, where = time.monotonic() - self._t, self._where
        self._l.release()
        if held > self.SLOW_LOCK:
            log(f"lock: held {held:.1f}s at {where}")


lock = TimedLock()
state_cache_lock = threading.Lock()  # one /api/state build at a time; the others wait and take its bytes
state_cache = {"v": -1, "body": b"", "gz": b"", "at": 0.0}
STATE_CACHE_SECONDS = 5  # health.now and the age-based states move without a version bump
version = 0
sessions = {}  # path -> Session

# User choices made in the UI, shared by every device: {"idle": {path: last_ts when marked}, "hidden": {path: when}}.
PREFS_PATH = os.path.join(HERE, "prefs.json")
try:
    with open(PREFS_PATH) as _f:
        prefs = json.load(_f)
except (OSError, ValueError):
    prefs = {}
prefs.setdefault("idle", {})
prefs.setdefault("hidden", {})
prefs.setdefault("hidden_ids", {})  # "kind:id" -> when; survives the same session resurfacing under another file


def save_prefs():
    tmp = PREFS_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(prefs, f, ensure_ascii=False, indent=1)
    os.replace(tmp, PREFS_PATH)


def apply_prefs(sm):
    """A manual idle mark holds until the session writes something newer; hidden is kept until restored."""
    mark = prefs["idle"].get(sm["path"])
    sm["manual_idle"] = mark is not None and (sm["last_ts"] or "") <= mark
    if sm["manual_idle"] and sm["state"] != "done":
        sm.update(state="idle", live=False, state_reason="수동으로 유휴 처리됨")
    sm["hidden"] = sm["path"] in prefs["hidden"] or f'{sm["kind"]}:{sm["id"]}' in prefs["hidden_ids"]
    return sm
orca_state = {"runs": [], "tasks": {}, "workers": [], "terminals": [], "error": None, "updated": 0}


def bump():
    global version
    version += 1


# Collector loops run on daemon threads, where one uncaught exception used to end the thread for good: the page
# kept its SSE pings (「실시간」) while that part of the data silently froze until a restart. Each pass is now
# guarded, and the outcome lands here so the UI can tell a stalled collector from a quiet one.
health = {}  # loop name -> {"ok": last clean pass, "error": last failure, "at": when it failed}
_reported = set()  # (where, repr) already printed with a traceback, so a repeating failure logs once


def report_failure(where, e):
    key = (where, repr(e))
    if key not in _reported:
        _reported.add(key)
        log(f"{where}: {e!r}")
        traceback.print_exc()


def loop_failed(name, e, where=None):
    """Call outside `lock`."""
    report_failure(where or name, e)
    with lock:
        health.setdefault(name, {}).update(error=short(f"{where + ': ' if where else ''}{e!r}", 240), at=time.time())
        bump()


def loop_ok(name):
    with lock:
        health.setdefault(name, {})["ok"] = time.time()


def short(text, n=280):
    text = " ".join(str(text).split())
    return text if len(text) <= n else text[: n - 1] + "…"


def tool_hint(name, inp):
    if not isinstance(inp, dict):
        return short(inp, 120)
    for key in ("command", "file_path", "pattern", "description", "prompt", "url", "skill", "query"):
        if key in inp:
            return short(inp[key], 120)
    return short(json.dumps(inp, ensure_ascii=False), 120)


class Session:
    def __init__(self, path, kind):
        self.path = path
        self.kind = kind
        self.offset = 0
        self.buf = b""
        self.id = os.path.splitext(os.path.basename(path))[0]
        self.title = None
        self.cwd = None
        self.launch_cwd = None  # where the agent was started; later cwds follow its own `cd`s
        self.model = None
        self.started = None
        self.last_ts = None
        self.ctx_window = CLAUDE_CTX_WINDOW if kind == "claude" else None
        self.turns = []  # {ts, ctx, input, cache_read, cache_write, output, tools:[...]}
        self.turn_by_key = {}
        self.compactions = []  # turn indices
        self.log = []
        self.pending_tools = []  # codex: tool calls seen before their usage record
        self.cats = collections.Counter()  # tool calls by category
        self.skill_use = collections.Counter()
        self.mcp_use = collections.Counter()
        self.parent = None
        self.role = "solo"  # solo | coordinator | worker (subagents are marked by parent)
        self.coord_handle = None  # worker: its parent coordinator's terminal
        self.own_handle = None  # this session's own Orca terminal, when the log reveals it
        self.task_id = None
        self.issues_orchestration = False
        self.error = None  # last turn ended on an API error (usage limit etc.) and nothing has run since
        self.busy = False  # a turn is open: the model is generating or a tool is running
        self.bg = {}  # background task id -> (kind, started ts): run_in_background Bash, Monitor, async agents
        self.stop_calls = {}  # TaskStop tool call id -> task id
        self.asks = {}  # AskUserQuestion call id -> [first question, epoch seconds, has a result]; see stale_decisions
        self.bg_calls = {}  # tool call id -> tool name, for calls that may start a background task
        self.own_run_calls = set()  # tool call ids of this session's run-create/run-use
        self.own_votes = collections.Counter()
        self.own_runs = collections.Counter()  # Run ids this session's run-create printed
        self.create_calls = set()  # tool call ids of this session's run-create
        self.term_calls = {}  # tool call id -> command, for `orca terminal create`
        self.made_terms = []  # Orca terminals this session opened (e.g. a driver script acting as coordinator)
        self.plan_calls = set()  # tool call ids that ran aplan
        # aplan events from the transcript echo and the store file, keyed by event id (both carry it).
        # Plans are rebuilt from them in time order, so a late-arriving store line lands in the right plan.
        self.plan_events = {}
        self.prompts = []  # [(ts, text)] instruction timeline, to bind each plan to the instruction it answers
        self._plans, self._plans_n = [], -1
        self.last_prompt = None
        self.last_prompt_ts = None
        if "/subagents/" in path:
            self.parent = os.path.basename(os.path.dirname(os.path.dirname(path)))
        if kind == "codex":
            self.id = self.id.split("-", 6)[-1] if self.id.startswith("rollout-") else self.id

    # ---- incremental read ----
    def poll(self):
        try:
            size = os.path.getsize(self.path)
        except OSError:
            return False
        if size < self.offset:  # truncated/rotated
            self.__init__(self.path, self.kind)
        if size == self.offset:
            return False
        with open(self.path, "rb") as f:
            f.seek(self.offset)
            data = f.read(size - self.offset)
        self.offset = size
        data = self.buf + data
        lines = data.split(b"\n")
        self.buf = lines.pop()  # keep partial last line
        changed = False
        for raw in lines:
            if not raw.strip():
                continue
            try:
                rec = json.loads(raw)
            except ValueError:
                continue
            ts = rec.get("timestamp")
            if ts:
                self.started = self.started or ts
                self.last_ts = ts
            (self.parse_claude if self.kind == "claude" else self.parse_codex)(rec, ts)
            changed = True
        return changed

    def add_log(self, ts, role, text, **extra):
        if role == "user":
            self.last_prompt, self.last_prompt_ts = text, ts
            self.prompts.append((ts or "", text))
        self.log.append({"ts": ts, "role": role, "text": text, "turn": len(self.turns) - 1, **extra})
        if len(self.log) > LOG_LIMIT:
            del self.log[: len(self.log) - LOG_LIMIT]

    def add_turn(self, key, ts, ctx, inp, cr, cw, out, cw_1h=0):
        if key in self.turn_by_key:  # split records repeat the same usage — do not double count
            t = self.turns[self.turn_by_key[key]]
            t["output"] = max(t["output"], out)
            return t
        prev = self.turns[-1]["ctx"] if self.turns else None
        t = {"ts": ts, "ctx": ctx, "input": inp, "cache_read": cr, "cache_write": cw, "cw_1h": min(cw_1h, cw),
             "output": out, "tools": [], "uses": [], "model": self.model}
        self.turns.append(t)
        self.turn_by_key[key] = len(self.turns) - 1
        if prev and ctx < prev * 0.6:  # sharp drop = compaction
            self.compactions.append(len(self.turns) - 1)
        return t

    def check_brief(self, text):
        """The first user message of an Orca worker carries its coordinator handle and task id."""
        if self.role == "worker" or len(self.turns) > 2:  # the brief opens the session
            return
        c, t = BRIEF_COORD.search(text), BRIEF_TASK.search(text)
        if c and t:
            self.role, self.coord_handle, self.task_id = "worker", c.group(1), t.group(1)
            # The brief's CLI examples carry the worker's own handle (--terminal/--from).
            own = collections.Counter(h for h in HANDLE.findall(text) if h != self.coord_handle)
            if own:
                self.own_handle = own.most_common(1)[0][0]

    def note_call(self, call_id, cmd):
        if call_id and isinstance(cmd, str) and OWN_RUN_CMD.search(cmd):
            self.own_run_calls.add(call_id)
            if RUN_CREATE.search(cmd):
                self.create_calls.add(call_id)
        if call_id and isinstance(cmd, str) and TERM_CREATE.search(cmd):
            self.term_calls[call_id] = cmd
        if call_id and isinstance(cmd, str) and APLAN_CMD.search(cmd):
            self.plan_calls.add(call_id)

    def note_bg_end(self, text):
        """A <task-notification> with a final status ends the task it names."""
        ids = BG_NOTE.findall(text)
        if ids and BG_END.search(text):
            for i in ids:
                self.bg.pop(i, None)

    def bg_live(self):
        """{kind: count} of background tasks still running."""
        out = collections.Counter()
        for kind, ts in self.bg.values():
            age = seconds_since(ts)
            if age is None or age < BG_MAX_SECONDS:
                out[kind] += 1
        return dict(out)

    def note_result(self, call_id, text, ts=None):
        if call_id in self.stop_calls:
            self.bg.pop(self.stop_calls.pop(call_id), None)
        tool = self.bg_calls.pop(call_id, None)
        m = tool and text and BG_START[tool].search(text)
        if m:
            self.bg[m.group(1)] = (BG_KIND[tool], ts or self.last_ts)
        if call_id in self.term_calls and text:
            # The new terminal's handle is whatever handle the output names that the command did not
            # (scripts often print it bare: H=$(orca terminal create ... | jq ...); echo $H).
            known = set(HANDLE.findall(self.term_calls[call_id])) | {self.own_handle}
            for h in HANDLE.findall(text):
                if h in known:
                    continue
                if h not in self.made_terms:
                    self.made_terms.append(h)
        if call_id in self.own_run_calls and text:
            self.own_votes.update(COORD_HANDLE_STR.findall(text))
            # Only a Run the session created: run-create binds the calling terminal as its coordinator, while
            # run-use may act for another terminal (`--from <driver>`), so its Run's coordinator is not this one.
            if call_id in self.create_calls:
                self.own_runs.update(RUN_ID.findall(text))
        if call_id in self.plan_calls and text:
            for tok in APLAN_TOKEN.findall(text):
                try:
                    ev = json.loads(base64.urlsafe_b64decode(tok + "=" * (-len(tok) % 4)))
                except (ValueError, json.JSONDecodeError):
                    continue
                self.apply_plan(ev, ts)

    def apply_plan(self, ev, ts):
        key = ev.get("id") or f"echo-{len(self.plan_events)}"
        if key not in self.plan_events:
            self.plan_events[key] = (ev.get("ts") or ts or "", ev)

    @property
    def plans(self):
        if self._plans_n != len(self.plan_events) + len(self.prompts):
            self._plans_n = len(self.plan_events) + len(self.prompts)
            self._plans = build_plans(sorted(self.plan_events.values(), key=lambda x: x[0]), self.prompts)
        return self._plans

    def plan_summary(self):
        if not self.plans:
            return None
        p = self.plans[-1]
        cur = next((k for k, x in enumerate(p["steps"]) if x["st"] in ("run", "fail")), None)
        return {"steps": [x["st"] for x in p["steps"]], "total": len(p["steps"]),
                "done": sum(x["st"] in ("done", "skip") for x in p["steps"]),
                "cur": cur, "cur_text": p["steps"][cur]["t"] if cur is not None else None,
                "count": len(self.plans), "prompt": short(p["prompt"] or "", 120)}

    def count_tool(self, name, inp):
        """-> (category, use keys): skill names and "mcp:<server>", as the dashboard's both_use keys them."""
        cat, skills, server = classify_tool(name, inp)
        self.cats[cat] += 1
        self.skill_use.update(skills)
        if server:
            self.mcp_use[server] += 1
        return cat, skills + (["mcp:" + server] if server else [])

    def use_tokens(self):
        """Tokens each skill / MCP server put into the context, from the context growth after the turn that called it.
        A turn's growth is split evenly over its tool calls, and a call's share over its use keys.
        inj = tokens added once · carry = those tokens summed over every later turn that re-read them (until a
        compaction drops them) · cost = carry priced at cache write for the first turn, cache read after."""
        n = len(self.turns)
        if n < 2:
            return {}
        comp = set(self.compactions)
        pw, pr = [0.0] * n, [0.0] * n
        for j, t in enumerate(self.turns):
            p = price_for(t["model"] or self.model, t["ctx"])
            if p:
                pw[j], pr[j] = p[1] / 1e6, p[3] / 1e6
        pre = [0.0]  # prefix sums of cache-read price
        for x in pr:
            pre.append(pre[-1] + x)
        end, nxt = [n] * n, n  # end[j]: first compaction turn after j (exclusive bound of j's segment)
        for j in range(n - 1, -1, -1):
            end[j] = nxt
            if j in comp:
                nxt = j
        out = {}
        for i, t in enumerate(self.turns[:-1]):
            if not t["tools"] or (i + 1) in comp or not any(t.get("uses") or []):
                continue
            growth = max(0, self.turns[i + 1]["ctx"] - t["ctx"])
            if not growth:
                continue
            share = growth / len(t["tools"])
            a, e = i + 1, end[i + 1]
            for keys in t["uses"]:
                for k in keys:
                    g = share / len(keys)
                    o = out.setdefault(k, [0.0, 0.0, 0.0])
                    o[0] += g
                    o[1] += g * (e - a)
                    o[2] += g * (pw[a] + pre[e] - pre[a + 1])
        return {k: [round(v[0]), round(v[1]), round(v[2], 4)] for k, v in out.items()}

    def check_command(self, cmd):
        # Workers can coordinate too (nested orchestration), so this is checked for every role.
        # Only a real call counts: `orca orchestration run-create --help` is someone reading the docs.
        if isinstance(cmd, str) and any(not re.search(r"(?:^|\s)(?:--help|-h)(?:\s|$)", re.split(r"[;&|\n]", cmd[m.end():], maxsplit=1)[0])
                                        for m in COORD_CMD.finditer(cmd)):
            self.issues_orchestration = True

    # ---- Claude Code ----
    def parse_claude(self, rec, ts):
        typ = rec.get("type")
        self.cwd = rec.get("cwd") or self.cwd
        self.launch_cwd = self.launch_cwd or self.cwd
        if typ == "ai-title":
            self.title = rec.get("aiTitle") or self.title
            return
        msg = rec.get("message") or {}
        if typ == "system" and rec.get("subtype") == "turn_duration":
            self.busy = False
        if typ == "queue-operation" and isinstance(rec.get("content"), str) and rec["content"].startswith("<task-notification>"):
            self.note_bg_end(rec["content"])  # a notice queued while a turn runs is written here first
            return
        if typ == "assistant":
            model = msg.get("model")
            if model == "<synthetic>":
                # Claude Code writes API errors (usage limit, overload) as a synthetic assistant message.
                body = msg.get("content")
                body = " ".join(b.get("text", "") for b in body if isinstance(b, dict)) if isinstance(body, list) else str(body or "")
                self.error = short(body, 120)
                self.busy = False  # the error ends the turn
            else:
                self.model = model or self.model
                self.error = None
            stop = msg.get("stop_reason")
            if stop == "tool_use":
                self.busy = True
            elif stop in ("end_turn", "stop_sequence", "max_tokens", "refusal"):
                self.busy = False
            usage = msg.get("usage")
            turn = None
            if usage:
                inp = usage.get("input_tokens", 0)
                cr = usage.get("cache_read_input_tokens", 0)
                cw = usage.get("cache_creation_input_tokens", 0)
                key = rec.get("requestId") or msg.get("id") or rec.get("uuid")
                cw_1h = (usage.get("cache_creation") or {}).get("ephemeral_1h_input_tokens", 0)
                turn = self.add_turn(key, ts, inp + cr + cw, inp, cr, cw, usage.get("output_tokens", 0), cw_1h)
            for block in msg.get("content") or []:
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "tool_use":
                    cmd = (block.get("input") or {}).get("command") if isinstance(block.get("input"), dict) else None
                    if block.get("name") in ("TaskStop", "KillShell") and isinstance(block.get("input"), dict):
                        tid = block["input"].get("task_id") or block["input"].get("shell_id")
                        if tid:
                            self.stop_calls[block.get("id")] = tid
                    if block.get("name") in ("Bash", "Monitor", "Agent"):
                        self.bg_calls[block.get("id")] = block["name"]
                    if block.get("name") == "AskUserQuestion" and isinstance(block.get("input"), dict):
                        qs = block["input"].get("questions")
                        q0 = qs[0].get("question") if isinstance(qs, list) and qs and isinstance(qs[0], dict) else None
                        if q0 and ts:
                            self.asks[block.get("id")] = [str(q0), epoch(ts), False]
                    self.check_command(cmd)
                    self.note_call(block.get("id"), cmd)
                    cat, keys = self.count_tool(block.get("name"), block.get("input"))
                    if turn is not None:
                        turn["tools"].append(cat)
                        turn["uses"].append(keys)
                    self.add_log(ts, "tool", block.get("name"), detail=tool_hint(block.get("name"), block.get("input")))
                elif block.get("type") == "text" and block.get("text", "").strip():
                    self.add_log(ts, "assistant", short(block["text"]))
        elif typ == "user":
            content = msg.get("content")
            if not rec.get("isMeta"):
                self.busy = True  # a prompt or a tool result: the model is up next
                if "[Request interrupted by user" in json.dumps(content, ensure_ascii=False)[:400]:
                    self.busy = False
            if isinstance(content, str):
                if content.startswith("<task-notification>"):
                    self.note_bg_end(content)
                self.check_brief(content)
                if not self.title and not content.startswith("<"):
                    self.title = short(content, 80)
                self.add_log(ts, "user", short(content))
            elif isinstance(content, list):
                for block in content:
                    if not isinstance(block, dict):
                        continue
                    if block.get("type") == "tool_result":
                        body = block.get("content")
                        if isinstance(body, list):
                            body = " ".join(b.get("text", "") for b in body if isinstance(b, dict))
                        body = str(body or "")
                        self.note_result(block.get("tool_use_id"), body, ts)
                        if block.get("tool_use_id") in self.asks:
                            self.asks[block["tool_use_id"]][2] = True
                        self.add_log(ts, "result", short(body, 200), size=len(body), error=bool(block.get("is_error")))
                    elif block.get("type") == "text" and not block.get("text", "").startswith("<"):
                        self.add_log(ts, "user", short(block.get("text", "")))
        elif typ == "system":
            sub = rec.get("subtype")
            if sub and "compact" in sub:
                if self.turns and (len(self.turns) - 1) not in self.compactions:
                    self.compactions.append(len(self.turns) - 1)
                self.add_log(ts, "system", "컨텍스트 압축 (" + sub + ")")

    # ---- Codex ----
    def parse_codex(self, rec, ts):
        typ = rec.get("type")
        p = rec.get("payload") or {}
        ptype = p.get("type")
        if typ == "session_meta":
            self.id = p.get("id") or self.id
            self.cwd = p.get("cwd") or self.cwd
            self.launch_cwd = self.launch_cwd or self.cwd
        elif typ == "turn_context":
            self.cwd = p.get("cwd") or self.cwd
            self.launch_cwd = self.launch_cwd or self.cwd
            self.model = p.get("model") or self.model
        elif typ == "token_usage_record":
            u = p.get("usage") or {}
            inp_total = u.get("input_tokens", 0)  # includes cached and cache-write tokens
            cr = u.get("cached_input_tokens", 0)
            cw = u.get("cache_write_input_tokens", 0)
            t = self.add_turn(p.get("response_id") or ts, ts, inp_total, max(0, inp_total - cr - cw), cr,
                              cw, u.get("output_tokens", 0))
            t["tools"].extend(c for c, _ in self.pending_tools)
            t["uses"].extend(k for _, k in self.pending_tools)
            self.pending_tools = []
        elif typ == "event_msg" and ptype == "task_started":
            self.busy = True
        elif typ == "event_msg" and ptype in ("task_complete", "turn_aborted"):
            self.busy = False
        elif typ == "event_msg" and ptype == "token_count":
            info = p.get("info") or {}
            self.ctx_window = info.get("model_context_window") or self.ctx_window
        elif typ == "response_item" and ptype in ("function_call", "custom_tool_call", "local_shell_call"):
            name = p.get("name") or ptype
            self.check_command(p.get("input") or p.get("arguments"))
            self.note_call(p.get("call_id"), p.get("input") or p.get("arguments"))
            self.pending_tools.append(self.count_tool(name, p.get("input") or p.get("arguments")))
            self.add_log(ts, "tool", name, detail=short(p.get("input") or p.get("arguments") or "", 120))
        elif typ == "response_item" and ptype in ("function_call_output", "custom_tool_call_output"):
            out = p.get("output")
            out = out if isinstance(out, str) else json.dumps(out, ensure_ascii=False)
            self.note_result(p.get("call_id"), out, ts)
            self.add_log(ts, "result", short(out, 200), size=len(out))
        elif typ == "response_item" and ptype == "message":
            role = p.get("role")
            text = " ".join(c.get("text", "") for c in p.get("content") or [] if isinstance(c, dict))
            if role == "assistant" and text.strip():
                self.add_log(ts, "assistant", short(text))
            elif role == "user" and "dispatched worker" in text:
                self.check_brief(text)
                self.add_log(ts, "user", short(text))
            elif role == "user" and text.strip() and not text.lstrip().startswith(("#", "<")):
                self.title = self.title or short(text, 80)
                self.add_log(ts, "user", short(text))
        elif ptype and "compact" in str(ptype):
            if self.turns and (len(self.turns) - 1) not in self.compactions:
                self.compactions.append(len(self.turns) - 1)
            self.add_log(ts, "system", "컨텍스트 압축")

    # ---- views ----
    def summary(self):
        cur_task, task_ids = self.orca_tasks()
        ctxs = [t["ctx"] for t in self.turns]
        if self.kind == "claude" and ctxs and max(ctxs) > CLAUDE_CTX_WINDOW:
            self.ctx_window = 1_000_000  # past 200k means a 1M-context model
            if self.model:
                LONG_CTX_MODELS.add(self.model)
        elif self.kind == "claude" and self.model in LONG_CTX_MODELS and not self.compactions:
            self.ctx_window = 1_000_000  # same model as a session that went past 200k (an auto-compaction would say otherwise)
        if self.role != "worker" and self.issues_orchestration:
            self.role = "coordinator"
        if self.role != "worker" and self.own_votes:
            self.own_handle = self.own_votes.most_common(1)[0][0]
        elif self.role != "worker" and self.own_run_calls and self.pane_handle():
            # The output was filtered (e.g. `run-create --json | grep '"id"'`, 12 of 22 calls in a sample) and
            # lost coordinator_handle: the terminal Orca's hook places this session in is its own.
            self.own_handle = self.pane_handle()
        elif self.role != "worker" and self.own_runs:
            # No live hook (pane closed): Orca's record of the Run the session created. A run-create run inside
            # another terminal (a test script) would name that terminal, which is why the hook comes first.
            by_run = {r.get("id"): r.get("coordinator_handle") for r in orca_state.get("runs", [])}
            votes = collections.Counter()
            for r, n in self.own_runs.items():
                if by_run.get(r):
                    votes[by_run[r]] += n
            if votes:
                self.own_handle = votes.most_common(1)[0][0]
        cost = {"input": 0.0, "cache_write": 0.0, "cache_read": 0.0, "output": 0.0}
        priced = bool(self.turns)
        for t in self.turns:
            c = turn_cost(t, self.model)
            if not c:
                priced = False
                continue
            for k, v in zip(cost, c):
                cost[k] += v
        return {
            "role": self.role, "coord_handle": self.coord_handle, "task_id": cur_task, "task_ids": task_ids,
            "own_handle": self.own_handle, "coordinates": self.issues_orchestration,
            "cost": round(sum(cost.values()), 4) if priced else None,
            "cost_parts": {k: round(v, 4) for k, v in cost.items()} if priced else None,
            "id": self.id, "path": self.path, "kind": self.kind, "title": self.title or self.id[:8],
            "cwd": self.cwd, "model": self.model, "parent": self.parent,
            "started": self.started, "last_ts": self.last_ts, **self.run_state(),
            "turns": len(self.turns), "ctx_now": ctxs[-1] if ctxs else 0, "ctx_peak": max(ctxs) if ctxs else 0,
            "ctx_avg": round(sum(ctxs) / len(ctxs)) if ctxs else 0, "ctx_window": self.ctx_window,
            "compactions": len(self.compactions), "tool_calls": sum(len(t["tools"]) for t in self.turns),
            "skills": sum(self.skill_use.values()), "skill_kinds": len(self.skill_use),
            "skill_use": dict(self.skill_use), "mcp_use": dict(self.mcp_use), "use_tok": self.use_tokens(),
            "last_action": self.last_action(), "plan": self.plan_summary(), "place": self.placement(), "gone": self.gone(), "made_terms": self.made_terms,
            "slots": turn_slots(self.turns, self.model, int(time.time() // SLOT_SECONDS) - SLOT_KEEP),
            "tokens": {
                "input": sum(t["input"] for t in self.turns),
                "cache_read": sum(t["cache_read"] for t in self.turns),
                "cache_write": sum(t["cache_write"] for t in self.turns),
                "output": sum(t["output"] for t in self.turns),
            },
        }

    def work_dir(self):
        """Orca's recorded worktree for a worker wins; otherwise the directory the agent was launched in."""
        if self.task_id:
            for w in orca_state.get("workers") or []:
                if w.get("taskId") == self.task_id:
                    wt = ((w.get("resource") or {}).get("worktreeId") or "").split("::", 1)[-1]
                    if wt:
                        return wt
        return self.launch_cwd

    def placement(self):
        return place_of(self.work_dir())

    def orca_tasks(self):
        """(current task, every task) for a worker. A settled worker's terminal can be re-engaged for a
        new task (e.g. the 구현 worker goes on to 판정); the brief only names the first one, so Orca's
        dispatch list for this terminal decides which task the session is on now."""
        ids = [self.task_id] if self.task_id else []
        cur = self.task_id
        if self.own_handle:
            ds = [w for w in orca_state.get("workers") or [] if w.get("agentTerminalHandle") == self.own_handle and w.get("taskId")]
            for w in ds:
                if w["taskId"] not in ids:
                    ids.append(w["taskId"])
            open_ = [w["taskId"] for w in ds if w.get("dispatchStatus") not in ("completed", "failed", "cancelled")]
            if open_:
                cur = open_[-1]
            elif len(ids) > 1:  # all settled: the latest task it took is the one it is "on"
                created = {t["id"]: t.get("created_at") or "" for ts in (orca_state.get("tasks") or {}).values() for t in ts}
                cur = max(ids, key=lambda i: created.get(i, ""))
        return cur, ids

    def gone(self):
        """The session's worktree (or launch directory) no longer exists on disk."""
        d = self.work_dir()
        return bool(d) and not os.path.isdir(d)

    def pane_handle(self):
        """The connected Orca terminal whose pane Orca's hook puts this session in, or None."""
        pane = (hooks.get(self.id) or {}).get("pane")
        if not pane:
            return None
        return next((t["handle"] for t in orca_state.get("terminals", [])
                     if t.get("connected") and f'{t.get("tabId")}:{t.get("leafId")}' == pane), None)

    def run_state(self):
        age = seconds_since(self.last_ts)
        hook = hooks.get(self.id)
        # Orca's hook is authoritative for its panes only when it is at least as fresh as the transcript
        # (it also sees background monitoring, which leaves no transcript turn open). A newer transcript
        # record wins: right after a new prompt the hook file still holds the previous turn's "done".
        if self.error and not self.busy:
            # An API error (usage limit etc.) ends the turn without a hook update, so it outranks the hook.
            state, why = "stalled", "API 오류로 멈춤: " + self.error
        elif hook and age is not None and hook["at"] >= time.time() - age - 1:
            if hook["state"] == "working" and hook.get("mode") == "monitoring":
                # Orca's Stop hook: the turn ended but background tasks still run.
                state, why = "bg", "Orca: monitoring (턴 종료 · 백그라운드 작업 진행)"
            elif hook["state"] == "working":
                state, why = "run", "Orca: " + (hook.get("mode") or "working")
            else:
                state, why = ("wait" if age < WAIT_SECONDS else "idle"), "Orca: " + hook["state"]
        elif self.busy:
            state, why = ("run", "턴 진행 중") if age is not None and age < STALL_SECONDS else ("stalled", "턴이 열린 채 기록 없음")
        else:
            state, why = ("wait", "턴 종료 · 입력 대기") if age is not None and age < WAIT_SECONDS else ("idle", "턴 종료")
            bg = self.bg_live()
            if bg:
                state, why = "bg", "턴 종료 · 백그라운드 " + " · ".join(f"{k} {n}" for k, n in bg.items())
        bg = self.bg_live() if state in ("bg", "run") else {}
        # live = a turn is open; a session whose turn ended with only background tasks left is "bg", not live.
        return {"state": state, "state_reason": why, "live": state == "run", "bg_tasks": sum(bg.values())}

    def last_action(self):
        """Most recent thing the agent did, for a one-line "now doing" hint."""
        for entry in reversed(self.log):
            if entry["role"] in ("tool", "assistant", "user", "system"):
                text = entry["text"] + (" · " + entry["detail"] if entry.get("detail") else "")
                return {"role": entry["role"], "text": short(text, 140), "ts": entry["ts"]}
        return None

    def detail(self):
        # Context growth after a turn is caused by that turn's tool results: attribute it.
        by_tool = {}
        for i, t in enumerate(self.turns):
            for name in t["tools"]:
                b = by_tool.setdefault(name, {"calls": 0, "ctx_growth": 0})
                b["calls"] += 1
            if i + 1 < len(self.turns) and t["tools"] and (i + 1) not in self.compactions:
                growth = max(0, self.turns[i + 1]["ctx"] - t["ctx"])
                for name in t["tools"]:
                    by_tool[name]["ctx_growth"] += growth // len(t["tools"])
        return {**self.summary(), "turn_list": self.turns, "compaction_turns": self.compactions,
                "by_tool": by_tool, "log": self.log, "cats": self.cats, "skill_use": self.skill_use, "mcp_use": self.mcp_use, "plans": self.plans}


VAULT = os.path.join(HOME, "Obsidian/obsidian")
_places = {}


def place_of(cwd):
    """Project (repo), worktree, branch and sub-path for a working directory, cached per directory."""
    if not cwd:
        return None
    if cwd in _places:
        return _places[cwd]

    def git(*args):
        try:
            r = subprocess.run(["git", "-C", cwd, *args], capture_output=True, text=True, timeout=3)
            return r.stdout.strip() if r.returncode == 0 else None
        except (OSError, subprocess.SubprocessError):
            return None

    top = git("rev-parse", "--show-toplevel")
    if top:
        common = git("rev-parse", "--path-format=absolute", "--git-common-dir") or os.path.join(top, ".git")
        main = os.path.dirname(common) if os.path.basename(common) == ".git" else common
        sub = os.path.relpath(cwd, top)
        p = {"project": os.path.basename(main), "worktree": os.path.basename(top), "main": main == top,
             "branch": git("branch", "--show-current") or None, "sub": None if sub == "." else sub, "path": top}
    elif cwd == VAULT or cwd.startswith(VAULT + "/"):
        sub = os.path.relpath(cwd, VAULT)
        p = {"project": "Obsidian 볼트", "worktree": None, "main": True, "branch": None,
             "sub": None if sub == "." else sub, "path": VAULT}
    elif cwd.startswith(("/private/tmp/", "/tmp/")) or "/scratch" in cwd:
        p = {"project": "임시 디렉터리", "worktree": os.path.basename(cwd), "main": True, "branch": None, "sub": None, "path": cwd}
    else:
        p = {"project": os.path.basename(cwd), "worktree": None, "main": True, "branch": None, "sub": None, "path": cwd}
    _places[cwd] = p
    return p


def build_plans(events, prompts):
    """One plan per instruction: {prompt, ts, steps: [{t, st, ts0, ts1, note}], hist: [[ts, done, total]]}."""
    import bisect
    pts = [t for t, _ in prompts]
    plans = []
    for ts, ev in events:
        k = bisect.bisect_right(pts, ts) - 1
        prompt_ts, prompt = (prompts[k] if k >= 0 else (None, None))
        op, plan = ev.get("op"), plans[-1] if plans else None
        # A plan made after the latest instruction is revised in place; a newer instruction starts a new plan.
        fresh = plan is None or (prompt_ts and (plan["ts"] or "") < prompt_ts)
        if op == "set" or (op == "add" and fresh):
            old = {} if fresh or op == "add" else {x["t"]: x for x in plan["steps"]}
            steps = [dict(old.get(t) or {"t": t, "st": "todo", "ts0": None, "ts1": None, "note": None}) for t in ev.get("steps", [])]
            if fresh:
                plan = {"prompt": prompt, "ts": ts, "steps": steps, "hist": []}
                plans.append(plan)
            else:
                plan["steps"] = steps
        elif op == "add":
            plan["steps"] += [{"t": t, "st": "todo", "ts0": None, "ts1": None, "note": None} for t in ev.get("steps", [])]
        elif plan:
            steps = plan["steps"]
            n = ev.get("n")
            i = n - 1 if n else next((j for j, x in enumerate(steps) if x["st"] == "run"), None)
            if i is None or not 0 <= i < len(steps):
                continue
            x = steps[i]
            if op == "start":
                x["st"], x["ts0"] = "run", x["ts0"] or ts
            else:
                x["st"], x["ts1"], x["ts0"] = op, ts, x["ts0"] or ts
                x["note"] = ev.get("note") or x["note"]
        else:
            continue
        steps = plan["steps"]
        if op != "fail" and not any(x["st"] == "run" for x in steps):
            nxt = next((x for x in steps if x["st"] == "todo"), None)
            if nxt:
                nxt["st"], nxt["ts0"] = "run", ts
        plan["hist"].append([ts, sum(x["st"] in ("done", "skip") for x in steps), len(steps)])
    return plans


SLOT_SECONDS = 300                 # compare tab's finest time bucket (5 min)
HISTORY_DAYS = 7                   # its widest span; older sessions come from the history scan below
SLOT_KEEP = HISTORY_DAYS * 86400 // SLOT_SECONDS


def turn_cost(t, model):
    """USD of one turn as (input, cache_write, cache_read, output), or None without a price."""
    pr = price_for(t["model"] or model, t["ctx"])
    if not pr:
        return None
    return (t["input"] * pr[0] / 1e6, ((t["cache_write"] - t["cw_1h"]) * pr[1] + t["cw_1h"] * pr[2]) / 1e6,
            t["cache_read"] * pr[3] / 1e6, t["output"] * pr[4] / 1e6)


def turn_slots(turns, model, keep):
    """5-minute slot (epoch // 300) -> [input, cache_write, cache_read, output, cost] for slots after `keep`.
    The compare tab's time chart merges these into 5m–1h bars."""
    slots = {}
    for t in turns:
        if "slot" not in t:
            t["slot"] = epoch_slot(t["ts"])
        if t["slot"] is None or t["slot"] <= keep:
            continue
        h = slots.setdefault(t["slot"], [0, 0, 0, 0, 0.0])
        h[0] += t["input"]; h[1] += t["cache_write"]; h[2] += t["cache_read"]; h[3] += t["output"]
        h[4] += sum(turn_cost(t, model) or ())
    return {k: v[:4] + [round(v[4], 4)] for k, v in slots.items()}


def epoch_slot(ts):
    """ISO timestamp -> whole SLOT_SECONDS since the epoch, or None."""
    try:
        return int(datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp() // SLOT_SECONDS)
    except (AttributeError, ValueError):
        return None


def seconds_since(ts):
    if not ts:
        return None
    try:
        return time.time() - datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def load_hooks():
    try:
        with open(HOOK_STATUS) as f:
            entries = json.load(f).get("entries", {})
    except (OSError, ValueError):
        return
    fresh = {}
    for e in entries.values():
        sid = (e.get("providerSession") or {}).get("id")
        payload = e.get("payload") or {}
        if sid and payload.get("state"):
            # paneKey ("<tabId>:<leafId>") names the Orca pane the session runs in; the file keeps one entry per
            # pane, so a pane later reused by another session no longer points back at this one.
            fresh[sid] = {"state": payload["state"], "mode": payload.get("workingMode"),
                          "at": (e.get("receivedAt") or 0) / 1000, "pane": e.get("paneKey")}
    hooks.clear()
    hooks.update(fresh)


# ---- watchers ----
PLAN_STORES = [os.path.join(HOME, ".agent-plans"), "/tmp/agent-plans"]


plan_pending = []  # store lines whose session is not discovered yet (new transcripts are globbed every 10 s)


def read_plan_stores(known, offsets):
    """Apply new aplan store lines to their sessions. Runs after transcripts are polled, so the
    instruction that a plan answers is already parsed when the plan arrives."""
    by_id = {s.id: s for s in known.values()}
    by_term = {s.own_handle: s for s in known.values() if s.own_handle and not s.parent}
    changed = False
    retry, plan_pending[:] = plan_pending[:], []
    lines = [(rec, t) for rec, t in retry if time.time() - t < 600]
    for d in PLAN_STORES:
        for path in glob.glob(os.path.join(d, "*.jsonl")):
            try:
                size = os.path.getsize(path)
                if size <= offsets.get(path, 0):
                    continue
                with open(path, "rb") as f:
                    f.seek(offsets.get(path, 0))
                    data = f.read()
            except OSError:
                continue
            end = data.rfind(b"\n") + 1  # leave a partial last line for the next tick
            offsets[path] = offsets.get(path, 0) + end
            for raw in data[:end].splitlines():
                try:
                    lines.append((json.loads(raw), time.time()))
                except ValueError:
                    continue
    for rec, t in lines:
        s = by_id.get(rec.get("session")) or by_term.get(rec.get("terminal"))
        if s and isinstance(rec.get("event"), dict):
            s.apply_plan(rec["event"], rec["event"].get("ts"))
            changed = True
        elif not s:
            plan_pending.append((rec, t))
    return changed


PRUNE_EVERY = 60


def prune_sessions(known, cutoff):
    """Drop sessions whose transcript has not changed since `cutoff`, the same test that keeps a file out at
    discovery, so a long-running server holds what a fresh start would (it held every session it ever saw:
    944 after a day, 10 of them live, with /api/state growing to 2.9MB). A dropped session moves to the
    history cache so the 7-day compare keeps it; prefs (idle/hidden) are keyed by path and survive.
    Returns the dropped paths."""
    gone = []
    for path, s in list(known.items()):
        try:
            st = os.stat(path)
        except OSError:
            st = None
        if st and st.st_mtime >= cutoff:
            continue
        del known[path]
        gone.append(path)
        with lock:
            sessions.pop(path, None)
            if st and st.st_mtime >= time.time() - HISTORY_DAYS * 86400:
                history["files"][path] = {"v": [st.st_mtime, st.st_size], "s": lite_of(s)}
    return gone


def scan_loop(hours):
    known = {}
    plan_offsets = {}
    pruned = set()  # paths dropped by prune_sessions, in case one comes back to life
    last_glob = last_tick = last_prune = 0
    while True:
        now = time.time()
        try:
            cutoff = min(now - hours * 3600, horizon_since or now)
            if now - last_prune > PRUNE_EVERY:
                last_prune = now
                gone = prune_sessions(known, cutoff)
                pruned.update(gone)
                if gone:
                    with lock:
                        bump()
            if now - last_glob > 10:
                last_glob = now
                for pattern, kind in [(CLAUDE_GLOB, "claude")] + [(g, "codex") for g in CODEX_GLOBS]:
                    for path in glob.glob(pattern, recursive=True):
                        path = os.path.realpath(path)  # the Orca Codex home may link to ~/.codex
                        if path in known:
                            continue
                        try:
                            if os.path.getmtime(path) < cutoff:
                                continue
                        except OSError:
                            continue
                        known[path] = Session(path, kind)
                        if path in pruned:
                            # A resumed session is parsed from scratch; reread the aplan stores so its plan
                            # events come back too (events are keyed by id, so the others are not doubled).
                            pruned.discard(path)
                            plan_offsets.clear()
            changed = False
            with lock:
                before = dict(hooks)
                load_hooks()
                changed = before != hooks
            for path, s in list(known.items()):
                # A record the parser does not expect fails only its own file: poll() advanced the offset before
                # parsing, so the next pass resumes after the batch instead of failing on it forever.
                try:
                    if path not in sessions:
                        # Not visible to request threads yet: parse its first (possibly huge) read outside the
                        # lock. After a restart every transcript lands here, and parsing them under the lock
                        # held every request for 6-55 s at a time.
                        if s.poll():
                            with lock:
                                sessions[path] = s
                            changed = True
                        continue
                    with lock:
                        if s.poll():
                            sessions[path] = s
                            changed = True
                except Exception as e:
                    loop_failed("scan", e, where=os.path.basename(path))
                    with lock:
                        sessions[path] = s
            with lock:
                changed = read_plan_stores(known, plan_offsets) or changed
            if changed or now - last_tick > 15:  # state also changes as time passes (stall/idle thresholds)
                last_tick = now
                with lock:
                    bump()
            loop_ok("scan")
        except Exception as e:
            loop_failed("scan", e)
        time.sleep(1)


# ---- usage history: sessions older than --hours, for the compare tab's 7-day time chart ----
# Only the usage per 5-minute slot is kept (no logs, plans or tools), so a week of transcripts stays cheap.
# Parsed once per file version and cached on disk; live sessions (the `sessions` dict) are left to scan_loop.
HISTORY_PATH = os.path.join(HERE, "history-cache.json")
HISTORY_EVERY = 300
history = {"files": {}, "updated": 0, "scanning": False}  # path -> {"v": [mtime, size], "s": lite session}
try:
    with open(HISTORY_PATH) as _f:
        history["files"] = json.load(_f)
except (OSError, ValueError):
    pass


def history_lite(path, kind):
    s = Session(path, kind)
    s.poll()
    return lite_of(s)


def lite_of(s):
    return {"id": s.id, "kind": s.kind, "path": s.path, "title": s.title or s.id[:8], "model": s.model,
            "parent": s.parent, "started": s.started, "last_ts": s.last_ts, "slots": turn_slots(s.turns, s.model, 0)}


def history_loop():
    time.sleep(15)  # let scan_loop load the live window first
    while True:
        try:
            history_pass()
            loop_ok("history")
        except Exception as e:
            with lock:
                history["scanning"] = False
            loop_failed("history", e)
        time.sleep(HISTORY_EVERY)


def history_pass():
    since = time.time() - HISTORY_DAYS * 86400
    with lock:
        live = set(sessions)
        history["scanning"] = True
    files, dirty = {}, False
    for pattern, kind in [(CLAUDE_GLOB, "claude")] + [(g, "codex") for g in CODEX_GLOBS]:
        for path in glob.glob(pattern, recursive=True):
            path = os.path.realpath(path)
            if path in live or path in files:
                continue
            try:
                st = os.stat(path)
            except OSError:
                continue
            if st.st_mtime < since:
                continue
            v = [st.st_mtime, st.st_size]
            old = history["files"].get(path)
            if old and old["v"] == v:
                files[path] = old
                continue
            try:
                files[path] = {"v": v, "s": history_lite(path, kind)}
                dirty = True
            except Exception as e:  # one unreadable transcript must not stop the scan
                print("history:", path, e, flush=True)
    dirty = dirty or len(files) != len(history["files"])
    with lock:
        history.update(files=files, updated=time.time(), scanning=False)
    if dirty:
        save_json(HISTORY_PATH, files)


def history_payload():
    """Sessions outside the live window with their slots from the last HISTORY_DAYS; one copy per session id."""
    keep = int(time.time() // SLOT_SECONDS) - SLOT_KEEP
    with lock:
        live = {(x.kind, x.id) for x in sessions.values()}
        files = list(history["files"].values())
        meta = {"updated": history["updated"], "scanning": history["scanning"], "days": HISTORY_DAYS}
    by_id = {}
    for f in files:
        x = f["s"]
        if (x["kind"], x["id"]) in live:
            continue
        slots = {k: v for k, v in x["slots"].items() if int(k) > keep}
        if not slots:
            continue
        cur = by_id.get((x["kind"], x["id"]))
        if not cur or len(slots) > len(cur["slots"]):  # the same Codex session can exist as two files
            by_id[(x["kind"], x["id"])] = {**x, "slots": slots}
    return {**meta, "sessions": list(by_id.values())}


# Without a terminal binding, list commands span every Run (the server may be started from an agent's terminal).
ORCA_ENV = {k: v for k, v in os.environ.items() if k not in ("ORCA_TERMINAL_HANDLE", "ORCA_PANE_KEY")}
SETTLED_EVERY = 300     # a settled Run (every task finished) is re-read this often ...
SETTLED_PER_CYCLE = 4   # ... but only a few per cycle, so open Runs are never starved behind them


def orca(*args, timeout=15):
    out = subprocess.run(["orca", *args, "--json"], capture_output=True, text=True, timeout=timeout, env=ORCA_ENV)
    data = json.loads(out.stdout)
    if not data.get("ok"):
        raise RuntimeError(short(out.stdout, 200))
    return data["result"]


def orca_all(key, *args):
    """Every row of a paged list command (run-list, worker-list: 100 per page, newest first)."""
    rows, cursor = [], None
    while True:
        res = orca(*args, *(["--cursor", cursor] if cursor else []))
        rows += res.get(key) or []
        cursor = (res.get("page") or {}).get("nextCursor") or res.get("nextCursor")
        if not cursor or not res.get(key):
            return rows


# Driver-written plan files (pre-planned worker rosters), listed in prefs.json "external_plans" (none by default).
EXTERNAL_PLANS = [os.path.expanduser(p) for p in prefs.get("external_plans") or []]
ext_plans = {}  # path -> {"path", "project", "generated_at", "tickets", "error"}
SUPERSEDED_RUN = re.compile(r"-(run_[0-9a-f]+)\.superseded\.json$")
# path -> {"coordinator_session", "driver_history"}, persisted across restarts
PLAN_HISTORY_PATH = os.path.join(HERE, "plan-history.json")
try:
    with open(PLAN_HISTORY_PATH) as _f:
        plan_history = json.load(_f)
except (OSError, ValueError):
    plan_history = {}


def save_json(p, data):
    tmp = p + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f)
    os.replace(tmp, p)


def ext_plan_loop():
    """Reload each external plan file when its mtime changes; a missing or broken file becomes an error entry."""
    seen = {}
    while True:
        clean = True
        for path in EXTERNAL_PLANS:
            try:
                mtime = os.path.getmtime(path)
            except OSError:
                mtime = None
            if path in seen and seen[path] == mtime:
                continue
            seen[path] = mtime  # a plan that fails to load is retried when the file changes, not every 2 s
            try:
                entry = read_ext_plan(path, mtime)
            except Exception as e:  # e.g. a ticket that is not an object
                loop_failed("ext_plan", e, where=os.path.basename(path))
                clean = False
                entry = {"path": path, "project": None, "generated_at": None, "tickets": [], "run_ids": [],
                         "driver_history": [], "error": "계획 파일을 해석하지 못함: " + short(repr(e), 200)}
            with lock:
                ext_plans[path] = entry
                bump()
        try:
            attach_e2e_progress()
        except Exception as e:
            loop_failed("ext_plan", e, where="e2e progress")
            clean = False
        try:
            collect_tests()
        except Exception as e:
            loop_failed("ext_plan", e, where="test progress")
            clean = False
        if clean:
            loop_ok("ext_plan")
        time.sleep(2)


def read_ext_plan(path, mtime):
    entry = {"path": path, "project": None, "generated_at": None, "tickets": [], "error": None}
    if mtime is None:
        entry["error"] = "파일 없음"
    else:
        try:
            with open(path) as f:
                data = json.load(f)
            entry.update({k: data.get(k) for k in ("project", "generated_at", "coordinator_session",
                                                   "coordinator_terminal", "scheduler_terminal")},
                         tickets=data.get("tickets") or [])
        except (OSError, ValueError) as e:
            entry["error"] = short(e, 200)
        # A re-driven ticket gets a new driver terminal and the plan forgets the old one; its earlier
        # Runs are still listed beside the plan (run-<ticket>[-<run>.superseded].json), so keep them too.
        # A superseded file names its Run, and that name wins over a body overwritten by a later restore.
        entry["run_ids"] = []
        for rf in sorted(glob.glob(os.path.join(os.path.dirname(path), "run-*.json"))):
            named = SUPERSEDED_RUN.search(os.path.basename(rf))
            if named:
                entry["run_ids"].append(named.group(1))
            try:
                with open(rf) as f:
                    rid = json.load(f).get("run_id")
            except (OSError, ValueError, AttributeError):
                continue
            if rid:
                entry["run_ids"].append(rid)
        entry["run_ids"] = list(dict.fromkeys(entry["run_ids"]))
        # Driver terminals the plan has forgotten are kept on disk, so a dashboard restart keeps them too.
        prev = ext_plans.get(path) or plan_history.get(path) or {}
        hist = (prev.get("driver_history") or []) if prev.get("coordinator_session") == entry.get("coordinator_session") else []
        entry["driver_history"] = list(dict.fromkeys(hist + [t.get("driver_terminal_handle") for t in entry["tickets"]
                                                             if t.get("driver_terminal_handle")]))
        if not entry["error"] and entry["driver_history"] != (plan_history.get(path) or {}).get("driver_history"):
            plan_history[path] = {"coordinator_session": entry.get("coordinator_session"),
                                  "driver_history": entry["driver_history"]}
            save_json(PLAN_HISTORY_PATH, plan_history)
    return entry


# A ticket's "e2e_progress" names a progress file run-tc rewrites every few seconds (active runs, latest result per TC,
# history); it is re-read on mtime change and attached as ticket["e2e"]. A missing file attaches an empty state.
e2e_cache = {}  # progress path -> (mtime, data)


def read_json_cached(p):
    """(data or {}) for a JSON file, re-read only when its mtime changes; a failed read keeps the last good data."""
    try:
        mtime = os.path.getmtime(p)
    except OSError:
        mtime = None
    cached = e2e_cache.get(p)
    if not cached or cached[0] != mtime:
        data = {}
        if mtime is not None:
            try:
                with open(p) as f:
                    data = json.load(f)
            except (OSError, ValueError):
                data = cached[1] if cached else {}
        cached = e2e_cache[p] = (mtime, data if isinstance(data, dict) else {})
    return cached[1]


# Long test runs (rspec, E2E, jest, builds) report progress for the 「테스트」 area. Two sources:
# - TEST_DIR: one JSON file per run that the worker rewrites atomically (write a temp file, then rename) —
#   {"label", "kind", "phase": building|running|done|failed, "total", "done", "passed", "failed", "pending",
#    "started_at", "updated_at", "eta_s", "failures": [{"id", "msg"}], "log", "owner", "terminal", "session_id"};
#   terminal (ORCA_TERMINAL_HANDLE) / session_id (CLAUDE_CODE_SESSION_ID) tie it to a session card, as run-tc's rows do.
#   A file untouched for TEST_KEEP_S drops out of view (the file itself is left alone).
# - run-tc progress files ({"active", "latest", "history"}): RUN_TC_PROGRESS plus every plan ticket's e2e_progress.
TEST_DIR = "/private/tmp/agent-test-progress"
TEST_KEEP_S = 24 * 3600
TEST_FIELDS = ("label", "kind", "phase", "detail", "total", "done", "passed", "failed", "pending", "started_at",
               "updated_at", "eta_s", "log", "owner", "terminal", "session_id")
RUN_TC_PROGRESS = prefs.get("run_tc_progress") or []  # run-tc progress files, listed in prefs.json
test_progress = {"files": [], "run_tc": {}, "history_n": 0, "history_at": None}
# Finished runs outlive their sources (a progress file drops out after TEST_KEEP_S, /private/tmp empties on reboot):
# each one is copied here once, keyed by source + run, and served by /api/tests for the 「테스트」 tab.
TEST_HISTORY_PATH = os.path.join(HERE, "test-history.json")
TEST_HISTORY_DAYS, TEST_HISTORY_MAX = 30, 2000
try:
    with open(TEST_HISTORY_PATH) as _f:
        test_history = json.load(_f)
    if not isinstance(test_history, dict):
        test_history = {}
except (OSError, ValueError):
    test_history = {}


def finished_key(r):
    """Sort key for a kept run: its finish time as epoch seconds (sources mix "Z" and "+09:00"), 0 when unknown."""
    try:
        return datetime.fromisoformat(str(r.get("finished_at")).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return 0


def archive_tests(files, run_tc):
    """Copy finished runs into test_history; True when something was added or pruned."""
    recs = {}
    for f in files:
        if f.get("phase") in ("done", "failed"):
            fin = f.get("updated_at") or datetime.fromtimestamp(f["mtime"], timezone.utc).isoformat()
            recs[f"file:{f['key']}:{f.get('started_at') or fin}"] = {
                **{k: f.get(k) for k in TEST_FIELDS}, "src": "file", "key": f["key"], "finished_at": fin,
                "failures": f["failures"]}
    for d in run_tc.values():
        latest = d.get("latest") if isinstance(d.get("latest"), dict) else {}
        for h in d.get("history") or []:
            if not isinstance(h, dict) or not h.get("run"):
                continue
            ids = h.get("ids") if isinstance(h.get("ids"), list) else []
            bad = (h.get("failed") or 0) > 0 or bool(re.search("실패|중단", str(h.get("outcome") or "")))
            recs["run-tc:" + str(h["run"])] = {
                "src": "run-tc", "key": h["run"], "kind": "e2e", "label": "E2E " + ", ".join(map(str, ids)),
                "owner": h.get("caller"), "phase": "failed" if bad else "done", "detail": h.get("outcome"),
                "passed": h.get("passed"), "failed": h.get("failed"), "started_at": h.get("started_at"),
                "finished_at": h.get("finished_at"), "updated_at": h.get("finished_at"), "log": h.get("log"),
                "failures": [{"id": tc, "msg": short(str(l.get("error") or ""), 300)} for tc, l in latest.items()
                             if isinstance(l, dict) and l.get("run") == h["run"] and l.get("status") == "failed"][:20]}
    changed = False
    for k, r in recs.items():
        old = test_history.get(k)
        if old is None or {**old, "archived_at": None} != {**r, "archived_at": None}:
            test_history[k] = {**r, "archived_at": (old or {}).get("archived_at") or time.time()}
            changed = True
    cutoff = time.time() - TEST_HISTORY_DAYS * 86400
    keep = sorted((k for k, r in test_history.items() if r.get("archived_at", 0) >= cutoff),
                  key=lambda k: finished_key(test_history[k]), reverse=True)[:TEST_HISTORY_MAX]
    if len(keep) != len(test_history):
        for k in set(test_history) - set(keep):
            del test_history[k]
        changed = True
    return changed


def collect_tests():
    now, files = time.time(), []
    try:
        names = sorted(n for n in os.listdir(TEST_DIR) if n.endswith(".json"))
    except OSError:
        names = []
    for n in names:
        p = os.path.join(TEST_DIR, n)
        d = read_json_cached(p)
        mtime = e2e_cache[p][0]
        if not d or not mtime or now - mtime > TEST_KEEP_S:
            continue
        fails = [{"id": short(str(f.get("id") or ""), 200), "msg": short(str(f.get("msg") or ""), 300)}
                 for f in (d.get("failures") or [])[:20] if isinstance(f, dict)] if isinstance(d.get("failures"), list) else []
        files.append({**{k: d.get(k) for k in TEST_FIELDS}, "key": n[:-5], "mtime": mtime, "failures": fails})
    for p in [p for p in e2e_cache if p.startswith(TEST_DIR + "/") and os.path.basename(p) not in names]:
        e2e_cache.pop(p, None)  # a removed run file
    paths = set(RUN_TC_PROGRESS) | {t["e2e_progress"] for plan in list(ext_plans.values())
                                    for t in plan["tickets"] if isinstance(t.get("e2e_progress"), str)}
    run_tc = {p: d for p in sorted(paths) if (d := read_json_cached(p))}
    with lock:
        archived = archive_tests(files, run_tc)
        if archived:
            save_json(TEST_HISTORY_PATH, test_history)
            test_progress.update(history_n=len(test_history), history_at=time.time())
        if archived or files != test_progress["files"] or run_tc != test_progress["run_tc"]:
            test_progress.update(files=files, run_tc=run_tc)
            bump()


def attach_e2e_progress():
    for plan in list(ext_plans.values()):
        # Drivers still on old code rewrite plan.json without tc_plan/e2e_progress, so the new driver also writes them to
        # e2e-tc-plan.json beside it ({package: {tc_plan, e2e_progress}}); plan.json values win when present.
        side = read_json_cached(os.path.join(os.path.dirname(plan["path"]), "e2e-tc-plan.json"))
        for t in plan.get("tickets") or []:
            extra = side.get(t.get("package")) if isinstance(side.get(t.get("package")), dict) else {}
            for key in ("tc_plan", "e2e_progress"):
                if not t.get(key) and extra.get(key):
                    with lock:
                        t[key] = extra[key]
                        bump()
            if not t.get("e2e_progress"):
                continue
            # run-tc replaces the progress file atomically, so a failed read is transient: the last state is kept
            data = read_json_cached(t["e2e_progress"])
            if t.get("e2e") is not data:
                with lock:
                    t["e2e"] = data
                    bump()


def with_plan_terms(sm):
    """A plan's coordinator session owns the plan's scheduler and per-ticket driver terminals,
    so the UI nests those scripts (and their Runs and workers) under it."""
    extra = []
    for plan in ext_plans.values():
        if plan.get("coordinator_session") not in (sm["id"], os.path.splitext(os.path.basename(sm["path"]))[0]):
            continue
        extra += [plan.get("scheduler_terminal")] + [t.get("driver_terminal_handle") for t in plan["tickets"]]
        extra += plan.get("driver_history") or []
        rids = set(plan.get("run_ids") or [])
        extra += [r.get("coordinator_handle") for r in orca_state["runs"] if r.get("id") in rids]
    made = list(sm["made_terms"])
    made += [h for h in dict.fromkeys(extra) if h and h not in made]
    sm["made_terms"] = made
    return sm


# Settled dispatches outlive the tracked-run window: once a Run ages out, its workers leave orca_state,
# and a finished worker would fall back to its transcript (idle, or stalled when release cut the last turn).
# {"tasks": {task id: dispatch status}, "runs": [run ids already swept]}, persisted across restarts.
SETTLED_PATH = os.path.join(HERE, "settled.json")
try:
    with open(SETTLED_PATH) as _f:
        settled_store = json.load(_f)
except (OSError, ValueError):
    settled_store = {}
settled_store.setdefault("tasks", {})
settled_store.setdefault("runs", [])


def record_settled(workers, tasks=()):
    """Remember settled dispatches, and settled Tasks (a Task keeps its status even when its
    dispatch row is gone); True when something new was recorded."""
    pairs = [(w.get("taskId"), w.get("dispatchStatus")) for w in workers] + [(t.get("id"), t.get("status")) for t in tasks]
    new = {tid: st for tid, st in pairs
           if tid and st in ("completed", "failed", "cancelled") and settled_store["tasks"].get(tid) != st}
    settled_store["tasks"].update(new)
    return bool(new)


def save_settled():
    tmp = SETTLED_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(settled_store, f)
    os.replace(tmp, SETTLED_PATH)


# Oldest point the dashboard still looks back to (epoch). It stretches past --hours while a session that
# started earlier is still active (a coordinator can run for days), so its Runs and workers stay visible.
horizon_since = None


HORIZON_MAX_HOURS = 72


def window_start(hours):
    """--hours ago, or the start of the earliest still-active coordinator if that is older, up to
    HORIZON_MAX_HOURS. The stretch keeps a coordinator that runs for ~40 hours with its Runs and workers;
    it used to follow any active session, so one interactive session open since 9/11 pulled the window back
    32 days and the server held 1,701 sessions (1,474 of them older than a day)."""
    now = time.time()
    since = now - hours * 3600
    with lock:  # issues_orchestration is set while parsing; the "coordinator" role only once summary() runs
        starts = [s.started for s in sessions.values()
                  if s.issues_orchestration and s.role != "worker" and not s.parent and s.started
                  and (seconds_since(s.last_ts) or 1e12) < WAIT_SECONDS]
    for st in starts:
        age = seconds_since(st)
        if age is not None:
            since = min(since, now - age)
    return max(since, now - max(hours, HORIZON_MAX_HOURS) * 3600)


RUNS_FULL_EVERY = 60  # seconds between full run-list pagings (3+ pages); the newest page is read every cycle
ORCA_BACKOFF_MAX = 30
ORCA_ACTION_TIMEOUT = 30  # terminal close / switch: a slow Orca often finishes between 15 and 30 seconds


def orca_loop(max_runs, hours):
    """Poll Orca. task-list needs --run, so tasks and workers are fetched per tracked Run.
    Runs with open tasks are re-read every cycle. Settled Runs are re-read when the newest page of
    worker-list shows a dispatch the cache does not know (a driver reusing its Run for the next
    checkbox), otherwise a few per cycle, stalest first. Re-reading all of them every minute made one
    cycle take minutes on a loaded machine, so new tasks showed up late."""
    prev = None
    cache = {}  # run id -> (fetched_at, tasks, workers)
    swept_at = {}  # untracked run id -> last sweep, for Runs that still had open dispatches
    open_old = set()  # Runs outside the window whose sweep found open dispatches: tracked until they settle
    global horizon_since
    # Orca's app runtime sometimes stops answering for tens of seconds; every CLI call then waits out its
    # timeout. Back off instead of queueing more calls on a stalled Orca (they also delay a 닫기 click).
    backoff, runs_all, runs_at = 0, [], 0.0
    while True:
        try:
            if time.time() - runs_at > RUNS_FULL_EVERY or not runs_all:
                runs_all, runs_at = orca_all("runs", "orchestration", "run-list"), time.time()
            else:  # newest page only; older Runs come from the last full listing
                page = orca("orchestration", "run-list").get("runs") or []
                ids = {r["id"] for r in page}
                runs_all = page + [r for r in runs_all if r["id"] not in ids]
            all_runs = runs = list(runs_all)
            run_coord.update({r["id"]: r.get("coordinator_handle") for r in all_runs if r.get("id")})
            runs.sort(key=lambda r: r.get("created_at") or "", reverse=True)
            since = window_start(hours)
            recent = [r for r in runs if (seconds_since(r.get("created_at")) or 1e12) < time.time() - since]
            runs = recent if len(recent) >= max_runs else runs[:max_runs]
            ids = {r["id"] for r in runs}
            runs += [r for r in all_runs if r["id"] in open_old and r["id"] not in ids]
            horizon_since = since
            news = {}  # run id -> dispatches on the newest worker page
            for x in orca("orchestration", "worker-list", "--limit", "100").get("workers") or []:
                news.setdefault(x.get("runId"), set()).add((x.get("dispatchId"), x.get("dispatchStatus")))
            budget = SETTLED_PER_CYCLE
            for r in sorted(runs, key=lambda r: cache.get(r["id"], (0,))[0]):  # stalest first
                at, t, w = cache.get(r["id"], (0, None, None))
                settled = bool(t) and all(x.get("status") in ("completed", "failed", "cancelled") for x in t)
                changed = bool(news.get(r["id"], set()) - {(x.get("dispatchId"), x.get("dispatchStatus")) for x in w or []})
                due = time.time() - at > SETTLED_EVERY and budget > 0
                if t is None or not settled or changed or due:
                    if t is not None and settled and not changed:
                        budget -= 1
                    t = orca("orchestration", "task-list", "--run", r["id"]).get("tasks", [])
                    w = orca_all("workers", "orchestration", "worker-list", "--run", r["id"])
                    cache[r["id"]] = (time.time(), t, w)
            tasks, workers = {}, []
            for r in runs:
                _, t, w = cache[r["id"]]
                tasks[r["id"]] = t
                workers.extend(w)
            # Drop fast-changing fields (preview, lastOutputAt) so the snapshot only changes on real updates.
            terminals = [{k: t.get(k) for k in ("handle", "title", "worktreePath", "branch", "connected", "tabId", "leafId")}
                         for t in orca("terminal", "list").get("terminals", [])]
            snapshot = {"runs": runs, "tasks": tasks, "workers": workers, "terminals": terminals, "error": None}
            dirty = record_settled(workers, [x for ts in tasks.values() for x in ts])
            # Runs outside the window are swept once (the first start backfills them all); one that still
            # had open dispatches is looked at again every 5 minutes until it settles.
            tracked = {r["id"] for r in runs}
            done_runs = set(settled_store["runs"])
            sweeps = 6  # per cycle: the first start backfills over several cycles instead of one long one
            for r in all_runs:
                rid = r["id"]
                if rid in tracked or rid in done_runs or time.time() - swept_at.get(rid, 0) < 300:
                    continue
                if not sweeps:
                    break
                sweeps -= 1
                swept_at[rid] = time.time()
                w = orca_all("workers", "orchestration", "worker-list", "--run", rid)
                t = orca("orchestration", "task-list", "--run", rid).get("tasks", [])
                dirty = record_settled(w, t) or dirty
                if all(x.get("dispatchStatus") in ("completed", "failed", "cancelled") for x in w) \
                        and all(x.get("status") in ("completed", "failed", "cancelled") for x in t):
                    settled_store["runs"].append(rid)
                    open_old.discard(rid)
                    dirty = True
                else:
                    open_old.add(rid)
            # An open old Run that settled while tracked goes back to the swept list.
            for r in runs:
                rid = r["id"]
                if rid in open_old and all(x.get("dispatchStatus") in ("completed", "failed", "cancelled")
                                           for x in cache.get(rid, (0, [], []))[2]):
                    open_old.discard(rid)
                    if rid not in done_runs:
                        settled_store["runs"].append(rid)
                        dirty = True
            if dirty:
                with lock:
                    save_settled()
                    bump()
            backoff = 0
        except Exception as e:  # orca not running, CLI changed, etc.
            report_failure("orca", e)
            snapshot = {**orca_state, "error": str(e)}
            if isinstance(e, subprocess.TimeoutExpired):
                backoff = min(ORCA_BACKOFF_MAX, max(8, backoff * 2))
                log(f"orca: no answer in {e.timeout}s, next poll in {backoff}s")
        key = json.dumps(snapshot, sort_keys=True, default=str)
        if key != prev:
            prev = key
            with lock:
                orca_state.update(snapshot, updated=time.time())
                bump()
        loop_ok("orca")  # the thread is alive; Orca's own failures are shown from orca_state["error"]
        time.sleep(backoff or 4)


# ---- 상호작용 (inter-agent messages) ----
# Orca keeps every orchestration message (send/ask/reply/worker_done/heartbeat) in its inbox. The 상호작용 tab
# reads it on demand: addresses are rewritten to terminal handles so the page can name the sessions on each end.
run_coord = {}  # run id -> coordinator terminal handle, for every Run run-list returns
inbox_cache = {"at": 0, "key": None, "body": None}
INBOX_TTL = 3
INBOX_BODY_CAP = 6000


# ---- 닫기 jobs: terminal closes run off the request thread ----
close_jobs = {}  # job id -> {id, handle, total, done, closed[], failed[], state, started, finished}
jobs_lock = threading.Lock()


def terminal_open(handle):
    """True while Orca still lists the terminal as connected; None when Orca cannot say (it is stalled)."""
    try:
        return any(t.get("handle") == handle and t.get("connected")
                   for t in orca("terminal", "list", timeout=ORCA_ACTION_TIMEOUT).get("terminals", []))
    except Exception:
        return None


def close_terminal(handle):
    """-> None on success, else the reason. A timed-out close is checked against `terminal list` (it often went
    through anyway) and tried once more when the terminal is still there."""
    err = None
    for _ in range(2):
        try:
            orca("terminal", "close", "--terminal", handle, timeout=ORCA_ACTION_TIMEOUT)
            return None
        except subprocess.TimeoutExpired:
            err = f"Orca 가 {ORCA_ACTION_TIMEOUT}초 안에 응답하지 않음"
        except Exception as e:
            err = short(e, 200)
        still = terminal_open(handle)
        if still is False:
            return None
        if still is None:
            return err + " · 닫혔는지 확인 못 함"
    return err


def run_close(jid, handle, below):
    """Close the terminals below first (deepest first, as close_tree ordered them), the session's own last."""
    job = close_jobs[jid]
    for h in [*below, handle]:
        why = close_terminal(h)
        with jobs_lock:
            job["done"] += 1
            (job["failed"] if why else job["closed"]).append({"handle": h, "error": why} if why else h)
        if why:
            log(f"close {h}{' under ' + handle if h != handle else ''}: {why}")
    closed = set(job["closed"])
    global focus_handles
    with lock:  # drop them now so the buttons go on the next refresh, before orca_loop's next pass
        orca_state["terminals"] = [t for t in orca_state.get("terminals", []) if t.get("handle") not in closed]
        focus_handles = {h: sid for h, sid in focus_handles.items() if h not in closed}
        bump()
    with jobs_lock:
        job.update(state="done", finished=time.time())
        for k in [k for k, j in close_jobs.items() if j["state"] == "done" and time.time() - j["finished"] > 600]:
            del close_jobs[k]


def interactions(limit, heartbeats):
    """-> {"messages": [...], "fetched": n}. limit counts the messages kept after the heartbeat filter."""
    raw = orca("orchestration", "inbox", "--limit", str(limit if heartbeats else limit * 3)).get("messages") or []
    with lock:
        by_dispatch = {w.get("dispatchId"): w.get("agentTerminalHandle") for w in orca_state.get("workers", [])
                       if w.get("dispatchId") and w.get("agentTerminalHandle")}
        coords = dict(run_coord)
    payloads = {}
    for m in raw:
        try:
            payloads[m["id"]] = json.loads(m.get("payload") or "{}") or {}
        except ValueError:
            payloads[m["id"]] = {}
        d = payloads[m["id"]].get("dispatchId")  # a worker's own message names its dispatch: learn the mapping
        if d and str(m.get("from_handle", "")).startswith("term_"):
            by_dispatch.setdefault(d, m["from_handle"])

    def term(addr):
        addr = addr or ""
        if addr.startswith("run:"):
            return coords.get(addr[4:]), "run"
        if addr.startswith("dispatch:"):
            return by_dispatch.get(addr[9:]), "dispatch"
        return (addr, "term") if addr.startswith("term_") else (None, "other")

    out = []
    for m in raw:
        if m.get("type") == "heartbeat" and not heartbeats:
            continue
        p, (ft, fk), (tt, tk) = payloads[m["id"]], term(m.get("from_handle")), term(m.get("to_handle"))
        body = m.get("body") or ""
        out.append({"id": m["id"], "run_id": m.get("run_id"), "type": m.get("type"), "priority": m.get("priority"),
                    "thread_id": m.get("thread_id"), "subject": m.get("subject"),
                    "body": body[:INBOX_BODY_CAP], "cut": len(body) > INBOX_BODY_CAP,
                    "from": m.get("from_handle"), "from_term": ft, "from_kind": fk,
                    "to": m.get("to_handle"), "to_term": tt, "to_kind": tk,
                    "task_id": p.get("taskId"), "outcome": p.get("outcome"), "phase": p.get("phase"),
                    "question": p.get("question"), "files": p.get("filesModified") or [],
                    "read": bool(m.get("read")), "created_at": m.get("created_at")})
        if len(out) >= limit:
            break
    return {"messages": out, "fetched": len(raw)}


# ---- 결정 버튼: AskUserQuestion shown on the page, answered in either place ----
# decision-hook (next to this file) is a Claude Code PreToolUse hook on AskUserQuestion. It registers the question
# here (/api/decision/ask) and ends at once, so Claude opens the terminal picker as usual and the page shows the same
# question as a card. An answer in the terminal closes the card once the transcript has the tool result
# (stale_decisions). An answer from the page is typed into that picker through the session's Orca terminal
# (type_answers), one key at a time, reading the rendered screen before and after each step; when the terminal is
# unknown or the screen is not what is expected it stops and says so, and the picker stays for the terminal.
DECISION_EVERY = 1.5
DECISION_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
DECISION_KEEP_S = 7200  # a card whose question never got a result in the transcript goes after this
decisions = {"available": True, "pending": []}  # what /api/state shows: the open cards, oldest first
decision_lock = threading.Lock()  # guards decision_store
decision_store = {}  # id -> {"card": the public card, "state": pending|answered|cancelled, "terminal", "busy"}


def epoch(ts):
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()
    except (AttributeError, ValueError):
        return 0


def publish_decisions():
    """Copy the open cards into `decisions` for /api/state. Call holding decision_lock, not `lock`."""
    pending = sorted((d["card"] for d in decision_store.values() if d["state"] == "pending"), key=lambda c: c["created_at"])
    with lock:
        if pending != decisions["pending"]:
            decisions["pending"] = pending
            bump()


def settle_decision(rid, state):
    """pending -> answered | cancelled. False when it was not pending."""
    with decision_lock:
        d = decision_store.get(rid)
        if not d or d["state"] != "pending":
            return False
        d.update(state=state, settled=time.time())
        publish_decisions()
        return True


def valid_questions(qs):
    return (isinstance(qs, list) and 1 <= len(qs) <= 4 and all(
        isinstance(q, dict) and isinstance(q.get("question"), str) and isinstance(q.get("options"), list)
        and all(isinstance(o, dict) and isinstance(o.get("label"), str) for o in q["options"]) for q in qs))


def add_decision(body):
    """A question from the hook -> its card id."""
    qs = body.get("questions")
    if not valid_questions(qs):
        raise ValueError("questions")
    rid = f"q{int(time.time() * 1000):x}{os.urandom(3).hex()}"
    cwd = body.get("cwd") if isinstance(body.get("cwd"), str) else ""
    term = body.get("terminal") if isinstance(body.get("terminal"), str) and HANDLE.fullmatch(body["terminal"]) else None
    card = {"id": rid, "session_id": str(body.get("session_id") or "") or None, "tool_use_id": body.get("tool_use_id"),
            "agent": os.path.basename(cwd.rstrip("/")) or "에이전트", "cwd": cwd, "created_at": time.time(),
            "questions": [{"question": q["question"], "header": q.get("header") or "", "multiSelect": bool(q.get("multiSelect")),
                           "preview": any(o.get("preview") for o in q["options"]),
                           "options": [{"label": o["label"], "description": o.get("description") or ""} for o in q["options"]]}
                          for q in qs]}
    with decision_lock:
        decision_store[rid] = {"card": card, "state": "pending", "terminal": term, "busy": False}
        publish_decisions()
    return rid


TYPED = re.compile(r"^[^\x00-\x1f\x7f]{1,500}$")  # typed text goes into the picker's input line: no control keys


def check_answers(card, answers):
    """The page's answers in question order (a label or typed text; a list of labels, at most one typed, for
    multiSelect) -> the same, trimmed; or an error string for one missing or one the picker cannot take by key."""
    if len(answers) != len(card["questions"]):
        return "답하지 않은 질문이 있습니다"
    out = []
    for q, a in zip(card["questions"], answers):
        labels = [o["label"] for o in q["options"]]
        picks = a if q["multiSelect"] else [a]
        if not (isinstance(picks, list) and picks and all(isinstance(x, str) and x.strip() for x in picks)):
            return "답하지 않은 질문이 있습니다"
        picks = list(dict.fromkeys(x.strip() for x in picks))
        typed = [x for x in picks if x not in labels]
        # a picker with previews has no typed row
        if len(labels) + 1 > 9 or len(typed) > (0 if q["preview"] else 1) or not all(TYPED.match(x) for x in typed):
            return "이 답은 대시보드에서 넣을 수 없습니다 — 터미널에서 답하세요"
        out.append(picks if q["multiSelect"] else picks[0])
    return out


# The picker as Claude Code draws it (checked against v2.1): a tab bar ("←  ☐ 색  ☒ 과일  ✔ Submit  →", or a single
# "☐ 색"), the question, numbered rows ("❯ 1. [✔] 사과" for multiSelect, "  2. 초록" otherwise; the row after the
# options is "Type something"), and a footer ending in "Esc to cancel". Several questions end in a review page
# ("Ready to submit your answers?"). Digit keys pick a single-choice option (and move on) or toggle a multiSelect
# one; on the typed row the keys go into its input line; → leaves a multiSelect question (but moves the text cursor
# on the typed row); Enter takes a single-choice typed row. Options with a preview are drawn beside a preview box
# ("❯ 1. 왼쪽      ┌───┐", checked against v2.1.303) with no typed row; there a digit only moves the cursor and
# Enter picks.
# Text sent in one write arrives as a paste, so each key goes on its own.
PICK_ROW = re.compile(r"^\s*(❯)?\s*(\d)\.\s(?:\[(.)\]\s)?(.*)$")
KEY_RIGHT, KEY_UP, KEY_DOWN, KEY_ENTER = "\x1b[C", "\x1b[A", "\x1b[B", "\r"
PICK_STEP_S = 4  # how long one key may take to show on the screen


class PickerError(Exception):
    pass


def compact(s):
    return re.sub(r"\s+", "", s)


def picker_state(handle, card):
    """The terminal's rendered screen -> {"kind": "gone", "answered": the screen shows answers sent} (no picker),
    {"kind": "review"}, {"kind": "other"}, or
    {"kind": "question", "qi", "answered": a question already has its tab ticked, "rows": {n: (text, checked)},
    "cursor": n}."""
    t = orca("terminal", "read", "--terminal", handle, "--screen", timeout=10)["terminal"]
    if t.get("source") != "screen":
        raise PickerError("터미널 화면을 읽지 못했습니다")
    lines = t["tail"] if isinstance(t["tail"], list) else str(t["tail"]).splitlines()
    if any("Ready to submit your answers?" in ln for ln in lines[-12:]):
        return {"kind": "review"}  # it has no footer
    foot = max((i for i, ln in enumerate(lines) if "Esc to cancel" in ln), default=None)
    if foot is None:
        return {"kind": "gone", "answered": any("User answered Claude's question" in ln for ln in lines)}
    head = next((i for i in range(foot, -1, -1) if "☐" in lines[i] or "☒" in lines[i]), None)
    if head is None:
        return {"kind": "other"}
    body = lines[head + 1:foot]
    rows, cursor, first = {}, None, None
    for i, ln in enumerate(body):
        m = PICK_ROW.match(ln)
        if not m:
            continue
        n = int(m[2])
        if n == 1 and first is None:
            first = i
        if first is not None and n not in rows:
            rows[n] = (m[4].strip(), m[3] not in (None, " "))
            cursor = n if m[1] else cursor
    if first is None:
        return {"kind": "other"}
    text = compact("".join(re.sub(r"^\s*│", "", ln) for ln in body[:first]))  # v2.1.3xx rules the question off with "│"
    qi = next((i for i, q in enumerate(card["questions"]) if compact(q["question"]) == text), None)
    if qi is None:
        return {"kind": "other"}
    return {"kind": "question", "qi": qi, "answered": "☒" in lines[head], "rows": rows, "cursor": cursor}


def type_answers(handle, card, answers):
    """Drive the picker in `handle` to `answers` (from check_answers). Raises PickerError, leaving the picker open,
    when the screen is not the fresh picker for this card or stops matching what was typed."""
    def press(key):
        orca("terminal", "send", "--terminal", handle, "--text", key, timeout=10)
        time.sleep(0.15)

    def until(ok, what):
        end = time.time() + PICK_STEP_S
        while True:
            st = picker_state(handle, card)
            if ok(st):
                return st
            if time.time() > end:
                raise PickerError(what)
            time.sleep(0.25)

    def sent(st):  # read twice: a frame caught mid-redraw has no footer either
        if st["kind"] != "gone" or not st["answered"]:
            return False
        time.sleep(0.3)
        st = picker_state(handle, card)
        return st["kind"] == "gone" and st["answered"]

    on = lambda qi: lambda s: s["kind"] == "question" and s["qi"] == qi
    st = until(lambda s: s["kind"] in ("question", "review"), "터미널에 이 질문의 선택기가 떠 있지 않습니다")
    if st["kind"] == "review" or st["qi"] or st["answered"] or any(c for _, c in st["rows"].values()):
        raise PickerError("터미널에서 이미 답하기 시작했습니다")
    last = len(card["questions"]) - 1
    for qi, (q, a) in enumerate(zip(card["questions"], answers)):
        labels, n = [o["label"] for o in q["options"]], len(q["options"])
        if q["multiSelect"]:
            typed = [x for x in a if x not in labels]
            want = {labels.index(x) + 1 for x in a if x in labels} | ({n + 1} if typed else set())
            for k in sorted(want):
                press(str(k))
            if typed:
                for _ in range(n + 1 - (st["cursor"] or 1)):
                    press(KEY_DOWN)
                until(lambda s: on(qi)(s) and s["cursor"] == n + 1, "직접 입력 칸으로 가지 못했습니다")
                press(typed[0])
            until(lambda s: on(qi)(s) and {k for k, (_, c) in s["rows"].items() if c} == want
                  and (not typed or compact(typed[0]).startswith(compact(s["rows"].get(n + 1, ("", False))[0]) or "-")),
                  "터미널의 선택이 보낸 답과 다릅니다")
            if typed:  # → only moves within the input line: step off it first
                press(KEY_UP)
                until(lambda s: on(qi)(s) and s["cursor"] == n, "직접 입력 칸에서 나오지 못했습니다")
            press(KEY_RIGHT)
        elif a in labels:
            k = labels.index(a) + 1
            press(str(k))
            if q["preview"]:
                until(lambda s: on(qi)(s) and s["cursor"] == k, "선택지로 가지 못했습니다")
                press(KEY_ENTER)
        else:
            press(str(n + 1))
            until(lambda s: on(qi)(s) and s["cursor"] == n + 1, "직접 입력 칸으로 가지 못했습니다")
            press(a)
            until(lambda s: on(qi)(s) and compact(a).startswith(compact(s["rows"].get(n + 1, ("", False))[0]) or "-"),
                  "직접 입력한 글이 터미널에 들어가지 않았습니다")
            press(KEY_ENTER)
        # The next question, the review page or, after the last one, the picker closing on its own.
        st = until(lambda s: (s["kind"] == "question" and s["qi"] > qi) or (qi == last and (s["kind"] == "review" or sent(s))),
                   "터미널이 다음 단계로 넘어가지 않았습니다")
    if st["kind"] == "review":
        press("1")  # "1. Submit answers"
        until(sent, "답을 제출하지 못했습니다")


def decision_terminal(d):
    """The Orca terminal a card's session runs in: the hook's ORCA_TERMINAL_HANDLE, else the session's terminal as
    the last /api/state mapped it (focus_targets). None outside Orca."""
    if d["terminal"]:
        return d["terminal"]
    sid = d["card"]["session_id"]
    return next((h for h, s in focus_handles.items() if s == sid), None)


DECISION_LOG = os.path.join(HERE, "decision.log")


def log_decision_failure(rid, card, handle, error):
    """One JSON line in decision.log per answer the page could not put in, with the screen the terminal shows
    afterwards: the card reports only the error, and the picker that caused it is gone by the time anyone looks."""
    entry = {"at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "id": rid, "terminal": handle, "error": error,
             "questions": [q["question"][:80] for q in card["questions"]] if card else None}
    if handle:
        try:
            t = orca("terminal", "read", "--terminal", handle, "--screen", timeout=10)["terminal"]
            entry["screen"] = (t["tail"] if isinstance(t["tail"], list) else str(t["tail"]).splitlines())[-40:]
        except Exception as e:
            entry["screen"] = f"(읽지 못함: {short(e, 160)})"
    try:
        with open(DECISION_LOG, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except OSError as e:
        report_failure("decision", e)


def answer_decision(rid, answers):
    """An answer from the page -> (http status, body). Types it into the session's terminal picker."""
    status, out, card, handle = answer_decision_once(rid, answers)
    if status != 200:
        log_decision_failure(rid, card, handle, out["error"])
    return status, out


def answer_decision_once(rid, answers):
    """answer_decision's work -> (status, body, the card or None, the terminal handle or None)."""
    with decision_lock:
        d = decision_store.get(rid)
        if not d or d["state"] != "pending":
            return 409, {"error": "이미 답했거나 닫힌 질문입니다"}, d and d["card"], None
        if d["busy"]:
            return 409, {"error": "이 질문의 답을 터미널에 입력하는 중입니다"}, d["card"], None
        answers = check_answers(d["card"], answers)
        if isinstance(answers, str):
            return 400, {"error": answers}, d["card"], None
        handle = decision_terminal(d)
        if not handle:
            return 409, {"error": "이 세션의 Orca 터미널을 찾지 못했습니다 — 터미널에서 답하세요"}, d["card"], None
        d["busy"] = True
    try:
        type_answers(handle, d["card"], answers)
    except PickerError as e:
        return 409, {"error": f"{e} — 터미널에서 답하세요"}, d["card"], handle
    except Exception as e:
        return 502, {"error": f"터미널에 입력하지 못했습니다 ({short(e, 160)}) — 터미널에서 답하세요"}, d["card"], handle
    finally:
        with decision_lock:
            d["busy"] = False
    settle_decision(rid, "answered")
    return 200, {"ok": True}, d["card"], handle


# A question answered in the terminal, cancelled there, or ended with its session is closed by the transcript: the
# AskUserQuestion call the card came from (its tool_use_id; without one, the same session's call with the same first
# question logged within ASK_MATCH_S of the card) already has a tool result. Such cards are cancelled here, as are ones past DECISION_KEEP_S.
ASK_MATCH_S = 120


def stale_decisions(pending):
    """Ids of pending questions whose AskUserQuestion call already ended in the session's transcript."""
    by_id = {s.id: s for s in sessions.values() if s.kind == "claude"}
    out = set()
    for r in pending:
        s, qs = by_id.get(r.get("session_id")), r.get("questions")
        q0 = qs[0].get("question") if isinstance(qs, list) and qs and isinstance(qs[0], dict) else None
        if not s or not q0 or not isinstance(r.get("created_at"), (int, float)):
            continue
        if r.get("tool_use_id"):
            # Not logged yet while the picker opens; matching by question here would take an earlier identical call.
            if s.asks.get(r["tool_use_id"], [0, 0, False])[2]:
                out.add(r.get("id"))
            continue
        near = [a for a in s.asks.values() if a[0] == q0 and abs(a[1] - r["created_at"]) <= ASK_MATCH_S]
        if near and min(near, key=lambda a: abs(a[1] - r["created_at"]))[2]:
            out.add(r.get("id"))
    return out


def sweep_decisions():
    """Cancel stale or abandoned cards and forget settled ones after a while."""
    with lock:
        pending = list(decisions["pending"])
        stale = stale_decisions(pending)
    now = time.time()
    for r in pending:
        if r["id"] in stale or now - r["created_at"] > DECISION_KEEP_S:
            settle_decision(r["id"], "cancelled")
    with decision_lock:
        for rid in [k for k, d in decision_store.items() if d["state"] != "pending" and now - d.get("settled", now) > 300]:
            del decision_store[rid]


def decision_loop():
    while True:
        try:
            sweep_decisions()
            loop_ok("decision")
        except Exception as e:
            loop_failed("decision", e)
        time.sleep(DECISION_EVERY)


# ---- 프로젝트 진행: <--projects-dir>/<project>/progress.json (../exports/project-progress.schema.json) ----
# The file holds source facts only (ordered stages, their steps with dates and status); everything derived — stage
# status and span, step counts, current stage, completion — is computed here, never written back. Read-only: a
# file that does not match the schema shows as that project's error and the rest carry on.
PROJECTS_DIRS = []  # main() fills it from --projects-dir; empty turns the feature off
PROJECTS_EVERY = 2
STEP_STATES = ("scheduling", "pending", "active", "done", "failed")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
DATETIME_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-](\d{2}):(\d{2}))$")
project_cache = {}  # progress.json path -> (mtime, entry)
projects = {"version": 0, "dirs": [], "list": []}  # what /api/projects serves; rebound whole, so readers need no lock


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


def lite_project(p):
    """List form: the detail without each stage's steps."""
    return {**p, "stages": [{k: v for k, v in st.items() if k != "steps"} for st in p["stages"]]} if "stages" in p else p


NOTE_MAX = 1 << 20
WIKILINK = re.compile(r"\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?(?:\|[^\]\n]*)?\]\]")


def find_project(name, base=None):
    """The listed project by folder name; ?dir= picks one when the same name sits in two --projects-dir."""
    return next((e for e in projects["list"] if e["name"] == name and base in (None, e["dir"])), None)


def project_note(entry, rel):
    """(body, status) for a note inside a project's folder: any .md under it, not only the steps, so the page can
    follow a step note's [[links]]. The resolved path must stay inside the folder (no .., no symlink out)."""
    root = os.path.realpath(os.path.dirname(entry["path"]))
    full = os.path.realpath(os.path.join(root, rel))
    if not full.startswith(root + os.sep) or not full.endswith(".md") or not os.path.isfile(full):
        return {"error": "not found"}, 404
    if os.path.getsize(full) > NOTE_MAX:
        return {"error": "노트가 너무 큼"}, 413
    try:
        with open(full, encoding="utf-8") as f:
            content = f.read()
    except (OSError, UnicodeDecodeError) as e:
        return {"error": short(e, 200)}, 500
    # [[target]] -> a note in this project folder: a vault path ("10_Projects/<p>/x/_index") matches by suffix,
    # a bare name by file name. Links outside the folder stay unresolved (path None).
    notes = []
    for d, subdirs, files in os.walk(root):
        subdirs[:] = [s for s in subdirs if not s.startswith(".")]
        notes += [os.path.relpath(os.path.join(d, f), root) for f in files if f.endswith(".md")]
    links = []
    for target in dict.fromkeys(m.strip() for m in WIKILINK.findall(content)):
        want = target if target.endswith(".md") else target + ".md"
        # the longest suffix match wins, so ".../3 설계문서/_index" is not taken for the folder's own _index
        hit = sorted((n for n in notes if ("/" + want).endswith("/" + n) or ("/" + n).endswith("/" + want)), key=len, reverse=True) or \
              [n for n in notes if os.path.basename(n) == os.path.basename(want)]
        links.append({"target": target, "path": hit[0] if hit else None})
    return {"project": entry["name"], "path": os.path.relpath(full, root), "abs": full,
            "mtime": os.path.getmtime(full), "content": content, "links": links}, 200


def scan_projects():
    """One pass over every --projects-dir; rebinds `projects` (and bumps its version) only when something changed."""
    dirs, found = [], {}
    for base in PROJECTS_DIRS:
        try:
            names = sorted(os.listdir(base))
        except OSError as e:
            dirs.append({"dir": base, "error": short(e.strerror or e, 200)})
            continue
        dirs.append({"dir": base, "error": None})
        for name in names:
            path = os.path.join(base, name, "progress.json")
            try:
                mtime = os.path.getmtime(path)
            except OSError:
                continue  # not a project folder (or not one yet)
            cached = project_cache.get(path)
            if not cached or cached[0] != mtime:
                cached = project_cache[path] = (mtime, read_progress(path, mtime, base, name))
            found[path] = cached[1]
    for path in [p for p in project_cache if p not in found]:
        project_cache.pop(path)  # a folder removed or its progress.json deleted
    global projects
    listed = list(found.values())
    if listed != projects["list"] or dirs != projects["dirs"]:
        projects = {"version": projects["version"] + 1, "dirs": dirs, "list": listed}


def projects_loop():
    while True:
        try:
            scan_projects()
            loop_ok("projects")
        except Exception as e:
            loop_failed("projects", e)
        time.sleep(PROJECTS_EVERY)


# ---- HTTP ----
# Bumped when a change to /api/* or /events would break a page built for the old shape; the page compares it
# with the one it was built for and says so instead of rendering garbage.
API_VERSION = 1
TICKET_RE = re.compile(r"\b([A-Z]{2,}-\d+)\b", re.ASCII)
PLACE_RE = re.compile(r"(?:^|\n)\s*(?:배치|워크트리|worktree|placement)\s*[:：]\s*([^\n]+)", re.I)


def lite_task(t):
    """Snapshot form of a task: spec and result stay on /api/run, their few derived values come along."""
    spec = t.get("spec") or ""
    place = PLACE_RE.search(spec)
    ticket = TICKET_RE.search(spec)
    try:
        outcome = (json.loads(t.get("result") or "null") or {}).get("outcome")
    except (ValueError, AttributeError):
        outcome = None
    return {**{k: t.get(k) for k in ("id", "run_id", "task_title", "display_name", "status", "deps",
                                      "created_at", "completed_at")},
            "place_hint": place.group(1).strip() if place else None,
            "ticket_key": ticket.group(1) if ticket else None,
            "outcome": outcome}


focus_handles = {}  # terminal -> session id, as the last /api/state mapped them: the only ones /api/orca/close accepts


def focus_targets(summaries):
    """Session id -> the connected Orca terminal it runs in, for 「Orca 에서 열기」. Orca's hook pane wins (it
    covers any Orca-launched Claude session); a terminal handle read from the transcript (own_handle) is the
    fallback, unless the hook places another session in that terminal. Subagents run in their parent's pane."""
    terms = {t["handle"]: t for t in orca_state.get("terminals", []) if t.get("connected")}
    by_pane = {f'{t["tabId"]}:{t["leafId"]}': h for h, t in terms.items() if t.get("tabId") and t.get("leafId")}
    out = {}
    for sm in summaries:
        h = by_pane.get((hooks.get(sm["id"]) or {}).get("pane"))
        if h and not sm["parent"]:
            out[sm["id"]] = h
    claimed = set(out.values())
    for sm in summaries:
        h = sm.get("own_handle")
        if sm["id"] not in out and not sm["parent"] and h in terms and h not in claimed:
            out[sm["id"]] = h
    return out


close_trees = {}  # terminal -> the connected terminals below it, deepest first, as the last /api/state mapped them


def close_tree(sm, summaries, focus, terms):
    """The connected Orca terminals under a session, for a cascading close: its workers' terminals (recursively,
    through sub-coordinators) and the terminals it opened (made_terms: driver/scheduler scripts, whose Run workers
    join the tree too). A terminal another session outside the tree runs in is left alone. Deepest first, so a
    coordinator never outlives the workers that report to it."""
    owners, tree, out, seen = {sm.get("own_handle"), focus.get(sm["id"])} | set(sm["made_terms"]), {sm["id"]}, [], set()
    level = list(sm["made_terms"])
    while True:
        kids = [w for w in summaries if w["role"] == "worker" and not w["parent"] and w["id"] not in tree
                and w.get("coord_handle") in owners]
        if not kids:
            break
        tree |= {w["id"] for w in kids}
        level += [focus.get(w["id"]) for w in kids]
        for w in kids:
            owners |= {w.get("own_handle"), focus.get(w["id"])} | set(w["made_terms"])
            level += w["made_terms"]
    foreign = {h for sid, h in focus.items() if sid not in tree}
    for h in reversed(level):
        if h and h in terms and h not in foreign and h not in seen and h != focus.get(sm["id"]):
            seen.add(h)
            out.append(h)
    return out


def lite_orca(o):
    prov = lambda w: (w.get("projection") or {}).get("provider") or {}
    return {"runs": [{k: r.get(k) for k in ("id", "objective", "coordinator_handle", "created_at")} for r in o.get("runs", [])],
            "tasks": {rid: [lite_task(t) for t in ts] for rid, ts in o.get("tasks", {}).items()},
            "workers": [{"taskId": w.get("taskId"), "runId": w.get("runId"), "dispatchStatus": w.get("dispatchStatus"),
                         "model": prov(w).get("model") or prov(w).get("id")} for w in o.get("workers", [])],
            "terminals": o.get("terminals", []), "error": o.get("error"), "updated": o.get("updated")}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    # Encode under `lock` (the snapshot shares dicts the collector threads mutate), then send outside it:
    # writing a multi-MB body to a slow remote client used to hold the lock and stall every collector.
    @staticmethod
    def encode(obj):
        return json.dumps(obj, ensure_ascii=False, default=str).encode()

    def send_json(self, obj, status=200):
        self.send_body(obj if isinstance(obj, bytes) else self.encode(obj), status)

    def build_state(self):
        """-> (version, encoded /api/state body)."""
        global focus_handles, close_trees
        with lock:
            v = version
            # The same Codex session can exist as two files (Orca home and ~/.codex): keep the fuller copy.
            by_id = {}
            for s in sessions.values():
                cur = by_id.get((s.kind, s.id))
                if not cur or (s.offset, s.last_ts or "") > (cur.offset, cur.last_ts or ""):
                    by_id[(s.kind, s.id)] = s
            # A worker whose dispatch settled is done, even if its transcript stopped mid-turn
            # (release can end the process before the closing message is written).
            # Also covers Runs that aged out of the tracked window (settled_store).
            settled = {**settled_store["tasks"],
                       **{w.get("taskId"): w.get("dispatchStatus") for w in orca_state.get("workers", [])
                          if w.get("dispatchStatus") in ("completed", "failed", "cancelled")}}
            summaries = []
            waiting = {}  # Claude session id -> its oldest pending question (decisions lists oldest first)
            for r in decisions["pending"]:
                waiting.setdefault(r.get("session_id") or None, r)
            for sess in by_id.values():
                sm = sess.summary()
                if sm["task_id"] in settled:
                    sm.update(state="done", live=False, state_reason="Orca: dispatch " + settled[sm["task_id"]])
                sm["decision"] = waiting.get(sm["id"]) if sm["kind"] == "claude" else None
                summaries.append(apply_prefs(with_plan_terms(sm)))
            focus = focus_targets(summaries)
            terms = {t["handle"] for t in orca_state.get("terminals", []) if t.get("connected")}
            trees = {}
            for sm in summaries:
                sm["orca_focus"] = focus.get(sm["id"])
                sm["orca_close_tree"] = close_tree(sm, summaries, focus, terms) if sm["orca_focus"] else []
                if sm["orca_focus"]:
                    trees[sm["orca_focus"]] = sm["orca_close_tree"]
            # Rebound, never edited in place: orca_terminal reads them without waiting for this lock.
            focus_handles = {h: sid for sid, h in focus.items()}
            close_trees = trees
            body = self.encode({
                "version": version, "api": API_VERSION,
                "sessions": sorted(summaries, key=lambda s: s["last_ts"] or "", reverse=True),
                "orca": lite_orca(orca_state),
                "ext_plans": [ext_plans[p] for p in EXTERNAL_PLANS if p in ext_plans],
                "tests": test_progress,
                "health": {"now": time.time(), "loops": health},
                "decisions": decisions,
            })
        return v, body

    def send_body(self, body, status=200, gz=None):
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        if len(body) > 1024 and "gzip" in self.headers.get("Accept-Encoding", ""):
            body = gz or gzip.compress(body, 5)
            self.send_header("Content-Encoding", "gzip")
            self.send_header("Vary", "Accept-Encoding")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def authorized(self, url):
        self.cors = None
        if not host_allowed(self.headers.get("Host")):
            self.send_json({"error": "unknown host"}, 403)
            return False
        origin = self.headers.get("Origin")
        if origin is None:  # not a cross-origin browser request (curl, a page opened on this address)
            return True
        if not origin_allowed(origin):
            self.send_json({"error": "origin not allowed"}, 403)
            return False
        self.cors = origin
        return True

    def end_headers(self):
        if getattr(self, "cors", None):
            self.send_header("Access-Control-Allow-Origin", self.cors)
            self.send_header("Vary", "Origin")
        super().end_headers()

    def do_OPTIONS(self):
        """CORS preflight for the JSON POSTs; Chrome's local network access check rides on the same request."""
        if not self.authorized(urlparse(self.path)):
            return
        self.send_response(204)
        if self.cors:
            self.send_header("Access-Control-Allow-Methods", "GET, POST")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Max-Age", "600")
            if self.headers.get("Access-Control-Request-Private-Network") == "true":
                self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        url = urlparse(self.path)
        if not self.authorized(url):
            return
        if url.path == "/":
            self.send_json({"name": "agent-dashboard", "api": API_VERSION})
        elif url.path == "/api/state":
            # Every open page refetches on each version tick: build the snapshot once per version and hand the
            # same bytes to the rest (three tabs used to rebuild it three times, each under the lock).
            with state_cache_lock:
                if not (state_cache["v"] == version and time.time() - state_cache["at"] < STATE_CACHE_SECONDS):
                    v, raw = self.build_state()
                    state_cache.update(v=v, body=raw, gz=gzip.compress(raw, 5), at=time.time())
                raw, gz = state_cache["body"], state_cache["gz"]
            self.send_body(raw, gz=gz)  # sent outside the cache lock: a slow client holds up no one
        elif url.path == "/api/session":
            path = parse_qs(url.query).get("path", [""])[0]
            with lock:
                s = sessions.get(path)
                body = s and self.encode(apply_prefs(with_plan_terms(s.detail())))
            if not body:
                return self.send_json({"error": "not found"}, 404)
            self.send_body(body)
        elif url.path == "/api/tests":
            with lock:
                body = self.encode({"runs": sorted(({**r, "id": k} for k, r in test_history.items()),
                                                   key=finished_key, reverse=True),
                                    "at": test_progress["history_at"]})
            self.send_body(body)
        elif url.path == "/api/history":
            self.send_json(history_payload())
        elif url.path == "/api/run":
            rid = parse_qs(url.query).get("id", [""])[0]
            with lock:
                run = next((r for r in orca_state.get("runs", []) if r.get("id") == rid), None)
                body = run and self.encode({"run": run, "tasks": orca_state.get("tasks", {}).get(rid, []),
                                            "workers": [w for w in orca_state.get("workers", []) if w.get("runId") == rid]})
            if not body:
                return self.send_json({"error": "not found"}, 404)
            self.send_body(body)
        elif url.path == "/api/decision/wait":
            # A decision-hook from before the hook stopped waiting may still poll after an update: let it step aside
            # (the terminal picker opens), since this server no longer holds questions for it.
            self.send_json({"state": "gone"})
        elif url.path == "/api/orca/job":
            jid = parse_qs(url.query).get("id", [""])[0]
            with jobs_lock:
                job = close_jobs.get(jid)
                body = job and self.encode(job)
            if not body:
                return self.send_json({"error": "not found"}, 404)
            self.send_body(body)
        elif url.path == "/api/interactions":
            q = parse_qs(url.query)
            limit = max(50, min(5000, int((q.get("limit") or ["1500"])[0] or 1500)))
            hb = (q.get("hb") or ["0"])[0] == "1"
            key = (limit, hb)
            try:
                if inbox_cache["key"] != key or time.time() - inbox_cache["at"] > INBOX_TTL:
                    inbox_cache.update(key=key, body=self.encode(interactions(limit, hb)), at=time.time())
            except Exception as e:  # orca not running, CLI changed, etc.
                return self.send_json({"error": str(e)}, 502)
            self.send_body(inbox_cache["body"])
        elif url.path == "/api/projects":
            p = projects
            self.send_json({"enabled": bool(PROJECTS_DIRS), "version": p["version"], "dirs": p["dirs"],
                            "projects": [lite_project(e) for e in p["list"]]})
        elif url.path == "/api/project":
            # By folder name; ?dir= picks one when the same name sits in two --projects-dir (else the first listed).
            q = parse_qs(url.query)
            found = find_project((q.get("name") or [""])[0], (q.get("dir") or [None])[0])
            if not found:
                return self.send_json({"error": "not found" if PROJECTS_DIRS else "--projects-dir 가 지정되지 않음"}, 404)
            self.send_json(found)
        elif url.path == "/api/project/note":
            # ?name=<project>&path=<note path relative to the project folder>[&dir=]: a step note or a note it links to
            q = parse_qs(url.query)
            found = find_project((q.get("name") or [""])[0], (q.get("dir") or [None])[0])
            if not found:
                return self.send_json({"error": "not found" if PROJECTS_DIRS else "--projects-dir 가 지정되지 않음"}, 404)
            self.send_json(*project_note(found, (q.get("path") or [""])[0]))
        elif url.path == "/events":
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            seen = seen_projects = -1
            try:
                while True:
                    # Project changes go out as a named event, so a page listening only for plain messages
                    # (the /api/state refetch) is not woken by them.
                    if PROJECTS_DIRS and projects["version"] != seen_projects:
                        seen_projects = projects["version"]
                        self.wfile.write(f"event: projects\ndata: {seen_projects}\n\n".encode())
                    if version != seen:
                        seen = version
                        self.wfile.write(f"data: {seen}\n\n".encode())
                    else:
                        self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
                    time.sleep(1)
            except (BrokenPipeError, ConnectionResetError):
                pass
        else:
            self.send_json({"error": "not found"}, 404)


    def do_POST(self):
        url = urlparse(self.path)
        if not self.authorized(url):
            return
        # JSON only: a cross-site form cannot send this content type without a CORS preflight, which authorized()
        # already limits to --origin.
        if url.path not in ("/api/pref", "/api/orca/focus", "/api/orca/close", *DECISION_POSTS) or not self.headers.get("Content-Type", "").startswith("application/json"):
            return self.send_json({"error": "bad request"}, 400)
        if url.path in DECISION_POSTS:
            return self.decision_post(url.path.rsplit("/", 1)[1])
        if url.path in ("/api/orca/focus", "/api/orca/close"):
            return self.orca_terminal(url.path.rsplit("/", 1)[1])
        try:
            body = json.loads(self.rfile.read(min(int(self.headers.get("Content-Length") or 0), 65536)))
            action, paths = body["action"], body["paths"]
            assert action in ("idle", "unidle", "hide", "unhide") and isinstance(paths, list)
        except (ValueError, KeyError, AssertionError, TypeError):
            return self.send_json({"error": "bad request"}, 400)
        with lock:
            for path in paths:
                s = sessions.get(path)
                if not s:
                    continue
                if action == "idle":
                    prefs["idle"][path] = s.last_ts or ""
                elif action == "unidle":
                    prefs["idle"].pop(path, None)
                elif action == "hide":
                    prefs["hidden"][path] = prefs["hidden_ids"][f"{s.kind}:{s.id}"] = datetime.now(timezone.utc).isoformat()
                else:
                    prefs["hidden"].pop(path, None)
                    prefs["hidden_ids"].pop(f"{s.kind}:{s.id}", None)
            save_prefs()
            bump()
        self.send_json({"ok": True})


    def orca_terminal(self, action):
        """{"handle"} -> focus: `orca terminal switch` and raise the Orca window, for any connected terminal the
        page offers (sessions and script drivers). close: `orca terminal close`, ending the agent's process (the
        transcript stays, so `claude --resume` can pick it up); only a terminal the last snapshot mapped to a
        session is accepted, never a driver script or an arbitrary handle. A running session may be closed too
        (the user's call); the page's confirm dialog warns about it. {"cascade": true} first closes the terminals
        the server itself mapped under that session (close_trees: workers and the scripts it opened), never a list
        the page sends. One failing below does not stop the rest; the session's own terminal closes last."""
        try:
            body = json.loads(self.rfile.read(min(int(self.headers.get("Content-Length") or 0), 65536)))
            handle, cascade = body["handle"], body.get("cascade", False)
            assert isinstance(handle, str) and HANDLE.fullmatch(handle) and isinstance(cascade, bool)
        except (ValueError, KeyError, AssertionError, TypeError, AttributeError):
            return self.send_json({"error": "bad request"}, 400)
        # No lock: these are whole objects swapped in by their writers, and build_state can hold the lock for
        # seconds, which used to delay every click before Orca was even asked.
        known = {t["handle"] for t in orca_state.get("terminals", []) if t.get("connected")}
        if action == "close":
            known &= set(focus_handles)
        below = list(close_trees.get(handle, [])) if action == "close" and cascade else []
        if handle not in known:
            return self.send_json({"error": "Orca 에 연결된 세션 터미널이 아닙니다"}, 404)
        if action == "close":
            # Each close takes ~2.5s even when Orca is healthy, so a coordinator with its workers ran past any
            # sensible request time. Answer at once; the page polls /api/orca/job for the outcome.
            jid = f"close-{int(time.time() * 1000)}"
            with jobs_lock:
                close_jobs[jid] = {"id": jid, "handle": handle, "total": len(below) + 1, "done": 0, "closed": [],
                                   "failed": [], "state": "running", "started": time.time()}
            threading.Thread(target=run_close, args=(jid, handle, below), daemon=True).start()
            return self.send_json({"ok": True, "job": jid, "total": len(below) + 1}, 202)
        try:
            orca("terminal", "switch", "--terminal", handle, timeout=ORCA_ACTION_TIMEOUT)
        except subprocess.TimeoutExpired:
            return self.send_json({"error": f"Orca 가 {ORCA_ACTION_TIMEOUT}초 안에 응답하지 않았습니다 (Orca 가 바쁜 상태). 잠시 뒤 다시 눌러 주세요"}, 504)
        except Exception as e:
            return self.send_json({"error": "Orca 전환 실패: " + short(e, 200)}, 502)
        # switch changes the tab inside Orca; bring the window itself forward too (the click asked for it)
        subprocess.run(["open", "-a", "Orca"], capture_output=True, timeout=5)
        self.send_json({"ok": True})

    def decision_post(self, action):
        """ask {session_id, tool_use_id, cwd, terminal, questions} from the hook -> {id}. answer {id, answers} from
        the page: types them into the session's terminal picker (answer_decision); 200 done, 400 an answer missing or
        one the picker cannot take, 409 no longer open or the terminal not usable, 502 Orca failed. release {id}: the
        old page's 「터미널에서 답하기」; the picker is already open, so nothing to do."""
        try:
            body = json.loads(self.rfile.read(min(int(self.headers.get("Content-Length") or 0), 262144)))
            assert isinstance(body, dict)
            if action == "ask":
                return self.send_json({"id": add_decision(body)})
            rid = body["id"]
            assert isinstance(rid, str) and DECISION_ID.match(rid)
            assert action != "answer" or isinstance(body["answers"], list)
        except (ValueError, KeyError, AssertionError, TypeError):
            return self.send_json({"error": "bad request"}, 400)
        if action == "answer":
            status, out = answer_decision(rid, body["answers"])
            return self.send_json(out, status)
        self.send_json({"ok": True})


DECISION_POSTS = ("/api/decision/ask", "/api/decision/answer", "/api/decision/release")


class Server(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        # A tab closed or a phone that slept mid-response is routine; it used to leave a traceback per hangup.
        if isinstance(sys.exc_info()[1], (BrokenPipeError, ConnectionResetError)):
            return
        super().handle_error(request, client_address)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--hours", type=float, default=24, help="only sessions touched within this window")
    ap.add_argument("--runs", type=int, default=8, help="minimum number of recent Orca runs to track (all runs inside --hours are tracked)")
    ap.add_argument("--host", action="append",
                    help="address to bind; repeatable (default 127.0.0.1). e.g. --host 127.0.0.1 --host <tailscale ip>")
    ap.add_argument("--origin", action="append", default=[],
                    help="page origin allowed over CORS, subdomains included; repeatable. e.g. --origin https://<project>.pages.dev")
    ap.add_argument("--projects-dir", action="append", default=[],
                    help="folder whose subfolders with a progress.json are projects; repeatable. Off when not given")
    args = ap.parse_args()
    hosts = args.host or ["127.0.0.1"]
    PROJECTS_DIRS.extend(os.path.abspath(os.path.expanduser(d)) for d in args.projects_dir)
    threading.Thread(target=scan_loop, args=(args.hours,), daemon=True).start()
    threading.Thread(target=orca_loop, args=(args.runs, args.hours), daemon=True).start()
    threading.Thread(target=ext_plan_loop, daemon=True).start()
    threading.Thread(target=history_loop, daemon=True).start()
    threading.Thread(target=decision_loop, daemon=True).start()
    if PROJECTS_DIRS:
        threading.Thread(target=projects_loop, daemon=True).start()
    servers = []
    ALLOWED_HOSTS.update(h.lower() for h in hosts)
    ALLOWED_ORIGINS.update(o.rstrip("/").lower() for o in args.origin)
    for host in hosts:
        server = Server((host, args.port), Handler)
        servers.append(server)
        print(f"agent-dashboard API → http://{host}:{args.port}/", flush=True)
    print(f"allowed origins: {', '.join(sorted(ALLOWED_ORIGINS)) or '(local only)'}", flush=True)
    print(f"project dirs: {', '.join(PROJECTS_DIRS) or '(off)'}", flush=True)
    for server in servers[1:]:
        threading.Thread(target=server.serve_forever, daemon=True).start()
    servers[0].serve_forever()


if __name__ == "__main__":
    main()
