---
name: wabidb-client-frontend
description: Client-side WabiDB work in the SvelteKit frontend (frontend/src/lib/wabidb/). Covers the IndexedDB outbound-queue store, scope registry, and the "Offline & Storage" settings wiring. Use when reviewing, fixing, or extending the WabiDB client abstraction, the outbound action queue, scope enable/disable, or the StorageSettings offline UI. Also applies when verifying that an "integration done" OpenCode/agent claim is real vs dead imports + orphaned i18n.
version: 1.0.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [WabiDB, frontend, sveltekit, indexeddb, offline, queue]
    related_skills: [wabi-deploy-debug, opencode]
---

# WabiDB Client (frontend/src/lib/wabidb/)

Client-side offline-first layer for Wabi. v1 ships a **scaffolding-only** abstraction:
`types.ts` (interfaces), `index.ts` (`WabiDBImpl` singleton + `openWabiDB`/`getWabiDB`),
`scopes/` (registry + corechat/system descriptors), `queue/` (manager + db),
`backend/` (detect → always 'indexeddb'; sqlite stub throws), `migration/legacy.ts` (empty).

## Architecture facts (durable)

- **One logical DB, many backends.** v1 only uses IndexedDB (web + Tauri both). SQLite stub
  exists at `backend/sqlite.ts` but is never selected — `backend/detect.ts` always returns
  `'indexeddb'`. Don't wire the SQLite path in v1.
- **Queue is a dedicated IndexedDB object store** named `outbound_queue` (DB `wabi-queue`,
  version 1), created in `queue/db.ts`. It is NOT shared with the settings/localStorage store.
- **Scope state persists in localStorage**: `wabi_scopes_v1` (descriptors) and
  `wabi_scope_state_v1` (enabled/backend per scope). Scope enable/disable is durable via
  these keys — verify in the browser by checking `localStorage.wabi_scope_state_v1`.
- **Opt-in philosophy preserved.** CoreChat defaults: drafts + queue always on, history opt-in.
  System always on. Nothing is offline-durable until the user/admin enables the scope.
- **`+layout.svelte` boots WabiDB**: `openWabiDB()` on mount, `retryFailed()` at boot, and a
  `window 'online'` handler that drains the queue; listener removed onDestroy. This is the
  only working wiring in v1.
- **v1 no-op methods (intentionally stubbed):** `put`, `get`, `query`, `getUsage` (returns
  zeros), `estimateDownload` (returns 0). Do NOT fake non-zero numbers in the UI for these.

## CRITICAL GOTCHA — IndexedDB keyPath mismatch (the queue-killer)

`queue/db.ts` creates the store with `{ keyPath: 'key' }`. A **keyPath store ignores the
explicit key argument** passed to `store.put(value, key)` — IndexedDB reads `value.key`
instead. If the serialized record has no `key` field, every `put()` throws `DataError`.

This exact bug shipped in the original scaffolding: `QueueManager._serialize()` returned a
`QueuedAction` with no `key`, so `enqueue`/`markSynced`/`retryFailed`/`clearScope` ALL threw,
while `getAll()` silently returned `[]` — the `+layout.svelte` integration therefore no-op'd
with no error. The queue was 100% non-functional yet `svelte-check` was clean.

**The fix (verified working):**
- In `QueueManager._serialize()`, add `key: \`${action.scopeId}:${id}\`` to the returned record.
- Change `db.put` to `store.put(value)` (drop the explicit key arg). The store reads `value.key`.
- `get`/`delete` already compute the same `${scopeId}:${id}` key, so they round-trip.

**Rule for any IndexedDB store you touch:** if the store has a `keyPath`, every written record
MUST carry that field; OR create the store with no keyPath and always pass the key to `put`.
`svelte-check` / `tsc` will NOT catch this — it is a runtime IDB error. There is no unit test
in v1 for the queue, so manual browser verification (or a tiny IDB round-trip script) is the
only proof.

## SECOND GOTCHA — MAX_QUEUE_SIZE is not enforced by age-pruning alone

Original `enqueue` called `prune()` when `size >= MAX_QUEUE_SIZE`, but `QueueDB.prune()` only
removes by AGE (30d, `MAX_QUEUE_AGE_MS`). >10k *recent* items still write. Fix: add
`QueueDB.trimToSize(maxSize)` that deletes the oldest `(len - maxSize)` records by `createdAt`
(FIFO), and call it after age-prune if still over cap. Net stays ≤ limit.

## VERIFYING AN "INTEGRATION DONE" CLAIM (agent self-reports lie)

When any agent (OpenCode, subagent, or a prior session) says it "wired WabiDB into ComponentX
and added i18n", do NOT trust the import line or the i18n JSON block as proof:

1. **Dead imports.** Grep the component BODY (script + template) for actual call sites
   (`getWabiDB(`, `listScopes(`, `retryFailed(`). If the import is present but uncalled, the
   integration is incomplete. Either finish it or remove the unused import.
2. **Orphaned i18n.** Grep the whole `frontend/src` tree for components referencing the new
   keys (e.g. `offline.`). If the i18n block exists but nothing renders it, it's dead weight.
3. **Runtime proof.** `svelte-check` passing does NOT mean the feature works — IDB errors and
   dead UI both pass typecheck. Confirm via the user's real browser: open the Offline & Storage
   screen, check scopes list renders (CoreChat opt-in / System always-on), queue counts show,
   Retry button works, and toggles persist to `localStorage.wabi_scope_state_v1`.

## Review checklist (when asked to review WabiDB client work)

- [ ] Queue records carry `key` field matching the store `keyPath` (no DataError on put).
- [ ] `enqueue` enforces MAX_QUEUE_SIZE by count, not just age.
- [ ] `_safeSerialize` guards circular refs / functions (returns `{ __unsafe: true, ... }`).
- [ ] `retryFailed()` respects MAX_FAILED_AGE_MS (no infinite dead-letter retry loop).
- [ ] Immutable record updates (spread, not in-place mutation) in manager.
- [ ] `close()` / `prune()` cleanup called (WabiDBImpl.close → queue.prune).
- [ ] StorageSettings (or other UI) actually RENDERS scopes + queue + usage, not just imports.
- [ ] i18n keys used by the UI exist in BOTH en.json and es.json (symmetric).
- [ ] No forbidden files touched (v1 scope excludes server Rust, docker, vite, +layout.svelte).

## OPTION 3 — real offline send-message enqueue + drain (verified 2026-07-25)

The queue is only useful once a write path actually enqueues. Verified pattern:

- `messageStore.ts` `sendMessage` becomes `async`; after `appendOptimisticMessage`, if
  `getWabiDB()` exists AND `!get(connected)`, `await db.enqueue({ scopeId: 'corechat',
  type: 'send-message', payload: { channelId, text, type, clientMessageId, ...options } })`,
  flag the optimistic message `deliveryState: 'failed'` + `deliveryError: 'Queued — will
  send when online'`, then `return` (do NOT `sock.emit` while offline). Online path unchanged.
- NEW `frontend/src/lib/wabidb/drain.ts` `drainOutboundQueue()`: guards on `getWabiDB()` +
  `getSocket()` + `get(connected)`; sorts pending by `createdAt`; for `type==='send-message'`
  replays `sock.emit('message', action.payload)` then `markSynced(action.id)`; breaks on error.
- Wire `drainOutboundQueue()` in EXACTLY two places: `socketConnectionCore.ts` `'connect'`
  handler (fire-and-forget) and `+layout.svelte` `'online'` handler (after `retryFailed()`).
- Reconcile on accept: in `'message-accepted'`, after the existing `_updateOptimisticMessage`,
  call `getWabiDB()?.markSyncedByClientId(payload.clientMessageId)`. `markSyncedByClientId`
  lives on `QueueManager` + `WabiDBImpl` only — NOT the `WabiDB` interface — so the forbidden
  `backend/sqlite.ts` stub is never forced to implement it. Match on embedded `clientMessageId`
  (the queue record id is a UUID we generated, not the clientMessageId).
- Other send paths (ForwardDialog, ShareToChannelModal, LiveChannelView) still emit directly
  and do NOT enqueue — extend later.

### SCOPE-DRIFT RECOVERY (worker over-edited a dirty file — real incident)

The option-3 worker was allowed `socketConnectionCore.ts` for ONLY two edits, but added ~81
lines of unrelated logic (`normalizeIncomingChannel`, username-race guard in `connect()`,
`switchChannel` calls). It even claimed "no forbidden file touched" — false. Recovery used:
1. `git diff frontend/src/lib/socketConnectionCore.ts | git apply --reverse` (undo the worker's
   whole change to that file; restores pre-dispatch dirty state, preserving other in-progress
   edits in the same file).
2. Re-apply ONLY the two scoped edits with fresh line context via the `patch` tool.
3. Verify: `git diff <file> | grep -cE "^\+"` → 10 (not 81); grep for drift markers → empty.
4. `npm run check` → still 2 pre-existing errors / 90 warnings (no new).
Always `git diff` each allowed file after a worker exits and reverse+re-apply on drift. The
worker's self-report of scope is not reliable (see "VERIFYING AN INTEGRATION DONE CLAIM").

## Out of scope for v1 (see wabidb-client-offline-plan.md for v2/v3)

Blobs (putBlob/getBlob), FTS in queue, Media/Maps/Knowledge/Models/AddonData scopes,
SQLite Tauri backend, real encryption-at-rest, real getUsage/estimateDownload numbers.

## Verification recipes

`references/indexeddb-queue-verification.md` — a browser-console IDB round-trip probe, the
"integration done" grep recipe, and the `npm run check` baseline for Wabidb client work.

## Runtime verification note (Wabi frontend is unrenderable headless)

Headless Chromium (chrome-headless-shell) crashes on Wabi with a Skia font error
(`SkFontMgr_FontConfigInterface Not implemented`) — for BOTH minified and unminified builds.
Verify Wabi frontend changes ONLY in Ronin's real browser. Use headless only for non-rendering
HTTP/route checks. (See wabi-frontend SPA note: the Rust server serves `adapter-static`
index.html; `terser` minification breaks the Svelte store runtime, so vite uses esbuild.)
