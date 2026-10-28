"""Worktree list endpoints: every local worktree, opened in the desktop VS Code or the web one."""

import json
import os
import subprocess
from urllib.parse import parse_qs

from adash.core.util import short
from adash.features.review import vscode_web
from adash.features.review.config import VSCODE_CLI
from adash.features.worktrees.worktrees import known, worktrees


def get_worktrees(h, url):
    """{repos[{name, path, error, worktrees[{path, name, comment, branch, head, main, orca, detached, locked, prunable,
    bare, missing, dirty, committed, subject}]}], at}; ?fresh=1 skips the short cache."""
    try:
        h.send_json(worktrees(fresh=parse_qs(url.query).get("fresh") == ["1"]))
    except Exception as e:
        h.send_json({"error": "워크트리 목록을 읽지 못했습니다: " + short(e, 200)}, 502)


def post_worktree(h, url):
    """{"path"} of a listed worktree -> open: a desktop VS Code window on it (an open window on that folder comes to the
    front). web: {"url"} of the web VS Code on it, relative to this server. Both only from this Mac's loopback, like the
    review tab's."""
    action = url.path.rsplit("/", 1)[1]
    try:
        body = json.loads(h.rfile.read(min(int(h.headers.get("Content-Length") or 0), 65536)))
        path = body["path"]
        assert isinstance(path, str)
    except (ValueError, KeyError, AssertionError, TypeError):
        return h.send_json({"error": "bad request"}, 400)
    if not vscode_web.local(h):
        return h.send_json({"error": "VS Code 열기는 이 맥에서 연 화면에서만 됩니다"}, 403)
    w = known(path)
    if not w:
        return h.send_json({"error": "목록에 없는 워크트리입니다"}, 404)
    if w["missing"] or w["bare"]:
        return h.send_json({"error": "디스크에 없는 워크트리입니다"}, 409)
    if action == "web":
        err = vscode_web.ensure()
        if err:
            return h.send_json({"error": err}, 502)
        return h.send_json({"url": vscode_web.url_for(path)})
    cmd = [VSCODE_CLI, path] if os.path.exists(VSCODE_CLI) else ["open", "-a", "Visual Studio Code", path]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
    if r.returncode:
        return h.send_json({"error": "VS Code 로 열지 못함: " + short(r.stderr, 200)}, 502)
    h.send_json({"ok": True})
