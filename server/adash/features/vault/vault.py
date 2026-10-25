"""Vault notes tied to the session that created them and to project steps."""

import os
import re
import time

from adash.core.state import lock, loop_failed, loop_ok, sessions
from adash.features.projects.notes import NOTE_MAX, WIKILINK
import adash.core.config as core_config
import adash.features.projects.store as projects_store


# ---- 볼트 노트: the notes each session created, by the `agent/<tool>-<session id>` tag in their frontmatter ----
# The vault's note rule puts exactly one such tag on every note, naming the session that first made it. Every .md
# under VAULT is stat'ed each pass and its head re-read only when its mtime moved. A note is tied to the project steps
# whose step note links to it (or that it is), so a session's page can say which step its documents belong to.
VAULT_EVERY = 5
VAULT_HEAD = 8192  # frontmatter sits at the top; no need to read whole notes
AGENT_TAG = re.compile(r"(?<![\w/])agent/(claude|codex)-([0-9A-Za-z][\w-]*)")
vault_cache = {}  # vault-relative path -> (mtime, {title, created, updated, agent})
step_links_cache = {}  # step note absolute path -> (mtime, [wikilink targets])
vault = {"on": False, "notes": {}, "by_agent": {}, "steps": {}}  # rebound whole, so readers need no lock


def note_head(full):
    """-> {title, created, updated, agent} from a note's frontmatter; agent is "<tool>-<id>" or None."""
    try:
        with open(full, encoding="utf-8", errors="replace") as f:
            head = f.read(VAULT_HEAD)
    except OSError:
        return None
    m = re.match(r"---\n(.*?)\n---", head, re.S)
    fm = m.group(1) if m else ""
    field = lambda k: (re.search(rf"^{k}:\s*(.+?)\s*$", fm, re.M) or [None, None])[1]
    tag = AGENT_TAG.search(fm)
    return {"title": (field("title") or "").strip("'\"") or os.path.splitext(os.path.basename(full))[0],
            "created": field("created"), "updated": field("updated"), "agent": tag and f"{tag[1]}-{tag[2]}"}


def resolve_link(target, rels, by_name):
    """[[target]] -> the vault-relative path Obsidian would open, or None: a path matches by suffix (the longest
    match wins), a bare name by file name."""
    want = target if target.endswith(".md") else target + ".md"
    if "/" in want:
        hit = [r for r in rels if ("/" + r).endswith("/" + want)]
        return min(hit, key=len) if hit else None
    hit = by_name.get(want)
    return min(hit, key=len) if hit else None


def scan_vault():
    seen = {}
    for d, subdirs, files in os.walk(core_config.VAULT):
        subdirs[:] = [s for s in subdirs if not s.startswith(".") and s != "node_modules"]
        for f in files:
            if not f.endswith(".md"):
                continue
            full = os.path.join(d, f)
            try:
                mtime = os.path.getmtime(full)
            except OSError:
                continue
            rel = os.path.relpath(full, core_config.VAULT)
            cached = vault_cache.get(rel)
            if not cached or cached[0] != mtime:
                head = note_head(full)
                if head is None:
                    continue
                cached = vault_cache[rel] = (mtime, head)
            seen[rel] = {**cached[1], "mtime": mtime}
    for rel in [r for r in vault_cache if r not in seen]:
        vault_cache.pop(rel)
    by_name = {}
    for rel in seen:
        by_name.setdefault(os.path.basename(rel), []).append(rel)
    # Project steps: a step note itself, and every note its [[links]] reach, belong to that step.
    steps = {}
    step_rels = {os.path.relpath(os.path.join(os.path.dirname(p["path"]), sp["path"]), core_config.VAULT)
                 for p in projects_store.projects["list"] for st in p.get("stages") or [] for sp in st["steps"]}
    for p in projects_store.projects["list"]:
        root = os.path.dirname(p["path"])
        proj = os.path.relpath(root, core_config.VAULT) + "/"
        for st in p.get("stages") or []:
            for sp in st["steps"]:
                full = os.path.join(root, sp["path"])
                rel = os.path.relpath(full, core_config.VAULT)
                if rel.startswith(".."):
                    continue  # a --projects-dir outside the vault
                try:
                    mtime = os.path.getmtime(full)
                except OSError:
                    continue
                cached = step_links_cache.get(full)
                if not cached or cached[0] != mtime:
                    try:
                        with open(full, encoding="utf-8", errors="replace") as f:
                            targets = list(dict.fromkeys(m.strip() for m in WIKILINK.findall(f.read(NOTE_MAX))))
                    except OSError:
                        targets = []
                    cached = step_links_cache[full] = (mtime, targets)
                ref = {"project": p["name"], "dir": p["dir"], "path": sp["path"], "title": sp["title"],
                       "status": sp["status"], "no": st["no"], "stage": st["name"]}
                # Its documents are the notes in the same project folder it links to; up-links (_index hubs), rule
                # notes and other steps it mentions are not, nor anything outside the project (CHANGE_LOG etc.).
                hits = [h for h in (resolve_link(t, seen, by_name) for t in cached[1]) if h and h not in step_rels and
                        h.startswith(proj) and os.path.basename(h) != "_index.md" and "/rules/" not in "/" + h]
                for hit in [rel, *hits]:
                    if ref not in steps.setdefault(hit, []):
                        steps[hit].append(ref)
    by_agent = {}
    for rel, n in seen.items():
        if n["agent"]:
            by_agent.setdefault(n["agent"], []).append(rel)
    global vault
    vault = {"on": True, "notes": seen, "by_agent": by_agent, "steps": steps}


def vault_notes(s):
    """The notes this session created, newest first, each with the project steps it belongs to."""
    v = vault
    rels = v["by_agent"].get(f"{s.kind}-{s.id}", [])
    out = [{"path": rel, "abs": os.path.join(core_config.VAULT, rel), **v["notes"][rel], "steps": v["steps"].get(rel, [])}
           for rel in rels if rel in v["notes"]]
    return sorted(out, key=lambda n: n["mtime"], reverse=True)


def vault_recent(limit):
    """GET /api/vault/recent: the notes agent sessions made (their agent/ tag), newest first, each with the live session
    that made it when this server holds it — the home tab's 「최근 볼트 문서」."""
    v = vault
    with lock:
        by_tag = {f"{x.kind}-{x.id}": x for x in sessions.values()}
    out = []
    for rel, n in sorted(((r, n) for r, n in v["notes"].items() if n["agent"]), key=lambda e: e[1]["mtime"], reverse=True)[:limit]:
        x = by_tag.get(n["agent"])
        out.append({"path": rel, "abs": os.path.join(core_config.VAULT, rel), "title": n["title"], "mtime": n["mtime"], "agent": n["agent"],
                    "session": x.path if x else None, "session_title": x.title if x else None})
    return {"on": v["on"], "notes": out}


def vault_loop():
    while True:
        try:
            scan_vault()
            loop_ok("vault")
        except Exception as e:
            loop_failed("vault", e)
        time.sleep(VAULT_EVERY)
