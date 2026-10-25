"""Usage history endpoint (the compare tab)."""

from adash.features.history.history import history_payload


def get_history(h, url):
    h.send_json(history_payload())
