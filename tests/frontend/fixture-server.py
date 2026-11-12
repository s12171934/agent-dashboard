#!/usr/bin/env python3
"""Serve synthetic UI fixtures and built production assets; no metrics service traffic."""
import sys,pathlib,http.server,functools,json
ROOT=pathlib.Path(__file__).resolve().parents[2]
class Handler(http.server.SimpleHTTPRequestHandler):
 def log_message(self,*args):pass
 def translate_path(self,path):
  clean=path.split('?',1)[0].lstrip('/')
  if clean.startswith('ds/'):return str(ROOT/'design-system'/clean[3:])
  if clean.startswith('test/'):return str(ROOT/'tests/frontend'/clean[5:])
  if clean.startswith('api/media/file'):return str(ROOT/'.tools/ui-sample.mp4')
  return str(ROOT/'frontend'/clean)
 def do_GET(self):
  path=self.path.split('?',1)[0]
  if path in ('/','/index.html','/fixture.html'):
   data=(ROOT/'frontend/index.html').read_text().replace('src="api.js"','src="test/fixture.js"').replace('<script>if(\'serviceWorker\' in navigator)', '<script>if(false)').replace('</body>','<script src="test/ui-checks.js"></script></body>').encode();return self.body(data,'text/html; charset=utf-8')
  if path=='/frame.html':return self.body(b'<!doctype html><title>Fixture editor</title><input aria-label="Editor draft"><p>Fixture embedded frame</p>','text/html')
  if path=='/sw.js':return self.body(b'', 'application/javascript')
  if path=='/chars/chars.json':return self.body(b'{"chars":{}}','application/json')
  super().do_GET()
 def body(self,data,kind):
  self.send_response(200);self.send_header('Content-Type',kind);self.send_header('Cache-Control','no-store');self.end_headers();self.wfile.write(data)
server=http.server.ThreadingHTTPServer(('127.0.0.1',int(sys.argv[1]) if len(sys.argv)>1 else 5517),Handler)
print(f'Fixture UI http://127.0.0.1:{server.server_port}/fixture.html',flush=True);server.serve_forever()
