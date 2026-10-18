// Service worker: makes the page installable (PWA) and opens it offline. Only this origin's page files go through
// it, network first: a new deployment shows at once, and the cache answers only when the network does not. The
// metric servers (other origins: /api/*, /events) and build.json, which spots new deployments, are never touched.
const CACHE = 'adash-shell-v1';
const SHELL = ['./', 'index.html', 'app.css', 'api.js', 'decision.js', 'app.js', 'manifest.webmanifest',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.endsWith('/build.json')) return;
  e.respondWith(fetch(e.request).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
    return res;
  }).catch(async () => (await caches.match(e.request, { ignoreSearch: true }))
    || (e.request.mode === 'navigate' && await caches.match('index.html')) || Response.error()));
});
