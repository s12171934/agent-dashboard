"""Published recordings: the list, and the video file with byte ranges (iOS plays and seeks a video only with them)."""

import os
import re
from urllib.parse import parse_qs

from adash.features.media.media import media_list, resolve

CHUNK = 256 * 1024
RANGE = re.compile(r"bytes=(\d*)-(\d*)$")


def get_list(h, url):
    h.send_json(media_list())


def get_file(h, url):
    full = resolve((parse_qs(url.query).get("path") or [""])[0])
    if not full:
        return h.send_json({"error": "not found"}, 404)
    size = os.path.getsize(full)
    start, end, status = 0, size - 1, 200
    want = h.headers.get("Range")
    if want:
        m = RANGE.match(want.strip())
        if m and (m[1] or m[2]):
            if m[1]:
                start, end = int(m[1]), min(int(m[2]), size - 1) if m[2] else size - 1
            else:  # bytes=-N: the last N bytes
                start = max(0, size - int(m[2]))
            status = 206
        if not m or not (m[1] or m[2]) or start > end:
            h.send_response(416)
            h.send_header("Content-Range", f"bytes */{size}")
            h.send_header("Content-Length", "0")
            h.end_headers()
            return
    h.send_response(status)
    h.send_header("Content-Type", "video/mp4")
    h.send_header("Accept-Ranges", "bytes")
    h.send_header("Content-Length", str(end - start + 1))
    if status == 206:
        h.send_header("Content-Range", f"bytes {start}-{end}/{size}")
    h.send_header("Cache-Control", "private, max-age=3600")
    h.send_header("X-Content-Type-Options", "nosniff")
    h.end_headers()
    left = end - start + 1
    try:
        with open(full, "rb") as f:
            f.seek(start)
            while left > 0:
                b = f.read(min(CHUNK, left))
                if not b:
                    break
                h.wfile.write(b)
                left -= len(b)
    except (BrokenPipeError, ConnectionResetError):  # the player dropped this range to ask for another
        pass
