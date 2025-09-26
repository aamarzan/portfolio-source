// sw.js

// 1) Versioned cache name so you can force a refresh on deploys
const CACHE_VERSION = 'v3';
const CACHE_NAME = 'marzan-portfolio-' + CACHE_VERSION;

// 2) Precache critical assets (include versioned URLs if you use ?v=)
const PRECACHE_URLS = [
  '/',                 // HTML entry
  '/index.html',       // explicit index
  '/style.css?v=1',    // versioned CSS
  '/script.js?v=1',    // versioned JS
  '/media/home/Logo.png?v=1' // key image
  // Add other critical assets here, with ?v=... if you cache-bust them
];

// 3) Only handle same-origin GET requests
function isSameOrigin(request) {
  try {
    const url = new URL(request.url);
    return url.origin === self.location.origin;
  } catch {
    return false;
  }
}
function isGET(request) {
  return request.method === 'GET';
}

// 4) Install: precache, skip waiting
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .catch((err) => {
        // Avoid failing the install if one precache URL is unavailable
        console.warn('Precache failed:', err);
      })
  );
  self.skipWaiting();
});

// 5) Activate: claim clients, delete old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      )
    )
  );
  self.clients.claim();
});

// 6) Fetch strategy:
//    - HTML/navigation: network-first (fresh updates win), fallback to cache offline
//    - Same-origin static assets (CSS/JS/images): stale-while-revalidate (fast + self-healing)
//    - Ignore cross-origin (CDN, analytics) so we don’t interfere
self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Only GET requests
  if (!isGET(req)) return;

  const accept = req.headers.get('accept') || '';
  const isHTML = accept.includes('text/html');

  // Ignore cross-origin requests (e.g., Google Analytics, CDNs)
  if (!isSameOrigin(req)) return;

  if (isHTML || req.mode === 'navigate') {
    // Network-first for HTML/navigation
    event.respondWith(
      fetch(req)
        .then((networkRes) => {
          // Cache the fresh HTML for offline
          const resClone = networkRes.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, resClone));
          return networkRes;
        })
        .catch(() => {
          // Offline fallback to cached HTML
          return caches.match(req).then((cached) => cached || caches.match('/index.html'));
        })
    );
    return;
  }

  // Stale-while-revalidate for same-origin static assets
  event.respondWith(
    caches.match(req).then((cached) => {
      const fetchPromise = fetch(req)
        .then((networkRes) => {
          // Cache the updated asset (respects query strings like ?v=2)
          const resClone = networkRes.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, resClone));
          return networkRes;
        })
        .catch(() => {
          // If network fails, use cache
          return cached;
        });

      // If we have a cached response, return it immediately (fast), and update in background
      return cached || fetchPromise;
    })
  );
});
