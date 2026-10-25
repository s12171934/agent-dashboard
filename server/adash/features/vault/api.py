"""Vault note endpoint."""

from urllib.parse import parse_qs

from adash.features.vault.vault import vault_recent


def get_recent(h, url):
    h.send_json(vault_recent(max(1, min(50, int((parse_qs(url.query).get("limit") or ["10"])[0] or 10)))))
