/*
 * EverythingApp service worker (Phase 6 — installable PWA).
 *
 * - App shell: navigations are network-first (fresh deploys win), falling back to the cached shell offline.
 * - Hashed build assets (/assets/*) are cache-first — their names change on every build.
 * - Never touches /api, /internal, SSE streams or the live-view proxy: those carry the auth token and
 *   live data, and must always hit the server.
 */
const CACHE = 'ea-shell-v1';
const SHELL = ['/', '/index.html', '/manifest.json', '/favicon.svg'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/internal') || url.pathname.startsWith('/liveview')) return;
  if (req.headers.get('accept')?.includes('text/event-stream')) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then(res => {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put('/index.html', copy));
          return res;
        })
        .catch(() => caches.match('/index.html').then(r => r ?? Response.error())),
    );
    return;
  }

  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(req).then(hit => hit ?? fetch(req).then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
        return res;
      })),
    );
  }
});
