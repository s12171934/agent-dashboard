"""Design document titles, navigation order and section tables of contents."""

import collections
import os
import re


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
