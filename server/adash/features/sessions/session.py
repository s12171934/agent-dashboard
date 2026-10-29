"""One transcript (Claude or Codex), parsed incrementally into a session summary and detail."""

import base64
import collections
import json
import os
import re
import time

from adash.core.util import epoch, short
from adash.features.decisions.store import INBOX_PICK
from adash.features.designs.refs import DesignReads, note_design_stats
from adash.features.orca_runs.store import orca_state
from adash.features.sessions.config import (CHAT_CHARS, CHAT_LIMIT, CLAUDE_CTX_WINDOW, LOG_LIMIT, LONG_CTX_MODELS,
    STALL_SECONDS, WAIT_SECONDS, hooks)
from adash.features.sessions.patterns import (APLAN_CMD, APLAN_SET, APLAN_TOKEN, BG_END, BG_KIND, BG_MAX_SECONDS,
    BG_NOTE, BG_START, BRIEF_COORD, BRIEF_TASK, COORD_CMD, COORD_HANDLE_STR, HANDLE, NOT_INSTRUCTION, OWN_RUN_CMD,
    RELAY, RELAY_BACK, RUN_CREATE, RUN_ID, TERM_CREATE, classify_tool, tool_hint)
from adash.features.sessions.places import place_of
from adash.features.sessions.plans import build_plans
from adash.features.sessions.pricing import price_for
from adash.features.sessions.usage import SLOT_KEEP, SLOT_SECONDS, seconds_since, turn_cost, turn_slots


class Session:
    def __init__(self, path, kind):
        self.path = path
        self.kind = kind
        self.offset = 0
        self.buf = b""
        self.id = os.path.splitext(os.path.basename(path))[0]
        self.title = None
        self.custom_title = None  # /rename
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
        self.chat = []  # the conversation as said: prompts and replies, whitespace kept (CHAT_LIMIT × CHAT_CHARS)
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
        self.awaits = set()  # terminals this session handed a message to and has had no answer from (see RELAY)
        self.error = None  # last turn ended on an API error (usage limit etc.) and nothing has run since
        self.busy = False  # a turn is open: the model is generating or a tool is running
        self.bg = {}  # background task id -> (kind, started ts): run_in_background Bash, Monitor, async agents
        self.stop_calls = {}  # TaskStop tool call id -> task id
        self.asks = {}  # AskUserQuestion call id -> [first question, epoch seconds, has a result]; see stale_decisions
        self.inbox_picks = {}  # 메일함 item id -> the pick the agent wrote for it ("[메일함 <id>] ..."); see sweep_decisions
        self.bg_calls = {}  # tool call id -> tool name, for calls that may start a background task
        self.own_run_calls = set()  # tool call ids of this session's run-create/run-use
        self.own_votes = collections.Counter()
        # Handles a run-create/run-use without --from bound this session as coordinator: a resumed session (reboot,
        # closed pane) gets a new terminal, so it has every terminal it ever coordinated from, not only own_handle.
        self.self_bind_calls = set()
        self.self_handles = []
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

    def add_log(self, ts, role, text, instruction=True, full=None, **extra):
        said = role == "assistant" or (role == "user" and instruction and not NOT_INSTRUCTION.match(text or ""))
        if role == "user":
            self.last_prompt, self.last_prompt_ts = text, ts
            if said:
                self.prompts.append((ts or "", text))
        if said and full is not None and full.strip():
            full = full.strip()
            self.chat.append({"ts": ts, "role": role, "text": full if len(full) <= CHAT_CHARS else full[: CHAT_CHARS - 1] + "…"})
            if len(self.chat) > CHAT_LIMIT:
                del self.chat[: len(self.chat) - CHAT_LIMIT]
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
        if isinstance(cmd, str) and (RELAY_BACK.search(cmd) or APLAN_SET.search(cmd)):
            self.awaits.clear()  # the answer read, or a new plan: a new piece of work
        if isinstance(cmd, str) and RELAY.search(cmd):
            # the handles written out in the command; a terminal named by a shell variable is not followed
            self.awaits.update(h for h in HANDLE.findall(cmd) if h != self.own_handle)
        if call_id and isinstance(cmd, str) and OWN_RUN_CMD.search(cmd):
            self.own_run_calls.add(call_id)
            if "--from" not in cmd:
                self.self_bind_calls.add(call_id)
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
            if call_id in self.self_bind_calls:
                self.self_handles += [h for h in COORD_HANDLE_STR.findall(text) if h not in self.self_handles]
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
        if typ == "custom-title":  # /rename: the user's name outranks Claude's ai-title and the first prompt
            self.custom_title = rec.get("customTitle") or self.custom_title
            self.title = self.custom_title or self.title
            return
        if typ == "ai-title":
            self.title = self.custom_title or rec.get("aiTitle") or self.title
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
                    self.add_log(ts, "assistant", short(block["text"]), full=block["text"])
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
                self.add_log(ts, "user", short(content), instruction=not rec.get("isMeta"), full=content)
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
                        self.add_log(ts, "user", short(block.get("text", "")), instruction=not rec.get("isMeta"), full=block.get("text", ""))
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
                self.add_log(ts, "assistant", short(text), full=text)
            elif role == "user" and "dispatched worker" in text:
                self.check_brief(text)
                self.add_log(ts, "user", short(text), full=text)
            elif role == "user" and text.strip() and not text.lstrip().startswith(("#", "<")):
                self.title = self.title or short(text, 80)
                self.add_log(ts, "user", short(text), full=text)
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
        aliases = []
        if self.role != "worker" and self.own_handle:
            aliases = [h for h in self.self_handles + [self.pane_handle()] if h and h != self.own_handle]
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
            "own_handle": self.own_handle, "own_aliases": list(dict.fromkeys(aliases)), "coordinates": self.issues_orchestration, "awaits": sorted(self.awaits),
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
            "last_action": self.last_action(), "plan": self.plan_summary(), "place": self.placement(), "made_terms": self.made_terms,
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
