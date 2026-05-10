// Mirit Nails Service Worker
// Strategy: cache-first for shell, network-first for index.html (so updates are quick)

const VERSION = 'v3.2.0'; // Bump on every deploy
const CACHE_NAME = `mirit-nails-${VERSION}`;
const SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

// Install: cache the shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL))
  );
  self.skipWaiting();
});

// Activate: delete old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k.startsWith('mirit-nails-') && k !== CACHE_NAME)
          .map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// Fetch:
// - For HTML / index navigations: network-first with cache fallback
//   (so users get updates ASAP if online)
// - For other assets: cache-first with network fallback
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Skip Firebase / Make / Green API / external network — always go online
  if (
    url.host.includes('googleapis.com') ||
    url.host.includes('firebaseio.com') ||
    url.host.includes('firebase') ||
    url.host.includes('hook.eu1.make.com') ||
    url.host.includes('greenapi.com') ||
    url.host.includes('gstatic.com') ||
    url.host.includes('cloudflare.com') ||
    url.host.includes('googleusercontent.com') ||
    url.host.includes('fonts.googleapis')
  ) {
    return; // Let the browser handle it normally
  }

  // For navigations / HTML — network first
  if (req.mode === 'navigate' || req.destination === 'document') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then((cached) => cached || caches.match('./index.html')))
    );
    return;
  }

  // For everything else — cache first
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) {
        // Try to refresh in background
        fetch(req)
          .then((res) => {
            if (res && res.status === 200) {
              const copy = res.clone();
              caches.open(CACHE_NAME).then((c) => c.put(req, copy));
            }
          })
          .catch(() => {});
        return cached;
      }
      return fetch(req).then((res) => {
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(req, copy));
        }
        return res;
      });
    })
  );
});

// Listen for skip-waiting from the page (when user accepts update)
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
