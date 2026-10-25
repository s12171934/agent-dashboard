"""Design document settings, the index and the read references."""

import json
import os
import threading

from adash.core.config import HERE


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
