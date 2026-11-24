/* Service worker logic for a gated app (see private-gate.js).

   The app's public sw.js sets self.GATE_APP and imports this file. Requests from the app's
   pages are answered from the private cache when the file was fetched with the owner's
   token, otherwise from the network, with a copy kept for offline use. The cached app page
   gets the gate script in refresh mode, so changed files are picked up in the background. */
const APP = self.GATE_APP;
const PRIVATE = 'private-' + APP;
const PUBLIC = 'public-' + APP;
const BASE = new URL('../', self.registration.scope).pathname;  // e.g. /Apps/

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

function cacheKey(url) {
  if (!url.pathname.startsWith(BASE)) return null;
  let rel = url.pathname.slice(BASE.length);
  if (rel === APP || rel.endsWith('/')) rel = rel.replace(/\/?$/, '/') + 'index.html';
  return BASE + rel;
}

async function withRefresher(res) {
  const html = await res.text();
  const tag = '<script src="' + BASE + 'shared/private-gate.js?v=2" data-app="' + APP + '" data-mode="refresh" defer></script>';
  const out = html.includes('</body>') ? html.replace('</body>', tag + '</body>') : html + tag;
  return new Response(out, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const key = cacheKey(url);
  if (!key) return;
  e.respondWith((async () => {
    const hit = await (await caches.open(PRIVATE)).match(key);
    if (hit) return req.mode === 'navigate' ? withRefresher(hit) : hit;
    try {
      const res = await fetch(req, req.mode === 'navigate' ? { cache: 'no-store' } : undefined);
      if (res.ok && res.type === 'basic' && !/\/private\.(bin|json)$/.test(key)) (await caches.open(PUBLIC)).put(key, res.clone());
      return res;
    } catch (err) {
      return (await (await caches.open(PUBLIC)).match(key)) || Response.error();
    }
  })());
});
