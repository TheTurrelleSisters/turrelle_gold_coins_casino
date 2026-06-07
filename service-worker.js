/*
 * service-worker.js — Gold Coins Casino Lobby
 * Gold Coins Casino System v2.4
 * AUTO-UPDATE: Detects new version, clears old cache, reloads all clients silently.
 * Bump CACHE_VER on every release — everything else is automatic.
 */
var CACHE_VER = 'lobby-v2.9';

/* Files to pre-cache on install */
var CACHE_URLS = ['./index.html','./manifest.json','./assets/images/lobby_banner.jpg','./assets/images/straypups_splash.jpg','./assets/images/turrelle_splash.jpg','./icons/icon-192x192.png','./icons/icon-512x512.png'];

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
        /* Skip waiting — activate immediately without waiting for old SW to die */
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
        /* Claim all open tabs immediately */
        return self.clients.claim();
      })
      .then(function() {
        /* Tell all open clients to reload so they get fresh files */
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
  var url = e.request.url;

  /* Always go to network for JS, HTML, and API calls */
  if (url.indexOf('.js') !== -1 ||
      url.indexOf('.html') !== -1 ||
      url.indexOf('supabase.co') !== -1 ||
      url.indexOf('jsdelivr.net') !== -1 ||
      url.indexOf('cdn.') !== -1) {
    e.respondWith(
      fetch(e.request)
        .then(function(resp) {
          /* Update cache with fresh copy */
          var clone = resp.clone();
          caches.open(CACHE_VER).then(function(cache) {
            cache.put(e.request, clone);
          });
          return resp;
        })
        .catch(function() {
          /* Network failed — serve from cache as fallback */
          return caches.match(e.request);
        })
    );
    return;
  }

  /* Cache-first for images, audio, video */
  e.respondWith(
    caches.match(e.request).then(function(cached) {
      return cached || fetch(e.request).then(function(resp) {
        var clone = resp.clone();
        caches.open(CACHE_VER).then(function(cache) {
          cache.put(e.request, clone);
        });
        return resp;
      });
    })
  );
});
