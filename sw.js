/* VNMY — service worker: приложение открывается без сети.
 *
 * Стратегии:
 *  - HTML / JS / CSS — network-first с кэшем как запасным вариантом
 *    (новые версии подхватываются сразу, офлайн — работает последняя загруженная);
 *  - картинки, иконки, манифест — cache-first (они неизменяемые);
 *  - stories/index.json и story.json — network-first: новые истории видны сразу.
 */
const VERSION = 'vnmy-2.0';
const SHELL = `${VERSION}-shell`;
const MEDIA = `${VERSION}-media`;

const SHELL_FILES = [
  './',
  './index.html',
  './css/base.css',
  './css/player.css',
  './css/editor.css',
  './js/app.js',
  './js/engine.js',
  './js/format.js',
  './js/expr.js',
  './js/store.js',
  './js/library.js',
  './js/novels.js',
  './js/universe.js',
  './js/player.js',
  './js/ui.js',
  './js/util.js',
  './js/weather.js',
  './js/icons.js',
  './js/version.js',
  './js/editor.js',
  './js/editor-tabs.js',
  './js/editor-ui.js',
  './bundle.js',
  './stories/builtin.js',
  './manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // кэшируем по одному: один недоступный файл не должен ломать установку
    await Promise.all(SHELL_FILES.map(async (file) => {
      try { await cache.add(new Request(file, { cache: 'reload' })); } catch { /* не критично */ }
    }));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

function isMedia(url) {
  return /\.(webp|png|jpe?g|gif|svg|woff2?|ico)$/i.test(url.pathname);
}

function isData(url) {
  return /stories\/(index\.json|.*story\.json)$/i.test(url.pathname);
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== location.origin) return;

  if (isMedia(url)) {
    event.respondWith((async () => {
      const cache = await caches.open(MEDIA);
      const hit = await cache.match(request);
      if (hit) return hit;
      try {
        const res = await fetch(request);
        if (res.ok) cache.put(request, res.clone());
        return res;
      } catch (err) {
        const fallback = await caches.match(request);
        if (fallback) return fallback;
        throw err;
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(SHELL);
    try {
      const res = await fetch(request);
      if (res.ok) cache.put(request, res.clone());
      return res;
    } catch (err) {
      const hit = await cache.match(request, { ignoreSearch: isData(url) });
      if (hit) return hit;
      if (request.mode === 'navigate') {
        const shell = await cache.match('./index.html');
        if (shell) return shell;
      }
      throw err;
    }
  })());
});
