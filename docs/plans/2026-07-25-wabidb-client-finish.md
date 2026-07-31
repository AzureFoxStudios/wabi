# WabiDB Client v1 — Finish Plan (scaffolding → working integration)

**Goal:** Take the v1 WabiDB client scaffolding (commits `e150e5d`, `1c65312`) from
"type-checks but does nothing at runtime" to a **working, reviewable offline-storage
foundation**: a functional outbound queue, a real "Offline & Storage" settings screen,
and correct scope/bootstrap wiring. Evolutionary only — no rewrite of existing stores.

**Author:** Hermes (review of opencode session 2026-07-25T03:20:50)
**Status:** planned, ready to delegate to OpenCode (deepseek-v4-flash-free)

---

## Context / Current state (verified)

Files exist under `frontend/src/lib/wabidb/`:
- `types.ts`, `index.ts` (WabiDBImpl singleton + `openWabiDB`/`getWabiDB`)
- `scopes/registry.ts` (+ `corechat.ts`, `system.ts`)
- `queue/manager.ts`, `queue/db.ts`
- `backend/detect.ts` (always 'indexeddb'), `backend/sqlite.ts` (stub, throws)
- `migration/legacy.ts` (empty)

Uncommitted integration already in the working tree (NOT pushed, entangled with ~50
unrelated dirty files):
- `+layout.svelte` correctly calls `openWabiDB()` on mount, runs `retryFailed()` at boot,
  and wires a `window 'online'` handler that drains the queue; removes it onDestroy. ✅ real.
- `StorageSettings.svelte` imports `openWabiDB`/`getWabiDB` but **uses neither** — dead imports only.
- `i18n/locales/en.json` + `es.json` added an `offline.*` block (42 lines each, symmetric) but
  **no component renders it**.

`npm run check` currently: 2 pre-existing errors (VoiceChannelList 'announcement' type
mismatch, LoreChannel string|number), 90 warnings. Neither error is from wabidb.

---

## CRITICAL BUGS TO FIX (block all runtime function)

### Bug 1 — Queue store keyPath mismatch (queue will throw on every write)
`frontend/src/lib/wabidb/queue/db.ts` creates the object store with
`{ keyPath: 'key' }`, but `QueueManager._serialize()` (queue/manager.ts) returns a
`QueuedAction` with **no `key` field**. On a keyPath store, IndexedDB ignores the explicit
`store.put(value, key)` second arg and instead reads `value.key`, which is `undefined` →
every `put()` throws `DataError`. Net effect: `enqueue`, `markSynced`, `retryFailed`,
`clearScope` all throw; `getAll` silently returns empty, so the +layout integration never
errors and never stores anything.

**Fix (worker's choice, but must round-trip):**
- Option A (preferred, simplest): in `QueueManager._serialize`, add `key: \`${scopeId}:${id}\``
  to the returned record, so the keyPath store has a real key and `get`/`delete` (which
  compute the same key) resolve. Keep `store.put(record)` WITHOUT the explicit key arg.
- Option B: create the store with no keyPath (`createObjectStore(QUEUE_STORE)`) and keep
  `store.put(record, key)`.

Either is fine; must verify a full enqueue → getAll → markSynced → getAll cycle works.

### Bug 2 — 10k cap not actually enforced
`QueueManager.enqueue` calls `prune()` when `size >= MAX_QUEUE_SIZE`, but `QueueDB.prune()`
only removes by AGE (30d). If a user enqueues >10k *recent* items, prune removes 0 and the
write still happens. Add real count-based eviction: when over `MAX_QUEUE_SIZE`, delete the
oldest `(size - MAX_QUEUE_SIZE)` records by `createdAt` (FIFO), or cap the write.

---

## INTEGRATION TO BUILD

### 3. StorageSettings "Offline & Storage" screen (render the dead i18n)
Wire `openWabiDB`/`getWabiDB` for real. Add a section (after the browser section, before the
archive actions) that:
- On mount: `const db = getWabiDB(); if (db) scopes = db.listScopes();`
- Lists each scope: name, `userControl` badge (always-on / opt-in / off),
  enable/disable button (respecting `userControl === 'always'` → disabled + "Always on").
  Enable calls `db.enableScope(id)` / `disableScope(id)`; refresh `scopes` after.
- Shows outbound queue counts by status: `const q = await db.listQueue();` count
  pending/failed/synced; render via `offline.wabiDB.{pending,failed,synced}` + `offline.wabiDB.queue_label`.
- "Retry failed actions" button → `await db.retryFailed();` then refresh counts; toast
  `offline.alerts.retry_success` / `retry_failed`.
- Usage row uses `db.getUsage()` — in v1 this returns zeros, so render
  `offline.wabiDB.usage_label` + "0 B" (or `estimating` then `0 B`). Do NOT fake numbers.
- Use the existing local `formatBytes()` helper already in the file for any byte display.

Use the `offline.*` i18n keys already added (en + es). Follow the file's existing Svelte
style (`.setting-group`, `.btn-primary`, `t(...)` helper, `ConfirmDialog` for destructive
actions). Bind reactive state; do not introduce a new store.

### 4. Remove dead imports if not used
After step 3, the imports WILL be used. If for any reason a piece is dropped, remove unused
imports rather than leaving them. (svelte-check warns but the worker must keep the file clean.)

---

## SCOPE GUARDRAILS (do NOT exceed)
- Files allowed to touch:
  - `frontend/src/lib/wabidb/queue/db.ts`
  - `frontend/src/lib/wabidb/queue/manager.ts`
  - `frontend/src/lib/wabidb/scopes/registry.ts` (only the `enableScope` dead-`force` cleanup)
  - `frontend/src/lib/components/StorageSettings.svelte`
  - `frontend/src/lib/i18n/locales/en.json` + `es.json` (only if a key is missing; they are complete)
- Files MUST NOT touch: all other ~50 dirty files, the Rust server, docker, vite config,
  `+layout.svelte` (already correct — leave it), `backend/sqlite.ts` (stub), `migration/legacy.ts`.
- Do NOT implement blobs/FTS/Media/Maps/Knowledge scopes — that is v2/v3 per the plan doc.
- Do NOT commit. Leave changes in the working tree for Hermes to review + verify.

---

## VERIFICATION (Hermes runs after worker exits)
1. `cd /home/Ronin/wabi/frontend && npm run check` — no NEW errors vs baseline (2 pre-existing).
2. Grep confirm StorageSettings now references `getWabiDB`/`listScopes`/`retryFailed` in body.
3. Confirm no `keyPath: 'key'` + keyless-record mismatch remains (read the final db.ts).
4. Runtime proof (queued for Ronin's real browser, since headless Chromium can't render Wabi):
   - open app, open Offline & Storage screen, confirm scopes list shows CoreChat (opt-in) +
     System (always-on), queue shows 0 pending, Retry button works, toggles persist to
     localStorage `wabi_scope_state_v1`.
   - Note: full offline→online queue drain needs a caller that enqueues; v1 scaffolding has
     no enqueue caller yet, so this is verified by the settings UI + the +layout online handler
     being present, not by a live network-drop test.

## SUCCESS = build-clean + settings UI real + queue round-trips + no unrelated files touched.
