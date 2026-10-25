"""The design document index across folders and worktrees."""

import os

from adash.core.state import bump, lock
from adash.features.designs.roots import design_roots, repo_info
from adash.features.designs.store import DESIGN_KINDS, design_bases
from adash.features.designs.toc import design_h1, design_nav, nav_title
import adash.features.designs.store as designs_store


def scan_designs():
    """One pass over the design folders; rebinds `design` (and bumps) only when a document or a source changed."""
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
    if sources != designs_store.design["sources"] or docs != designs_store.design["docs"]:
        designs_store.design = {"version": designs_store.design["version"] + 1, "sources": sources, "docs": docs}
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
    e = designs_store.design["docs"].get(key) or {}
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
    e = designs_store.design["docs"].get(key)
    return e and e["copies"][0]
