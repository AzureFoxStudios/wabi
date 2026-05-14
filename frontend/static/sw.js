// Wabi Custom Service Worker — no third-party dependencies
// Replaces vite-plugin-pwa / workbox

const API_CACHE = 'api-cache-v1';
const MEDIA_CACHE = 'media-cache-v1';
const SHELL_CACHE = 'shell-cache-v1';

const MAX_API_ENTRIES = 50;
const MAX_MEDIA_ENTRIES = 300;
const API_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour
const MEDIA_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

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

  // API routes — NetworkFirst
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirstHandler(request, API_CACHE, MAX_API_ENTRIES, API_MAX_AGE_MS));
    return;
  }

  // Media — StaleWhileRevalidate
  if (
    url.pathname.startsWith('/uploads/') ||
    /^\/api\/whiteboard\/boards\/[^/]+\/files\//.test(url.pathname)
  ) {
    event.respondWith(staleWhileRevalidateHandler(request, MEDIA_CACHE, MAX_MEDIA_ENTRIES, MEDIA_MAX_AGE_MS));
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
      await cache.put(request, response.clone());
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

  const revalidate = async () => {
    try {
      const response = await fetch(request);
      if (response.ok) {
        await cache.put(request, response.clone());
        await trimCache(cache, maxEntries);
      }
    } catch {
      // Background revalidate failed — cached version still in use, no action needed
    }
  };

  if (cached) {
    // Serve cached immediately, revalidate in background
    revalidate();
    const isFresh = await isEntryFresh(cached, maxAgeMs);
    if (isFresh) return cached;
    // Cached but stale — still return it while revalidating
    return cached;
  }

  // No cache — wait for network
  const response = await fetch(request);
  if (response.ok) {
    await cache.put(request, response.clone());
    await trimCache(cache, maxEntries);
  }
  return response;
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
 */
async function deleteOldCaches() {
  const expectedCaches = [API_CACHE, MEDIA_CACHE, SHELL_CACHE];
  const keys = await caches.keys();
  return Promise.all(
    keys
      .filter((key) => !expectedCaches.includes(key))
      .map((key) => caches.delete(key))
  );
}
