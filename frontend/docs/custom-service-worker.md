# Custom Service Worker — Replacing vite-plugin-pwa / workbox

## Status

Proposed — pending implementation.

## Motivation

`vite-plugin-pwa` uses Google's **workbox** library under the hood:
- `workbox-build` — runs at build time, generates `sw.js`. Contains vulnerable `lodash` and `minimatch` packages (flagged in npm audit).
- `workbox` runtime — ships in the generated `sw.js` to every user's browser (~50KB).

For a privacy-focused, self-hosted chat app, shipping Google's service worker toolkit to users is unnecessary dependency. A custom `sw.js` using browser built-ins achieves the same result with zero third-party code in the browser.

## What PWA Currently Does

The current `VitePWA` config in `vite.config.ts` sets up:

```
Cache: /api/*  → NetworkFirst (1hr TTL, 50 max entries)
Cache: /uploads/* + whiteboard media → StaleWhileRevalidate (7d TTL, 300 max entries)
```

The service worker also handles the web app manifest for "Add to Home Screen" on Android.

## What We Want

| Feature | Implementation |
|---------|---------------|
| API caching | NetworkFirst, 1hr TTL, 50 max entries |
| Media caching | StaleWhileRevalidate, 7d TTL, 300 max entries |
| App shell offline | Cache app shell on install |
| Manifest | Hand-written `static/manifest.json` |
| SW registration | Keep existing `+layout.svelte` logic (it already points to `/sw.js`) |
| Update detection | Optional ~15 lines of `registration.update()` |

## Implementation Plan

### 1. Create `static/manifest.json`

Replaces the `manifest:` key from the current `VitePWA` config in `vite.config.ts`.

```json
{
  "name": "Wabi",
  "short_name": "Wabi",
  "description": "Ephemeral chat with screen sharing and business features",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#1a1a1a",
  "theme_color": "#1a1a1a",
  "icons": [
    {
      "src": "/icon-192.png",
      "sizes": "192x192",
      "type": "image/png"
    },
    {
      "src": "/icon-512.png",
      "sizes": "512x512",
      "type": "image/png",
      "purpose": "any maskable"
    }
  ]
}
```

### 2. Create `static/sw.js`

~90 lines of vanilla JS using the CacheStorage API. No external dependencies.

**Cache names:**
- `api-cache` — API responses
- `media-cache` — uploads and whiteboard files
- `app-shell` — app shell for offline

**Event flow:**

```
install event:
  → pre-cache app shell: /, /app.css

fetch event (navigation / HTML):
  → try network first
  → if network fails, serve cached HTML or offline page

fetch event (GET /api/*):
  → network first
  → on success, update cache
  → on network failure, serve cached response
  → max 50 entries, auto-expire after 1hr

fetch event (GET /uploads/* or whiteboard media):
  → stale-while-revalidate: serve cached immediately, update in background
  → on first request (uncached): fetch from network and cache
  → max 300 entries, auto-expire after 7 days

fetch event (other):
  → pass through, no caching
```

**Key implementation details:**
- Use `Cache.put()` for storing responses
- Use `Cache.delete()` for manual eviction (max entries)
- No automatic expiration — track `Date.now()` on store, run cleanup on activate
- `self.clients.claim()` in activate to take over immediately
- Handle `self.skipWaiting()` in install for force update

### 3. Update `vite.config.ts`

Remove the `VitePWA` import and plugin. Keep everything else.

```diff
- import { VitePWA } from 'vite-plugin-pwa';
- ...
- ...(isTauri ? [] : [VitePWA({ ... })])
+ // PWA handled by static/sw.js
```

### 4. Remove `vite-plugin-pwa` from package.json

```
npm uninstall vite-plugin-pwa
```

Or just remove it from `package.json` and run `npm install`.

### 5. Keep `+layout.svelte` unchanged

Lines 73–84 in `+layout.svelte` already do:

```svelte
} else if (import.meta.env.PROD && 'serviceWorker' in navigator && !isRunningInTauri()) {
    navigator.serviceWorker.register('/sw.js')...
```

This works with the custom `sw.js` — no change needed. SvelteKit's `serviceWorker: { register: true }` in `svelte.config.js` is also fine to keep or remove (it's redundant since we register manually).

## Files to Create / Modify

| File | Action |
|------|--------|
| `static/sw.js` | Create — the custom service worker |
| `static/manifest.json` | Create — replaces plugin-generated manifest |
| `vite.config.ts` | Modify — remove VitePWA plugin and import |
| `package.json` | Modify — remove `vite-plugin-pwa` |
| `src/routes/+layout.svelte` | No change needed |

## What We Lose

- **Auto-update toast** — the "new version available, refresh" prompt that vite-plugin-pwa injects. Can be re-added manually with ~15 lines using `registration.update()` and `registration.addEventListener('updatefound', ...)`.
- **workbox-build vulnerability warnings** — gone (good)

## What We Keep

- "Add to Home Screen" on Android (via manifest.json)
- API caching (NetworkFirst)
- Media caching (StaleWhileRevalidate)
- Offline page fallback
- App installability

## Verification

1. `npm run build` — succeeds with no workbox packages
2. `static/sw.js` exists in build output
3. `static/manifest.json` exists in build output
4. Browser DevTools → Application → Service Workers → `sw.js` registered
5. DevTools → Network → "from cache" seen on repeated API requests
6. DevTools → Network → "from service worker" seen on media

## Timeline

~20 minutes to implement + deploy to Tim's server.
