#!/usr/bin/env python3
"""Local agent dashboard metrics server — REST + SSE for Claude/Codex sessions and Orca runs.

Stdlib only. Tails session logs incrementally and pushes change notices over SSE. The page itself lives in
../frontend and is served elsewhere (Cloudflare Pages); this process only answers /api/* and /events.

    python3 server.py [--port 8787] [--hours 24] [--host 127.0.0.1] [--origin https://<project>.pages.dev]
                      [--projects-dir <folder of project folders>] [--design-dir <design folder>] [--design-days 14]

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
import shlex
import subprocess
import sys
import threading
import time
import traceback
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urlparse
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
# User-role text that is not an instruction: harness tags (<task-notification>, <system-reminder>, …), the
# "[Image: original WxH …]" line beside a pasted image, and Orca's inbox nudge. Counted as instructions, they
# split a plan in two whenever one arrived between `aplan done` and a revising `aplan set`.
NOT_INSTRUCTION = re.compile(r"\s*(?:<|\[Image: |You have \d+ orchestration messages?\b)")
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
        self.inbox_picks = {}  # 메일함 item id -> the pick the agent wrote for it ("[메일함 <id>] ..."); see sweep_decisions
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
        self.reads = DesignReads(path, kind)  # design-document reads, for the 「설계문서」 tab
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
            if self.reads.wants(raw):
                self.reads.feed(rec, ts)
            changed = True
        if self.reads.stats:
            note_design_stats(self.reads)
        return changed

    def add_log(self, ts, role, text, instruction=True, **extra):
        if role == "user":
            self.last_prompt, self.last_prompt_ts = text, ts
            if instruction and not NOT_INSTRUCTION.match(text or ""):
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
                    for m in INBOX_PICK.finditer(block["text"]):
                        self.inbox_picks[m[1]] = m[2].strip(" `*")
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
                self.add_log(ts, "user", short(content), instruction=not rec.get("isMeta"))
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
                        self.add_log(ts, "user", short(block.get("text", "")), instruction=not rec.get("isMeta"))
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


def prune_sessions(known, cutoff, held=frozenset()):
    """Drop sessions whose transcript has not changed since `cutoff`, the same test that keeps a file out at
    discovery, so a long-running server holds what a fresh start would (it held every session it ever saw:
    944 after a day, 10 of them live, with /api/state growing to 2.9MB). A dropped session moves to the
    history cache so the 7-day compare keeps it; prefs (idle/hidden) are keyed by path and survive.
    Sessions in `held` (ids with a 메일함 item, inbox_sessions) stay whatever their age. Returns the dropped paths."""
    gone = []
    for path, s in list(known.items()):
        if s.id in held:
            continue
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


scan_ready = False  # scan_loop has read every transcript once: a session it does not know by now does not exist


def scan_loop(hours):
    global scan_ready
    known = {}
    plan_offsets = {}
    pruned = set()  # paths dropped by prune_sessions, in case one comes back to life
    last_glob = last_tick = last_prune = 0
    while True:
        now = time.time()
        try:
            cutoff = min(now - hours * 3600, horizon_since or now)
            held = inbox_sessions()  # a 메일함 item keeps its session listed, however old
            if now - last_prune > PRUNE_EVERY:
                last_prune = now
                gone = prune_sessions(known, cutoff, held)
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
                            if os.path.getmtime(path) < cutoff and os.path.splitext(os.path.basename(path))[0] not in held:
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
            scan_ready = True
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
# path -> {"coordinator_session", "driver_history", "owner"}, persisted across restarts (owner: see plan_owners)
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
            attach_box_notes()
        except Exception as e:
            loop_failed("ext_plan", e, where="box notes")
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
    entry = {"path": path, "project": None, "generated_at": None, "tickets": [], "extra_worktrees": [], "error": None}
    if mtime is None:
        entry["error"] = "파일 없음"
    else:
        try:
            with open(path) as f:
                data = json.load(f)
            entry.update({k: data.get(k) for k in ("project", "driver", "generated_at", "design_root", "design_commit",
                                                   "coordinator_session", "coordinator_terminal", "scheduler_terminal")},
                         tickets=data.get("tickets") or [], extra_worktrees=data.get("extra_worktrees") or [])
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
            plan_history[path] = {**(plan_history.get(path) or {}), "coordinator_session": entry.get("coordinator_session"),
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


# A box the driver adds after start (a fix for integration-review findings or a scene mismatch) carries only fix_source
# in plan.json. Its reason is the 「- 추가 사유: <reason> — <date>」 line the driver writes under that box in the launch
# sheet (the ticket state <package>.json beside the plan names the sheet), else the findings it was added for; a review's
# round is the 「N라운드」/「N차」 in its title. They are attached as reason_auto / round_auto; fix_reason / round written
# by the driver itself win on the page.
ROUND_RE = re.compile(r"(\d+)\s*(?:라운드|차)")
ROUND_KINDS = ("integration-review", "pr-review", "completion-review")
text_cache = {}  # path -> (mtime, text)


def read_text_cached(p):
    try:
        mtime = os.path.getmtime(p)
    except OSError:
        return ""
    cached = text_cache.get(p)
    if not cached or cached[0] != mtime:
        try:
            with open(p, encoding="utf-8") as f:
                cached = text_cache[p] = (mtime, f.read())
        except (OSError, ValueError):
            return cached[1] if cached else ""
    return cached[1]


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
                        bump()


def resolve_plan_owner(path, plan, summaries):
    """(owner session id, None) or (None, why) for an external plan. The plan's own claim comes first — the session
    it names, else the one running in its coordinator terminal, else the one that opened or runs in its scheduler
    terminal — and whichever session that is, its coordinators are followed up to the top: a scheduler relaunched
    from a worker's terminal still belongs to that worker's coordinator. A resolved owner is remembered in
    plan_history, so a plan whose trail goes cold (relaunched with nohup, a reused terminal) keeps its owner."""
    top = [sm for sm in summaries if not sm["parent"]]
    by_handle = {sm["own_handle"]: sm for sm in sorted(top, key=lambda sm: sm["last_ts"] or "") if sm.get("own_handle")}
    by_id = {}
    for sm in top:
        by_id[sm["id"]] = by_id[os.path.splitext(os.path.basename(sm["path"]))[0]] = sm

    def ascend(sm):
        seen = {sm["id"]}
        while sm["role"] == "worker" and sm.get("coord_handle") in by_handle and by_handle[sm["coord_handle"]]["id"] not in seen:
            sm = by_handle[sm["coord_handle"]]
            seen.add(sm["id"])
        return sm

    sched = plan.get("scheduler_terminal")
    found = (by_id.get(plan.get("coordinator_session") or "")
             or by_handle.get(plan.get("coordinator_terminal") or "")
             or next((sm for sm in sorted(top, key=lambda sm: sm["last_ts"] or "", reverse=True) if sched and sched in sm["made_terms"]), None)
             or by_handle.get(sched or ""))
    remembered = (plan_history.get(path) or {}).get("owner")
    if found:
        owner = ascend(found)["id"]
        if owner != remembered:
            plan_history[path] = {**(plan_history.get(path) or {}), "owner": owner}
            save_json(PLAN_HISTORY_PATH, plan_history)
        return owner, None
    if remembered in by_id:
        return remembered, None
    if plan.get("coordinator_session"):
        return None, f"계획이 적은 코디네이터 세션 {plan['coordinator_session'][:8]} 을 찾지 못함"
    if sched:
        return None, f"스케줄러 터미널 {sched[:13]} 을 연 세션도, 그 안에서 도는 세션도 없음 (coordinator.json 없음)"
    return None, "계획에 코디네이터·스케줄러가 없음 (coordinator.json 없음)"


plan_owners = {}  # plan path -> (owner session id or None, why not), as the last /api/state resolved them


def with_plan_terms(sm):
    """A plan's coordinator session owns the plan's scheduler and per-ticket driver terminals,
    so the UI nests those scripts (and their Runs and workers) under it."""
    extra = []
    for path, plan in ext_plans.items():
        if (plan_owners.get(path) or (None,))[0] != sm["id"]:
            continue
        extra += [plan.get("scheduler_terminal")] + [t.get("driver_terminal_handle") for t in plan["tickets"]]
        extra += plan.get("driver_history") or []
        rids = set(plan.get("run_ids") or [])
        extra += [r.get("coordinator_handle") for r in orca_state["runs"] if r.get("id") in rids]
    made = list(sm["made_terms"])
    made += [h for h in dict.fromkeys(extra) if h and h not in made]
    sm["made_terms"] = made
    return sm


def plan_with_owner(path, plan):
    """The plan as the page gets it, naming the owner resolve_plan_owner found (flagged coordinator_inferred when the
    plan itself named another or none) or, without one, why not (owner_problem), so an unowned plan says so."""
    owner, why = plan_owners.get(path) or (None, None)
    if not owner:
        return {**plan, "owner_problem": why}
    return plan if owner == plan.get("coordinator_session") else {**plan, "coordinator_session": owner, "coordinator_inferred": True}


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
decisions = {"available": True, "pending": [], "inbox_mode": False, "inbox": []}  # what /api/state shows: the open
# cards, oldest first; whether 메일함 mode is on; the 메일함, newest first
decision_lock = threading.Lock()  # guards decision_store and inbox_store
decision_store = {}  # id -> {"card": the public card, "state": pending|answered|cancelled, "terminal", "busy"}

# 메일함 모드 (prefs "decision_inbox", one switch for the whole server): the user is away. The hook still registers
# each question, but it is filed in the 메일함 instead of opening a card, and /api/decision/ask answers {"deny": reason};
# the hook turns that into a PreToolUse deny, so no picker opens and Claude goes on with the recommended option
# ("(Recommended)" in its label, else the first) or its own best call. The reason asks it to write its pick as one
# line "[메일함 <id>] ..."; the transcript scan keeps that line (Session.inbox_picks) and sweep_decisions copies it
# to the item. Until then the item shows the recommended options the server worked out. Choosing another answer on
# the page later sends the session a follow-up message through its Orca terminal (inbox_answer).
# Items outlive restarts (inbox.json): {id: {"card": the public item, "terminal"}}.
# While a session has an item it is held: the scan keeps it listed however old (scan_loop), a supervised worker's
# terminal is retained (retain_worker), and session-guard keeps agents from closing it (guard_command). A person
# may still close it from the page. An item whose session the scan does not know is dropped, like an orphan card.
INBOX_PATH = os.path.join(HERE, "inbox.json")
INBOX_KEEP = 200  # newest items kept ...
INBOX_KEEP_S = 14 * 86400  # ... and read ones only this long
INBOX_PICK = re.compile(r"\[메일함 (q[0-9a-f]{8,40})\][ \t]*([^\n]{1,300})")
RECOMMENDED = re.compile(r"\((?:Recommended|권장|추천)\)", re.I)
try:
    with open(INBOX_PATH) as _f:
        inbox_store = {d["card"]["id"]: d for d in json.load(_f)["items"]}
except (OSError, ValueError, KeyError, TypeError):
    inbox_store = {}


def inbox_sessions():
    """Session ids that have a 메일함 item."""
    with decision_lock:
        return {d["card"]["session_id"] for d in inbox_store.values() if d["card"]["session_id"]}


def save_inbox():
    """Call holding decision_lock."""
    tmp = INBOX_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump({"items": list(inbox_store.values())}, f, ensure_ascii=False)
    os.replace(tmp, INBOX_PATH)


def epoch(ts):
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()
    except (AttributeError, ValueError):
        return 0


def publish_decisions():
    """Copy the open cards into `decisions` for /api/state. Call holding decision_lock, not `lock`."""
    pending = sorted((d["card"] for d in decision_store.values() if d["state"] == "pending"), key=lambda c: c["created_at"])
    inbox = sorted((dict(d["card"]) for d in inbox_store.values()), key=lambda c: c["created_at"], reverse=True)
    with lock:
        mode = bool(prefs.get("decision_inbox"))
        if pending != decisions["pending"] or inbox != decisions["inbox"] or mode != decisions["inbox_mode"]:
            decisions.update(pending=pending, inbox=inbox, inbox_mode=mode)
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
    """A question from the hook -> {"id"} for a card, or {"id", "inbox": true, "deny": reason} when 메일함 mode
    filed it instead."""
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
    with lock:
        away = bool(prefs.get("decision_inbox"))
    with decision_lock:
        if away:
            card.update(recommended=[recommended(q) for q in card["questions"]], chosen=None, read=False)
            inbox_store[rid] = {"card": card, "terminal": term}
            save_inbox()
            threading.Thread(target=retain_worker, args=(term,), daemon=True).start()
        else:
            decision_store[rid] = {"card": card, "state": "pending", "terminal": term, "busy": False}
        publish_decisions()
    return {"id": rid, "inbox": True, "deny": deny_reason(card)} if away else {"id": rid}


def recommended(q):
    labels = [o["label"] for o in q["options"]]
    return next((x for x in labels if RECOMMENDED.search(x)), labels[0] if labels else "")


def deny_reason(card):
    """What Claude reads in place of the user's answer."""
    qs, picks = card["questions"], card["recommended"]
    fmt = f"[메일함 {card['id']}] " + ("답" if len(qs) == 1 else " / ".join(f"{i + 1}) 답" for i in range(len(qs))))
    rec = "; ".join(f"{i + 1}) {short(q['question'], 80)} → {p}" for i, (q, p) in enumerate(zip(qs, picks)))
    return ("사용자가 자리를 비워 이 질문을 에이전트 대시보드 메일함에 남겼습니다(메일함 모드). AskUserQuestion 을 다시 부르지 말고, "
            "각 질문의 권장 선택지((Recommended) 가 붙은 것, 없으면 첫 번째)나 가장 합리적인 판단으로 진행하세요. "
            f"진행하기 전에 무엇을 골랐는지 정확히 이 형식의 한 줄로 남기세요: {fmt} "
            "(사용자가 나중에 다른 답을 고르면 이 세션에 후속 메시지가 옵니다. 그러니 작업이 끝나도 이 세션을 닫지 마세요). "
            f"권장 선택지: {rec}")


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


class PickerGone(PickerError):
    """No picker on the screen at all: the question was closed (answered or cancelled) before the transcript said so."""


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
    try:
        st = until(lambda s: s["kind"] in ("question", "review"), "터미널에 이 질문의 선택기가 떠 있지 않습니다")
    except PickerError:
        if picker_state(handle, card)["kind"] == "gone":  # another question's picker ("other") may be a misread: kept
            raise PickerGone("터미널에 이 질문의 선택기가 없습니다. 이미 닫힌 질문이라 카드를 치웠습니다")
        raise
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
    """An answer from the page -> (http status, body). Types it into the session's terminal picker. 410 {closed}:
    the terminal shows no picker, so the card is closed (PickerGone); that is logged too, with the screen."""
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
    except PickerGone as e:
        settle_decision(rid, "cancelled")
        return 410, {"error": str(e), "closed": True}, d["card"], handle
    except PickerError as e:
        return 409, {"error": f"{e} — 터미널에서 답하세요"}, d["card"], handle
    except Exception as e:
        return 502, {"error": f"터미널에 입력하지 못했습니다 ({short(e, 160)}) — 터미널에서 답하세요"}, d["card"], handle
    finally:
        with decision_lock:
            d["busy"] = False
    settle_decision(rid, "answered")
    return 200, {"ok": True}, d["card"], handle


def followup_text(card, answers):
    """The message a later answer sends to the session: one line, so --enter submits it whole."""
    went = card["chosen"] or " / ".join(card["recommended"])
    chose = "; ".join(f"「{short(q['question'], 80)}」에 {', '.join(a) if isinstance(a, list) else a}"
                      for q, a in zip(card["questions"], answers) if a is not None)
    return re.sub(r"\s+", " ", f"[대시보드 메일함 {card['id']}] 앞서 {went} (으)로 진행했지만 사용자는 {chose} 를 골랐습니다. 반영하세요.")


def inbox_answer(rid, action, answers):
    """read | unread | delete | answer from the page -> (http status, body). answer: answers in question order, null
    for a question left as it went; sends followup_text to the session's Orca terminal and, once sent, drops the
    item (its session is no longer held). delete: drops it unsent (the page offers it after an error)."""
    with decision_lock:
        d = inbox_store.get(rid)
        if not d:
            return 404, {"error": "메일함에 없는 항목입니다"}
        if action == "delete":
            del inbox_store[rid]
        elif action != "answer":
            d["card"]["read"] = action == "read"
        if action != "answer":
            save_inbox()
            publish_decisions()
            return 200, {"ok": True}
        qs = d["card"]["questions"]
        ok = len(answers) == len(qs) and any(a is not None for a in answers) and all(
            a is None or (isinstance(a, list) and q["multiSelect"] and a and all(isinstance(x, str) and TYPED.match(x) for x in a))
            or (isinstance(a, str) and not q["multiSelect"] and TYPED.match(a)) for q, a in zip(qs, answers))
        if not ok:
            return 400, {"error": "고른 답이 없거나 보낼 수 없는 답입니다"}
        went = [d["card"]["chosen"]] if d["card"]["chosen"] and len(qs) == 1 else None if d["card"]["chosen"] else d["card"]["recommended"]
        if went and all(a is None or a == w or a == [w] for a, w in zip(answers, went)):
            return 400, {"error": "에이전트가 진행한 답과 같습니다 — 바꿀 것이 없으면 「확인」을 누르세요"}
        handle = decision_terminal(d)
        if not handle:
            return 409, {"error": "이 세션의 Orca 터미널을 찾지 못했습니다 — 세션에 직접 알려 주세요"}
        text = followup_text(d["card"], answers)
    try:
        orca("terminal", "send", "--terminal", handle, "--text", text, "--enter", timeout=15)
    except Exception as e:
        return 502, {"error": f"터미널에 보내지 못했습니다 ({short(e, 160)}) — 세션에 직접 알려 주세요"}
    with decision_lock:
        inbox_store.pop(rid, None)
        save_inbox()
        publish_decisions()
    return 200, {"ok": True, "text": text}


def worker_rows(fresh=False):
    """Supervised worker rows (dispatchId, agentTerminalHandle, ...): the tracked Runs', or Orca's newest 100."""
    rows = list(orca_state.get("workers", []))
    if fresh:
        rows += orca("orchestration", "worker-list", "--limit", "100").get("workers") or []
    return rows


def retain_worker(term):
    """A supervised worker whose session got a 메일함 item: ask Orca to keep its terminal when the Run releases it."""
    if not term:
        return
    try:
        w = next((x for x in worker_rows(fresh=True) if x.get("agentTerminalHandle") == term), None)
        if w and w.get("dispatchId"):
            orca("orchestration", "worker-retain", "--dispatch", w["dispatchId"], timeout=15)
    except Exception as e:
        log(f"worker-retain {term}: {short(e, 160)}")


def held_places():
    """(terminal handles, worktree paths) of the sessions with a 메일함 item."""
    with decision_lock:
        items = list(inbox_store.values())
    terms = {t for t in (decision_terminal(d) for d in items) if t}
    tdirs = {t.get("handle"): t.get("worktreePath") for t in orca_state.get("terminals", [])}
    with lock:
        cwd = {s.id: s.cwd for s in sessions.values() if s.kind == "claude"}
    dirs = {tdirs.get(t) for t in terms} | {cwd.get(d["card"]["session_id"]) or d["card"]["cwd"] for d in items}
    return terms, {x.rstrip("/") for x in dirs if x}


def worktree_hit(sel, dirs, own_cwd):
    """Whether an Orca worktree selector (path:, branch:, name:, id:, identity:, issue:, active/current) may name one
    of `dirs`. Loose on purpose: a wrong match only asks a person to do the close."""
    kind, _, val = sel.partition(":")
    if kind in ("active", "current") and not val:
        return any(own_cwd == d or own_cwd.startswith(d + "/") for d in dirs)
    val = val.split("::")[-1].removeprefix("refs/heads/").rstrip("/")
    if not val:
        return False
    if kind == "path":
        return any(os.path.realpath(val) == os.path.realpath(d) for d in dirs)
    return any(val in d for d in dirs)


def guard_command(command, own, own_cwd):
    """A Bash command an agent is about to run -> why it may not (it would close a held session), or None.
    Looks for `orca terminal close`, `orca worktree rm` and `orca orchestration worker-stop|worker-release|
    worker-abandon` in each simple command."""
    try:
        words = shlex.split(command, comments=True, posix=True)
    except ValueError:
        words = command.split()
    terms, dirs = held_places()
    if not terms and not dirs:
        return None
    hits = []
    cmd = []
    for w in words + [";"]:
        if w not in (";", "&&", "||", "|", "&"):
            cmd.append(w)
            continue
        i = next((k for k, x in enumerate(cmd) if os.path.basename(x) == "orca"), None)
        args = [y for x in (cmd[i + 1:] if i is not None else []) for y in (x.split("=", 1) if x.startswith("--") else [x])]
        cmd = []
        opt = lambda name: next((args[k + 1] for k, x in enumerate(args[:-1]) if x == name), None)
        sub = [x for x in args if not x.startswith("-")][:2]
        if sub == ["terminal", "close"]:
            if opt("--worktree"):
                hits += [opt("--worktree")] if worktree_hit(opt("--worktree"), dirs, own_cwd) else []
            elif (opt("--terminal") or own) in terms:
                hits.append(opt("--terminal") or own)
        elif sub == ["worktree", "rm"] and opt("--worktree") and worktree_hit(opt("--worktree"), dirs, own_cwd):
            hits.append(opt("--worktree"))
        elif sub[:1] == ["orchestration"] and any(x in args for x in ("worker-stop", "worker-release", "worker-abandon")):
            h = next((x.get("agentTerminalHandle") for x in worker_rows() if x.get("dispatchId") == opt("--dispatch")), None)
            if h in terms:
                hits.append(opt("--dispatch"))
    if not hits:
        return None
    return (f"이 명령은 메일함에 사용자가 확인할 결정이 남은 세션을 닫습니다 ({', '.join(hits)}). 사용자가 나중에 다른 답을 고르면 "
            "그 세션에 후속 메시지가 가야 하므로 에이전트·오케스트레이션은 이 세션을 닫거나 멈추거나 놓아주지 마세요. "
            "닫기가 꼭 필요하면 사용자에게 대시보드에서 직접 닫아 달라고 남기고 이 단계는 건너뛰세요.")


def set_inbox_mode(on):
    with lock:
        prefs["decision_inbox"] = on
        save_prefs()
    with decision_lock:
        publish_decisions()


# A question answered in the terminal, cancelled there, or ended with its session is closed by the transcript: the
# AskUserQuestion call the card came from (its tool_use_id; without one, the same session's call with the same first
# question logged within ASK_MATCH_S of the card) already has a tool result. Such cards are cancelled here, as are ones past DECISION_KEEP_S.
# So is a card no Claude session in the scan window owns (no session id, or a session the scan does not know) once
# ORPHAN_S has passed: the page could not link it to a session, and such a question has been closed.
ASK_MATCH_S = 120
ORPHAN_S = 90  # time for the scan to pick up the transcript of a session that just started


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
    """Cancel stale, orphaned or abandoned cards and forget settled ones after a while."""
    with lock:
        pending = list(decisions["pending"])
        stale = stale_decisions(pending)
        known = {s.id for s in sessions.values() if s.kind == "claude"}
    now = time.time()
    for r in pending:
        orphan = scan_ready and r.get("session_id") not in known and now - r["created_at"] > ORPHAN_S
        if r["id"] in stale or orphan or now - r["created_at"] > DECISION_KEEP_S:
            settle_decision(r["id"], "cancelled")
    with lock:
        picks = {k: v for s in sessions.values() if s.kind == "claude" for k, v in s.inbox_picks.items()}
    with decision_lock:
        for rid in [k for k, d in decision_store.items() if d["state"] != "pending" and now - d.get("settled", now) > 300]:
            del decision_store[rid]
        changed = False
        for rid, d in inbox_store.items():
            if picks.get(rid) and d["card"]["chosen"] != picks[rid]:
                d["card"]["chosen"] = picks[rid]
                changed = True
        keep = sorted(inbox_store, key=lambda k: inbox_store[k]["card"]["created_at"], reverse=True)[:INBOX_KEEP]
        orphan = lambda c: scan_ready and c["session_id"] not in known and now - c["created_at"] > ORPHAN_S
        for rid in [k for k, d in inbox_store.items() if k not in keep or orphan(d["card"])
                    or (d["card"]["read"] and now - d["card"]["created_at"] > INBOX_KEEP_S)]:
            del inbox_store[rid]
            changed = True
        if changed:
            save_inbox()
        publish_decisions()


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


# ---- design documents: a viewer for the design folders and the sections each session read ----
# A design folder (prefs "design_dirs" or --design-dir, e.g. <repo>/feature-designs) is indexed together with the same
# folder in every git worktree of its repository, since a feature's documents usually live on a branch until merged; an
# external plan's design_root adds its folder the same way. A document is keyed by its path from the folder's parent
# ("feature-designs/<slug>/<file>"), so the copies in different worktrees share one key. The configured folder's copy
# is the one shown, else the copy changed last.
# Reads are taken from the session logs as they are parsed: Read and Grep calls exactly (file_path/offset/limit and the
# numbered result; the hit lines), shell reads approximately (sed -n a,bp · head · tail · cat · nl · awk NR ranges,
# grep/rg hits), each turned into one reference per `## ` section it touched. References are kept in design-refs.json,
# so they outlive the session's place in the --hours window.
DESIGN_DIRS = []  # main() fills it from --design-dir and prefs["design_dirs"]; empty turns the feature off
DESIGN_EVERY = 5
DESIGN_GIT_EVERY = 60     # worktree lists and HEADs are re-read this often
DESIGN_DAYS = 14          # main() sets it from --design-days: how far back the backfill reads transcripts
DESIGN_KINDS = {".md": "md", ".svg": "image", ".png": "image", ".jpg": "image", ".jpeg": "image", ".gif": "image",
                ".webp": "image", ".pdf": "pdf"}
DESIGN_TYPES = {".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
                ".gif": "image/gif", ".webp": "image/webp", ".pdf": "application/pdf"}
DESIGN_FILE_MAX = 32 << 20
DESIGN_REFS_PATH = os.path.join(HERE, "design-refs.json")
design = {"version": 0, "sources": [], "docs": {}}  # rebound whole by scan_designs, so readers need no lock
design_bases = set()  # folder names that mark a design path ("feature-designs"); read by the session parser
design_ticket_refs = {}  # external plan path -> {package: [section badge]}, rebuilt with the index
refs_lock = threading.Lock()  # guards design_refs; taken after `lock` when both are held, never before it
try:
    with open(DESIGN_REFS_PATH) as _f:
        design_refs = json.load(_f)
except (OSError, ValueError):
    design_refs = {}
for _k in ("refs", "sessions", "scanned"):
    design_refs.setdefault(_k, {})
design_refs_dirty = False
design_rev = 0  # bumped with every reference added, so the page knows when to refetch a document's counts


def git_in(cwd, *args):
    try:
        r = subprocess.run(["git", "-C", cwd, *args], capture_output=True, text=True, timeout=5)
        return r.stdout.strip() if r.returncode == 0 else None
    except (OSError, subprocess.SubprocessError):
        return None


_git_cache = {}  # (folder, what) -> (when, value)


def git_cached(key, fn):
    hit = _git_cache.get(key)
    if not hit or time.time() - hit[0] > DESIGN_GIT_EVERY:
        hit = _git_cache[key] = (time.time(), fn())
    return hit[1]


def worktree_copies(folder):
    """The folder, then the same folder in the other worktrees of its repository (that have it)."""
    def find():
        top = git_in(folder, "rev-parse", "--show-toplevel")
        if not top:
            return [folder]
        rel = os.path.relpath(folder, top)
        out = [folder]
        for line in (git_in(folder, "worktree", "list", "--porcelain") or "").splitlines():
            if line.startswith("worktree "):
                wt = line[len("worktree "):]
                if os.path.realpath(wt) != os.path.realpath(top) and os.path.isdir(os.path.join(wt, rel)):
                    out.append(os.path.join(wt, rel))
        return out
    return git_cached((folder, "worktrees"), find)


def repo_info(folder):
    """Where a design folder sits: repository, worktree, branch and HEAD (cached a minute)."""
    def find():
        top = git_in(folder, "rev-parse", "--show-toplevel")
        if not top:
            return {"repo": None, "worktree": None, "branch": None, "head": None, "main": True}
        common = git_in(folder, "rev-parse", "--path-format=absolute", "--git-common-dir") or os.path.join(top, ".git")
        main = os.path.dirname(common) if os.path.basename(common) == ".git" else common
        return {"repo": os.path.basename(main), "worktree": os.path.basename(top), "main": main == top,
                "branch": git_in(folder, "branch", "--show-current") or None, "head": git_in(folder, "rev-parse", "HEAD")}
    return git_cached((folder, "info"), find)


def design_roots():
    """[(folder, configured)]: each configured folder and each external plan's design folder, followed by its copies
    in the repository's other worktrees. Real paths, each once."""
    want = [(d, True) for d in DESIGN_DIRS]
    names = {os.path.basename(d) for d in DESIGN_DIRS}
    for p in list(ext_plans.values()):
        root = p.get("design_root")
        if not root:
            continue
        root = os.path.realpath(os.path.expanduser(root))
        # the ancestor named like a configured folder (…/feature-designs/<slug> → …/feature-designs), else its parent
        cur = root
        while os.path.dirname(cur) != cur and os.path.basename(cur) not in names:
            cur = os.path.dirname(cur)
        want.append((cur if os.path.basename(cur) in names else os.path.dirname(root), False))
    out, seen = [], set()
    for folder, configured in want:
        if not os.path.isdir(folder):
            continue
        for i, f in enumerate(worktree_copies(folder)):
            f = os.path.realpath(f)
            if f not in seen:
                seen.add(f)
                out.append((f, configured and i == 0))
    return out


HEADING = re.compile(r"^(#{1,6})\s+(.*?)\s*#*\s*$")
FENCE = re.compile(r"^\s*(```|~~~)")
SECTION_NO = re.compile(r"^§?\s*(\d+(?:[.-]\d+)*)[.)]?(?=\s|$)")
_toc_cache = {}  # abs path -> ((mtime, size), (toc, line count))
_label_cache = {}  # abs path -> ((mtime, size), H1 title or [(chapter title, [ids])] of an index.html)
NAV_SECTIONS = re.compile(r"\bconst\s+SECTIONS\s*=\s*\[(.*?)\]\s*;", re.S)
NAV_GROUP = re.compile(r"""\btitle\s*:\s*(['"])(.*?)\1\s*,\s*ids\s*:\s*\[([^\]]*)\]""", re.S)
NAV_ID = re.compile(r"""(['"])([^'"]+)\1""")


def _by_stat(path, read):
    try:
        st = os.stat(path)
    except OSError:
        return None
    v = (st.st_mtime, st.st_size)
    hit = _label_cache.get(path)
    if hit and hit[0] == v:
        return hit[1]
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            out = read(f)
    except OSError:
        return None
    _label_cache[path] = (v, out)
    return out


def design_h1(path):
    """The first `# ` heading of a Markdown file outside code fences, or None."""
    def read(f):
        fence = None
        for n, line in enumerate(f):
            if n > 400:
                return None
            m = FENCE.match(line)
            if m:
                fence = None if fence == m.group(1) else fence or m.group(1)
            elif not fence:
                h = HEADING.match(line.rstrip("\n"))
                if h and len(h.group(1)) == 1:
                    return h.group(2) or None
        return None
    return _by_stat(path, read)


def design_nav(path):
    """The reading order of a feature folder's index.html viewer: [(chapter title, [doc ids])], the ids being paths
    without ".md" ("flows/A-teacher-settings"); [] when the page has no SECTIONS list."""
    def read(f):
        m = NAV_SECTIONS.search(f.read())
        return [(g.group(2), [i.group(2) for i in NAV_ID.finditer(g.group(3))]) for g in NAV_GROUP.finditer(m.group(1))] if m else []
    return _by_stat(path, read) or []


def nav_title(doc_id, h1):
    """The viewer's rule: a node's H1 starts with its own path or slug ("flows/R1-material R1 …"); the name is the rest."""
    if not h1:
        return None
    for prefix in (doc_id + " ", doc_id.rsplit("/", 1)[-1] + " "):
        if h1.startswith(prefix):
            return h1[len(prefix):].strip() or h1
    return h1


def design_toc(path):
    """(sections, line count) of a Markdown file: one section per `## ` heading outside code fences, from the heading
    to the line before the next one; lines before the first are 「머리말」 (「본문」 when there is no `## `).
    Section: {id, title, no, start, end} with 1-based inclusive lines. The id is the title, numbered on a repeat."""
    try:
        st = os.stat(path)
    except OSError:
        return [], 0
    v = (st.st_mtime, st.st_size)
    hit = _toc_cache.get(path)
    if hit and hit[0] == v:
        return hit[1]
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            lines = f.read().split("\n")
    except OSError:
        return [], 0
    if lines and lines[-1] == "":
        lines.pop()
    heads, fence = [], None
    for n, line in enumerate(lines, 1):
        m = FENCE.match(line)
        if m:
            fence = None if fence == m.group(1) else fence or m.group(1)
            continue
        if fence:
            continue
        h = HEADING.match(line)
        if h and len(h.group(1)) == 2:
            heads.append((n, h.group(2)))
    toc, seen = [], collections.Counter()
    if not heads or heads[0][0] > 1:
        toc.append({"id": "머리말" if heads else "본문", "title": "머리말" if heads else "본문", "no": None,
                    "start": 1, "end": heads[0][0] - 1 if heads else len(lines)})
    for i, (n, title) in enumerate(heads):
        seen[title] += 1
        no = SECTION_NO.match(title)
        toc.append({"id": title if seen[title] == 1 else f"{title} ({seen[title]})", "title": title,
                    "no": no.group(1) if no else None, "start": n,
                    "end": heads[i + 1][0] - 1 if i + 1 < len(heads) else len(lines)})
    out = (toc, len(lines))
    _toc_cache[path] = (v, out)
    return out


def scan_designs():
    """One pass over the design folders; rebinds `design` (and bumps) only when a document or a source changed."""
    global design
    roots = design_roots()
    sources, docs = [], {}
    for i, (root, configured) in enumerate(roots):
        base = os.path.basename(root)
        sources.append({"dir": root, "configured": configured, **repo_info(root)})
        for d, subdirs, files in os.walk(root):
            subdirs[:] = sorted(s for s in subdirs if not s.startswith(".") and s != "node_modules")
            for f in sorted(files):
                ext = os.path.splitext(f)[1].lower()
                if ext not in DESIGN_KINDS:
                    continue
                p = os.path.join(d, f)
                try:
                    st = os.stat(p)
                except OSError:
                    continue
                key = base + "/" + os.path.relpath(p, root)
                e = docs.setdefault(key, {"key": key, "kind": DESIGN_KINDS[ext], "copies": []})
                e["copies"].append({"src": i, "abs": p, "mtime": st.st_mtime, "size": st.st_size})
    for e in docs.values():
        e["copies"].sort(key=lambda c: (not sources[c["src"]]["configured"], -c["mtime"]))
    label_designs(roots, sources, docs)
    design_bases.update(os.path.basename(r) for r, _ in roots)
    if sources != design["sources"] or docs != design["docs"]:
        design = {"version": design["version"] + 1, "sources": sources, "docs": docs}
        with lock:
            bump()


def label_designs(roots, sources, docs):
    """Names documents the way a feature folder's index.html does: the title from the H1 (without its path prefix), and,
    for the documents its SECTIONS list holds, the chapter number and title and the reading order. The index.html is
    taken from the copies the same way as a document (configured folder first, then the newest)."""
    navs = {}
    for i, (root, _) in enumerate(roots):
        try:
            slugs = [d for d in os.listdir(root) if os.path.isfile(os.path.join(root, d, "index.html"))]
        except OSError:
            continue
        for slug in slugs:
            p = os.path.join(root, slug, "index.html")
            try:
                mtime = os.path.getmtime(p)
            except OSError:
                continue
            navs.setdefault((os.path.basename(root), slug), []).append((not sources[i]["configured"], -mtime, p))
    chapters = {}
    for (base, slug), ps in navs.items():
        n = 0
        for ch, (title, ids) in enumerate(design_nav(min(ps)[2]), 1):
            for doc_id in ids:
                n += 1
                chapters.setdefault(f"{base}/{slug}/{doc_id}.md", {"ch": ch, "chapter": title, "order": n})
    for key, e in docs.items():
        e.update(chapters.get(key) or {})
        if e["kind"] == "md":
            parts = key.split("/", 2)
            e["title"] = nav_title(os.path.splitext(parts[-1])[0], design_h1(e["copies"][0]["abs"]))


def doc_label(key):
    """{title, ch, chapter} of a document for the lists that name it (only the keys it has)."""
    e = design["docs"].get(key) or {}
    return {k: e[k] for k in ("title", "ch", "chapter") if e.get(k) is not None}


def design_key(path):
    """The document key ("feature-designs/<slug>/<file>") of a path inside any copy of a design folder, else None."""
    if not path or not design_bases:
        return None
    path = os.path.normpath(path)
    best = None
    for base in design_bases:
        i = path.rfind("/" + base + "/")
        if i >= 0 and (best is None or i > best[0]):
            best = (i, path[i + 1:])
    if not best or os.path.splitext(best[1])[1].lower() not in DESIGN_KINDS:
        return None
    return best[1]


def design_copy(key):
    e = design["docs"].get(key)
    return e and e["copies"][0]


# ---- reading references out of tool calls ----
READ_LINE = re.compile(r"^\s*(\d+)(?:\t|→)(.*)$")  # Claude's Read result: "<n>\t<line>" (older builds: "<n>→")
HIT_LINE = re.compile(r"^(.*?):(\d+)[:-]")          # grep -n / rg -n output: "<path>:<n>:<text>" ("-" on context lines)
BARE_HIT = re.compile(r"^(\d+)[:-]")                # the same for a single file: "<n>:<text>"
SED_RANGE = re.compile(r"^\s*(\d+|\$)?\s*(?:,\s*(\d+|\$)\s*)?(?:p|\{\s*p\s*;?\s*\})\s*$")
JS_CMD = re.compile(r"""\bcmd\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')""")
READERS = {"cat", "nl", "sed", "head", "tail", "awk", "less", "more", "bat", "batcat"}
SEARCHERS = {"grep", "egrep", "fgrep", "rg", "ag", "ack"}
QUIET = {"apply_patch", "cp", "mv", "rm", "tee", "ls", "wc", "find", "stat", "file", "test", "[", "echo", "printf", "git", "mkdir", "cd", "du", "readlink",
         "realpath", "basename", "dirname", "open", "true", "aplan", "orca", "touch", "diff", "cmp", "md5", "shasum"}
TOC_PATTERN = re.compile(r"^\^?\s*(?:\\)?#")  # grep '^## ' and the like: reading the table of contents, not a search
SHELL_STOP = {";", "&&", "||", "&", "(", ")", "{", "}", "|", "|&"}
SHELL_KEYWORDS = {"then", "do", "else", "elif", "fi", "done", "if", "while", "until", "time", "!", "command", "builtin", "exec", "xargs"}


def unquote_newlines(cmd):
    """Unquoted newlines become `;` (shlex treats them as blanks), heredoc bodies are dropped, a trailing \\ joins lines."""
    out, q, i, n = [], None, 0, len(cmd)
    while i < n:
        c = cmd[i]
        if q:
            if c == "\\" and q == '"' and i + 1 < n:
                out.append(cmd[i:i + 2]); i += 2; continue
            if c == q:
                q = None
            out.append(c)
        elif c == "\\" and i + 1 < n:
            out.append(" " if cmd[i + 1] == "\n" else cmd[i:i + 2]); i += 2; continue
        elif c in "'\"":
            q = c; out.append(c)
        elif c == "#" and (not out or out[-1] in " \t;\n"):
            j = cmd.find("\n", i); i = n if j < 0 else j; continue
        elif c == "<" and cmd.startswith("<<", i) and not cmd.startswith("<<<", i):
            m = re.match(r"<<-?\s*(['\"]?)(\w+)\1", cmd[i:])
            if m:
                end = re.compile(r"\n[ \t]*" + re.escape(m.group(2)) + r"[ \t]*(?:\n|$)").search(cmd, i + m.end())
                line_end = cmd.find("\n", i + m.end())
                rest = cmd[i + m.end():line_end if line_end >= 0 else n]
                out.append(" " + rest + " ;")  # the rest of the heredoc's own line still runs (`<<EOF | cmd`)
                i = end.end() if end else n
                continue
            out.append(c)
        elif c == "\n":
            out.append(" ; ")
        else:
            out.append(c)
        i += 1
    return "".join(out)


def shell_commands(cmd):
    """[[argv, ...] per pipeline] for a shell command line; None when it does not parse."""
    try:
        lx = shlex.shlex(unquote_newlines(cmd), posix=True, punctuation_chars=";&|()<>")
        lx.whitespace_split = True
        toks = list(lx)
    except ValueError:
        return None
    pipes, pipe, argv = [], [], []
    for t in toks + [";"]:
        if t in SHELL_STOP:
            if argv:
                pipe.append(argv)
            argv = []
            if t not in ("|", "|&") and pipe:
                pipes.append(pipe)
                pipe = []
        elif t in ("<", ">", ">>", "2>", "&>", "2>&1", ">&"):
            argv.append(t)
        else:
            argv.append(t)
    return pipes


def expand(tok, env, cwd, soft=False):
    """$NAME / ${NAME} / ~ / $HOME in a token; None when a shell variable or a command substitution stays unresolved
    ($0, $1 … are left alone: inside an awk or sed script they are not the shell's). soft leaves those in place."""
    tok = re.sub(r"\$\{?([A-Za-z_]\w*)\}?", lambda m: env.get(m.group(1), HOME if m.group(1) == "HOME" else m.group(0)), tok)
    if tok.startswith("~"):
        tok = HOME + tok[1:]
    return tok if soft or not re.search(r"\$\{?[A-Za-z_(]|`", tok) else None


def line_ranges_of_sed(scripts):
    """Line ranges a `sed -n` script prints: "a,bp", "ap", "a,${p}" and ;-separated lists. None when it prints others."""
    out = []
    for s in scripts:
        for part in re.split(r"[;\n]", s):
            if not part.strip():
                continue
            m = SED_RANGE.match(part)
            if not m or not m.group(1):
                return None
            a = 10 ** 9 if m.group(1) == "$" else int(m.group(1))
            b = a if m.group(2) is None else (10 ** 9 if m.group(2) == "$" else int(m.group(2)))
            out.append((a, b))
    return out or None


def awk_ranges(script):
    lo = re.search(r"NR\s*(>=|>|==)\s*(\d+)", script)
    hi = re.search(r"NR\s*(<=|<)\s*(\d+)", script)
    pair = re.search(r"NR\s*==\s*(\d+)\s*,\s*NR\s*==\s*(\d+)", script)
    if pair:
        return [(int(pair.group(1)), int(pair.group(2)))]
    if not lo and not hi:
        return None if re.search(r"NR\s*[<>=!]", script) else [(1, 10 ** 9)]  # NR only printed: every line
    a = (int(lo.group(2)) + (lo.group(1) == ">")) if lo else 1
    b = (int(hi.group(2)) - (hi.group(1) == "<")) if hi else 10 ** 9
    if lo and lo.group(1) == "==" and not hi:
        b = a
    return [(a, b)]


def count_arg(args, i, default):
    """-n N / -nN / -N / -n +K for head and tail: (count, from_start)."""
    a = args[i]
    if a in ("-n", "--lines") and i + 1 < len(args):
        v = args[i + 1]
    elif a.startswith("--lines="):
        v = a.split("=", 1)[1]
    elif a.startswith("-n"):
        v = a[2:]
    elif re.match(r"^-\d+$", a):
        v = a[1:]
    else:
        return default
    m = re.match(r"^(\+)?(\d+)$", v)
    return (int(m.group(2)), bool(m.group(1))) if m else default


def apply_filter(argv, ranges, length):
    """Narrow line ranges by a filter later in a pipeline (sed -n, head, tail, awk NR); None when the filter is not one."""
    name = os.path.basename(argv[0])
    lines = [n for a, b in ranges for n in range(a, min(b, length) + 1)]
    if name == "sed" and "-n" in argv:
        rs = line_ranges_of_sed([x for x in argv[1:] if not x.startswith("-")][:1])
        if rs is None:
            return None
        picked = [lines[k - 1] for a, b in rs for k in range(a, min(b, len(lines)) + 1)]
    elif name in ("head", "tail"):
        n, plus = (10, False)
        for i in range(1, len(argv)):
            n, plus = count_arg(argv, i, (n, plus))
        picked = lines[:n] if name == "head" else lines[n - 1:] if plus else lines[-n:] if n else []
    elif name == "awk":
        rs = awk_ranges(next((x for x in argv[1:] if not x.startswith("-")), ""))
        if rs is None:
            return None
        picked = [lines[k - 1] for a, b in rs for k in range(a, min(b, len(lines)) + 1)]
    elif name in ("cut", "tr", "fold", "less", "more", "cat", "expand", "column", "nl") or name == "sed" and "-n" not in argv:
        return ranges  # one line out per line in (sed without -n only rewrites them)
    else:
        return None
    return to_ranges(picked)


def to_ranges(nums):
    out = []
    for n in sorted(set(nums)):
        if out and n == out[-1][1] + 1:
            out[-1][1] = n
        else:
            out.append([n, n])
    return [tuple(r) for r in out]


def design_file_lines(path):
    """Line count of a file (for open-ended ranges); 0 when unreadable."""
    if path.endswith(".md"):
        return design_toc(path)[1]
    try:
        with open(path, "rb") as f:
            return sum(1 for _ in f)
    except OSError:
        return 0


def grep_regex(argv, tool):
    """(compiled pattern, files and folders, listing only, raw pattern) from a grep/rg argv; the pattern is None when
    it is not usable."""
    pat, paths, fixed, icase, word, ere, listing = None, [], False, False, False, tool != "grep", False
    i = 1
    takes = {"-e", "--regexp", "-g", "--glob", "-t", "--type", "-A", "-B", "-C", "-m", "--max-count", "--include",
             "--exclude", "-f", "--max-columns", "--context", "--after-context", "--before-context", "-M", "-T"}
    while i < len(argv):
        a = argv[i]
        if a == "--":
            paths += argv[i + 1:] if pat is not None else argv[i + 2:]
            pat = pat if pat is not None else (argv[i + 1] if i + 1 < len(argv) else None)
            break
        if a in ("-e", "--regexp") and i + 1 < len(argv):
            pat = argv[i + 1]; i += 2; continue
        if a in takes:
            i += 2; continue
        if a.startswith("--"):
            fixed |= a == "--fixed-strings"; icase |= a == "--ignore-case"; word |= a == "--word-regexp"
            listing |= a in ("--files", "--files-with-matches", "--count", "--files-without-match")
            ere |= a in ("--extended-regexp", "--perl-regexp")
        elif a.startswith("-") and len(a) > 1:
            fl = a[1:]
            fixed |= "F" in fl; icase |= "i" in fl; word |= "w" in fl; ere |= "E" in fl or "P" in fl
            listing |= any(c in fl for c in "lLc")
        elif pat is None:
            pat = a
        else:
            paths.append(a)
        i += 1
    if "--files" in argv:
        return None, paths, True, None
    if pat is None:
        return None, paths, listing, None
    if fixed:
        rx = re.escape(pat)
    elif not ere:  # grep's basic syntax: \| \( \) \+ \? are the operators, the bare characters are literal
        rx = re.sub(r"\\([|()+?{}])|([|()+?{}])", lambda m: m.group(1) or "\\" + m.group(2), pat)
    else:
        rx = pat
    if word:
        rx = r"\b(?:" + rx + r")\b"
    try:
        return re.compile(rx, re.I if icase else 0), paths, listing, pat
    except re.error:
        return None, paths, listing, pat


def hits_in(path, rx):
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return [n for n, line in enumerate(f, 1) if rx.search(line)]
    except OSError:
        return []


def search_reads(rx, targets, out, cwd, single):
    """Search hits from a grep/rg run: the numbered lines of its output when it printed numbers, else the pattern run
    again over the design files it named (or listed). -> [read]"""
    found = collections.defaultdict(set)
    if out:
        for line in out.splitlines():
            m = HIT_LINE.match(line)
            if m and not BARE_HIT.match(line):
                p = os.path.normpath(os.path.join(cwd or "/", os.path.expanduser(m.group(1))))
                if design_key(p):
                    found[p].add(int(m.group(2)))
            elif single and BARE_HIT.match(line):
                found[single].add(int(BARE_HIT.match(line).group(1)))
    exact = bool(found)
    if not found and rx is not None:
        files = set()
        if out:
            for line in out.splitlines():
                p = os.path.normpath(os.path.join(cwd or "/", os.path.expanduser(line.split(":", 1)[0].strip())))
                if design_key(p) and os.path.isfile(p):
                    files.add(p)
        if not files:
            files = {t for t in targets if os.path.isfile(t) and design_key(t)}
        for p in files:
            hs = hits_in(p, rx)
            if hs:
                found[p].update(hs)
    return [{"abs": p, "kind": "search", "hits": sorted(ns), "exact": exact} for p, ns in found.items()]


def unroll_loops(pipes):
    """`for NAME in w1 w2 …; do BODY; done` becomes NAME=w1 BODY NAME=w2 BODY …, so a read of "$D/$NAME" can be
    followed. A loop over a glob or a command's output is left as it is (its reads count as missed)."""
    out, k = [], 0
    while k < len(pipes):
        pipe = pipes[k]
        k += 1
        head = pipe[0][1:] if pipe[0][:1] in (["do"], ["then"]) else pipe[0]
        if head[:1] != ["for"] or len(head) < 3 or head[2] != "in" or any(c in w for w in head[3:] for c in "*?[`$(") or len(head) > 60:
            out.append(pipe)
            continue
        name, words, depth, body = head[1], head[3:], 1, []
        while k < len(pipes):
            p2 = pipes[k]
            k += 1
            h = p2[0][1:] if p2[0][:1] == ["do"] else p2[0]
            depth += h[:1] == ["for"]
            depth -= h[:1] == ["done"]
            if depth == 0:
                break
            body.append(p2)
        body = unroll_loops(body)
        for w in words:
            out.append([[f"{name}={w}"]])
            out.extend(body)
    return out


def shell_reads(cmd, cwd, out, stats):
    """Design reads in a shell command (Bash, Codex exec): [{abs, kind, ranges|hits, exact}], approximate by nature.
    A command that names a design path but cannot be followed (a loop variable, a script, an unresolved $VAR) is
    counted in stats[reason]."""
    if not isinstance(cmd, str) or not cmd.strip():
        return []
    pipes = shell_commands(cmd)
    if pipes is None:
        if any(b in cmd for b in design_bases):
            stats["해석 불가"] += 1
        return []
    env, reads, loop, talkers = {}, [], 0, 0
    for pipe in unroll_loops(pipes):
        first = pipe[0]
        while first and re.match(r"^[A-Za-z_]\w*=", first[0]):  # NAME=value [command]
            k, v = first[0].split("=", 1)
            v = expand(v, env, cwd)
            if v is not None:
                env[k] = v
            first = first[1:]
        while first and first[0] in SHELL_KEYWORDS:
            first = first[1:]
        if not first:
            continue
        if first[0] == "for":
            loop += 1
        if first[0] == "done":
            loop = max(0, loop - 1)
        argv = [expand(t, env, cwd) for t in first]
        name = os.path.basename(argv[0] or "")
        if name == "cd":
            target = argv[1] if len(argv) > 1 else HOME
            if target:
                cwd = os.path.normpath(os.path.join(cwd or "/", target))
            continue
        talkers += 1  # a command that may print: the output belongs to one read only when it is the only one
        named = [t for t in (expand(t, env, cwd, True) for t in first) if any("/" + b + "/" in "/" + t or t.startswith(b) for b in design_bases)]
        in_design = cwd and design_key(os.path.join(cwd, "x.md"))
        if not named and not in_design:
            continue
        if loop:
            stats["반복문 변수"] += 1 if named else 0
            continue
        if None in argv:
            if named:
                stats["풀지 못한 변수"] += 1
            continue
        resolve = lambda t: os.path.normpath(os.path.join(cwd or "/", t))
        if name in SEARCHERS:
            rx, targets, listing, pat = grep_regex(argv, name)
            if rx is None and listing:
                continue  # rg --files / grep -l with nothing to search for: a listing
            if TOC_PATTERN.match(pat or ""):
                stats["목차 조회"] += 1
                continue
            targets = [resolve(t) for t in targets] or [cwd or "/"]
            single = targets[0] if len(targets) == 1 and os.path.isfile(targets[0]) else None
            reads += search_reads(rx, targets, out, cwd, single)
            continue
        if name == "git" and "show" in argv:
            stats["git show"] += 1 if named else 0
            continue
        if name not in READERS:
            if named and name not in QUIET:
                stats["읽기 외 명령 (" + (name if re.match(r"^[\w.+-]{1,24}$", name) else "기타") + ")"] += 1
            continue
        # a reader: its file arguments and the line ranges it prints
        args = argv[1:]
        files, ranges = [], [(1, 10 ** 9)]
        if name == "sed":
            scripts, i, quiet = [], 0, False
            while i < len(args):
                a = args[i]
                if a in ("-e", "--expression") and i + 1 < len(args):
                    scripts.append(args[i + 1]); i += 2; continue
                if a.startswith("-") and a != "-":
                    quiet |= "n" in a.lstrip("-") and not a.startswith("--")
                    i += 1; continue
                if not scripts:
                    scripts.append(a)
                else:
                    files.append(a)
                i += 1
            if quiet:
                ranges = line_ranges_of_sed(scripts)
                if ranges is None:
                    stats["sed 스크립트"] += 1
                    continue
        elif name in ("head", "tail"):
            n, plus = (10, False)
            for i, a in enumerate(args):
                n, plus = count_arg(args, i, (n, plus))
            skip = False
            for i, a in enumerate(args):
                if skip:
                    skip = False
                    continue
                if a in ("-n", "--lines", "-c", "--bytes"):
                    skip = True
                    continue
                if not a.startswith("-") or a == "-":
                    files.append(a)
            ranges = [("head", n)] if name == "head" else [("tail", n, plus)]
        elif name == "awk":
            script, i = None, 0
            while i < len(args):
                a = args[i]
                if a in ("-v", "-F", "-f") and i + 1 < len(args):
                    if a == "-v" and "=" in args[i + 1]:
                        k, v = args[i + 1].split("=", 1)
                        env["awk:" + k] = v
                    i += 2; continue
                if script is None:
                    script = a
                else:
                    files.append(a)
                i += 1
            script = re.sub(r"\b([A-Za-z_]\w*)\b", lambda m: env.get("awk:" + m.group(1), m.group(1)), script or "")
            ranges = awk_ranges(script)
            if ranges is None:
                stats["awk 스크립트"] += 1
                continue
        else:
            files = [a for a in args if not a.startswith("-") or a == "-"]
        files = [resolve(f) for f in files if f != "-"]
        if len(files) != 1 and len(pipe) > 1:
            if named:
                stats["여러 파일 파이프"] += 1
            continue
        for f in files:
            if not design_key(f):
                continue
            length = design_file_lines(f)
            rs = []
            for r in ranges:
                if r[0] == "head":
                    rs.append((1, r[1]))
                elif r[0] == "tail":
                    rs.append((r[1], length) if r[2] else (max(1, length - r[1] + 1), length))
                else:
                    rs.append(r)
            rs = [(max(1, a), min(b, length)) for a, b in rs if a <= length]
            searched = False
            for later in pipe[1:]:
                later = [expand(t, env, cwd) for t in later]
                if None not in later and os.path.basename(later[0]) in SEARCHERS and rs:
                    rx, _, _, pat = grep_regex(later, os.path.basename(later[0]))
                    if any(a.startswith("-") and not a.startswith("--") and "v" in a for a in later[1:]):
                        continue  # grep -v: the lines that do not match, a read of the rest
                    if rx is not None and not TOC_PATTERN.match(pat or ""):
                        try:
                            with open(f, encoding="utf-8", errors="replace") as fh:
                                text = fh.read().split("\n")
                        except OSError:
                            text = []
                        hits = [n for a, b in rs for n in range(a, b + 1) if n <= len(text) and rx.search(text[n - 1])]
                        if hits:
                            reads.append({"abs": f, "kind": "search", "hits": hits, "exact": False})
                    elif rx is not None:
                        stats["목차 조회"] += 1
                    searched = True
                    break
                rs = apply_filter(later, rs, length) if None not in later and rs else None
                if rs is None:
                    stats["파이프 뒤 필터"] += 1
                    break
            if rs and not searched:
                reads.append({"abs": f, "kind": "read", "ranges": rs, "exact": False})
    if talkers == 1 and len(reads) == 1 and reads[0]["kind"] == "read" and len(reads[0]["ranges"]) == 1 and out:
        # the output is this one read: its `## ` lines place the sections, as a Read's do (line numbers from cat -n /
        # nl are dropped; with a filter that drops lines in between, the count would be off, so only plain ranges)
        a, b = reads[0]["ranges"][0]
        body = [re.sub(r"^\s*\d+(?:\t|: )", "", l) for l in out.split("\n")]
        if body and not body[-1]:
            body.pop()
        if len(body) == b - a + 1:
            reads[0]["heads"] = output_heads(enumerate(body, a))
    return reads


def output_heads(numbered):
    """[(line, title)] of the `## ` headings outside code fences among (line, text) pairs."""
    heads, fence = [], None
    for n, text in numbered:
        f = FENCE.match(text)
        if f:
            fence = None if fence == f.group(1) else fence or f.group(1)
        elif not fence:
            h = HEADING.match(text)
            if h and len(h.group(1)) == 2:
                heads.append((n, h.group(2)))
    return heads


def read_tool_reads(inp, body, result):
    """A Claude Read call: the numbered lines of its result give the exact range, and its `## ` lines the sections."""
    path = inp.get("file_path")
    if not design_key(path):
        return []
    if os.path.splitext(path)[1].lower() != ".md":
        return [{"abs": path, "kind": "read", "ranges": [], "exact": True}]
    numbered = [(int(m.group(1)), m.group(2)) for m in map(READ_LINE.match, body.split("\n")) if m]
    nums, heads = [n for n, _ in numbered], output_heads(numbered)
    file = (result or {}).get("file") if isinstance(result, dict) else None
    if not nums and isinstance(file, dict) and file.get("numLines"):
        start = int(file.get("startLine") or 1)
        nums = [start, start + int(file["numLines"]) - 1]
    if not nums:
        return []
    return [{"abs": path, "kind": "read", "ranges": [(min(nums), max(nums))], "heads": heads, "exact": True}]


def tool_reads(name, inp, cwd, body, result, stats):
    """Every design read one tool call made, from its input and output."""
    if isinstance(inp, str):
        try:
            inp = json.loads(inp)
        except ValueError:
            inp = {"command": inp}
    if not isinstance(inp, dict):
        return []
    if name == "Read":
        return read_tool_reads(inp, body, result)
    if name == "Grep":
        rx, _, _, pat = grep_regex(["rg"] + (["-i"] if inp.get("-i") else []) + ["-e", inp.get("pattern") or ""], "rg")
        target = os.path.normpath(os.path.join(cwd or "/", os.path.expanduser(inp.get("path") or ".")))
        if TOC_PATTERN.match(pat or ""):
            stats["목차 조회"] += 1
            return []
        return search_reads(rx, [target], body, cwd, target if os.path.isfile(target) else None)
    # shell: Claude Bash, Codex exec_command / shell / local_shell_call, and Codex's JS `exec` running several commands
    wd = inp.get("workdir") or inp.get("working_directory") or cwd
    cmd = inp.get("command") or inp.get("cmd")
    if isinstance(cmd, list):
        cmd = cmd[-1] if len(cmd) >= 3 and cmd[1] in ("-lc", "-c") else " ".join(shlex.quote(c) for c in cmd)
    if isinstance(cmd, str) and name in ("exec", "js") and "exec_command" in cmd:
        outs = {}
        for line in (body or "").splitlines():
            if line.startswith('{"index"'):
                try:
                    x = json.loads(line)
                    outs[x["index"]] = ((x.get("result") or {}).get("value") or {}).get("output") or ""
                except (ValueError, KeyError, TypeError, AttributeError):
                    pass
        reads = []
        if re.search(r"\bcmd\s*:\s*`", cmd):
            stats["JS 템플릿 문자열"] += len(re.findall(r"\bcmd\s*:\s*`", cmd))
        for i, m in enumerate(JS_CMD.finditer(cmd)):
            lit = m.group(1)
            try:
                c = json.loads(lit) if lit[0] == '"' else json.loads('"' + lit[1:-1].replace('"', '\\"').replace("\\'", "'") + '"')
            except ValueError:
                stats["해석 불가"] += 1
                continue
            reads += shell_reads(c, wd, outs.get(i, ""), stats)
        return reads
    return shell_reads(cmd, wd, body, stats)


def sections_read(toc, a, b, heads):
    """{section id: (lines read, first, last)} for lines a..b. Headings seen in the output place their sections first
    (they survive a document edited after the read; first/last are then the lines as numbered when read); a heading the
    current table of contents no longer has keeps its old title, so the page lists it apart. Without any heading, the
    line numbers are matched against the current table of contents."""
    out = {}
    by_title = {}
    for s in toc:
        by_title.setdefault(s["title"], s)
    marks = [(n, by_title.get(t) or {"id": t}) for n, t in heads or []]
    if marks:
        n0, s0 = marks[0]
        if a < n0:
            k = next((i for i, x in enumerate(toc) if x is s0), None)
            prev = toc[k - 1] if k else next((x for x in toc if x["start"] <= a <= x["end"]), None)
            if prev:
                out[prev["id"]] = (n0 - a, a, n0 - 1)
        for j, (n, s) in enumerate(marks):
            end = marks[j + 1][0] - 1 if j + 1 < len(marks) else b
            k0, lo, hi = out.get(s["id"], (0, n, end))
            out[s["id"]] = (k0 + end - n + 1, min(lo, n), max(hi, end))
    else:
        for s in toc:
            lo, hi = max(a, s["start"]), min(b, s["end"])
            if lo <= hi:
                out[s["id"]] = (hi - lo + 1, lo, hi)
    return out


def anchor(read):
    """[(section id or None, cover or None, lines [a, b] or None, hits or None)] for one read."""
    key = design_key(read["abs"])
    path = read["abs"] if os.path.isfile(read["abs"]) else (design_copy(key) or {}).get("abs")
    if not path or not path.endswith(".md"):
        return [(None, None, None, len(read.get("hits") or []) or None)]
    toc = design_toc(path)[0]
    size = {s["id"]: max(1, s["end"] - s["start"] + 1) for s in toc}
    if read["kind"] == "search":
        per = collections.Counter()
        for n in read["hits"]:
            s = next((s for s in toc if s["start"] <= n <= s["end"]), None)
            if s:
                per[s["id"]] += 1
        return [(sid, None, None, k) for sid, k in per.items()]
    out = []
    for a, b in read["ranges"]:
        for sid, (k, lo, hi) in sections_read(toc, a, b, read.get("heads")).items():
            if sid in size:
                out.append((sid, round(min(1.0, k / size[sid]), 3), [lo, hi], None))
            else:  # a heading this document no longer has: its length is unknown
                out.append((sid, None, [lo, hi], None))
    return out


class DesignReads:
    """The design reads in one transcript: tool calls that may read a design folder are held until their result
    arrives, then turned into references (design_refs). Fed by Session.poll for live sessions and by the backfill."""

    def __init__(self, path, kind):
        self.path, self.kind = path, kind
        self.id = os.path.splitext(os.path.basename(path))[0]
        if kind == "codex":
            self.id = self.id.split("-", 6)[-1] if self.id.startswith("rollout-") else self.id
        self.parent = os.path.basename(os.path.dirname(os.path.dirname(path))) if "/subagents/" in path else None
        self.cwd = self.task = self.title = None
        self.calls = {}  # call id -> (tool, input, cwd, ts)
        self.marks = set()  # call ids as bytes, so a result line can be picked out before it is parsed
        self.stats = collections.Counter()
        self.seen = 0

    def wants(self, raw):
        if not design_bases:
            return False
        self.seen += 1
        if self.seen <= 8 or any(m in raw for m in self.marks):  # the opening lines name the session (title, brief)
            return True
        if self.kind == "codex" and (b'"session_meta"' in raw or b'"turn_context"' in raw
                                     or not self.title and b'"role":"user"' in raw.replace(b" ", b"")):
            return True
        return b"Your task ID is" in raw or b'"ai-title"' in raw or any(b.encode() in raw for b in design_bases)

    def note_call(self, cid, name, inp, ts):
        text = inp if isinstance(inp, str) else json.dumps(inp, ensure_ascii=False)
        if not cid or not any(b in text for b in design_bases) and not (self.cwd and design_key(os.path.join(self.cwd, "x.md"))):
            return
        self.calls[cid] = (name, inp, self.cwd, ts)
        self.marks.add(cid.encode())

    def note_result(self, cid, body, ts, result=None):
        call = self.calls.pop(cid, None)
        if not call:
            return
        self.marks.discard(cid.encode())
        name, inp, cwd, cts = call
        try:
            reads = tool_reads(name, inp, cwd, body or "", result, self.stats)
        except Exception as e:  # one odd command must not stop the transcript
            report_failure("design reads", e)
            return
        if reads:
            self.stats["호출"] += 1
            add_design_refs(self, cid, name, reads, cts or ts)

    def brief(self, text):
        if not self.task and isinstance(text, str):
            m = BRIEF_TASK.search(text)
            if m:
                self.task = m.group(1)

    def feed(self, rec, ts):
        if self.kind == "claude":
            self.cwd = rec.get("cwd") or self.cwd
            typ = rec.get("type")
            if typ == "ai-title":
                self.title = rec.get("aiTitle") or self.title
                return
            content = (rec.get("message") or {}).get("content")
            if typ == "assistant":
                for b in content or []:
                    if isinstance(b, dict) and b.get("type") == "tool_use":
                        self.note_call(b.get("id"), b.get("name"), b.get("input"), ts)
            elif typ == "user":
                if isinstance(content, str):
                    self.brief(content)
                    self.title = self.title or (short(content, 80) if not content.startswith("<") else None)
                for b in content if isinstance(content, list) else []:
                    if isinstance(b, dict) and b.get("type") == "tool_result" and b.get("tool_use_id") in self.calls:
                        body = b.get("content")
                        if isinstance(body, list):
                            body = "\n".join(x.get("text", "") for x in body if isinstance(x, dict))
                        self.note_result(b["tool_use_id"], str(body or ""), ts, rec.get("toolUseResult"))
                    elif isinstance(b, dict) and b.get("type") == "text":
                        self.brief(b.get("text"))
            return
        p = rec.get("payload") or {}
        typ, ptype = rec.get("type"), p.get("type")
        if typ == "session_meta":
            self.id = p.get("id") or self.id
            self.cwd = p.get("cwd") or self.cwd
        elif typ == "turn_context":
            self.cwd = p.get("cwd") or self.cwd
        elif typ == "response_item" and ptype in ("function_call", "custom_tool_call", "local_shell_call"):
            self.note_call(p.get("call_id"), p.get("name") or ptype, p.get("input") or p.get("arguments") or p.get("action"), ts)
        elif typ == "response_item" and ptype in ("function_call_output", "custom_tool_call_output"):
            out = p.get("output")
            if isinstance(out, list):
                out = "\n".join(x.get("text", "") for x in out if isinstance(x, dict))
            elif not isinstance(out, str):
                out = json.dumps(out, ensure_ascii=False)
            self.note_result(p.get("call_id"), out, ts)
        elif typ == "response_item" and ptype == "message" and p.get("role") == "user":
            text = " ".join(c.get("text", "") for c in p.get("content") or [] if isinstance(c, dict))
            self.brief(text)
            if not self.title and text.strip() and not text.lstrip().startswith(("#", "<")):
                self.title = short(text, 80)  # as parse_codex names a session


def plan_tickets():
    """{task id: (plan path, ticket)} over the external plans' session rows."""
    out = {}
    for path, p in list(ext_plans.items()):
        for k in p.get("tickets") or []:
            for r in k.get("sessions") or []:
                if isinstance(r, dict) and r.get("task_id"):
                    out[r["task_id"]] = (path, k)
    return out


def row_key(tickets, task):
    """The external plan's name for a task's session row ("S5#4 리뷰 codex"): the title of a Codex worker, whose first
    message is its brief, and of any session with no title of its own."""
    hit = tickets.get(task)
    return hit and next((r.get("key") for r in hit[1].get("sessions") or [] if isinstance(r, dict) and r.get("task_id") == task), None)


def design_commit_for(plan_path, doc):
    """The plan's design_commit when the document is under its design_root."""
    p = ext_plans.get(plan_path) or {}
    root, commit = p.get("design_root"), p.get("design_commit")
    k = root and design_key(os.path.join(os.path.realpath(os.path.expanduser(root)), "x.md"))
    return commit if k and doc.startswith(k[:-len("x.md")]) else None


def add_design_refs(src, cid, tool, reads, ts):
    """Record one reference per (document, section) of a call; a call seen again (a re-parse) replaces its own."""
    global design_refs_dirty
    tickets = plan_tickets()
    task = src.task or (design_refs["sessions"].get(src.parent) or {}).get("task")
    hit = tickets.get(task)
    new = {}
    for r in reads:
        doc = design_key(r["abs"])
        if not doc:
            continue
        for sid, cover, lines, hits in anchor(r):
            key = f"{src.id}|{cid}|{doc}|{sid}|{r['kind']}"
            old = new.get(key)
            if old and lines:  # two ranges of one call in the same section
                old["cover"] = round(min(1.0, (old["cover"] or 0) + (cover or 0)), 3)
                old["lines"] = [min(old["lines"][0], lines[0]), max(old["lines"][1], lines[1])]
                continue
            new[key] = {"session": src.id, "ticket": hit[1].get("package") if hit else None, "doc": doc, "section": sid,
                        "kind": r["kind"], "cover": cover, "lines": lines, "hits": hits, "tool": tool,
                        "exact": r.get("exact", False), "commit": design_commit_for(hit[0], doc) if hit else None,
                        "ts": ts, "call": cid}
    if not new:
        return
    global design_rev
    with refs_lock:
        design_rev += 1
        design_refs["refs"].update(new)
        meta = design_refs["sessions"].setdefault(src.id, {})
        meta.update({k: v for k, v in (("path", src.path), ("kind", src.kind), ("title", src.title), ("parent", src.parent),
                                       ("task", src.task), ("cwd", src.cwd)) if v})
        design_refs_dirty = True


def note_design_stats(src):
    """Keep a transcript's count of design commands that could not be followed, for the measurement in the README."""
    global design_refs_dirty
    if not src.stats:
        return
    with refs_lock:
        meta = design_refs["sessions"].setdefault(src.id, {})
        if meta.get("stats") != dict(src.stats):
            meta.update(stats=dict(src.stats), path=src.path, kind=src.kind)
            if src.title:
                meta["title"] = src.title
            design_refs_dirty = True


def backfill_designs():
    """Read the transcripts of the last DESIGN_DAYS that scan_loop does not hold (older than --hours) once each, so a
    reference made before this server started is there too. Only lines that can matter are parsed."""
    global design_refs_dirty
    since = time.time() - DESIGN_DAYS * 86400
    with lock:
        live = set(sessions)
    for pattern, kind in [(CLAUDE_GLOB, "claude")] + [(g, "codex") for g in CODEX_GLOBS]:
        for path in glob.glob(pattern, recursive=True):
            path = os.path.realpath(path)
            try:
                st = os.stat(path)
            except OSError:
                continue
            v = [st.st_mtime, st.st_size]
            if path in live or st.st_mtime < since or design_refs["scanned"].get(path) == v:
                continue
            src = DesignReads(path, kind)
            try:
                with open(path, "rb") as f:
                    for raw in f:
                        if not src.wants(raw):
                            continue
                        try:
                            rec = json.loads(raw)
                        except ValueError:
                            continue
                        src.feed(rec, rec.get("timestamp"))
            except OSError:
                continue
            note_design_stats(src)
            with refs_lock:
                design_refs["scanned"][path] = v
                design_refs_dirty = True
            time.sleep(0)  # let the request threads in between files


def ticket_section_badges():
    """{plan path: {package: [{doc, section, no, sessions, count}]}} — the sections each ticket's sessions read."""
    tickets = plan_tickets()
    with refs_lock:
        refs = list(design_refs["refs"].values())
        metas = dict(design_refs["sessions"])
    task_of = {sid: m.get("task") or (metas.get(m.get("parent")) or {}).get("task") for sid, m in metas.items()}
    agg = {}
    for r in refs:
        if r["kind"] != "read" or not r["section"]:
            continue
        hit = tickets.get(task_of.get(r["session"]))
        if not hit:
            continue
        e = agg.setdefault(hit[0], {}).setdefault(hit[1].get("package"), {}).setdefault((r["doc"], r["section"]), [set(), 0])
        e[0].add(r["session"])
        e[1] += 1
    out = {}
    for plan, by_pkg in agg.items():
        for pkg, secs in by_pkg.items():
            rows = []
            for (doc, sid), (ss, n) in secs.items():
                m = SECTION_NO.match(sid)
                rows.append({"doc": doc, **{"doc_" + k: v for k, v in doc_label(doc).items()}, "section": sid, "no": m.group(1) if m else None, "sessions": len(ss), "count": n})
            out.setdefault(plan, {})[pkg] = sorted(rows, key=lambda x: (-x["count"], x["doc"], x["section"]))
    return out


def save_design_refs():
    global design_refs_dirty
    with refs_lock:
        if not design_refs_dirty:
            return False
        body = json.dumps(design_refs, ensure_ascii=False)
        design_refs_dirty = False
    tmp = DESIGN_REFS_PATH + ".tmp"
    with open(tmp, "w") as f:
        f.write(body)
    os.replace(tmp, DESIGN_REFS_PATH)
    return True


def design_backfill_loop():
    while not scan_ready:
        time.sleep(2)
    while True:
        try:
            backfill_designs()
            loop_ok("design_backfill")
        except Exception as e:
            loop_failed("design_backfill", e)
        time.sleep(300)


def design_loop():
    global design_ticket_refs
    while True:
        try:
            scan_designs()
            badges = ticket_section_badges()
            changed = save_design_refs()
            if changed or badges != design_ticket_refs:
                design_ticket_refs = badges
                with lock:
                    bump()
            loop_ok("design")
        except Exception as e:
            loop_failed("design", e)
        time.sleep(DESIGN_EVERY)


def design_list():
    """GET /api/designs: the sources, and each document with how many sessions read it."""
    d = design
    with refs_lock:
        refs = list(design_refs["refs"].values())
    per = {}
    for r in refs:
        e = per.setdefault(r["doc"], {"sessions": set(), "reads": 0, "searches": 0})
        e["sessions"].add(r["session"])
        e["reads" if r["kind"] == "read" else "searches"] += 1
    docs = []
    for key, e in sorted(d["docs"].items()):
        c = e["copies"][0]
        p = per.get(key)
        docs.append({"key": key, **doc_label(key), "order": e.get("order"), "kind": e["kind"], "src": c["src"], "copies": len(e["copies"]), "mtime": c["mtime"],
                     "size": c["size"], "sessions": len(p["sessions"]) if p else 0, "reads": p["reads"] if p else 0,
                     "searches": p["searches"] if p else 0})
    known = set(d["docs"])
    gone = sorted({r["doc"] for r in refs} - known)  # read once, no longer in any copy
    plans = [{"project": p.get("project"), "path": path, "design_root": p.get("design_root"), "design_commit": p.get("design_commit")}
             for path, p in list(ext_plans.items()) if p.get("design_root")]
    return {"enabled": bool(DESIGN_DIRS or d["sources"]), "version": d["version"], "sources": d["sources"], "docs": docs,
            "gone": gone, "plans": plans, "refs": len(refs)}


def session_meta(sid, live):
    """Title, path, kind and task of a session for the reference lists: the live session when it is held (live: id ->
    Session), else what design-refs.json kept."""
    with refs_lock:
        m = dict(design_refs["sessions"].get(sid) or {})
    s = live.get(sid)
    if s:
        m.update(path=s.path, kind=s.kind, title=s.title or m.get("title"), task=s.task_id or m.get("task"), live=True)
    return m


def span_ts(row, ts):
    if ts:
        row["first"] = min(row["first"] or ts, ts)
        row["last"] = max(row["last"] or ts, ts)


def design_doc(key):
    """GET /api/design: one document with its table of contents, the references per section, and its version."""
    e = design["docs"].get(key)
    if not e:
        return {"error": "not found"}, 404
    c = e["copies"][0]
    src = design["sources"][c["src"]]
    out = {"key": key, **doc_label(key), "kind": e["kind"], "mtime": c["mtime"], "size": c["size"], "source": src,
           "copies": [{**design["sources"][x["src"]], "mtime": x["mtime"]} for x in e["copies"]]}
    if e["kind"] == "md":
        if c["size"] > DESIGN_FILE_MAX:
            return {"error": "문서가 너무 큼"}, 413
        try:
            with open(c["abs"], encoding="utf-8", errors="replace") as f:
                out["content"] = f.read()
        except OSError as err:
            return {"error": short(err, 200)}, 500
        out["toc"] = design_toc(c["abs"])[0]
    with refs_lock:
        refs = [r for r in design_refs["refs"].values() if r["doc"] == key]
    tickets = plan_tickets()
    with lock:
        live = {s.id: s for s in sessions.values()}
    metas = {}
    rows = {}
    for r in refs:
        m = metas.get(r["session"]) or metas.setdefault(r["session"], session_meta(r["session"], live))
        row = rows.setdefault((r["section"], r["session"]), {
            "section": r["section"], "session": r["session"], "title": (m.get("kind") == "codex" and row_key(tickets, m.get("task"))) or m.get("title") or row_key(tickets, m.get("task")) or r["session"][:8],
            "path": m.get("path"), "kind": m.get("kind"), "parent": m.get("parent"), "reads": 0, "searches": 0,
            "lines": [], "cover": None, "first": None, "last": None, "exact": False, "commits": set(),
            "ticket": r.get("ticket") or (tickets.get(m.get("task")) or (None, {}))[1].get("package")})
        row["reads" if r["kind"] == "read" else "searches"] += 1
        row["exact"] |= r["kind"] == "read" and r.get("exact", False)
        if r.get("lines"):
            row["lines"].append(r["lines"])
        elif r["kind"] == "read" and r.get("cover") is not None:
            row["cover"] = max(row["cover"] or 0, r["cover"])
        if r.get("commit"):
            row["commits"].add(r["commit"])
        span_ts(row, r["ts"])
    size = {s["id"]: max(1, s["end"] - s["start"] + 1) for s in out.get("toc") or []}
    for row in rows.values():
        if row["lines"]:  # union of the line ranges read in the section, over the section's current length
            covered = sum(b - a + 1 for a, b in to_ranges(n for a, b in row["lines"] for n in range(a, b + 1)))
            row["cover"] = round(min(1.0, covered / size.get(row["section"], covered or 1)), 3)
        row["lines"] = to_ranges(n for a, b in row["lines"] for n in range(a, b + 1))
        row["commits"] = sorted(row["commits"])
    out["refs"] = sorted(rows.values(), key=lambda x: x["last"] or "", reverse=True)
    # the plans whose design_root holds this document: their design_commit against the copy's HEAD
    out["plans"] = []
    for path, p in list(ext_plans.items()):
        if design_commit_for(path, key):
            head, commit = src.get("head"), p["design_commit"]
            same_file = None
            if head and commit and head != commit:
                same_file = git_cached((c["abs"], commit, head), lambda: subprocess.run(
                    ["git", "-C", os.path.dirname(c["abs"]), "diff", "--quiet", commit, head, "--", c["abs"]],
                    capture_output=True, timeout=5).returncode == 0)
            out["plans"].append({"project": p.get("project"), "path": path, "design_commit": commit, "head": head,
                                 "same": bool(head) and head == commit, "same_file": same_file})
    return out, 200


def design_file(key):
    """(bytes, content type) of a picture or PDF in a design folder; the path must resolve inside the folder."""
    e = design["docs"].get(key)
    if not e or e["kind"] == "md":
        return None, 404
    c = e["copies"][0]
    root = os.path.realpath(design["sources"][c["src"]]["dir"])
    full = os.path.realpath(c["abs"])
    if not full.startswith(root + os.sep) or not os.path.isfile(full):
        return None, 404
    if os.path.getsize(full) > DESIGN_FILE_MAX:
        return None, 413
    with open(full, "rb") as f:
        return (f.read(), DESIGN_TYPES[os.path.splitext(full)[1].lower()]), 200


_archived = collections.OrderedDict()  # (path, mtime, size) -> Session, the last few opened


def archived_session(path):
    """A transcript outside the live window, parsed on demand, when design-refs.json names it (the 「설계문서」 tab links
    every session that read a document, however old). Others stay unknown: this never reads an arbitrary path."""
    with refs_lock:
        known = any(m.get("path") == path for m in design_refs["sessions"].values())
    if not known:
        return None
    try:
        st = os.stat(path)
    except OSError:
        return None
    key = (path, st.st_mtime, st.st_size)
    if key not in _archived:
        s = Session(path, "codex" if os.path.basename(path).startswith("rollout-") else "claude")
        s.poll()
        _archived[key] = s
        while len(_archived) > 4:
            _archived.popitem(last=False)
    return _archived[key]


def session_design_refs(sid):
    """The design sections one session (and its subagents) read: [{doc, section, no, reads, searches, cover, last}]."""
    with refs_lock:
        kids = {k for k, m in design_refs["sessions"].items() if m.get("parent") == sid}
        refs = [r for r in design_refs["refs"].values() if r["session"] == sid or r["session"] in kids]
    rows = {}
    for r in refs:
        row = rows.setdefault((r["doc"], r["section"]), {"doc": r["doc"], "section": r["section"], "reads": 0, "searches": 0,
                                                         "lines": [], "cover": None, "first": None, "last": None, "sub": False})
        row["reads" if r["kind"] == "read" else "searches"] += 1
        row["sub"] |= r["session"] != sid
        if r.get("lines"):
            row["lines"].append(r["lines"])
        span_ts(row, r["ts"])
    for row in rows.values():
        e = design_copy(row["doc"])
        toc = design_toc(e["abs"])[0] if e and e["abs"].endswith(".md") else []
        s = next((x for x in toc if x["id"] == row["section"]), None)
        row["no"] = s["no"] if s else (SECTION_NO.match(row["section"] or "") or [None, None])[1]
        row["start"] = s["start"] if s else None
        row.update({"doc_" + k: v for k, v in doc_label(row["doc"]).items()})
        if row["lines"] and s:
            covered = sum(b - a + 1 for a, b in to_ranges(n for a, b in row["lines"] for n in range(a, b + 1)))
            row["cover"] = round(min(1.0, covered / max(1, s["end"] - s["start"] + 1)), 3)
        del row["lines"]
    return sorted(rows.values(), key=lambda x: (x["doc"], x["start"] or 0))


# ---- Review: a QA set's tickets → their Orca worktrees, reviewed ticket by ticket in VS Code ----
# prefs.json "qa_sets": [{"epic": "<epic key>", "project": "<vault-relative project folder>"}]. The epic's children
# (Jira `parent = epic`, read only) are the set's tickets. Each ticket pulls in the Orca worktrees whose folder name
# carries its key, the vault step note whose file name does (the project's progress.json lists them) and its latest
# test run. A review is recorded in that step note's frontmatter (review / review_sha / review_at); 「리뷰 후 변경」 is
# not stored but derived from review_sha against the worktrees' HEADs now.
QA_SETS = prefs.get("qa_sets") or []
# Branch a worktree is compared with when it has no open PR, per repo (the main checkout's folder name); else main.
REVIEW_BASES = prefs.get("review_bases") or {}
# Repos listed first inside a ticket and in its VS Code window (e.g. a shared library the apps build on).
REVIEW_FIRST = prefs.get("review_first") or []
JIRA_SITE = (prefs.get("jira_site") or "").rstrip("/")  # https://<site>.atlassian.net
REVIEW_EVERY, JIRA_EVERY, PR_EVERY = 30, 300, 600
REVIEW_WS_DIR = "/private/tmp/agent-dashboard-review"  # generated .code-workspace files
WT_KEY = re.compile(r"(?<![A-Za-z0-9])([A-Z][A-Z0-9]+-\d+)(?![0-9])")
review_state = {"sets": [], "updated": None}
review_kick = threading.Event()  # a review mark wakes the loop so the page shows it at once
_jira_token = None


def jira_token():
    """ATLASSIAN_API_TOKEN; launchd does not read ~/.zshrc where it is exported, so ask an interactive zsh once."""
    global _jira_token
    if _jira_token is None:
        t = os.environ.get("ATLASSIAN_API_TOKEN") or ""
        if not t:
            try:
                out = subprocess.run(["/bin/zsh", "-ic", "print -r -- $ATLASSIAN_API_TOKEN"], capture_output=True,
                                     text=True, timeout=15).stdout.strip().splitlines()
                t = out[-1].strip() if out else ""
            except (OSError, subprocess.SubprocessError):
                t = ""
        _jira_token = t
    return _jira_token


def jira_get(path, query):
    email, token = prefs.get("jira_email"), jira_token()
    if not (JIRA_SITE and email and token):
        raise RuntimeError("Jira 설정 없음 (prefs.json jira_site · jira_email, ATLASSIAN_API_TOKEN)")
    auth = base64.b64encode(f"{email}:{token}".encode()).decode()
    req = Request(f"{JIRA_SITE}/rest/api/3/{path}?{urlencode(query)}",
                  headers={"Authorization": "Basic " + auth, "Accept": "application/json"})
    with urlopen(req, timeout=20) as r:
        return json.load(r)


def jira_epic(epic):
    """-> (epic summary, [{key, summary, status, cat, assignee}]) for an epic's children."""
    summary = jira_get(f"issue/{epic}", {"fields": "summary"})["fields"].get("summary")
    out, nxt = [], None
    while True:
        q = {"jql": f"parent = {epic} ORDER BY key", "fields": "summary,status,assignee", "maxResults": "100"}
        if nxt:
            q["nextPageToken"] = nxt
        d = jira_get("search/jql", q)
        for i in d.get("issues") or []:
            f, st = i["fields"], i["fields"].get("status") or {}
            out.append({"key": i["key"], "summary": f.get("summary"), "status": st.get("name"),
                        "cat": (st.get("statusCategory") or {}).get("key"),
                        "assignee": (f.get("assignee") or {}).get("displayName")})
        nxt = d.get("nextPageToken")
        if not nxt or d.get("isLast", True):
            return summary, out


def git_at(path, *args, timeout=10):
    try:
        r = subprocess.run(["git", "-C", path, *args], capture_output=True, text=True, timeout=timeout)
        return r.stdout.strip() if r.returncode == 0 else None
    except (OSError, subprocess.SubprocessError):
        return None


def note_review(path):
    """Step note frontmatter: {status, review, review_sha {repo: sha}, review_at}."""
    out = {"status": None, "review": None, "review_sha": {}, "review_at": None}
    try:
        with open(path, encoding="utf-8") as f:
            text = f.read(8192)
    except OSError:
        return out
    m = re.match(r"---\n(.*?)\n---\n", text, re.S)
    sub = False
    for ln in (m.group(1).split("\n") if m else []):
        if sub and ln[:1] in (" ", "\t") and ":" in ln:
            k, v = ln.strip().split(":", 1)
            out["review_sha"][k.strip()] = v.strip().strip("'\"")
            continue
        sub = False
        k, _, v = ln.partition(":")
        if k == "review_sha":
            sub = True
        elif k in ("status", "review", "review_at"):
            out[k] = v.strip() or None
    return out


def write_review(path, shas):
    """Replace the review fields of a step note's frontmatter; shas None clears them. The note's `updated` stays:
    a review mark is state, not a change to what the note says."""
    with open(path, encoding="utf-8") as f:
        text = f.read()
    m = re.match(r"---\n(.*?)\n---\n", text, re.S)
    if not m:
        raise ValueError("frontmatter 없음")
    keep, skip = [], False
    for ln in m.group(1).split("\n"):
        if skip and ln[:1] in (" ", "\t"):
            continue
        skip = bool(re.match(r"(review|review_sha|review_at):", ln))
        if not skip:
            keep.append(ln)
    if shas is not None:
        # quoted: an all-digit short sha would otherwise read back as a YAML number
        keep += ["review: done", "review_sha:", *[f'  {r}: "{s}"' for r, s in sorted(shas.items())],
                 f"review_at: {datetime.now().date().isoformat()}"]
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write("---\n" + "\n".join(keep) + "\n---\n" + text[m.end():])
    os.replace(tmp, path)


def project_notes(project, prefix):
    """key -> {step: abs path, notes: [abs paths of the ticket's other notes]} for a vault project folder. Note names
    carry the project's own key first ("PRJ-1 7.52 QA-12 …"), so only keys with the set's prefix count."""
    pdir = os.path.join(VAULT, project)
    key_of = lambda p: next((k for k in WT_KEY.findall(os.path.basename(p)) if k.startswith(prefix)), None)
    with open(os.path.join(pdir, "progress.json"), encoding="utf-8") as f:
        prog = json.load(f)
    out = {}
    for st in prog.get("stages") or []:
        for s in st.get("steps") or []:
            k = key_of(s.get("path") or "")
            if k:
                out.setdefault(k, {"step": os.path.join(pdir, s["path"]), "notes": []})
    for p in glob.glob(os.path.join(pdir, "**", "*.md"), recursive=True):
        k = key_of(p)
        if k in out and p != out[k]["step"]:
            out[k]["notes"].append(p)
    return out


def ticket_test(key):
    """Latest kept or live test run that names the ticket in its key, label or owner."""
    runs = [r for r in list(test_history.values()) + list(test_progress.get("files") or [])
            if any(key in str(r.get(f) or "") for f in ("key", "label", "owner"))]
    runs.sort(key=lambda r: str(r.get("finished_at") or r.get("updated_at") or r.get("started_at") or ""))
    return {k: runs[-1].get(k) for k in ("label", "kind", "phase", "detail", "passed", "failed", "pending",
                                          "started_at", "finished_at", "updated_at")} if runs else None


def wt_repo(w, worktrees):
    main = next((x for x in worktrees if x.get("repoId") == w.get("repoId") and x.get("isMainWorktree")), None)
    return os.path.basename(main["path"]) if main else os.path.basename(os.path.dirname(w["path"]))


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
            "handoffs": len(hand), "done": len(done), "driver": bool(rec.get("driver"))}


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


def review_pass(jira, prs, stats):
    worktrees = orca("worktree", "list", timeout=20).get("worktrees") or []
    by_key = {}
    for w in worktrees:
        m = WT_KEY.search(os.path.basename(w.get("path") or ""))
        if m and not w.get("isMainWorktree") and not w.get("isArchived") and os.path.isdir(w["path"]):
            by_key.setdefault(m.group(1), []).append(w)
    now = time.time()
    sets = []
    for qs in QA_SETS:
        epic, project = qs.get("epic"), qs.get("project")
        err = None
        if now - jira.get(epic, (0,))[0] > JIRA_EVERY:
            try:
                jira[epic] = (now, *jira_epic(epic))
            except Exception as e:  # keep the last list; say why it is old
                err = "Jira: " + short(repr(e), 160)
                jira[epic] = (now, *(jira.get(epic, (0, None, []))[1:]))
        _, epic_summary, children = jira.get(epic, (0, None, []))
        try:
            notes = project_notes(project, epic.split("-")[0] + "-") if project else {}
        except (OSError, ValueError) as e:
            notes, err = {}, (err + " · " if err else "") + "progress.json: " + short(repr(e), 120)
        try:
            ships = ship_tasks(epic) if SHIP_PROMPT else {}
        except Exception as e:
            ships, err = {}, (err + " · " if err else "") + "반출 Run: " + short(repr(e), 120)
        watch = os.path.expanduser(qs.get("watch") or "")
        driver = bool(watch) and os.path.isdir(os.path.join(watch, "tickets"))
        tickets = []
        for c in children:
            key = c["key"]
            repos = []
            qa = qa_ticket(watch, key) if watch else None
            if driver and qa and qa["worktree"] and os.path.isdir(qa["worktree"]):
                places = [(path, br, repo, None, None) for path, br, repo in driver_worktree_repos(qa["worktree"])]
            else:
                places = [(w["path"], (w.get("branch") or "").removeprefix("refs/heads/"), wt_repo(w, worktrees),
                           w.get("displayName"), w.get("comment")) for w in by_key.get(key, [])]
            for path, branch, repo, wname, wcomment in places:
                head = git_at(path, "rev-parse", "HEAD")
                pk = (path, branch)
                if now - prs.get(pk, (0,))[0] > PR_EVERY:
                    try:
                        r = subprocess.run(["gh", "pr", "list", "--head", branch, "--state", "all", "--limit", "1",
                                            "--json", "number,url,state,baseRefName"], cwd=path,
                                           capture_output=True, text=True, timeout=20)
                        lst = json.loads(r.stdout) if r.returncode == 0 and r.stdout.strip() else []
                        prs[pk] = (now, lst[0] if lst else None)
                    except (OSError, ValueError, subprocess.SubprocessError):
                        prs[pk] = (now, None)
                pr = prs[pk][1]
                if pr and pr.get("baseRefName"):
                    base, base_src = pr["baseRefName"], "PR"
                else:
                    base, base_src = REVIEW_BASES.get(repo, "main"), "설정" if repo in REVIEW_BASES else "기본"
                base_ref = next((r for r in (f"origin/{base}", base) if git_at(path, "rev-parse", "--verify", "--quiet", r)), None)
                base_sha = base_ref and git_at(path, "rev-parse", base_ref)
                sk = (path, head, base_sha)
                if head and base_sha and sk not in stats:
                    lr = (git_at(path, "rev-list", "--left-right", "--count", f"{base_sha}...{head}") or "0\t0").split()
                    ss = git_at(path, "diff", "--shortstat", f"{base_sha}...{head}") or ""
                    num = lambda pat: int((re.search(pat, ss) or [0, 0])[1])
                    stats[sk] = {"behind": int(lr[0]), "ahead": int(lr[1]), "files": num(r"(\d+) files? changed"),
                                 "ins": num(r"(\d+) insertions?"), "dels": num(r"(\d+) deletions?")}
                porcelain = git_at(path, "status", "--porcelain")
                repos.append({"repo": repo, "path": path, "branch": branch, "name": wname,
                              "comment": wcomment or None, "head": head, "base": base, "base_ref": base_ref,
                              "base_src": base_src, "pr": pr, "dirty": len(porcelain.splitlines()) if porcelain else 0,
                              **(stats.get(sk) or {})})
            repos.sort(key=lambda r: (r["repo"] not in REVIEW_FIRST, r["repo"]))
            n = notes.get(key) or {}
            fm = note_review(n["step"]) if n.get("step") else {}
            if not repos:
                review = "none"
            elif fm.get("review") != "done":
                review = "pending"
            else:
                rs = fm.get("review_sha") or {}
                same = all(r["head"] and rs.get(r["repo"]) and r["head"].startswith(rs[r["repo"]]) for r in repos)
                review = "done" if same else "changed"
            tickets.append({**c, "repos": repos, "review": review, "review_at": fm.get("review_at"),
                            "review_sha": fm.get("review_sha") or {}, "step": n.get("step"),
                            "step_status": fm.get("status"), "notes": n.get("notes") or [], "test": ticket_test(key),
                            "ship": ship_state(ships.get(key), ship_launch.get(key)), "qa": qa})
        # Worktrees named after a key the epic does not list (another QA, or a key typo) stay visible too.
        listed = {c["key"] for c in children}
        stray = sorted(k for k in by_key if k.startswith(epic.split("-")[0] + "-") and k not in listed)
        sets.append({"epic": epic, "summary": epic_summary, "project": project, "error": err,
                     "tickets": tickets, "stray": stray, "watch": watch or None, "driver": driver,
                     "stages": QA_STAGES})
    autos = qa_automations([s["epic"] for s in sets])
    for s in sets:
        s["automations"] = autos.get(s["epic"], [])
    with lock:
        review_state.update(sets=sets, updated=datetime.now(timezone.utc).isoformat())
        bump()


# ---- Ship: 「PR 후 머지」 hands a 진행 중 ticket to a supervised Orca worker ----
# prefs.json "ship_prompt" is the prompt template (absolute path, {{name}} slots filled from the ticket below) and each
# QA set's "ship_place" the Orca worktree path the worker starts in — outside the ticket's worktrees, which the worker
# removes at the end. One Run per set, found again by its objective, holds every ship Task; nobody coordinates it, so
# the prompt has the worker stop and report failure instead of asking. A Task's title starts with the ticket key.
SHIP_PROMPT = os.path.expanduser(prefs.get("ship_prompt") or "")
SHIP_AGENT, SHIP_MODEL = prefs.get("ship_agent") or "claude", prefs.get("ship_model") or "opus"
SHIP_SETTLED = ("completed", "failed", "cancelled", "launch_failed")
ship_runs = {}    # epic -> run id
ship_launch = {}  # key -> {"at", "error"} while worker-start runs, and why it failed


def jira_stage(t):
    """Same split as the page's jiraStage: 개발 완료 and QA 준비 완료 share 진행 중's category, so they go by name."""
    n = re.sub(r"\s", "", t.get("status") or "")
    return ("ready" if "QA준비" in n else "dev" if "개발완료" in n else "qa" if "QA완료" in n or t.get("cat") == "done"
            else "todo" if t.get("cat") == "new" else "prog")


def ship_objective(epic):
    return f"{epic} 티켓 반출 (대시보드)"


def ship_run(epic, create=False):
    if epic not in ship_runs:
        rid = next((r["id"] for r in orca_all("runs", "orchestration", "run-list")
                    if r.get("objective") == ship_objective(epic)), None)
        if not rid and create:
            rid = orca("orchestration", "run-create", "--objective", ship_objective(epic), timeout=30)["run"]["id"]
        if not rid:
            return None
        ship_runs[epic] = rid
    return ship_runs[epic]


def ship_tasks(epic):
    """key -> latest ship Task of the set's Run {status, task_id, at}."""
    rid = ship_run(epic)
    out = {}
    for x in (orca("orchestration", "task-list", "--run", rid).get("tasks") or []) if rid else []:
        m = WT_KEY.match(x.get("task_title") or "")
        if m and str(x.get("created_at") or "") >= str((out.get(m.group(1)) or {}).get("at") or ""):
            out[m.group(1)] = {"status": x.get("status"), "task_id": x.get("id"), "run_id": rid, "at": x.get("created_at")}
    return out


BASE_SRC = {"PR": "기존 PR 의 base", "설정": "설정", "기본": "설정 없음 → main"}


def ship_state(task, launch):
    """The Task, unless a launch started after it: then 'launching', or 'launch_failed' with why."""
    if launch and (not task or str(task.get("at") or "") < launch["at"]):
        return {"status": "launch_failed" if launch["error"] else "launching", "error": launch["error"], "at": launch["at"]}
    return task


def ship_spec(t, qs):
    lines = []
    for r in t["repos"]:
        pr = r.get("pr") or {}
        lines.append(f"- {r['repo']} — 워크트리 `{r['path']}`, 브랜치 `{r['branch']}`, 베이스 `{r['base']}` "
                     f"({BASE_SRC.get(r['base_src'], r['base_src'])}), PR {pr.get('url') or '없음'}"
                     f"{' (' + pr['state'] + ')' if pr.get('state') else ''}, 앞선 커밋 {r.get('ahead', '?')} · "
                     f"뒤처진 커밋 {r.get('behind', '?')}{', 미커밋 ' + str(r['dirty']) if r.get('dirty') else ''}")
    vals = {"key": t["key"], "summary": t.get("summary") or "", "jira_url": f"{JIRA_SITE}/browse/{t['key']}",
            "jira_status": t.get("status") or "", "assignee": t.get("assignee") or "없음", "epic": qs["epic"],
            "project": os.path.join(VAULT, qs.get("project") or ""), "vault": VAULT, "step_note": t.get("step") or "없음",
            "notes": ", ".join(t.get("notes") or []) or "없음", "repos": "\n".join(lines)}
    with open(SHIP_PROMPT, encoding="utf-8") as f:
        return re.sub(r"\{\{(\w+)\}\}", lambda m: str(vals.get(m.group(1), m.group(0))), f.read())


def ship_start(t, qs):
    key = t["key"]
    try:
        spec = ship_spec(t, qs)
        rid = ship_run(qs["epic"], create=True)
        res = orca("orchestration", "worker-start", "--run", rid, "--spec", spec, "--task-title", f"{key} 반출",
                   "--worktree", "path:" + os.path.expanduser(qs["ship_place"]), "--agent", SHIP_AGENT,
                   "--model", SHIP_MODEL, timeout=240)
        handle = res.get("agentTerminalHandle") or (res.get("startupTerminal") or {}).get("handle")
        if handle:
            try:
                orca("terminal", "rename", "--terminal", handle, "--title", f"{key} 반출", timeout=15)
            except Exception:
                pass  # the Task row still names the ticket
        with lock:
            ship_launch.pop(key, None)
    except Exception as e:
        with lock:
            ship_launch[key] = {"at": datetime.now(timezone.utc).isoformat(), "error": short(str(e), 300)}
    review_kick.set()


def review_loop():
    jira, prs, stats = {}, {}, {}
    while True:
        if QA_SETS:
            try:
                review_pass(jira, prs, stats)
                loop_ok("review")
            except Exception as e:
                loop_failed("review", e)
        review_kick.wait(REVIEW_EVERY)
        review_kick.clear()


def review_ticket(key):
    return next((t for s in review_state["sets"] for t in s["tickets"] if t["key"] == key), None)


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
                summaries.append(sm)
            # Owners first (from the sessions' own terminals), then each owner takes its plans' scripts.
            plan_owners.clear()
            plan_owners.update({p: resolve_plan_owner(p, plan, summaries) for p, plan in ext_plans.items()})
            summaries = [apply_prefs(with_plan_terms(sm)) for sm in summaries]
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
                "ext_plans": [{**plan_with_owner(p, ext_plans[p]), "design_refs": design_ticket_refs.get(p) or {}}
                              for p in EXTERNAL_PLANS if p in ext_plans],
                "design": {"enabled": bool(DESIGN_DIRS or design["sources"]), "version": f'{design["version"]}.{design_rev}'},
                "tests": test_progress,
                "reviews_at": review_state["updated"],
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
            extra = {}
            if not s:
                s = archived_session(path)  # a session the 「설계문서」 tab links to, outside --hours
                extra["archived"] = True
            if s and design_bases:
                extra["design_refs"] = session_design_refs(s.id)  # the sections it (and its subagents) read
            with lock:
                body = s and self.encode({**apply_prefs(with_plan_terms(s.detail())), **extra})
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
        elif url.path == "/api/reviews":
            with lock:
                body = self.encode({"sets": review_state["sets"], "updated": review_state["updated"], "jira": JIRA_SITE})
            self.send_body(body)
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
        elif url.path == "/api/decision/mode":
            with lock:
                self.send_json({"inbox": bool(prefs.get("decision_inbox"))})
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
        elif url.path == "/api/designs":
            self.send_json(design_list())
        elif url.path == "/api/design":
            self.send_json(*design_doc((parse_qs(url.query).get("path") or [""])[0]))
        elif url.path == "/api/design/file":
            body, status = design_file((parse_qs(url.query).get("path") or [""])[0])
            if not body:
                return self.send_json({"error": "not found" if status == 404 else "파일이 너무 큼"}, status)
            self.send_response(200)
            self.send_header("Content-Type", body[1])
            self.send_header("Content-Length", str(len(body[0])))
            self.send_header("Cache-Control", "no-cache")
            if body[1] == "image/svg+xml":  # an SVG opened on its own must not run its scripts on this origin
                self.send_header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src data:")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(body[0])
        elif url.path == "/api/design/refs":
            self.send_json({"refs": session_design_refs((parse_qs(url.query).get("session") or [""])[0])})
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
        if url.path not in ("/api/pref", "/api/orca/focus", "/api/orca/close", *REVIEW_POSTS, *QA_POSTS, *DECISION_POSTS) or not self.headers.get("Content-Type", "").startswith("application/json"):
            return self.send_json({"error": "bad request"}, 400)
        if url.path in DECISION_POSTS:
            return self.decision_post(url.path.rsplit("/", 1)[1])
        if url.path in ("/api/orca/focus", "/api/orca/close"):
            return self.orca_terminal(url.path.rsplit("/", 1)[1])
        if url.path in REVIEW_POSTS:
            return self.review_action(url.path.rsplit("/", 1)[1])
        if url.path in QA_POSTS:
            return self.qa_action(url.path.rsplit("/", 1)[1])
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


    def qa_action(self, what):
        """automation {"epic", "id", "action": enable|disable|run}: an Orca automation that names the epic (the set
        lists them). ticket {"epic", "key", "action": approve|cleanup_check|cleanup}: the qa-driver CLI on the set's
        state directory — approve records push/PR approval and tells the coordinator; cleanup_check is cleanup's dry run
        (exit 3 = it would stop: uncommitted or unpushed work), cleanup removes the worktree."""
        try:
            body = json.loads(self.rfile.read(min(int(self.headers.get("Content-Length") or 0), 65536)))
            epic, action = body["epic"], body["action"]
            assert isinstance(epic, str) and WT_KEY.fullmatch(epic) and isinstance(action, str)
        except (ValueError, KeyError, AssertionError, TypeError):
            return self.send_json({"error": "bad request"}, 400)
        with lock:
            st = next((json.loads(json.dumps(x)) for x in review_state["sets"] if x["epic"] == epic), None)
        if not st:
            return self.send_json({"error": "없는 QA 묶음입니다"}, 404)
        if what == "automation":
            aid = body.get("id")
            if action not in ("enable", "disable", "run") or aid not in {a["id"] for a in st.get("automations") or []}:
                return self.send_json({"error": "이 묶음의 자동화가 아니거나 모르는 동작입니다"}, 400)
            try:
                if action == "run":
                    orca("automations", "run", aid, timeout=60)
                else:
                    orca("automations", "edit", aid, "--enabled" if action == "enable" else "--disabled", timeout=30)
            except Exception as e:
                return self.send_json({"error": "Orca: " + short(str(e), 300)}, 502)
            qa_auto_cache["at"] = 0  # show the new state on the next pass
            review_kick.set()
            return self.send_json({"ok": True})
        key = body.get("key")
        if not (isinstance(key, str) and any(t["key"] == key for t in st["tickets"])):
            return self.send_json({"error": "묶음에 없는 티켓입니다"}, 404)
        if not st.get("watch"):
            return self.send_json({"error": "이 묶음에는 상태 디렉터리(watch)가 없습니다"}, 409)
        args = {"approve": ("approve", key, "--by", "대시보드"), "cleanup_check": ("cleanup", key, "--dry-run"),
                "cleanup": ("cleanup", key)}.get(action)
        if not args:
            return self.send_json({"error": "모르는 동작입니다"}, 400)
        try:
            code, out = qa_cli(epic, st["watch"], *args)
        except subprocess.TimeoutExpired:
            return self.send_json({"error": "qa-driver 가 제한 시간 안에 끝나지 않았습니다"}, 504)
        review_kick.set()
        return self.send_json({"ok": code == 0, "code": code, "output": out}, 200 if code in (0, 3) else 502)

    def review_action(self, action):
        """{"key"} -> open: one VS Code window holding every worktree of the ticket. Only for a request addressed to
        this Mac's loopback (the page open on this Mac): it starts an app here, and a tailnet device reaches the server
        through `tailscale serve`, whose requests carry the ts.net Host and X-Forwarded-For. mark {"key", "done"}:
        record or clear the review in the ticket's vault step note, with each worktree's HEAD now."""
        try:
            body = json.loads(self.rfile.read(min(int(self.headers.get("Content-Length") or 0), 65536)))
            key = body["key"]
            assert isinstance(key, str) and WT_KEY.fullmatch(key)
            done = body.get("done", True)
            assert isinstance(done, bool)
        except (ValueError, KeyError, AssertionError, TypeError):
            return self.send_json({"error": "bad request"}, 400)
        with lock:
            t = review_ticket(key)
            t = t and json.loads(json.dumps(t))
        if not t:
            return self.send_json({"error": "묶음에 없는 티켓입니다"}, 404)
        if not t["repos"]:
            return self.send_json({"error": "이 티켓의 워크트리가 없습니다"}, 409)
        if action == "ship":
            qs = next((q for q in QA_SETS if any(x["key"] == key for s in review_state["sets"] if s["epic"] == q.get("epic")
                                                  for x in s["tickets"])), None)
            if not SHIP_PROMPT or not os.path.isfile(SHIP_PROMPT):
                return self.send_json({"error": "prefs.json 의 ship_prompt 가 없거나 파일이 없습니다"}, 409)
            if not qs or not qs.get("ship_place"):
                return self.send_json({"error": "prefs.json 의 이 묶음에 ship_place 가 없습니다"}, 409)
            if jira_stage(t) != "prog":
                return self.send_json({"error": f"Jira 「{t.get('status')}」 티켓입니다 (진행 중만)"}, 409)
            with lock:
                busy = (key in ship_launch and not ship_launch[key].get("error")) \
                    or (t.get("ship") and t["ship"].get("status") not in SHIP_SETTLED)
                if busy:
                    return self.send_json({"error": "이미 반출 중입니다"}, 409)
                ship_launch[key] = {"at": datetime.now(timezone.utc).isoformat(), "error": None}
                bump()
            threading.Thread(target=ship_start, args=(t, qs), daemon=True).start()
            review_kick.set()
            return self.send_json({"ok": True}, 202)
        if action == "open":
            host = (self.headers.get("Host") or "").lower().rsplit(":", 1)[0].strip("[]")
            if host not in ("127.0.0.1", "localhost", "::1") or self.headers.get("X-Forwarded-For"):
                return self.send_json({"error": "VS Code 열기는 이 맥에서 연 화면에서만 됩니다"}, 403)
            os.makedirs(REVIEW_WS_DIR, exist_ok=True)
            ws = os.path.join(REVIEW_WS_DIR, f"{key}.code-workspace")
            save_json(ws, {"folders": [{"path": r["path"], "name": f'{r["repo"]} · {r["branch"]} (vs {r["base_ref"] or r["base"]})'}
                                       for r in t["repos"]]})
            r = subprocess.run(["open", "-a", "Visual Studio Code", ws], capture_output=True, text=True, timeout=15)
            if r.returncode:
                return self.send_json({"error": "VS Code 를 열지 못함: " + short(r.stderr, 200)}, 502)
            return self.send_json({"ok": True})
        if not t["step"]:
            return self.send_json({"error": "볼트에 이 티켓의 스텝 노트가 없습니다"}, 409)
        shas = {}
        for r in t["repos"]:
            head = git_at(r["path"], "rev-parse", "--short=9", "HEAD")
            if not head:
                return self.send_json({"error": f'{r["repo"]} HEAD 를 읽지 못함'}, 502)
            shas[r["repo"]] = head
        try:
            write_review(t["step"], shas if done else None)
        except (OSError, ValueError) as e:
            return self.send_json({"error": "스텝 노트 기록 실패: " + short(repr(e), 200)}, 500)
        with lock:  # show it now; the next pass (woken here) recomputes it from the note anyway
            live = review_ticket(key)
            if live:
                live.update(review="done" if done else "pending", review_sha=shas if done else {},
                            review_at=datetime.now().date().isoformat() if done else None)
                review_state["updated"] = datetime.now(timezone.utc).isoformat()
                bump()
        review_kick.set()
        self.send_json({"ok": True, "review_sha": shas if done else {}})

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
        """ask {session_id, tool_use_id, cwd, terminal, questions} from the hook -> {id}, or with 메일함 mode on
        {id, inbox, deny} (add_decision). answer {id, answers} from the page: types them into the session's terminal
        picker (answer_decision); 200 done, 400 an answer missing or one the picker cannot take, 409 no longer open or
        the terminal not usable, 502 Orca failed. release {id}: the old page's 「터미널에서 답하기」; the picker is
        already open, so nothing to do. dismiss {id}: take a card off the page (the terminal picker stays); the page
        offers it after an error. mode {inbox: bool}: 메일함 mode on or off. inbox {id, action read|unread|delete|answer,
        answers}: a 메일함 item (inbox_answer). guard {command, terminal, cwd} from session-guard -> {deny} when the
        command would close a session with a 메일함 item (guard_command), else {}."""
        try:
            body = json.loads(self.rfile.read(min(int(self.headers.get("Content-Length") or 0), 262144)))
            assert isinstance(body, dict)
            if action == "ask":
                return self.send_json(add_decision(body))
            if action == "guard":
                assert isinstance(body["command"], str)
                own, cwd = body.get("terminal"), body.get("cwd")
                why = guard_command(body["command"], own if isinstance(own, str) else None, cwd if isinstance(cwd, str) else "")
                return self.send_json({"deny": why} if why else {})
            if action == "mode":
                assert isinstance(body["inbox"], bool)
                set_inbox_mode(body["inbox"])
                return self.send_json({"ok": True, "inbox": body["inbox"]})
            rid = body["id"]
            assert isinstance(rid, str) and DECISION_ID.match(rid)
            assert action != "answer" or isinstance(body["answers"], list)
            assert action != "inbox" or body["action"] in ("read", "unread", "delete", "answer")
            assert action != "inbox" or body["action"] != "answer" or isinstance(body["answers"], list)
        except (ValueError, KeyError, AssertionError, TypeError):
            return self.send_json({"error": "bad request"}, 400)
        if action == "answer":
            status, out = answer_decision(rid, body["answers"])
            return self.send_json(out, status)
        if action == "inbox":
            status, out = inbox_answer(rid, body["action"], body.get("answers") or [])
            return self.send_json(out, status)
        if action == "dismiss":
            if not settle_decision(rid, "cancelled"):
                return self.send_json({"error": "이미 답했거나 닫힌 질문입니다"}, 409)
            return self.send_json({"ok": True})
        self.send_json({"ok": True})


REVIEW_POSTS = ("/api/review/open", "/api/review/mark", "/api/review/ship")
QA_POSTS = ("/api/qa/automation", "/api/qa/ticket")
DECISION_POSTS = ("/api/decision/ask", "/api/decision/answer", "/api/decision/release", "/api/decision/mode",
                  "/api/decision/inbox", "/api/decision/guard", "/api/decision/dismiss")


class Server(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        # A tab closed or a phone that slept mid-response is routine; it used to leave a traceback per hangup.
        if isinstance(sys.exc_info()[1], (BrokenPipeError, ConnectionResetError)):
            return
        super().handle_error(request, client_address)


def main():
    global DESIGN_DAYS
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
    ap.add_argument("--design-dir", action="append", default=[],
                    help="design document folder (e.g. <repo>/feature-designs), added to prefs.json design_dirs; repeatable")
    ap.add_argument("--design-days", type=float, default=DESIGN_DAYS,
                    help="how far back (days) design reads are looked for in transcripts outside --hours")
    args = ap.parse_args()
    DESIGN_DAYS = args.design_days
    for d in (prefs.get("design_dirs") or []) + args.design_dir:
        d = os.path.realpath(os.path.expanduser(d))
        if d not in DESIGN_DIRS:
            DESIGN_DIRS.append(d)
    design_bases.update(os.path.basename(d) for d in DESIGN_DIRS)  # before scan_loop parses the first transcript
    hosts = args.host or ["127.0.0.1"]
    PROJECTS_DIRS.extend(os.path.abspath(os.path.expanduser(d)) for d in args.projects_dir)
    threading.Thread(target=scan_loop, args=(args.hours,), daemon=True).start()
    threading.Thread(target=orca_loop, args=(args.runs, args.hours), daemon=True).start()
    threading.Thread(target=ext_plan_loop, daemon=True).start()
    threading.Thread(target=history_loop, daemon=True).start()
    threading.Thread(target=decision_loop, daemon=True).start()
    threading.Thread(target=review_loop, daemon=True).start()
    if PROJECTS_DIRS:
        threading.Thread(target=projects_loop, daemon=True).start()
    if DESIGN_DIRS or EXTERNAL_PLANS:  # an external plan's design_root is a design folder too
        threading.Thread(target=design_loop, daemon=True).start()
        threading.Thread(target=design_backfill_loop, daemon=True).start()
    servers = []
    ALLOWED_HOSTS.update(h.lower() for h in hosts)
    ALLOWED_ORIGINS.update(o.rstrip("/").lower() for o in args.origin)
    for host in hosts:
        server = Server((host, args.port), Handler)
        servers.append(server)
        print(f"agent-dashboard API → http://{host}:{args.port}/", flush=True)
    print(f"allowed origins: {', '.join(sorted(ALLOWED_ORIGINS)) or '(local only)'}", flush=True)
    print(f"project dirs: {', '.join(PROJECTS_DIRS) or '(off)'}", flush=True)
    print(f"design dirs: {', '.join(DESIGN_DIRS) or '(off)'}", flush=True)
    for server in servers[1:]:
        threading.Thread(target=server.serve_forever, daemon=True).start()
    servers[0].serve_forever()


if __name__ == "__main__":
    main()
