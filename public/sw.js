// ============================================================================
// WA Bot Console — Service Worker
// ============================================================================
const CACHE = 'wa-bot-v2';
const ASSETS = [
  '/',
  '/manifest.json',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;
  
  const url = new URL(request.url);
  // Never cache API calls
  if (url.pathname.startsWith('/api/') || url.pathname === '/health') return;
  
  // Network-first for HTML, cache-first for assets
  if (request.headers.get('accept')?.includes('text/html')) {
    e.respondWith(
      fetch(request).catch(() => caches.match(request).then(r => r || caches.match('/')))
    );
    return;
  }
  
  e.respondWith(
    caches.match(request).then(cached => cached || fetch(request).then(res => {
      if (res.ok && url.origin === self.location.origin) {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(request, clone));
      }
      return res;
    }))
  );
});