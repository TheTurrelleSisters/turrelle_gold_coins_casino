/*
 * service-worker.js — Gold Coins Casino Lobby
 * Gold Coins Casino System v3.3
 * AUTO-UPDATE: Detects new version, clears old cache, reloads all clients silently.
 * Bump CACHE_VER on every release — everything else is automatic.
 */
var CACHE_VER = 'lobby-v4.1';

/* Files to pre-cache on install */
var CACHE_URLS = [
  './index.html',
  './manifest.json',
  './assets/images/lobby_banner.jpg',
  './assets/images/straypups_splash.jpg',
  './assets/images/turrelle_splash.jpg',
  './assets/images/pokeher_splash.jpg',
  './assets/maxine_splash.jpg',
  './icons/icon-192x192.png',
  './icons/icon-512x512.png'
];

/* ── INSTALL: cache files + skip waiting immediately ── */
self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open(CACHE_VER)
      .then(function(cache) {
        return cache.addAll(CACHE_URLS).catch(function(err) {
          console.warn('[SW] Pre-cache failed (non-fatal):', err);
        });
      })
      .then(function() {
        return self.skipWaiting();
      })
  );
});

/* ── ACTIVATE: nuke ALL old caches, claim all clients, force reload ── */
self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys()
      .then(function(keys) {
        return Promise.all(
          keys.map(function(key) {
            if (key !== CACHE_VER) {
              console.log('[SW] Deleting stale cache:', key);
              return caches.delete(key);
            }
          })
        );
      })
      .then(function() {
        return self.clients.claim();
      })
      .then(function() {
        return self.clients.matchAll({ type: 'window' }).then(function(clients) {
          clients.forEach(function(client) {
            if (client.url && 'navigate' in client) {
              client.navigate(client.url);
            }
          });
        });
      })
  );
});

/* ── FETCH: network-first for JS/HTML, cache-first for assets ── */
self.addEventListener('fetch', function(e) {
  /* Never intercept non-GET requests — cache.put() only supports GET */
  if (e.request.method !== 'GET') return;

  var url = e.request.url;

  /* Never cache Supabase API responses */
  if (url.indexOf('supabase.co') !== -1) return;

  /* Network-first for JS, HTML, CDN */
  if (url.indexOf('.js')          !== -1 ||
      url.indexOf('.html')        !== -1 ||
      url.indexOf('jsdelivr.net') !== -1 ||
      url.indexOf('cdn.')         !== -1) {
    e.respondWith(
      fetch(e.request)
        .then(function(resp) {
          /* Skip cache.put for 206 Partial Content (range requests) */
          if (resp && resp.status !== 206) {
            var clone = resp.clone();
            caches.open(CACHE_VER).then(function(cache) {
              cache.put(e.request, clone);
            });
          }
          return resp;
        })
        .catch(function() {
          return caches.match(e.request);
        })
    );
    return;
  }

  /* Cache-first for images, audio, video */
  e.respondWith(
    caches.match(e.request).then(function(cached) {
      return cached || fetch(e.request).then(function(resp) {
        if (resp && resp.status !== 206) {
          var clone = resp.clone();
          caches.open(CACHE_VER).then(function(cache) {
            cache.put(e.request, clone);
          });
        }
        return resp;
      });
    })
  );
});
