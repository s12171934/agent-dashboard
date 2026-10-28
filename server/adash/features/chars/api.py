"""「캐릭터」 tab endpoints: start a character from an uploaded picture (an Orca agent draws and publishes it), the jobs
and how far each got, a job's picture or sheets, dropping a finished job, deleting a character for good, changing a
person's name, look and role, and redrawing one of their sheets."""

import json
import subprocess
from urllib.parse import parse_qs

from adash.core.util import short
from adash.features.chars.jobs import check_create, create, list_jobs, remove, sheet_file, unpublish
from adash.features.chars.redraw import forget, list_redraws, set_meta, start

BODY_MAX = 15 << 20  # a 10MB picture as base64 in JSON


def get_jobs(h, url):
    h.send_json({"jobs": list_jobs(), "redraws": list_redraws()})


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
    """create: {who, name, look, boss, driver, notes, agent, model, image (base64)} -> 202 {job}. remove: {id} -> {ok}
    (a job's folder). unpublish: {who} -> {ok} once the character is deleted for good (takes ~10-30 s: wrangler). meta:
    {who, name, look, boss, driver} -> {ok} once chars.json has them. redraw: {who, kind full|bust|sd, set a-d, name,
    look, boss, driver} -> 202 {redraw}, which /api/chars/jobs follows (redraws) until it is done or failed. boss and
    driver give the role (coordinator, script driver; neither: worker)."""
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
        if action == "redraw":
            b = body
            return h.send_json({"ok": True, "redraw": start(b.get("who"), b.get("kind"), b.get("set"), b.get("name"),
                                                            b.get("look") or "", b.get("boss"), b.get("driver"))}, 202)
        if action in ("unpublish", "meta"):
            try:
                if action == "meta":
                    set_meta(body.get("who"), body.get("name") or "", body.get("look") or "", body.get("boss"), body.get("driver"))
                else:
                    unpublish(body.get("who"))
                    forget(body.get("who"))
            except subprocess.TimeoutExpired:
                return h.send_json({"error": "wrangler 가 제때 끝나지 않았습니다 — 잠시 뒤 다시 확인하세요"}, 504)
            except RuntimeError as e:
                return h.send_json({"error": short(e, 300)}, 502)
            return h.send_json({"ok": True})
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
