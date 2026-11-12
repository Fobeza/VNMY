/* VNMY — service worker: приложение открывается без сети.
 *
 * Стратегии:
 *  - HTML / JS / CSS — network-first с кэшем как запасным вариантом
 *    (новые версии подхватываются сразу, офлайн — работает последняя загруженная);
 *  - картинки, иконки, манифест — cache-first (они неизменяемые);
 *  - stories/index.json и story.json — network-first: новые истории видны сразу.
 */
const VERSION = 'vnmy-2.9.0';
const SHELL = `${VERSION}-shell`;
const MEDIA = `${VERSION}-media`;

const SHELL_FILES = [
  './',
  './index.html',
  './css/base.css',
  './css/player.css',
  './js/app.js',
  './js/engine.js',
  './js/session.js',
  './js/persistence.js',
  './js/format.js',
  './js/expr.js',
  './js/store.js',
  './js/library.js',
  './js/novels.js',
  './js/universe.js',
  './js/player.js',
  './js/settings.js',
  './js/audio.js',
  './js/gestures.js',
  './js/import.js',
  './js/gallery.js',
  './js/ui.js',
  './js/util.js',
  './js/weather.js',
  './js/icons.js',
  './js/version.js',
  './bundle.js',
  './stories/builtin.js',
  './manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // Commit the complete shell atomically; a failed update keeps the old worker.
    await cache.addAll(SHELL_FILES.map(file => new Request(file, { cache: 'reload' })));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('vnmy-') && !k.startsWith(VERSION)).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

function isMedia(url) {
  return /\.(webp|png|jpe?g|gif|svg|woff2?|ico)$/i.test(url.pathname);
}

/* Кэш принимает только полный ответ: частичный (206, запрос диапазона для
 * аудио) он отвергает с ошибкой. */
function cacheable(res) {
  return res.status === 200 && res.type === 'basic';
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
        if (cacheable(res)) cache.put(request, res.clone()).catch(() => {});
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
      if (cacheable(res)) cache.put(request, res.clone()).catch(() => {});
      return res;
    } catch (err) {
      const hit = await cache.match(request, { ignoreSearch: isData(url) });
      if (hit) return hit;
      const downloaded = await caches.match(request, { ignoreSearch: isData(url) });
      if (downloaded) return downloaded;
      if (request.mode === 'navigate') {
        const shell = await cache.match('./index.html');
        if (shell) return shell;
      }
      throw err;
    }
  })());
});
