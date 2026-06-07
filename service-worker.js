var CACHE_VER  = 'lobby-v1.0';
var CACHE_URLS = ['./index.html', './manifest.json'];
self.addEventListener('install', function(e) {
  e.waitUntil(caches.open(CACHE_VER).then(function(c) { return c.addAll(CACHE_URLS); }).then(function() { return self.skipWaiting(); }));
});
self.addEventListener('activate', function(e) {
  e.waitUntil(caches.keys().then(function(keys) {
    return Promise.all(keys.map(function(k) { if (k !== CACHE_VER) return caches.delete(k); }));
  }).then(function() { return self.clients.claim(); }));
});
self.addEventListener('fetch', function(e) {
  if (e.request.url.indexOf('supabase.co') !== -1 || e.request.url.indexOf('jsdelivr') !== -1) return;
  e.respondWith(caches.match(e.request).then(function(c) { return c || fetch(e.request); }));
});
