const CACHE = 'suspension-lab-__BUILD_ID__';
const SHELL = ['/', '/manifest.webmanifest', '/app-icon.svg', '/app-icon-192.png', '/app-icon-512.png', '/THREE-LICENSE.txt'];
const sameResponse = (response, requested) => response.ok && response.type === 'basic' &&
  !response.redirected && response.url === requested.href && !requested.search;

self.addEventListener('install', event => event.waitUntil((async () => {
  const manifest = new URL('/asset-manifest.json', self.location.origin);
  const response = await fetch(manifest, { cache: 'no-store' });
  if (!sameResponse(response, manifest)) throw new Error('Asset manifest unavailable');
  const assets = await response.json();
  if (!Array.isArray(assets) || assets.length > 100 || assets.some(asset =>
    typeof asset !== 'string' || !/^\/assets\/[\w.-]+$/.test(asset))) throw new Error('Invalid asset manifest');
  const cache = await caches.open(CACHE);
  await Promise.all([...SHELL, ...assets].map(async name => {
    const url = new URL(name, self.location.origin);
    const asset = await fetch(url, { cache: 'reload' });
    if (!sameResponse(asset, url)) throw new Error('Offline shell file unavailable');
    await cache.put(url, asset);
  }));
  await self.skipWaiting();
})()));

self.addEventListener('activate', event => event.waitUntil((async () => {
  for (const key of await caches.keys()) if (key.startsWith('suspension-lab-') && key !== CACHE) await caches.delete(key);
  await self.clients.claim();
})()));

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).then(async response => {
      if (url.pathname === '/' && sameResponse(response, url) &&
          /^text\/html(?:;|$)/i.test(response.headers.get('content-type') || '')) {
        await caches.open(CACHE).then(cache => cache.put('/', response.clone())).catch(() => {});
      }
      return response;
    }).catch(async () => (await caches.open(CACHE)).match('/')));
    return;
  }
  event.respondWith((async () => {
    const cache = await caches.open(CACHE).catch(() => null);
    const cached = await cache?.match(event.request);
    if (cached) return cached;
    const response = await fetch(event.request);
    if (url.pathname.startsWith('/assets/') && sameResponse(response, url)) {
      await cache?.put(event.request, response.clone()).catch(() => {});
    }
    return response;
  })());
});
