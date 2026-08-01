# Custom Service Worker

## Status

**Implemented.** Active files:

- `frontend/static/sw.js` — custom SW (no workbox)
- `frontend/static/manifest.webmanifest` — **canonical** web app manifest
- `frontend/static/offline.html` — offline navigation fallback
- Registered from app layout as `/sw.js`

## Canonical manifest (finding 26)

| File | Role |
|------|------|
| `static/manifest.webmanifest` | **Active** — linked from `src/app.html` |
| `static/manifest.json` | **Removed** — was a divergent duplicate |

Do not reintroduce `manifest.json`. Edit only `manifest.webmanifest`.

App shell theme/description should stay aligned with `app.html` (`theme-color`, meta description).

## What the SW does (current)

| Feature | Behavior |
|---------|----------|
| Install | `event.waitUntil` precaches shell into `shell-cache-v2`: `/`, `/offline.html`, `/manifest.webmanifest`, `/favicon.png`, `/wabi-logo.png` |
| Navigate | Network-first; on failure → cached shell → `/offline.html` → inline 503 |
| Media | SWR on `/uploads/*` and whiteboard file paths; `media-cache-v2`; `X-Cached-At` stamp; 24h TTL; max 300 entries |
| Media revalidate | Background refresh tied to `event.waitUntil` so the worker does not die mid-cache |
| API | Pass-through (no SW caching of `/api/*`) |
| Logout | App clears `media-cache-*` caches |

## Cache names

- `shell-cache-v2` — app shell + offline page
- `media-cache-v2` — capability-URL uploads (short retention)

Activate deletes any cache name not in the expected set (drops stale v1 shells/media).

## Registration

Keep existing `+layout.svelte` registration pointing at `/sw.js`. No vite-plugin-pwa / workbox.

## Verify

1. Hard reload online once so install precaches shell.
2. DevTools → Application → Service Workers: `sw.js` activated.
3. Offline → reload: shell or offline.html, not a bare browser error.
4. Only `manifest.webmanifest` is linked from `app.html`.
