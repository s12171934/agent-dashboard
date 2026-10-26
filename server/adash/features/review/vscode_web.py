"""Web VS Code for a worktree, opened under its ticket in the review list (an iframe) before the desktop app.

One `code serve-web` for the whole machine, listening only on a unix socket in the user's private temp folder and run
without its own connection token: the token rides in a SameSite=Lax cookie and serve-web forbids framing
(X-Frame-Options, frame-ancestors), so it cannot sit inside the dashboard page as it comes. This server relays
/vscode/<secret>/… to that socket instead, dropping the framing headers. The secret is the server base path serve-web
runs under (every asset and websocket URL carries it), kept in DATA so a serve-web left from an earlier run is reused;
the relay also answers only on loopback, like 「VS Code 로 열기」. Files open read-only (Machine settings): it is for
looking at a worktree, the desktop window is for changing it.
"""

import hashlib
import html
import json
import os
import re
import secrets
import socket
import subprocess
import tempfile
import threading
import time
from urllib.parse import parse_qs

from adash.core.config import HERE
from adash.features.review.config import VSCODE_CLI

DATA = os.path.join(HERE, "vscode-web")  # serve-web's server download, extensions and settings; the secret
# gettempdir: per user, 0700. Named after DATA, whose secret the serve-web on it runs under (a second checkout's server
# must not reuse it).
SOCK = os.path.join(tempfile.gettempdir(), f"adash-vscode-web-{hashlib.sha1(DATA.encode()).hexdigest()[:10]}.sock")
PREFIX = "/vscode/"
SETTINGS = {"files.readonlyInclude": {"**": True}, "workbench.startupEditor": "none", "chat.disableAIFeatures": True,
            "workbench.secondarySideBar.defaultVisibility": "hidden"}
# Defaults the workbench page itself carries (configurationDefaults): application-scoped settings, which Machine settings
# on the server cannot set. No workspace trust, so a worktree opens trusted and Source Control shows without asking.
DEFAULTS = {"security.workspace.trust.enabled": False}
# ?theme=light|dark on the workbench page: the dashboard's theme, as the default colour theme of that page (the page asks
# again when the dashboard's theme changes). A theme the user picked inside VS Code still wins.
THEMES = {"light": "Default Light Modern", "dark": "Default Dark Modern"}
_start = threading.Lock()
_proc = None


def local(h):
    """Loopback only and not through tailscale serve (it adds X-Forwarded-For): the Mac the worktrees are on."""
    host = (h.headers.get("Host") or "").lower().rsplit(":", 1)[0].strip("[]")
    return host in ("127.0.0.1", "localhost", "::1") and not h.headers.get("X-Forwarded-For")


def base():
    os.makedirs(DATA, mode=0o700, exist_ok=True)
    p = os.path.join(DATA, "secret")
    try:
        with open(p) as f:
            s = f.read().strip()
        if re.fullmatch(r"[A-Za-z0-9_-]{20,}", s):
            return PREFIX + s
    except OSError:
        pass
    s = secrets.token_urlsafe(24)
    fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(s)
    return PREFIX + s


def _alive():
    try:
        with socket.socket(socket.AF_UNIX) as s:
            s.settimeout(2)
            s.connect(SOCK)
        return True
    except OSError:
        return False


def ensure():
    """Start serve-web unless one already answers on SOCK. Returns an error message, or None when it is up."""
    global _proc
    with _start:
        if _alive():
            return None
        if not os.path.exists(VSCODE_CLI):
            return "VS Code 가 설치돼 있지 않습니다 (" + VSCODE_CLI + ")"
        b = base()
        mdir = os.path.join(DATA, "data", "Machine")
        os.makedirs(mdir, exist_ok=True)
        try:
            with open(os.path.join(mdir, "settings.json")) as f:
                cur = json.load(f)
        except (OSError, ValueError):
            cur = {}
        with open(os.path.join(mdir, "settings.json"), "w") as f:
            json.dump({**cur, **SETTINGS}, f, indent=2)
        try:
            os.unlink(SOCK)
        except OSError:
            pass
        log = open(os.path.join(DATA, "serve-web.log"), "ab")
        _proc = subprocess.Popen([VSCODE_CLI, "serve-web", "--socket-path", SOCK, "--without-connection-token",
                                  "--accept-server-license-terms", "--server-base-path", b, "--server-data-dir", DATA,
                                  "--disable-telemetry"], stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                                 # a closed panel's extension host goes after 5 minutes, not the default 3 hours
                                 env={**os.environ, "VSCODE_RECONNECTION_GRACE_TIME": "300000"},
                                 start_new_session=True)  # outlives this server; the next one reuses it
        log.close()
        end = time.time() + 90  # the first start downloads the server build
        while time.time() < end:
            if _alive():
                return None
            if _proc.poll() is not None:
                return f"serve-web 이 종료됨 (코드 {_proc.returncode}) — {os.path.join(DATA, 'serve-web.log')}"
            time.sleep(0.5)
        return "serve-web 이 90초 안에 뜨지 않았습니다"


def url_for(path):
    return base() + "/?folder=" + path


def _dechunk(body):
    out = b""
    while body:
        size, _, body = body.partition(b"\r\n")
        n = int(size.split(b";")[0] or b"0", 16)
        if not n:
            break
        out += body[:n]
        body = body[n + 2:]
    return out


def _workbench(head, body, theme):
    """The workbench page with DEFAULTS (and the colour theme, when given) as configurationDefaults, sent with a
    Content-Length."""
    lines = head.split("\r\n")
    chunked = any(ln.lower().replace(" ", "") == "transfer-encoding:chunked" for ln in lines[1:])
    page = (_dechunk(body) if chunked else body).decode("utf-8")

    def put(m):
        cfg = json.loads(html.unescape(m.group(2)))
        themed = {"workbench.colorTheme": THEMES[theme], "window.autoDetectColorScheme": False} if theme else {}
        cfg["configurationDefaults"] = {**cfg.get("configurationDefaults", {}), **DEFAULTS, **themed}
        return m.group(1) + html.escape(json.dumps(cfg), quote=True) + '"'
    page = re.sub(r'(id="vscode-workbench-web-configuration" data-settings=")([^"]*)"', put, page, count=1).encode()
    lines = [ln for ln in lines if ln.split(":", 1)[0].strip().lower() not in ("transfer-encoding", "content-length")]
    return "\r\n".join(lines + [f"Content-Length: {len(page)}"]), page


# Accept-Language goes as English: serve-web picks the display language from it, and a Korean browser got a language
# pack built for an older VS Code that showed wrong strings.
_DROP_REQ = {"connection", "keep-alive", "proxy-connection", "te", "trailer", "upgrade", "accept-language"}


def _head(sock):
    buf = b""
    while b"\r\n\r\n" not in buf:
        chunk = sock.recv(65536)
        if not chunk:
            break
        buf += chunk
        if len(buf) > 1 << 20:
            raise OSError("response head too large")
    head, _, rest = buf.partition(b"\r\n\r\n")
    return head.decode("latin-1"), rest


def _frameable(head):
    """The response head with framing allowed: no X-Frame-Options, no CSP frame-ancestors, and cookies that a
    cross-site frame still sends (SameSite=None needs Secure; loopback http counts as secure)."""
    lines = head.split("\r\n")
    out = [lines[0]]
    for ln in lines[1:]:
        k, _, v = ln.partition(":")
        name = k.strip().lower()
        if name == "x-frame-options":
            continue
        if name == "content-security-policy":
            v = ";".join(d for d in v.split(";") if not d.strip().lower().startswith("frame-ancestors"))
            if not v.strip(" ;"):
                continue
        elif name == "set-cookie":
            v = re.sub(r";\s*SameSite=\w+", "", v, flags=re.I) + "; SameSite=None; Secure; Partitioned"
        out.append(f"{k}:{v}")
    return "\r\n".join(out) + "\r\n\r\n"


def _pipe(src_read, dst):
    try:
        while True:
            chunk = src_read(65536)
            if not chunk:
                break
            dst.sendall(chunk)
    except OSError:
        pass
    try:
        dst.shutdown(socket.SHUT_WR)
    except OSError:
        pass


def proxy(h, url):
    """Relay one request (or a websocket) under the secret base to serve-web, raw, then close the connection."""
    h.close_connection = True
    if not local(h):
        return h.send_json({"error": "웹 VS Code 는 이 맥에서 연 화면에서만 됩니다"}, 403)
    b = base()
    if url.path != b and not url.path.startswith(b + "/"):
        return h.send_json({"error": "not found"}, 404)
    try:
        up = socket.socket(socket.AF_UNIX)
        up.connect(SOCK)
    except OSError:
        return h.send_json({"error": "웹 VS Code 가 떠 있지 않습니다. 대시보드에서 다시 여세요"}, 502)
    with up:
        ws = h.headers.get("Upgrade", "").lower() == "websocket"
        page = h.command == "GET" and url.path in (b, b + "/")
        theme = page and (parse_qs(url.query).get("theme") or [""])[0]
        theme = theme if theme in THEMES else None
        lines = [f"{h.command} {h.path} HTTP/1.1"]
        lines += [f"{k}: {v}" for k, v in h.headers.items()
                  if k.lower() not in _DROP_REQ and not (page and k.lower() == "accept-encoding")]
        lines += ["Accept-Language: en"] + (["Connection: Upgrade", "Upgrade: websocket"] if ws else ["Connection: close"])
        up.sendall(("\r\n".join(lines) + "\r\n\r\n").encode("latin-1"))
        n = int(h.headers.get("Content-Length") or 0)
        while n > 0:
            chunk = h.rfile.read(min(n, 65536))
            if not chunk:
                break
            up.sendall(chunk)
            n -= len(chunk)
        try:
            head, rest = _head(up)
        except OSError:
            return
        if page and head.startswith("HTTP/1.1 200"):
            while chunk := up.recv(65536):
                rest += chunk
            head, rest = _workbench(head, rest, theme)
        h.connection.sendall(_frameable(head).encode("latin-1") + rest)
        if ws:
            t = threading.Thread(target=_pipe, args=(h.rfile.read1, up), daemon=True)
            t.start()
        _pipe(up.recv, h.connection)
        if ws:
            t.join(timeout=5)
