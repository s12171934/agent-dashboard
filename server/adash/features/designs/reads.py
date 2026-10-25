"""Which design sections a tool call read."""

import collections
import json
import os
import re
import shlex

from adash.features.designs.index import design_copy, design_key
from adash.features.designs.shell_reads import (JS_CMD, READ_LINE, TOC_PATTERN, grep_regex, output_heads,
    search_reads, shell_reads)
from adash.features.designs.toc import design_toc


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
