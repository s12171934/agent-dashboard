"""Orca's hook status: which Orca pane a Claude session runs in."""

import json

from adash.features.sessions.config import HOOK_STATUS, hooks


def load_hooks():
    try:
        with open(HOOK_STATUS) as f:
            entries = json.load(f).get("entries", {})
    except (OSError, ValueError):
        return
    fresh = {}
    for e in entries.values():
        sid = (e.get("providerSession") or {}).get("id")
        payload = e.get("payload") or {}
        if sid and payload.get("state"):
            # paneKey ("<tabId>:<leafId>") names the Orca pane the session runs in; the file keeps one entry per
            # pane, so a pane later reused by another session no longer points back at this one.
            fresh[sid] = {"state": payload["state"], "mode": payload.get("workingMode"),
                          "at": (e.get("receivedAt") or 0) / 1000, "pane": e.get("paneKey")}
    hooks.clear()
    hooks.update(fresh)
