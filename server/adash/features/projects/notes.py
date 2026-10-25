"""A project's step notes and the notes they link to."""

import os
import re

from adash.core.util import short
import adash.features.projects.store as projects_store


def lite_project(p):
    """List form: the detail without each stage's steps."""
    return {**p, "stages": [{k: v for k, v in st.items() if k != "steps"} for st in p["stages"]]} if "stages" in p else p


NOTE_MAX = 1 << 20
WIKILINK = re.compile(r"\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?(?:\|[^\]\n]*)?\]\]")


def find_project(name, base=None):
    """The listed project by folder name; ?dir= picks one when the same name sits in two --projects-dir."""
    return next((e for e in projects_store.projects["list"] if e["name"] == name and base in (None, e["dir"])), None)


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
