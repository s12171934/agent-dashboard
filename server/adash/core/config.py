"""Paths every part of the server shares. VAULT is rebound by main() from --vault."""

import os

HOME = os.path.expanduser("~")
# server/: server.py, the package and the CLIs (aqa, ausage, adata) live here
HERE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
VAULT = os.path.join(HOME, "Obsidian/obsidian")


def data_dir():
    """The folder that holds the server's state (prefs.json, histories, caches, server.log): $ADASH_DATA, else
    server/data, else server/ itself — where every file lived before the data folder (`adata migrate` moves them)."""
    env = os.environ.get("ADASH_DATA")
    if env:
        return os.path.abspath(os.path.expanduser(env))
    d = os.path.join(HERE, "data")
    return d if os.path.isdir(d) else HERE


# Read once at import: every module joins its file onto DATA at import time, so set ADASH_DATA before starting.
DATA = data_dir()

# What lives in DATA, for `adata` (export · import · migrate). Kept here so a new file is listed next to its peers.
# state: carried to another machine. cache: rebuilt from transcripts/APIs, and keyed by this machine's paths.
# local: belongs to this machine only (log, VS Code download and its secret) and is never carried.
DATA_FILES = {
    "prefs.json": "state",          # settings, chars, flow_ok, decision_inbox (core/prefs)
    "settled.json": "state",        # Orca runs marked settled (orca_runs)
    "pending.json": "state",        # decision cards waiting for an answer (decisions)
    "inbox.json": "state",          # decision inbox mode's queued questions (decisions)
    "decision.log": "state",        # answered decisions (decisions)
    "plan-history.json": "state",   # external plans (plans)
    "test-history.json": "state",   # finished test runs (tests)
    "design-refs.json": "state",    # design sections each session read (designs)
    "media.json": "state",          # published recordings (media)
    "qa-sheets.json": "state",      # TC sheet progress written by aqa (review)
    "review-gone.json": "state",    # worktrees gone from review (review)
    "worktree-notes.json": "state", # worktree notes (worktrees)
    "usage.jsonl": "state",         # page usage events (usage)
    "pricing.json": "state",        # price overrides (sessions)
    "history-cache.json": "cache",  # 7-day usage history, keyed by transcript path (history)
    "plan-usage.json": "cache",     # plan usage buckets (plan_usage)
    "server.log": "local",          # launchd stdout/stderr
    "vscode-web": "local",          # serve-web download, extensions, settings and the relay secret (review)
    ".token": "local",              # legacy
}
