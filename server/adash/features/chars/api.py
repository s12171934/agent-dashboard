"""「캐릭터」 tab endpoints: start a character from an uploaded picture (an Orca agent draws and publishes it), the jobs
and how far each got, a job's picture or sheets, and dropping a finished job."""

import json
from urllib.parse import parse_qs

from adash.core.util import short
from adash.features.chars.jobs import check_create, create, list_jobs, remove, sheet_file

BODY_MAX = 15 << 20  # a 10MB picture as base64 in JSON


def get_jobs(h, url):
    h.send_json({"jobs": list_jobs()})


def get_file(h, url):
    q = parse_qs(url.query)
    got = sheet_file((q.get("job") or [""])[0], (q.get("f") or [""])[0])
    if not got:
        return h.send_json({"error": "not found"}, 404)
    h.send_response(200)
    h.send_header("Content-Type", got[1])
    h.send_header("Content-Length", str(len(got[0])))
    h.send_header("Cache-Control", "no-cache")
    h.send_header("X-Content-Type-Options", "nosniff")
    h.end_headers()
    h.wfile.write(got[0])


def post_char(h, url):
    """create: {who, name, look, boss, notes, agent, model, image (base64)} -> 202 {job}. remove: {id} -> {ok}."""
    action = url.path.rsplit("/", 1)[1]
    try:
        n = int(h.headers.get("Content-Length") or 0)
        if n > BODY_MAX:
            return h.send_json({"error": "원본 그림은 10MB 까지입니다"}, 413)
        body = json.loads(h.rfile.read(n))
        if not isinstance(body, dict):
            raise ValueError
        if action == "remove":
            return h.send_json({"ok": remove(body.get("id") or "")})
        args = check_create(body)
    except ValueError as e:
        return h.send_json({"error": str(e) or "잘못된 요청입니다"}, 400)
    except (KeyError, TypeError, AttributeError):
        return h.send_json({"error": "잘못된 요청입니다"}, 400)
    try:
        job = create(*args)
    except ValueError as e:
        return h.send_json({"error": str(e)}, 400)
    except Exception as e:
        return h.send_json({"error": "작업을 시작하지 못했습니다: " + short(e, 200)}, 502)
    h.send_json({"ok": True, "job": job}, 202)
