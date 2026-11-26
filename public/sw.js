const CACHE_NAME = 'masenet-shell-v4-update';
const APP_SHELL = ['/', '/manifest.webmanifest', '/masemediatv-logo.png', '/masenet-app-icon.svg', '/masemediatv-logo.svg', '/masenet-home-mark.svg'];
const NEVER_CACHE = /(^|\/)(api|media)(\/|$)|\.(m3u8|m3u|ts|m4s|mp4|mkv|mov|webm|mpd|vtt|srt|key)(\?|$)/i;

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(APP_SHELL);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith('masenet-shell-') && key !== CACHE_NAME).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || request.headers.has('range')) return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin || NEVER_CACHE.test(url.pathname)) return;
  if (request.destination === 'video' || request.destination === 'audio') return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response.ok) {
          const cache = await caches.open(CACHE_NAME);
          await cache.put('/', response.clone());
        }
        return response;
      } catch {
        const cached = await caches.match('/');
        return cached || new Response(
          '<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#080a09"><title>MaseNet offline</title><body style="margin:0;background:#080a09;color:#f3f7f4;font:16px system-ui;display:grid;min-height:100vh;place-items:center;text-align:center"><main style="padding:28px"><h1>MaseNet</h1><p>You are offline. Reconnect to continue browsing and streaming.</p><button onclick="location.reload()" style="padding:12px 18px;border:0;border-radius:12px;background:#38e6a0;color:#052015;font-weight:700">Try again</button></main></body></html>',
          { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
        );
      }
    })());
    return;
  }

  if (url.pathname.startsWith('/assets/') || url.pathname === '/manifest.webmanifest' || url.pathname.endsWith('.svg')) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(request);
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok && response.type === 'basic') await cache.put(request, response.clone());
      return response;
    })());
  }
});
