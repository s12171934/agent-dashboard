"""The HTTP handler: host and origin checks, CORS, JSON bodies, and routing to the feature endpoints (routes.py)."""

import gzip
import json
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse

from adash.http.routes import GET, POST, PREFIXES
from adash.http.security import host_allowed, origin_allowed


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    # Encode under `lock` (the snapshot shares dicts the collector threads mutate), then send outside it:
    # writing a multi-MB body to a slow remote client used to hold the lock and stall every collector.
    @staticmethod
    def encode(obj):
        return json.dumps(obj, ensure_ascii=False, default=str).encode()

    def send_json(self, obj, status=200):
        self.send_body(obj if isinstance(obj, bytes) else self.encode(obj), status)

    def send_body(self, body, status=200, gz=None):
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        if len(body) > 1024 and "gzip" in self.headers.get("Accept-Encoding", ""):
            body = gz or gzip.compress(body, 5)
            self.send_header("Content-Encoding", "gzip")
            self.send_header("Vary", "Accept-Encoding")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def authorized(self, url):
        self.cors = None
        if not host_allowed(self.headers.get("Host")):
            self.send_json({"error": "unknown host"}, 403)
            return False
        origin = self.headers.get("Origin")
        if origin is None:  # not a cross-origin browser request (curl, a page opened on this address)
            return True
        if not origin_allowed(origin):
            self.send_json({"error": "origin not allowed"}, 403)
            return False
        self.cors = origin
        return True

    def end_headers(self):
        if getattr(self, "cors", None):
            self.send_header("Access-Control-Allow-Origin", self.cors)
            self.send_header("Vary", "Origin")
        super().end_headers()

    def do_OPTIONS(self):
        """CORS preflight for the JSON POSTs; Chrome's local network access check rides on the same request."""
        if not self.authorized(urlparse(self.path)):
            return
        self.send_response(204)
        if self.cors:
            self.send_header("Access-Control-Allow-Methods", "GET, POST")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Max-Age", "600")
            if self.headers.get("Access-Control-Request-Private-Network") == "true":
                self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Content-Length", "0")
        self.end_headers()

    @staticmethod
    def prefixed(url):
        return next((f for p, f in PREFIXES.items() if url.path.startswith(p)), None)

    def do_GET(self):
        url = urlparse(self.path)
        if not self.authorized(url):
            return
        route = GET.get(url.path) or self.prefixed(url)
        if not route:
            return self.send_json({"error": "not found"}, 404)
        route(self, url)

    def do_POST(self):
        url = urlparse(self.path)
        if not self.authorized(url):
            return
        route = self.prefixed(url)
        if route:
            return route(self, url)
        # JSON only: a cross-site form cannot send this content type without a CORS preflight, which authorized()
        # already limits to --origin.
        route = POST.get(url.path)
        if not route or not self.headers.get("Content-Type", "").startswith("application/json"):
            return self.send_json({"error": "bad request"}, 400)
        route(self, url)
