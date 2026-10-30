"""Inter-agent message endpoint."""

import gzip
from urllib.parse import parse_qs

from adash.core.files import StaleWhileRefresh
from adash.features.interactions.interactions import INBOX_TTL, inbox_cache, interactions


def get_interactions(h, url):
    q = parse_qs(url.query)
    limit = max(50, min(5000, int((q.get("limit") or ["1500"])[0] or 1500)))
    hb = (q.get("hb") or ["0"])[0] == "1"
    key = (limit, hb)
    if key not in inbox_cache:  # one per view (limit, heartbeats), each gzipped once per compute
        inbox_cache[key] = StaleWhileRefresh("interactions", lambda: gz_body(h.encode(interactions(limit, hb))), INBOX_TTL)
    try:
        raw, gz = inbox_cache[key].get()
    except Exception as e:  # orca not running, CLI changed, etc.
        return h.send_json({"error": str(e)}, 502)
    h.send_body(raw, gz=gz)


def gz_body(raw):
    return raw, gzip.compress(raw, 5)
