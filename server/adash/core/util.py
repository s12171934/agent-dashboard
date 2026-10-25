"""Small text and time helpers."""

from datetime import datetime


def short(text, n=280):
    text = " ".join(str(text).split())
    return text if len(text) <= n else text[: n - 1] + "…"


def epoch(ts):
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()
    except (AttributeError, ValueError):
        return 0
