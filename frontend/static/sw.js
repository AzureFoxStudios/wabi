// Wabi Custom Service Worker — no third-party dependencies
// Replaces vite-plugin-pwa / workbox
//
// Finding 5: media cache stamps X-Cached-At, enforces max age, cleared on logout.
// Finding 12: install actually precaches a shell; navigate falls back to it;
//             media SWR revalidate is tied to event.waitUntil.

const MEDIA_CACHE = 'media-cache-v2';
const SHELL_CACHE = 'shell-cache-v2';

const MAX_MEDIA_ENTRIES = 300;
// Capability-URL uploads: short retention. Logout also deletes this cache.
const MEDIA_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

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
      const cache = await caches.open(SHELL_CACHE);
      // Best-effort: one failure must not abort the whole install.
      await Promise.all(
        SHELL_PRECACHE_URLS.map(async (path) => {
          try {
            const req = new Request(path, { cache: 'reload', credentials: 'same-origin' });
            const res = await fetch(req);
            if (res && res.ok) {
              await cache.put(path === '/' ? '/' : path, res.clone());
            }
          } catch {
            // ignore individual precache failures
          }
        })
      );
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

  // Media — network-preferring SWR with real max-age (cachePut stamps age)
  if (
    url.pathname.startsWith('/uploads/') ||
    /^\/api\/whiteboard\/boards\/[^/]+\/files\//.test(url.pathname)
  ) {
    event.respondWith(
      staleWhileRevalidateHandler(request, MEDIA_CACHE, MAX_MEDIA_ENTRIES, MEDIA_MAX_AGE_MS, event)
    );
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

async function networkFirstHandler(request, cacheName, maxEntries, maxAgeMs) {
  const cache = await caches.open(cacheName);

  try {
    const response = await fetch(request);
    if (response.ok) {
      await cachePut(cache, request, response.clone());
      await trimCache(cache, maxEntries);
    }
    return response;
  } catch {
    const cached = await cache.match(request);
    if (cached) {
      const isFresh = await isEntryFresh(cached, maxAgeMs);
      if (isFresh) return cached;
    }
    return new Response(JSON.stringify({ error: 'Offline', details: 'Network unavailable and no cached response' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function staleWhileRevalidateHandler(request, cacheName, maxEntries, maxAgeMs, event) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const fresh = cached ? await isEntryFresh(cached, maxAgeMs) : false;

  const fetchAndStore = async () => {
    const response = await fetch(request);
    if (response.ok) {
      await cachePut(cache, request, response.clone());
      await trimCache(cache, maxEntries);
    }
    return response;
  };

  // Fresh hit: serve immediately, refresh in background (tied to SW lifetime)
  if (cached && fresh) {
    const bg = fetchAndStore().catch(() => {});
    if (event && typeof event.waitUntil === 'function') {
      event.waitUntil(bg);
    }
    return cached;
  }

  // Miss or stale: prefer network so expiry is actually enforced
  try {
    return await fetchAndStore();
  } catch {
    // Offline last resort only if we still have *something* (stale allowed offline)
    if (cached) return cached;
    return new Response(JSON.stringify({ error: 'Offline', details: 'Network unavailable and no cached response' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check if a cached response is still within maxAgeMs.
 * We store a timestamp as a custom header when caching: `X-Cached-At`
 */
async function isEntryFresh(cachedResponse, maxAgeMs) {
  const cachedAt = cachedResponse.headers.get('X-Cached-At');
  if (!cachedAt) return false;
  return Date.now() - parseInt(cachedAt, 10) < maxAgeMs;
}

/**
 * Open a cache and store a response with an X-Cached-At timestamp header.
 */
async function cachePut(cache, request, response) {
  const headers = new Headers(response.headers);
  headers.set('X-Cached-At', String(Date.now()));
  const augmentedResponse = new Response(await response.clone().blob(), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
  await cache.put(request, augmentedResponse);
}

/**
 * Enforce max entry count by deleting oldest entries.
 * Uses X-Cached-At header for ordering.
 */
async function trimCache(cache, maxEntries) {
  const keys = await cache.keys();
  if (keys.length <= maxEntries) return;

  const entriesWithAge = [];
  for (const key of keys) {
    const response = await cache.match(key);
    if (response) {
      const cachedAt = response.headers.get('X-Cached-At');
      entriesWithAge.push({ key, age: cachedAt ? parseInt(cachedAt, 10) : 0 });
    }
  }

  entriesWithAge.sort((a, b) => a.age - b.age);

  const toDelete = entriesWithAge.slice(0, entriesWithAge.length - maxEntries);
  await Promise.all(toDelete.map(({ key }) => cache.delete(key)));
}

/**
 * Delete caches whose names we no longer use (stale workbox caches, old versions).
 * shell-cache-v2 drops empty v1 shells; media-cache-v2 drops unstamped v1 media.
 */
async function deleteOldCaches() {
  const expectedCaches = [MEDIA_CACHE, SHELL_CACHE];
  const keys = await caches.keys();
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
  if (data.type === 'wabi-clear-media-cache') event.waitUntil(caches.delete(MEDIA_CACHE));
});

