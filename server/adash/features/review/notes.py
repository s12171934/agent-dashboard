"""Review marks in the vault step notes' frontmatter."""

import glob
import json
import os
import re
from datetime import datetime

from adash.features.review.config import WT_KEY
import adash.core.config as core_config


def note_review(path):
    """Step note frontmatter: {status, review, review_sha {repo: sha}, review_at, review_round}."""
    out = {"status": None, "review": None, "review_sha": {}, "review_at": None, "review_round": None}
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
        elif k in ("status", "review", "review_at", "review_round"):
            out[k] = v.strip() or None
    return out


def write_review(path, shas, rnd=None):
    """Replace the review fields of a step note's frontmatter; shas None clears them. rnd: the driver's round the
    review saw. The note's `updated` stays: a review mark is state, not a change to what the note says."""
    with open(path, encoding="utf-8") as f:
        text = f.read()
    m = re.match(r"---\n(.*?)\n---\n", text, re.S)
    if not m:
        raise ValueError("frontmatter 없음")
    keep, skip = [], False
    for ln in m.group(1).split("\n"):
        if skip and ln[:1] in (" ", "\t"):
            continue
        skip = bool(re.match(r"(review|review_sha|review_at|review_round):", ln))
        if not skip:
            keep.append(ln)
    if shas is not None:
        # quoted: an all-digit short sha would otherwise read back as a YAML number
        keep += ["review: done", "review_sha:", *[f'  {r}: "{s}"' for r, s in sorted(shas.items())],
                 f"review_at: {datetime.now().date().isoformat()}", *([f"review_round: {rnd}"] if rnd else [])]
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write("---\n" + "\n".join(keep) + "\n---\n" + text[m.end():])
    os.replace(tmp, path)


def reopened_since(fm, qa, path):
    """The driver started a later round than the one the review saw. A review without review_round (written before
    it was recorded) is stale when review_at's date is before the latest round's start, or the same day and the
    step note has not been written since that start (a review rewrites the note, so it cannot predate its mtime)."""
    if not qa or qa.get("round", 0) < 2:
        return False
    rr = fm.get("review_round")
    if rr and rr.isdigit():
        return qa["round"] > int(rr)
    started, at = (qa.get("at") or {}).get("selected"), fm.get("review_at")
    if not (started and at) or at > started[:10]:
        return False
    try:
        return at < started[:10] or datetime.fromtimestamp(os.path.getmtime(path)).isoformat(" ") < started
    except OSError:
        return True


def write_review_sha(path, shas):
    """Replace only review_sha in a step note's frontmatter (review, review_at, review_round stay)."""
    with open(path, encoding="utf-8") as f:
        text = f.read()
    m = re.match(r"---\n(.*?)\n---\n", text, re.S)
    if not m:
        raise ValueError("frontmatter 없음")
    out, skip = [], False
    for ln in m.group(1).split("\n"):
        if skip and ln[:1] in (" ", "\t"):
            continue
        skip = ln.startswith("review_sha:")
        if skip:
            out += ["review_sha:", *[f'  {r}: "{sh}"' for r, sh in sorted(shas.items())]]
        else:
            out.append(ln)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write("---\n" + "\n".join(out) + "\n---\n" + text[m.end():])
    os.replace(tmp, path)


def project_notes(project, prefix):
    """key -> {step: abs path, notes: [abs paths of the ticket's other notes]} for a vault project folder. Note names
    carry the project's own key first ("PRJ-1 7.52 QA-12 …"), so only keys with the set's prefix count."""
    pdir = os.path.join(core_config.VAULT, project)
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
