/* ツーリング相棒 service worker — アプリシェルをキャッシュしてオフライン起動可能に */
const CACHE_NAME = 'touring-buddy-v2';
const SHELL = ['.', 'index.html', 'style.css', 'app.js', 'packs.js', 'manifest.json', 'icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE_NAME).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // APIリクエストはキャッシュせず常にネットワークへ
  if (url.origin !== location.origin) return;
  // アプリシェルはネットワーク優先・失敗時キャッシュ(更新を取り込みつつオフラインでも動く)
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
