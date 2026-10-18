#!/usr/bin/env python3
"""Serve frontend/ locally with live reload, for editing the page.

    python3 scripts/dev-frontend.py [--port 5500]

- Every response is sent with no-store, so the browser always reads the file on disk.
- index.html gets a small script that polls /__reload once a second. A change to a .css file swaps the stylesheets in
  place (no reload, the view and scroll stay); any other change under frontend/ reloads the page. Polling, not a held
  stream: Chrome opens at most 6 connections per host, so one stream per tab would lock out the sixth tab.
- /ds/ serves design-system/ (the deploy copies it there).
- /sw.js is replaced by a worker that unregisters itself and drops its caches, so the PWA's offline cache never
  serves a stale file here.
- The page reads the metric server as usual (default http://127.0.0.1:8787); localhost origins need no --origin.
"""
import argparse
import functools
import json
import http.server
import os
import socketserver
import threading
import time

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'frontend'))
# The design system lives beside the page and is served under /ds/, as deploy-frontend.sh lays it out.
DS = os.path.normpath(os.path.join(ROOT, '..', 'design-system'))

RELOAD_JS = b"""<script>
// dev-frontend.py live reload: css swaps in place, anything else reloads the page.
(() => {
  let seen = null;
  const poll = async () => {
    try {
      const { stamp, files } = await (await fetch('/__reload?since=' + (seen ?? ''), { cache: 'no-store' })).json();
      if (seen !== null && files.length) {
        if (!files.every(f => f.endsWith('.css'))) return location.reload();
        document.querySelectorAll('link[rel=stylesheet]').forEach(l => {
          const u = new URL(l.href); u.searchParams.set('v', Date.now()); l.href = u.href;
        });
      }
      seen = stamp;
    } catch {}
    setTimeout(poll, 1000);
  };
  poll();
})();
</script>
"""

# Served in place of the PWA worker: unregister, drop the shell cache, and reload the pages it controlled.
DEV_SW = b"""self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil((async () => {
  for (const k of await caches.keys()) await caches.delete(k);
  await self.registration.unregister();
  for (const c of await self.clients.matchAll({ type: 'window' })) c.navigate(c.url);
})()));
"""


def snapshot():
    out = {}
    for root, prefix in ((ROOT, ''), (DS, 'ds/')):
        for d, _, files in os.walk(root):
            for f in files:
                p = os.path.join(d, f)
                try:
                    out[prefix + os.path.relpath(p, root)] = os.stat(p).st_mtime_ns
                except OSError:
                    pass
    return out


class Changes:
    """Watches frontend/ in one thread; requests ask what changed since a stamp."""

    def __init__(self):
        self.lock = threading.Lock()
        self.stamp = 0
        self.log = []  # (stamp, files)
        threading.Thread(target=self.watch, daemon=True).start()

    def watch(self):
        seen = snapshot()
        while True:
            time.sleep(0.3)
            now = snapshot()
            changed = sorted(k for k in now.keys() | seen.keys() if now.get(k) != seen.get(k))
            seen = now
            if changed:
                with self.lock:
                    self.stamp += 1
                    self.log = (self.log + [(self.stamp, changed)])[-200:]

    def since(self, stamp):
        with self.lock:
            files = sorted({f for st, fs in self.log if stamp is not None and st > stamp for f in fs})
            return self.stamp, files


CHANGES = None


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def translate_path(self, path):
        clean = path.split('?', 1)[0].split('#', 1)[0]
        if clean == '/ds' or clean.startswith('/ds/'):
            rel = os.path.normpath(clean[len('/ds'):].lstrip('/') or '.')
            if rel.startswith('..'):
                return os.path.join(DS, '__nope__')
            return os.path.join(DS, rel)
        return super().translate_path(path)

    def log_message(self, fmt, *args):
        pass

    def do_GET(self):
        path = self.path.split('?', 1)[0]
        if path == '/__reload':
            return self.reload_poll()
        if path == '/sw.js':
            return self.send_body(DEV_SW, 'text/javascript')
        if path in ('/', '/index.html'):
            return self.index()
        return super().do_GET()

    def index(self):
        with open(os.path.join(ROOT, 'index.html'), 'rb') as f:
            self.send_body(f.read().replace(b'</body>', RELOAD_JS + b'</body>'), 'text/html; charset=utf-8')

    def reload_poll(self):
        q = self.path.partition('?')[2]
        arg = dict(p.partition('=')[::2] for p in q.split('&') if p).get('since', '')
        stamp, files = CHANGES.since(int(arg) if arg.isdigit() else None)
        self.send_body(json.dumps({'stamp': stamp, 'files': files}).encode(), 'application/json')

    def send_body(self, body, ctype):
        self.send_response(200)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def handle(self):
        # a reload or a closed tab cuts requests off mid-reply; that is not an error worth a traceback
        try:
            super().handle()
        except (BrokenPipeError, ConnectionResetError):
            pass


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    # The page opens a burst of requests at once (ds.css alone imports a dozen files); the default backlog of 5
    # drops some, and a dropped @import is skipped without an error.
    request_queue_size = 128


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=5500)
    ap.add_argument('--host', default='127.0.0.1')
    a = ap.parse_args()
    global CHANGES
    CHANGES = Changes()
    srv = Server((a.host, a.port), functools.partial(Handler, directory=ROOT))
    print(f'frontend: http://{a.host}:{a.port}/  (live reload, Ctrl-C to stop)')
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
