// 離線快取：只快取本站程式檔（cache-first）。卡片資料在 IndexedDB，不經這裡。
// 更新任何程式檔後，要把 CACHE 的版本號加一，手機才會換成新版。
const CACHE = 'bulba-shell-v28';
const ASSETS = ['./', './index.html', './app.js', './style.css', './manifest.webmanifest', './icon.svg', './lib/mobile_format.mjs',
  './lib/market_prices.mjs', './lib/favorites.mjs', './lib/card_match.mjs', './scan_worker.js', './vendor/opencv.js'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cached = await caches.match(request, { ignoreSearch: true });
    if (cached) return cached;
    if (request.mode === 'navigate') {
      const shell = await caches.match('./index.html');
      if (shell) return shell;
    }
    return fetch(request);
  })());
});
