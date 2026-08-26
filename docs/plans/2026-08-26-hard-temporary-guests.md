# 2026-08-26 — Hard-Temporary Guests (Tombstone Deletion)

## Problem

Every `POST /api/auth/guest` created a **permanent** user row in WabiDB
(`handle_guest` → `create_user(username, None, "")`), and nothing ever removed
it. WabiDB had no `delete_user` at all. The admin roster listed every user, so
historical guests accumulated forever as `Guest_<uuid>` + Role rows.

Decision: guests are hard-temporary. No persistence without registering — a
guest identity dies when its last socket disconnects.

## Design

WabiDB dispatches each event type to exactly ONE projection handler (duplicate
registration is a startup error in `DispatchTable::new`), so cascades cannot be
spread across projections by re-subscribing. Instead a dedicated handler owns
the new event and performs cross-index cleanup itself.

### New event: `user_deleted`

- Payload: postcard-encoded `wabidb::domain::UserDeleted { user_id: u64 }`.
- Owner: `projections/user_deletion.rs` → `UserDeletionProjection`.
- Cascade performed inside its `apply()`:
  - `users` — remove the account row (`user_id.to_be_bytes()` key).
  - `channel_members` — full index scan, collect keys whose record matches the
    user, then remove (key is `[len][channel_id][user_id LE]`, not
    user-prefixable).
  - `dm_identities` — BE-user prefix scan + remove of all device bundles.
- Messages authored by deleted guests are intentionally kept; the frontend
  renders them through its guest fallback when the author row is missing.

### Store surface

- Trait: `WabiStore::delete_user(user_id)` (+ read-only stub on
  `LocalWabiStore`).
- Adapter: emits via `run(0, "delete_user", "users", "user_deleted", 6, …)` —
  same emit shape as `create_user`.

### Reap triggers (wabi-server)

1. **Final disconnect** — `presence.rs::on_disconnect`: after removing the
   socket from `connected_users`, if no remaining entry shares the
   `db_user_id`, re-fetch the row and delete it only if
   `password_hash.is_empty()`. Broadcasts `user-deleted { dbUserId }`.
2. **Periodic reconciliation** — `shared.rs::reap_disconnected_guests`, called
   from `spawn_sweep_loop` each minute: deletes every empty-password-hash user
   with no live socket that is past `GUEST_REAP_GRACE_MICROS` (5 min after
   creation). Safety net for missed disconnects / stale-socket sweeps.
3. **Boot sweep** — the same reconciliation runs once ~60 s after sweep-loop
   start, clearing all accumulated `Guest_*` rows from previous processes
   (delay lets restart-reconnects land first).

Guard rails: registered accounts are never touched (password-hash check at
reap time, re-read fresh from the DB); fresh guests get a 5-minute grace window
so the REST→socket-connect gap can't get them reaped before their first socket.

## Tests

- wabidb `projections/user_deletion.rs`: row removal, bystander isolation,
  membership cascade across channels, DM identity cascade across devices,
  unknown-user noop, corrupt-payload error.
- wabi-server `tests/guest_tombstone.rs`: tombstone removes row +
  memberships while leaving registered users intact; tombstone survives
  engine close/reopen (replay durability).

## Consequence for refresh

Guest tokens live in sessionStorage, which survives a page refresh — but after
this change the restored JWT points at a deleted row, fails auth with
"user not found", and the client lands back as a fresh guest. That is the
intended product behavior: persistence requires registration.
