/* Kuber service worker.
 *
 * Network-first for ALL app code — HTML, JS and CSS — so a redeploy always
 * reaches the device. This differs from the Wobble service worker, which is
 * cache-first for static assets: Wobble's JS is inlined into index.html, so
 * only the shell needed freshness. Kuber ships separate ES modules, and a
 * cache-first rule on those would happily serve a stale engine against a fresh
 * shell, which is both wrong and very hard to diagnose.
 *
 * Cache-first is therefore limited to genuinely immutable assets: icons and
 * the manifest.
 *
 * Bump CACHE on every deploy that changes the static list.
 */
const CACHE = 'kuber-v1';

const STATIC = [
  './manifest.webmanifest',
  './icons/icon-152.png',
  './icons/icon-167.png',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(STATIC))
      .catch(() => {})           // a missing icon must not block activation
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // never touch API calls

  const isImmutable = /\/icons\/|\.webmanifest$/.test(url.pathname);

  if (isImmutable) {
    e.respondWith(
      caches.match(req).then((cached) => cached || fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      })),
    );
    return;
  }

  // Everything else — the shell, the modules, the stylesheet — is network-first
  // with a cache fallback, so the app still opens offline on the last version
  // that was successfully fetched.
  e.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req).then((r) => r || caches.match('./index.html'))),
  );
});
