"""Design documents for the API: the list, one document with its reads, its files."""

import os
import subprocess

from adash.core.state import lock, sessions
from adash.core.util import short
from adash.features.designs.index import design_copy, doc_label
from adash.features.designs.refs import design_commit_for, plan_tickets, row_key
from adash.features.designs.roots import git_cached
from adash.features.designs.shell_reads import to_ranges
from adash.features.designs.store import DESIGN_DIRS, DESIGN_FILE_MAX, DESIGN_TYPES, design_refs, refs_lock
from adash.features.designs.toc import SECTION_NO, design_toc
from adash.features.plans.store import ext_plans
import adash.features.designs.store as designs_store


def design_list():
    """GET /api/designs: the sources, and each document with how many sessions read it."""
    d = designs_store.design
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
    e = designs_store.design["docs"].get(key)
    if not e:
        return {"error": "not found"}, 404
    c = e["copies"][0]
    src = designs_store.design["sources"][c["src"]]
    out = {"key": key, **doc_label(key), "kind": e["kind"], "mtime": c["mtime"], "size": c["size"], "source": src,
           "copies": [{**designs_store.design["sources"][x["src"]], "mtime": x["mtime"]} for x in e["copies"]]}
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
    e = designs_store.design["docs"].get(key)
    if not e or e["kind"] == "md":
        return None, 404
    c = e["copies"][0]
    root = os.path.realpath(designs_store.design["sources"][c["src"]]["dir"])
    full = os.path.realpath(c["abs"])
    if not full.startswith(root + os.sep) or not os.path.isfile(full):
        return None, 404
    if os.path.getsize(full) > DESIGN_FILE_MAX:
        return None, 413
    with open(full, "rb") as f:
        return (f.read(), DESIGN_TYPES[os.path.splitext(full)[1].lower()]), 200


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
