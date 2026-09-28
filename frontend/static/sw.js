// Wabi Custom Service Worker — no third-party dependencies
// Replaces vite-plugin-pwa / workbox
//
// Finding 12: install actually precaches a shell; navigate falls back to it;
//             revocable files always use the network.

// Old upload/whiteboard responses are purged when this worker activates.
// The static build fills these markers with a content-derived ID and the full
// immutable asset list. A missing build step must not claim offline readiness.
const BUILD_ID = 'unversioned';
const APP_PRECACHE_URLS = [];
const SHELL_CACHE = `shell-cache-${BUILD_ID}`;
const APP_ASSET_CACHE = `app-assets-${BUILD_ID}`;

/** Static assets safe to precache (same-origin, no auth). */
const SHELL_PRECACHE_URLS = [
  '/',
  '/offline.html',
  '/manifest.webmanifest',
  '/favicon.png',
  '/wabi-logo-boot.webp',
];

// ---------------------------------------------------------------------------
// Install — pre-cache the app shell (finding 12)
// ---------------------------------------------------------------------------
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      if (BUILD_ID === 'unversioned' || APP_PRECACHE_URLS.length === 0) {
        throw new Error('Static build did not provide an offline asset list');
      }
      const shell = await caches.open(SHELL_CACHE);
      const app = await caches.open(APP_ASSET_CACHE);
      const putRequired = async (cache, path) => {
        if (await cache.match(path)) return;
        const response = await fetch(new Request(path, { cache: 'reload', credentials: 'same-origin' }));
        if (!response.ok || response.type !== 'basic') throw new Error(`Cannot precache ${path}: ${response.status}`);
        await cache.put(path, response);
      };
      // A failed chunk leaves the previous worker and its complete caches
      // active. Keep concurrency bounded for phones and smaller servers.
      for (const paths of [SHELL_PRECACHE_URLS, APP_PRECACHE_URLS]) {
        for (let index = 0; index < paths.length; index += 12) {
          await Promise.all(paths.slice(index, index + 12).map(path =>
            putRequired(paths === SHELL_PRECACHE_URLS ? shell : app, path)
          ));
        }
      }
      await self.skipWaiting();
    })()
  );
});

// ---------------------------------------------------------------------------
// Activate — claim all clients immediately, clean up old caches
// ---------------------------------------------------------------------------
self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      self.clients.claim(),
      deleteOldCaches(),
    ])
  );
});

// ---------------------------------------------------------------------------
// Fetch — routing and caching strategies
// ---------------------------------------------------------------------------
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Navigation / HTML — network first, fallback to cached shell or offline page
  if (request.mode === 'navigate') {
    event.respondWith(navigationHandler(request, event));
    return;
  }

  // The cached HTML shell needs its versioned JS/CSS to start offline.
  // These hashed build assets are public and immutable; API and uploads keep
  // their separate network/cache policies below.
  if (request.method === 'GET' && url.origin === self.location.origin && url.pathname.startsWith('/_app/immutable/')) {
    event.respondWith(immutableAssetHandler(request));
    return;
  }

  // Revocable capability URLs must reach the Authority on every request.
  if (
    request.method === 'GET' && url.origin === self.location.origin && (
      url.pathname.startsWith('/uploads/') ||
      /^\/api\/whiteboard\/boards\/[^/]+\/files\//.test(url.pathname)
    )
  ) {
    event.respondWith(revocableMediaHandler(request));
    return;
  }

  // API routes carry auth, setup state, live channel state, and plugin state.
  // Let the browser hit the network directly so the worker never manufactures
  // local 503s for healthy login/config requests.
  if (url.pathname.startsWith('/api/')) {
    return;
  }

  // Everything else — no caching, pass through
});

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function immutableAssetHandler(request) {
  const cache = await caches.open(APP_ASSET_CACHE);
  // A tab opened before an update may still request an old hashed chunk.
  // Activation retains one prior asset cache for exactly this transition.
  const cached = (await cache.match(request)) || (await caches.match(request));
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok && response.type === 'basic') {
    await cache.put(request, response.clone());
  }
  return response;
}

async function navigationHandler(request, event) {
  try {
    const response = await fetch(request);
    // Keep a fresh copy of successful navigations as the SPA shell.
    if (response && response.ok && response.type === 'basic') {
      const cache = await caches.open(SHELL_CACHE);
      const putPromise = cache.put('/', response.clone()).catch(() => {});
      if (event && typeof event.waitUntil === 'function') {
        event.waitUntil(putPromise);
      }
    }
    return response;
  } catch {
    const cache = await caches.open(SHELL_CACHE);
    // Prefer the real app shell if we ever captured it online.
    const shell =
      (await cache.match('/')) ||
      (await cache.match('/index.html')) ||
      (await cache.match(request));
    if (shell) return shell;

    const offline = await cache.match('/offline.html');
    if (offline) return offline;

    // Last resort — styled inline page (should rarely hit if offline.html precached)
    return offlineFallbackResponse();
  }
}

function offlineFallbackResponse() {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Wabi — Offline</title>
<style>html,body{min-height:100%;margin:0;font-family:system-ui,sans-serif;color:#e2e8f0;background:linear-gradient(180deg,#0f172a,#060b14)} .w{min-height:100vh;display:grid;place-items:center;padding:24px;text-align:center} h1{margin:0 0 8px;font-size:1.25rem} p{color:#94a3b8;max-width:28rem;line-height:1.5} button{margin-top:12px;padding:10px 16px;border-radius:10px;border:1px solid #475569;background:#0f172a;color:#e2e8f0}</style>
</head><body><div class="w"><div><h1>You're offline</h1><p>Wabi can't reach the server. Reload when you're back online.</p><button onclick="location.reload()">Try again</button></div></div></body></html>`;
  return new Response(html, {
    status: 503,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

async function revocableMediaHandler(request) {
  try {
    // Bypass the browser HTTP cache as well as this worker's old media cache.
    return await fetch(new Request(request, { cache: 'no-store' }));
  } catch {
    // A cached capability URL may have been revoked while this device was
    // offline, so an unavailable Authority cannot authorize stale bytes.
    return new Response(JSON.stringify({ error: 'Authority unavailable' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
    });
  }
}

/**
 * Keep one prior shell/asset pair for pages opened before an update. Their
 * hashed imports may still be in flight after the new worker claims clients.
 */
async function deleteOldCaches() {
  const keys = await caches.keys();
  const previousShell = keys.filter(key => key.startsWith('shell-cache-') && key !== SHELL_CACHE).at(-1);
  const previousAssets = keys.filter(key => key.startsWith('app-assets-') && key !== APP_ASSET_CACHE).at(-1);
  const expectedCaches = [SHELL_CACHE, APP_ASSET_CACHE, previousShell, previousAssets];
  return Promise.all(
    keys
      .filter((key) => !expectedCaches.includes(key))
      .map((key) => caches.delete(key))
  );
}

// Web Push (PWA Phase 1)
self.addEventListener('push', (event) => {
  let payload = {};
  try {
    if (event.data) payload = event.data.json();
  } catch {
    try {
      payload = { body: event.data ? event.data.text() : '' };
    } catch {
      payload = {};
    }
  }
  const title = (payload && payload.title) || 'Wabi';
  const body = (payload && payload.body) || 'New notification';
  const icon = (payload && payload.icon) || '/icon-192.png';
  const data = payload && typeof payload === 'object' ? { ...payload } : {};
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon,
      badge: icon,
      data,
      tag: typeof payload.tag === 'string' ? payload.tag : undefined
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = (event.notification && event.notification.data) || {};
  const params = new URLSearchParams();
  const kind = data.wabiNav || data.kind;
  if (kind) params.set('wabiNav', String(kind));
  if (data.channelId) params.set('channelId', String(data.channelId));
  if (data.messageId) params.set('messageId', String(data.messageId));
  if (data.callId) params.set('callId', String(data.callId));
  if (data.section) params.set('section', String(data.section));
  const targetUrl = params.toString() ? `/?${params.toString()}` : '/';
  event.waitUntil(
    (async () => {
      const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of allClients) {
        if ('focus' in client) {
          await client.focus();
          try {
            client.postMessage({ type: 'wabi-navigate', payload: data });
          } catch (_) {}
          return;
        }
      }
      if (self.clients.openWindow) await self.clients.openWindow(targetUrl);
    })()
  );
});

self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || typeof data !== 'object') return;
  if (data.type === 'wabi-skip-waiting') self.skipWaiting();
  if (data.type === 'wabi-clear-media-cache') {
    event.waitUntil(caches.keys().then(keys =>
      Promise.all(keys.filter(key => key.startsWith('media-cache-')).map(key => caches.delete(key)))
    ));
  }
});
