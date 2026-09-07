---
name: wabidb-client-offline
description: "Client-side WabiDB offline queue and scope registry in frontend/src/lib/wabidb. Use when changing outbound queueing, reconnect replay, group intent cancellation, IndexedDB queue transactions, or Offline & Storage settings."
metadata:
  version: 1.2.0
  author: Hermes
  platforms: [linux, macos, windows, web]
  hermes:
    tags: [WabiDB, Frontend, Offline, IndexedDB, SvelteKit, Queue]
---

# WabiDB Client Offline Layer

This is the shared browser/Tauri **client queue**, not the Rust event-sourced
engine. Source-verified 2026-09-08. The IndexedDB outbound queue is real, but
`WabiDBImpl.put/get/delete/query` are still scaffolds. Do not claim complete
offline projections or that every emit is safely queued. The SQLite backend
file exists, throws unsupported errors and is not selected by default.

## Ownership and files

- `types.ts`: client interface, scopes and JSON/structured-cloned QueuedAction.
- `index.ts`: `openWabiDB/getWabiDB` singleton and delegation.
- `queue/manager.ts`: scoped enqueue, status changes, durable message claims.
- `queue/db.ts`: IndexedDB `wabi-queue/outbound_queue`, keyPath `key`.
- `queue/groupPolicy.ts`: online-only membership and stale group intent policy.
- `drain.ts`: serialized draining, connection/authority rechecks, message receipt
  handling. Do not reintroduce parallel drains or emit-then-success for messages.
- `scopes/registry.ts`: localStorage scope descriptors/preferences.
- `StorageSettings.svelte`: queue counts, retry and scope UI.
- `../storage.ts` / `../storageDb.ts`: settings-only access for existing
  server-scoped Planner preferences. No current incoming-message archive pipeline.

## Group intent is versioned, not blindly replayable

Group create/add/kick/leave are **online-only commands** handled by
`groupOperations.ts` and `groupOperation.ts`. They wait for the correlated
application result, not an emit receipt. Old queued membership/avatar actions
are permanently failed for review; `retryFailed` must not re-enable them.

New queue entries capture `authority.realm` (normalized server + JWT subject)
before storage awaits. Group content also captures the exact string
`membershipRevision` from `groupMembership.ts`. This is a local stale-work
fence, NEVER server authorization. Another realm's entries defer. Group content
waits for authoritative init and requires the same revision; missing legacy
context, removal, or remove/re-add invalidates it. Do not stamp authority during
drain: that would silently adopt another account's old intent.

Group mutation helpers and all clients must ship with the versioned backend.
See `docs/plans/2026-09-07-group-membership-revocation.md` for the actual contract
and actual verification/release status.

## Legacy archives are quarantined, not migrated

The old ChatStorage implementations, delayed archive cache, archive export UI and
Tauri chat-sidecar bootstrap were retired after a headful regression exported a
removed group's unowned archive. Neither native entry point registered the
sidecar commands, and no current inbound caller populated those archives. Do not
restore a fake history/autosave toggle or build a parallel store to satisfy an
obsolete roadmap.

Old `wabi-chat-db` and server-scoped database `messages` stores stay untouched:
their account ownership cannot be proven, so the app must not load/export them,
adopt them for the current login, trim or delete them automatically. No purge of
unowned user data is claimed. `LocalSettings` opens only `settings`; the directory
barrel re-exports the same singleton. Existing Planner preferences remain
server-scoped, not newly account-private. Settings writes acknowledge transaction
completion; request success followed by abort is a failure.

New managed chat history would need an explicit ingestion contract, server/account
ownership, membership-incarnation fences on persisted reads/writes/exports, and
an authorized legacy recovery design. The supported outbound queue is not that
history. `StorageSettings.svelte` says so, displays real queue results/errors and
does not render the scaffold usage estimate as measured storage. Its translation
keys live under `storage.offline`, not the nonexistent root `offline` namespace.
Run `node scripts/storage-boundary-browser-smoke.mjs` for real IndexedDB + Settings
coverage in browser and simulated native modes; it does not prove native WebView.

Call recovery is **not** owned by this optional queue. SocketManager notifies
call owners after authoritative init; owners await device/voice admission and
rebuild relays on the new socket object. Do not restore the old post-drain
`rejoinWabidbCallRooms` hook or infer roster completion from emit ordering.
Voice join/subscribe/leave/unsubscribe and transmit-mode actions are also
ephemeral call intent: new enqueue rejects them; legacy rows fail permanently
with a voice-specific reason. Sidebar subscriptions go through the call owner,
and local unsubscribe still works between socket objects. A queued old leave
must not race a fresh readmission; recovery republishes current routing mode.

## Queue persistence and acknowledgements

Records contain `id/type/scopeId/status/createdAt/payload` plus optional
`retriedAt/error/retryable/authority/attemptedAt`. These are client IndexedDB
records, not Rust postcard records. Preserve `key: scopeId + ':' + id` on every
write: passing a separate put argument does not satisfy an inline keyPath.

Resolve writes on **transaction completion**, not request success.
`QueueDB.updateAction` does read-modify-write in a single transaction;
`claimMessage` uses it so concurrent tabs cannot both send one queued message.
Persist `attemptedAt` BEFORE emit, then recheck the socket and group access.
A crash/lost reply may leave an uncertain attempt. Never automatically replay it:
the server currently echoes clientMessageId but does not use it as a durable
deduplication key.

A queued chat message becomes synced only after `message-accepted`, via the
concrete `getWabiDB().markSyncedByClientId` method. A timeout/uncertain prior
attempt becomes non-retryable failed; a late valid receipt can still confirm an
attempt. Atomic status updates prevent a late timeout overwriting synced.
This proves a server receipt, not independently verified durable message
persistence: the server's separate message-send failure contract needs review.
Non-message legacy dispatches still use their existing emit completion behavior;
do not generalize membership/message guarantees to all action types.

Preserve the 10k queue cap: prune by age first, then trim oldest records if still
full. Preserve non-retryable failures. Do not retry an attempted message merely
because the user pressed the general Retry button.

## Verification

- `bun test src/lib` for pure policy/receipt tests and existing frontend regressions.
- `node scripts/group-membership-browser-smoke.mjs`: real headful Chromium,
  production UI/socket/state helpers, scoped auth, actual IndexedDB transactions,
  desktop CSP; controlled HTTP/socket peer (not live users).
- Run broader calling/browser checks when changing shared imports or reconnect
  ordering. Build static web and Tauri frontend as appropriate; neither proves a
  native WebView or physical microphone/device test.
