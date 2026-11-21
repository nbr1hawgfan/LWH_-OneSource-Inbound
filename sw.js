/* One Source Inbound moved into the Warehouse Toolkit (Nov 2026). This worker only clears the old
   offline copy so phones load the "moved" page; it no longer caches anything. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('os-inbound-')).map(k => caches.delete(k))))
    .then(() => self.clients.claim()).then(() => self.registration.unregister()));
});
