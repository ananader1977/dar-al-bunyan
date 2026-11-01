// Service worker: makes the app installable on phones and shows a clear page when there is no connection.
// Always tries the network first (so updates pushed to GitHub show at once); the cache is only a fallback.
// Data (/api/...) is never cached.
const CACHE = 'dab-v1';
const SHELL = ['/app/', '/app/offline.html', '/css/app.css', '/js/app.js', '/js/admin.js', '/js/common.js', '/mark.png', '/icons/icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith((async () => {
    try {
      const res = await fetch(e.request);
      if (res.ok && res.type === 'basic') { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return res;
    } catch {
      const hit = await caches.match(e.request, { ignoreSearch: true });
      if (hit) return hit;
      if (e.request.mode === 'navigate') return caches.match('/app/offline.html');
      return Response.error();
    }
  })());
});
