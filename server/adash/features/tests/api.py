"""Test run endpoints."""

from urllib.parse import parse_qs

from adash.core.state import lock
from adash.features.tests.tests import finished_key, test_history, test_progress


def get_tests(h, url):
    with lock:
        body = h.encode({"runs": sorted(({**r, "id": k} for k, r in test_history.items()),
                                        key=finished_key, reverse=True),
                         "at": test_progress["history_at"]})
    h.send_body(body)


def get_run(h, url):
    """?id=<test_history key> -> that kept run ({..., "id", "cases"}), for a finished run's case toggle; 404 when unknown."""
    rid = (parse_qs(url.query).get("id") or [""])[0]
    with lock:
        r = test_history.get(rid)
        body = r and h.encode({**r, "id": rid})
    if not body:
        return h.send_json({"error": "보관된 실행이 없습니다"}, 404)
    h.send_body(body)
