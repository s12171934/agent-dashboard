"""Test run endpoints."""

from adash.core.state import lock
from adash.features.tests.tests import finished_key, test_history, test_progress


def get_tests(h, url):
    with lock:
        body = h.encode({"runs": sorted(({**r, "id": k} for k, r in test_history.items()),
                                        key=finished_key, reverse=True),
                         "at": test_progress["history_at"]})
    h.send_body(body)
