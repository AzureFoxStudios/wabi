// Wabi Custom Service Worker — no third-party dependencies
// Replaces vite-plugin-pwa / workbox
//
// Finding 5: media cache must stamp X-Cached-At (via cachePut), enforce
// max age before serving, and be cleared on logout from the app shell.

const MEDIA_CACHE = 'media-cache-v2';
const SHELL_CACHE = 'shell-cache-v1';

const MAX_MEDIA_ENTRIES = 300;
// Capability-URL uploads: short retention. Logout also deletes this cache.
const MEDIA_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

// ---------------------------------------------------------------------------
// Install — pre-cache the app shell
// ---------------------------------------------------------------------------
self.addEventListener('install', (event) => {
  self.skipWaiting();
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

  // Navigation / HTML — network first, fallback to cache or offline
  if (request.mode === 'navigate') {
    event.respondWith(navigationHandler(request));
    return;
  }

  // Media — network-preferring SWR with real max-age (cachePut stamps age)
  if (
    url.pathname.startsWith('/uploads/') ||
    /^\/api\/whiteboard\/boards\/[^/]+\/files\//.test(url.pathname)
  ) {
    event.respondWith(staleWhileRevalidateHandler(request, MEDIA_CACHE, MAX_MEDIA_ENTRIES, MEDIA_MAX_AGE_MS));
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

async function navigationHandler(request) {
  try {
    const response = await fetch(request);
    return response;
  } catch {
    // Try to serve a cached HTML page
    const cache = await caches.open(SHELL_CACHE);
    const cached = await cache.match('/');
    if (cached) return cached;
    // Ultimate fallback — return a basic offline response
    return new Response(
      '<html><body><h1>Offline</h1><p>No internet connection.</p></body></html>',
      { headers: { 'Content-Type': 'text/html' } }
    );
  }
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
    // Network failed and no valid cache — return offline error
    return new Response(JSON.stringify({ error: 'Offline', details: 'Network unavailable and no cached response' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function staleWhileRevalidateHandler(request, cacheName, maxEntries, maxAgeMs) {
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

  // Fresh hit: serve immediately, refresh in background
  if (cached && fresh) {
    void fetchAndStore().catch(() => {});
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

  // Sort by oldest first using X-Cached-At
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
 * Bumping MEDIA_CACHE to v2 drops legacy unstamped media-cache-v1 entries.
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
