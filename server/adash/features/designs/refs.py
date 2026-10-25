"""Read references per document section, ticket and session, kept in design-refs.json."""

import collections
import glob
import json
import os
import time

from adash.core.state import lock, report_failure, sessions
from adash.core.util import short
from adash.features.designs.index import design_key, doc_label
from adash.features.designs.reads import anchor, tool_reads
from adash.features.designs.store import DESIGN_REFS_PATH, design_bases, design_refs, refs_lock
from adash.features.designs.toc import SECTION_NO
from adash.features.plans.store import ext_plans
from adash.features.sessions.config import CLAUDE_GLOB, CODEX_GLOBS
from adash.features.sessions.patterns import BRIEF_TASK
import adash.features.designs.store as designs_store


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
    with refs_lock:
        designs_store.design_rev += 1
        design_refs["refs"].update(new)
        meta = design_refs["sessions"].setdefault(src.id, {})
        meta.update({k: v for k, v in (("path", src.path), ("kind", src.kind), ("title", src.title), ("parent", src.parent),
                                       ("task", src.task), ("cwd", src.cwd)) if v})
        designs_store.design_refs_dirty = True


def note_design_stats(src):
    """Keep a transcript's count of design commands that could not be followed, for the measurement in the README."""
    if not src.stats:
        return
    with refs_lock:
        meta = design_refs["sessions"].setdefault(src.id, {})
        if meta.get("stats") != dict(src.stats):
            meta.update(stats=dict(src.stats), path=src.path, kind=src.kind)
            if src.title:
                meta["title"] = src.title
            designs_store.design_refs_dirty = True


def backfill_designs():
    """Read the transcripts of the last DESIGN_DAYS that scan_loop does not hold (older than --hours) once each, so a
    reference made before this server started is there too. Only lines that can matter are parsed."""
    since = time.time() - designs_store.DESIGN_DAYS * 86400
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
                designs_store.design_refs_dirty = True
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
    with refs_lock:
        if not designs_store.design_refs_dirty:
            return False
        body = json.dumps(design_refs, ensure_ascii=False)
        designs_store.design_refs_dirty = False
    tmp = DESIGN_REFS_PATH + ".tmp"
    with open(tmp, "w") as f:
        f.write(body)
    os.replace(tmp, DESIGN_REFS_PATH)
    return True
