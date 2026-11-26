// Filmroom service worker. It does exactly ONE thing: keep the film-look files (luts/*.png, about 18 MB in all) after their first download, so later
// visits load them from disk instantly, even offline. It never touches the page, scripts, API calls or anything else.
// The page asks for luts/<name>.png?v=<LUT_VER>. When a look file changes: bump LUT_VER in index.html AND CACHE here (the old cache is deleted).
const CACHE = 'filmroom-luts-1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k.startsWith('filmroom-luts-') && k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));

self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== self.location.origin || !/\/luts\/[a-z0-9-]+\.png$/.test(u.pathname)) return;   // anything else: the browser handles it as usual
  e.respondWith((async () => {
    const cache = await caches.open(CACHE), hit = await cache.match(e.request);
    if (hit) return hit;
    const res = await fetch(e.request);
    if (res.ok) cache.put(e.request, res.clone()).catch(() => {});          // only complete, successful responses are kept
    return res;
  })());
});
