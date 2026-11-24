/* Cache the shell so the app opens without a connection.

   The page itself always comes from the network, and with cache:'no-store' so
   the browser's own HTTP cache cannot hand back yesterday's copy either; the
   cached page is the offline fallback, nothing more. Everything else — icons,
   the manifest — is immutable enough to serve from the cache first.

   Note './' is deliberately NOT in the shell: it is the document under another
   name, and caching it lets a stale page outlive every redeploy. */
const CACHE = 'hours-courses-20261027-motion-1-fonts';
const SHELL = ['../shared/fonts/hours.css?v=1', '../shared/motion.css?v=1', '../shared/motion.mjs?v=1', './index.html', './manifest.webmanifest?v=9e6c408366',
               './icon-180.png?v=9e6c408366', './icon-192.png?v=9e6c408366', './icon-512.png?v=9e6c408366'];
const wantsHTML = (req) => req.mode === 'navigate'
  || (req.headers.get('accept') || '').includes('text/html');

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => k.startsWith(CACHE.split('-')[0] + '-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  if (wantsHTML(req)) {
    e.respondWith(fetch(req, { cache: 'no-store' }).then((r) => {
      const copy = r.clone();
      caches.open(CACHE).then((c) => c.put('./index.html', copy));
      return r;
    }).catch(() => caches.match('./index.html')));
    return;
  }
  e.respondWith(caches.match(req).then((hit) => hit || fetch(req)));
});
