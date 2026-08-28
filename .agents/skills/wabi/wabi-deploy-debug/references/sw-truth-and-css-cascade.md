# Service Worker truth — the SW is NOT the stale-UI culprit

## What the audit proved (2026-08-08)

`frontend/static/sw.js` (the custom Wabi SW) does **not** cache the app shell
in a way that hides deploys:

- **Navigations**: network-first. It fetches fresh from the network every
  time; the cached `/` is only a *fallback for when the fetch throws*
  (offline). It re-caches `/` on every successful navigation.
- **`/api/*`**: explicitly passed through (no caching) — login/config/init
  state is never stale.
- **`_app/immutable/*` (JS/CSS chunks)**: "Everything else — no caching,
  pass through." The SW NEVER intercepts chunk requests.
- Precached on install: `/`, `/offline.html`, `/manifest.webmanifest`,
  `/favicon.png`, `/wabi-logo.png` — no hashed chunks.

**Consequence:** an SW version bump (`__WABI_SW_VERSION__` '9' → '10') changes
nothing served on an online client. The "3 hours of service worker this and
that" (Ronin, 2026-08-08) was spent on the wrong suspect. A real SW unregister
+ hard-refresh only matters for genuinely OFFLINE previews.

## Why a deploy can look like it "did nothing" even when verified

SHA matches, `StartedAt` fresh, public CSS hash equals the binary's embedded
hash — and the UI still looks wrong. The causes are deterministic source bugs,
not caching:

1. **CSS duplicate-selector cascade** — a legacy stylesheet imported LAST in
   `frontend/src/styles/styles.css` overrides the modern sheet at equal
   specificity (later import wins). The 2026-08-08 kanban case:
   `todo-list.css` re-defined `.kanban-board { display:grid }` (no column
   template) + `!important` grid media queries; `kanban-board.css` (part1)
   defined the correct `display:flex; flex-direction:row` spread but imports
   earlier → grid always won → columns stacked ("fell through the floor").
   Same sheet also stomped `.filters`, `.column-settings`, `.column-toggle`,
   `.empty-column`, `.card-title`, `.add-btn`, `.header-right` (calendar
   `+ Add Event` was repainted indigo; task-panel's 32px-square `.add-btn`
   would win if the legacy copy is removed). ~50 classes were defined in 2+
   sheets at audit time.
   **Detection:** `scripts/css-cascade-audit.py` (lists every class defined
   in >1 sheet and which import wins). **Fix:** delete the legacy duplicate
   rules — but only for classes whose modern definition is the intended one
   AND whose other users have their own scoped styles. `.tags`, `.card-*`,
   `.modal*`, `.form-*` in todo-list.css are the ONLY definition for
   lightboxes/modals/forum rows — deleting the whole sheet breaks them.
   For components that rely on global classes (CalendarImpl header), the
   robust fix is a SCOPED `<style>` block in the component — scoped rules
   always beat globals regardless of import order.

2. **Single-shot capability gates** — `hasAddonCapability('lore')` cached
   its promise forever in `capabilityCache`, so ONE raced first fetch left
   the Code chip stuck on "Addon unavailable" for the whole session; even
   after making negatives non-sticky, `ChannelSidebar` stored the mount-time
   probe result in a plain `let` and never re-checked. Fix: re-probe when
   the create form opens (`refreshLoreCapability()` on both the sidebar
   button and the `wabi:create-channel` event path). See
   `lore-capability-gate.md`.

3. **z-index collisions** — an error banner at `z-index:17` under a floating
   toolbar at `z-index:20` at the same `top` offset is invisible ("red error
   behind UI I cannot read"). Audit banner vs sibling toolbar z-index +
   `top`. See the whiteboard row in SKILL.md.

4. **Stub handlers / wrong-arg calls** — `handleTemplateSelect` was a
   `// TODO` no-op; `handleUpload` passed `(token, channelId, file, path)`
   to `uploadLoreFile(token, channelId, path, file, ...)` → runtime throw.
   Grep `// TODO` in handlers; verify arg order against the API signature.

## Triage order that actually resolves "it doesn't update"

1. Prove the build: Tim SHA == local; `docker inspect` `State.StartedAt` >
   binary `stat -c %y` (force-recreate with `docker rm -f` + `up -d`, not
   `restart`).
2. Prove serving: public `/` CSS/JS hash == `strings <binary> | grep -oE '0\.[A-Za-z0-9_-]+\.(css|js)'`.
3. Prove content: `strings <binary> | grep -c '<feature-marker>'` (lazy
   chunks are NOT in index.html hrefs).
4. Audit source for the four classes above — do NOT touch the SW.

## When the SW bump IS still worth doing

Only for offline-shell hygiene or to force re-precache of `/offline.html`.
It is never the fix for "deploys don't change anything."
