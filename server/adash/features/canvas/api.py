"""The workflow-canvas address for the asking device (see canvas.py)."""

from adash.features.canvas.canvas import info


def _local(h):
    """Loopback and not through tailscale serve (it adds X-Forwarded-For)."""
    host = (h.headers.get("Host") or "").lower().rsplit(":", 1)[0].strip("[]")
    return host in ("127.0.0.1", "localhost", "::1") and not h.headers.get("X-Forwarded-For")


def get_info(h, url):
    h.send_json(info(_local(h)))
