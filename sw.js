/* Offline cache for One Source Inbound. Bump VERSION with every deploy (must match APP_VERSION in app.js). */
const VERSION = '1.0.0';
const CACHE = 'os-inbound-' + VERSION;
const ASSETS = [
  './', 'index.html', 'app.css', 'app.js', 'manifest.json',
  'vendor/JsBarcode.code128.min.js', 'vendor/html5-qrcode.min.js',
  'icons/icon-192.png', 'icons/icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('os-inbound-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Cache first so the app always opens with no connection; refresh the cache in the background when online.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(req, { ignoreSearch: true });
      const net = fetch(req).then((res) => {
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      }).catch(() => null);
      if (hit) return hit;
      const res = await net;
      if (res) return res;
      if (req.mode === 'navigate') return cache.match('index.html');
      return new Response('Offline', { status: 503 });
    })
  );
});
