"""Inter-agent message endpoint."""

import time
from urllib.parse import parse_qs

from adash.features.interactions.interactions import INBOX_TTL, inbox_cache, interactions


def get_interactions(h, url):
    q = parse_qs(url.query)
    limit = max(50, min(5000, int((q.get("limit") or ["1500"])[0] or 1500)))
    hb = (q.get("hb") or ["0"])[0] == "1"
    key = (limit, hb)
    try:
        if inbox_cache["key"] != key or time.time() - inbox_cache["at"] > INBOX_TTL:
            inbox_cache.update(key=key, body=h.encode(interactions(limit, hb)), at=time.time())
    except Exception as e:  # orca not running, CLI changed, etc.
        return h.send_json({"error": str(e)}, 502)
    h.send_body(inbox_cache["body"])
