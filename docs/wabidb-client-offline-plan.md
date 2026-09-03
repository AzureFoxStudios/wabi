# WabiDB Client & Offline Scopes — Implementation Plan

**Status:** Scaffold Complete (v1), Ready for Integration  
**Author:** WabiDB Offline Enhancement Proposal  
**Related:** offline-first-architecture.md, persistence-policy-plan.md

---

## Philosophy

1. **One logical DB → many backends.** Same API on IndexedDB (web) and SQLite (Tauri/native).
2. **Everything offline is opt-in.** Nothing is durable until the user or admin chooses.
3. **Explicit user actions for large data.** Albums, maps, models, wiki pages require confirmation with size estimates.
4. **Outbound queue is first-class.** Not just drafts — messages, reactions, edits, uploads all queue when offline.
5. **Addons register their own offline needs** through the same `registerScope()` API.
6. **Storage cost and progress are always visible.**

---

## What the v1 PR Delivered

A complete client-side WabiDB abstraction layer in `frontend/src/lib/wabidb/` with 14 new files and zero modifications to existing code.

### Core Components

| Component | File | Purpose |
|-----------|------|---------|
| `types.ts` | `frontend/src/lib/wabidb/types.ts` | All TypeScript interfaces (WabiDB, OfflineScopeDescriptor, QueuedAction, etc.) |
| `index.ts` | `frontend/src/lib/wabidb/index.ts` | `WabiDBImpl` class + `openWabiDB()` singleton factory |
| `scopes/registry.ts` | `frontend/src/lib/wabidb/scopes/registry.ts` | Scope registration, enable/disable, CoreChat + System bootstrap |
| `scopes/corechat.ts` | `frontend/src/lib/wabidb/scopes/corechat.ts` | CoreChat scope descriptor |
| `scopes/system.ts` | `frontend/src/lib/wabidb/scopes/system.ts` | System scope descriptor |
| `queue/manager.ts` | `frontend/src/lib/wabidb/queue/manager.ts` | Outbound action queue (enqueue, listQueue, markSynced, retryFailed) |
| `queue/db.ts` | `frontend/src/lib/wabidb/queue/db.ts` | Standalone QueueDB with dedicated `outbound_queue` IndexedDB store |
| `backend/detect.ts` | `frontend/src/lib/wabidb/backend/detect.ts` | Backend detection (returns `indexeddb` for v1) |
| `backend/sqlite.ts` | `frontend/src/lib/wabidb/backend/sqlite.ts` | Stub SQLite backend (exists but never selected in v1) |
| `migration/legacy.ts` | `frontend/src/lib/wabidb/migration/legacy.ts` | Empty scaffold for future migration logic |

### WabiDB API (v1 partial)

```typescript
interface WabiDB {
  open(options?: { backend?: 'sqlite' | 'indexeddb' | 'auto' }): Promise<void>;
  close(): Promise<void>;
  registerScope(scope: OfflineScopeDescriptor): void;
  enableScope(scopeId: string, options?: EnableOptions): Promise<void>;
  disableScope(scopeId: string): Promise<void>;
  listScopes(): ScopeStatus[];
  put(scopeId: string, key: string, value: any): Promise<void>;       // no-op in v1
  get(scopeId: string, key: string): Promise<any>;                   // no-op in v1
  enqueue(action: QueuedAction): Promise<string>;
  listQueue(filter?: QueueFilter): Promise<QueuedAction[]>;
  markSynced(actionId: string): Promise<void>;
  retryFailed(): Promise<void>;
  getUsage(): Promise<StorageReport>;          // stubbed as zero in v1
  estimateDownload(scopeId: string, items: string[]): Promise<number>;  // stubbed as zero
  clearScope(scopeId: string): Promise<void>;
}
```

### CoreChat Defaults

| Feature | Default |
|---------|---------|
| Message history | **opt-in** (matches existing `saveHistory` flag) |
| Drafts | **always on** |
| Outbound queue | **always on** |

### Backend Strategy

- **Web (v1):** IndexedDB via the existing `storage/indexeddb.ts` wrapper
- **Tauri/native (v1):** IndexedDB (same backend, SQLite stub exists but never selected)
- **Tauri/native (v2):** SQLite via `rusqlite` (backend stub exists at `backend/sqlite.ts`)

---

## Scope Definitions (v1)

| Scope | Default | Contents | User Control |
|-------|---------|----------|--------------|
| `corechat` | opt-in | Message history (opt-in), drafts, outbound queue, presence snapshots, local search index | opt-in |
| `system` | always on | Themes, preferences, emoji/sticker packs, auth/session, storage metadata | always |

### Future Scopes (v2+)

| Scope | Default | Contents |
|-------|---------|----------|
| `media` | opt-in | Photos/albums, attachments, thumbnails + full blobs |
| `maps` | off | Tile regions/packages + metadata |
| `knowledge` | opt-in | Wiki pages + forum threads + attachments |
| `models` | opt-in | 3D models + viewer assets (addon) |
| `addonData` | per-addon | Namespaced store any addon can register |

---

## Architecture

```
App Code
  ↓
WabiDB (openWabiDB())
  ↓ ├── Scope Registry (which scopes exist, enabled?)
  ├── Queue Manager (outbound actions, sync on reconnect)
  └── Backend (IndexedDB on web, SQLite on Tauri)
        ↓
  IndexedDB ("wabi-queue" DB, "outbound_queue" store)
  IndexedDB ("wabi-chat-db:{server}" DB, "messages" + "settings" stores)
  ──────────────────────────────────────────────────────────
  (existing storage code completely untouched)
```

### Queue Lifecycle

1. **Enqueue** — action written to `outbound_queue` IndexedDB store with `status: 'pending'`
2. **Pending** — waits until connectivity returns
3. **Sync** — on `online` event, `retryFailed()` resets failed actions, queue drains FIFO
4. **Ack** — `markSynced(actionId)` sets `status: 'synced'`
5. **Fail** — if server rejects, action stays `'failed'` for retry (max 24h age)

### Safety Guarantees

- **Queue size bound:** `MAX_QUEUE_SIZE = 10,000` with auto-prune on overflow
- **Failed action TTL:** `MAX_FAILED_AGE_MS = 24h` — stale failures auto-evict
- **Queue age TTL:** `MAX_QUEUE_AGE_MS = 30 days` — old entries auto-prune
- **Serialization safety:** `_safeSerialize()` catches circular refs, functions, and non-serializable payloads
- **Immutable updates:** queue records use spread instead of in-place mutation

---

## What's Stubbed or Not Yet Implemented

| Method | v1 Behavior | v2 Plan |
|--------|-------------|---------|
| `put(scopeId, key, value)` | no-op | IndexedDB (web) / SQLite (Tauri) |
| `get(scopeId, key)` | returns `undefined` | Typed read from scope storage |
| `delete(scopeId, key)` | no-op | Delete from scope storage |
| `query(scopeId, query)` | returns `[]` | IndexedDB cursor or SQLite query |
| `putBlob(scopeId, id, blob, meta)` | not yet | Blob store in IndexedDB or SQLite BLOB |
| `getBlob(scopeId, id)` | returns `null` | Retrieve from blob store |
| `getUsage()` | returns zero | Real size via `navigator.storage.estimate()` |
| `estimateDownload()` | returns zero | Real size calculation from scope |
| SQLite backend | stub (never selected) | Full `rusqlite` implementation for Tauri |
| Blob storage | not yet | Dedicated blob object store |
| FTS/search | not yet | Full-text search in queue and chat |

---

## What Still Needs to Be Done

### Integration (next)
1. Wire `openWabiDB()` into `+layout.svelte` boot sequence
2. Wire `navigator.onLine` / `online` event → `retryFailed()` queue drain
3. Build "Offline & Storage" settings UI screen
4. Implement real `getUsage()` with `navigator.storage.estimate()`

### V2 Features
5. Implement SQLite backend (`backend/sqlite.ts` → real `rusqlite` Tauri commands)
6. Implement `put`/`get`/`query` for CoreChat scope (move beyond no-op)
7. Implement `putBlob`/`getBlob` for Media scope
8. Add remaining scopes (media, maps, knowledge, models, addonData)
9. Implement queue FTS for search
10. Add encryption at rest for queue data

### V3 Features (future)
11. LAN mesh sync (proposal Layer 4)
12. CRDT conflict resolution for queue
13. Storage cost visibility in settings UI with per-scope breakdown

---

## Security & Memory Review Results

The scaffolding was reviewed for bad actors and memory leaks. Issues found and fixed:

| Issue | Severity | Fix |
|-------|----------|-----|
| Unbounded queue growth | HIGH | `MAX_QUEUE_SIZE = 10000` + auto-prune |
| No failed-action TTL | HIGH | `MAX_FAILED_AGE_MS = 24h` in `retryFailed()` |
| Non-serializable payloads | HIGH | `_safeSerialize()` catches circular refs / functions |
| Mutable queue records | MEDIUM | Immutable spread instead of in-place mutation |
| `close()` no-op | MEDIUM | Now calls `queue.prune()` for cleanup |
| No error boundary on queue ops | MEDIUM | Try/catch on localStorage ops |

**No XSS vectors** (no DOM manipulation), **no cross-origin leaks** (IndexedDB is same-origin isolated), **no timer leaks** (zero `setInterval`/`setTimeout`), **no circular reference loops** (linear `WabiDBImpl → QueueManager → QueueDB → IDBDatabase` chain).

---

## Skills Reference

11 wabidb skills updated on disk with client WabiDB sections:

- `wabidb-core-capabilities` — client abstraction overview
- `wabidb-store-trait` — TypeScript↔Rust equivalents
- `wabidb-api-handlers` — client registration pattern
- `wabidb-projection-system` — scope lifecycle mirroring projection lifecycle
- `wabidb-transaction-system` — queue lifecycle, transaction↔queue analogy
- `wabidb-crash-recovery-patterns` — client queue crash resilience
- `wabidb-fuzz-testing-strategies` — client-side fuzz considerations
- `wabidb-storage-format` — client IndexedDB format vs server `.wseg`/`.widx`
- `wabidb-performance-benchmarks` — client queue performance
- `wabidb-power-loss-patterns` — client durability guarantees
- `wabidb-testing-best-practices` — client-side test recommendations

---

## Commit Reference

| Commit | Change |
|--------|--------|
| `e150e5d` | feat: WabiDB client scaffolding — scope registry, outbound queue, IndexedDB backend |
| `1c65312` | fix: WabiDB security hardening — bounded queue, serialization safety, memory fixes |

Both pushed to `origin/main`.