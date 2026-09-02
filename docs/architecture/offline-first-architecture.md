# Offline-First Architecture

**Status:** Planned (vision + boot-layer only for now)  
**Generated:** 2026-07-01  
**Related:** effects-system-architecture.md, PLAN.md (Task Block M)

---

## Vision

Wabi should be usable without an internet connection. Not just "graceful degradation" that shows an error — but genuinely useful: browse cached chats, read messages, use local tools, and (in the future) communicate over LAN mesh with other Wabi instances on the same network.

---

## Offline Layers

```
Layer 1: Boot Survival     (now — don't show login to returning users)
Layer 2: Read Cache        (soon — browse cached messages/chats offline)
Layer 3: Local Actions     (future — queue writes, sync on reconnect)
Layer 4: LAN Mesh          (dream — p2p between Wabi nodes on same network)
```

---

## Current State (as of 2026-07-01)

### Boot Sequence

```
1. app.html renders:
   - Boot shell (#wabi-boot-shell) — fullscreen spinner
   - <body> CSS background (gradient, works before JS)

2. Svelte hydrates:
   a. +layout.svelte mounts (global CSS, i18n, service worker)
   b. +page.svelte mounts:
      - onMount fires async bootstrap:
        i.   Read savedToken, savedUsername, savedGuestSessionId from storage
        ii.  If hasSession → initSocket(), loggedIn = true
        iii. If !hasSession → loggedIn = false, clear identity
        iv.  initializeTheme() (fire-and-forget)
        v.   isBootstrapping = false
        vi.  dismissDocumentBootShell() — hides spinner

3. Template renders:
   - If loggedIn → <MainLayout />
   - If !loggedIn → <Login />
```

### Problem

If a returning user reloads while offline:
1. `savedToken` exists (localStorage, persisted via "Remember Me")
2. `initSocket()` fails — can't reach server
3. The socket error subscriber catches `session_expired` / `invalid_token`
4. Sets `loggedIn = false`, clears session, **shows login screen**
5. User is stuck at login with no internet

The app becomes a brick without internet — despite cached data being available.

---

## Layer 1: Boot Survival (Implementation Plan)

### Goal

A returning user (has `wabi_has_logged_in` flag) should **never** see the login screen. If offline, stay in the boot shell with a "Work Offline" option. Only show login on explicit logout.

### Changes

#### 1. Add `wabi_has_logged_in` flag

**`Login.svelte`** — on successful login:
```ts
localStorage.setItem('wabi_has_logged_in', 'true');
```

**Settings / Logout button** — on explicit logout:
```ts
localStorage.removeItem('wabi_has_logged_in');
// + clear token, redirect to login
```

#### 2. Modify auth check in `+page.svelte`

Current flow (pseudocode):
```
if (savedUsername && hasSession) → loggedIn = true, boot app
else → loggedIn = false, show login
```

New flow:
```
const hasLoggedInBefore = localStorage.getItem('wabi_has_logged_in') === 'true';

if (savedUsername && hasSession) {
  // Online, valid session — normal boot
  loggedIn = true;
  initSocket(...);
} else if (hasLoggedInBefore) {
  // Returning user but offline / session expired
  // DON'T dismiss boot shell. Show "Reconnecting..." state.
  bootState = 'reconnecting';
  scheduleRetry();
} else {
  // Fresh user — show login
  loggedIn = false;
}
```

#### 3. Boot shell states

The boot shell in `app.html` needs states:

| State | Shown when | Behavior |
|-------|-----------|----------|
| `booting` | Initial load | Current spinner + animated ring |
| `reconnecting` | Returning user, offline | Message: "Reconnecting…" + retry pulsing + "Work Offline" button |
| `offline` | User clicked "Work Offline" | Dismiss boot shell, show MainLayout in offline mode |

The boot shell already has a `data-state` attribute mechanism; the inline IIFE updates the DOM based on events:

```html
<div id="wabi-boot-shell" data-state="booting">
  <!-- booting state (existing) -->
  <div class="boot-spinner">...</div>
  <div class="boot-title">Starting Wabi</div>

  <!-- reconnecting state (new, hidden by default) -->
  <div class="reconnect-state" hidden>
    <div class="boot-title">Reconnecting…</div>
    <button id="wabi-work-offline">Work Offline</button>
  </div>

  <div class="dots">...</div>
</div>
```

#### 4. Retry logic

In `+page.svelte`, if `hasLoggedInBefore && !hasSession`:

```ts
let retryCount = 0;
const maxRetries = 5;
const retryInterval = 3000; // 3 seconds

function scheduleRetry() {
  const timer = setInterval(async () => {
    retryCount++;
    // Try to validate session
    const token = getAuthToken();
    if (token) {
      try {
        await fetch('/api/auth/validate', {
          headers: { Authorization: `Bearer ${token}` }
        });
        // Success! Session is valid.
        clearInterval(timer);
        initSocket(token);
        loggedIn = true;
        dismissDocumentBootShell();
        return;
      } catch {}
    }
    if (retryCount >= maxRetries) {
      clearInterval(timer);
      // Stay in boot shell, show "Work Offline" more prominently
    }
  }, retryInterval);
}
```

Also listen for `window.addEventListener('online', ...)` to re-trigger validation immediately when connectivity returns.

#### 5. Offline mode indicator

When the user clicks "Work Offline" or retries are exhausted:

```ts
function enterOfflineMode() {
  // Show cached data from IndexedDB
  loadCachedData();
  // Switch to offline UI
  loggedIn = true;
  isOffline = true;
  dismissDocumentBootShell();
}
```

The `<MainLayout />` or a wrapper component shows an offline banner:

```
┌──────────────────────────────────────┐
│ ⚠ Offline — changes will sync when  │
│   reconnected  [Retry] [Dismiss]     │
└──────────────────────────────────────┘
```

---

## Layer 2: Read Cache (Future)

### Goal

Browse cached messages, channels, and user profiles from a previous session without internet.

### Architecture

```
Service Worker
├─ Cache-first: app shell, CSS, JS assets
├─ Network-first: API data (fallback to cache)
└─ Background sync for queued writes

IndexedDB (local)
├─ messages-store: Last N messages per channel
├─ channels-store: Channel list + metadata
├─ users-store: User profiles
└─ assets-store: Uploaded images/files (thumbs)

Data Layer
├─ Online: normal socket/API access
├─ Offline: read from IndexedDB
└─ Sync: delta-sync on reconnect
```

### Key Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| Caching strategy | Cache messages on receive | Every message received over socket is written to IndexedDB. No separate fetch pass. |
| Storage limit | 500 messages per channel, 50 MB total | Prevents unbounded storage growth. Configurable. |
| Image caching | Thumbnails only, full-res on demand | Storage tradeoff. Full images fetched on click if online. |
| Cache invalidation | LRU eviction per channel | Most recent N messages kept, oldest dropped. |

---

## Layer 3: Local Actions (Future)

### Goal

Queue actions taken offline (send message, add reaction, edit profile) and replay them when connectivity returns.

### Architecture

```
Action Queue (IndexedDB)
├─ Each action: { id, type, payload, createdAt }
├─ On reconnect: replay in order
├─ Conflict resolution: last-write-wins or server response
└─ UI: show pending indicator for queued actions
```

---

## Layer 4: LAN Mesh (Dream)

### Goal

Two Wabi instances on the same local network can communicate directly without internet — via WebRTC or UDP broadcast.

### Architecture

```
┌──────────────┐         ┌──────────────┐
│  Wabi Node A │◄──WebRTC──►│  Wabi Node B │
│  192.168.1.5 │  or UDP    │  192.168.1.8 │
└──────────────┘         └──────────────┘

Discovery: mDNS / UDP broadcast
Transport: WebRTC (data channels) or raw UDP
Auth: Pre-shared LAN token or QR code pairing
Data: Cached channels + messages, real-time sync
```

The server API at `/lan` already exists (`wabi-server/src/api/lan.rs` — local route tokens). This would use that foundation.

---

## Implementation Phases

| Phase | Layer | Effort | When |
|-------|-------|--------|------|
| **P1** | Boot Survival | Small (1-2 days) | This sprint |
| **P2** | Read Cache | Medium (1-2 weeks) | Next sprint |
| **P3** | Local Actions | Large (2-4 weeks) | Future |
| **P4** | LAN Mesh | Very large (4-8 weeks) | Future |

### P1 — Boot Survival (This Sprint)

1. Add `wabi_has_logged_in` flag in `Login.svelte` and logout handlers
2. Add reconnect state to boot shell in `app.html`
3. Modify auth logic in `+page.svelte` for the `hasLoggedInBefore && !hasSession` branch
4. Add retry logic with `setInterval` + `window.addEventListener('online', ...)`
5. Add "Work Offline" button to boot shell
6. Enter offline mode on click — dismiss boot shell, show MainLayout with offline indicator

---

## File Map

### Layer 1 (this sprint)

| File | Change |
|------|--------|
| `src/app.html` | Add reconnect state + "Work Offline" button to boot shell |
| `src/routes/+page.svelte` | Add `wabi_has_logged_in` check, retry logic, offline mode entry |
| `src/lib/components/Login.svelte` | Set `wabi_has_logged_in` on success |
| `src/lib/components/MainLayout.svelte` | Show offline banner when `isOffline` |
| `src/lib/components/Settings.svelte` | Clear `wabi_has_logged_in` on explicit logout |

### Layer 2 (future)

| File | Change |
|------|--------|
| `src/lib/storage/chatStorage.ts` | IndexedDB write-on-receive for messages |
| `src/lib/storage/cache.ts` | LRU eviction, storage limits |
| Service worker | Cache-first for static assets |

### Layer 3 (future)

| File | Change |
|------|--------|
| `src/lib/storage/actionQueue.ts` | Offline action queue |
| `src/lib/sync/syncEngine.ts` | Replay queued actions on reconnect |

---

## Principles

1. **Never show login to a returning user.** The `wabi_has_logged_in` flag is the gate. Once set, login screen is unreachable unless user explicitly logs out.
2. **Boot shell is the fallback UI.** If we can't reach the server, stay in the shell with a "Work Offline" option. Don't show a broken or empty state.
3. **Cache is a side effect of normal operation.** Messages go to IndexedDB as they arrive. No separate sync pass needed.
4. **Offline is a first-class mode.** Not an error state. UI shows what's available and clearly indicates what's pending.
5. **LAN mesh is the north star.** The architecture should eventually support fully decentralized local communication.
