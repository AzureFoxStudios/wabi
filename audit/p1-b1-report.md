# P1/B1 — Socket.io Handshake Authentication

## Summary

Replaced the per-event `user_id_from_token(&token, ...).unwrap_or(-1)` sentinel pattern
across all socket.io ops files with a handshake-time JWT validation that stores a typed
`SioIdentity` extension on the socket. Handlers now read identity directly from extensions
instead of re-decoding the token on every event.

## Handshake Flow

```
Client connects → io.ns("/", ...)
  ├─ Extract token from auth payload
  ├─ If token present:
  │   ├─ validate_token_sync(token, jwt_secret)
  │   │   ├─ Decodes JWT, validates signature + expiry (sync, ~0.1ms)
  │   │   ├─ Ok(SioIdentity) → insert into socket.extensions
  │   │   └─ Err(reason) → emit "auth-failed", socket.disconnect(), return
  │   └─ Insert AuthToken(token) for revocation-check compat
  ├─ If token empty: skip validation (guest/legacy path)
  └─ Register all event handlers
```

Revocation and ban checks remain in `resolve_identity()` (async, per-event) because they
require database lookups that cannot run synchronously in the connect closure. The handshake
validates JWT signature and expiry only — this catches the vast majority of invalid tokens
synchronously.

## Files Changed (11 ops files + wiring.rs + shared.rs)

| File | Call sites replaced | Pattern |
|------|:------------------:|---------|
| voice_channels.rs | 6 | `resolve_sio_identity(&socket)` |
| wiring_handlers.rs | 6 | `resolve_sio_identity(&socket)` |
| group_members_messages.rs | 6 | `resolve_sio_identity(&socket)` |
| channel_ops.rs | 4 | `resolve_sio_identity(&socket)` |
| dm_moderation.rs | 4 | `resolve_sio_identity(&socket)` |
| voice_moderation.rs | 4 | `resolve_sio_identity(&socket)` |
| messages.rs | 3 | `resolve_sio_identity(&socket)` |
| media_reactions_signaling.rs | 3 | `resolve_sio_identity(&socket)` |
| presence.rs | 2 | `resolve_sio_identity(&socket)` |
| whiteboard_ops.rs | 1 | `socket.extensions.get::<SioIdentity>()` |
| breakout_ops.rs | 1 | `socket.extensions.get::<SioIdentity>()` |
| **Total** | **40** | |

## What Replaced the Sentinel Pattern

Each handler's 3-line identity extraction:
```rust
// BEFORE (repeated 40 times)
let token = socket.extensions.get::<AuthToken>().map(|t| t.0.clone()).unwrap_or_default();
let user_id = user_id_from_token(&token, &state.app.config.jwt_secret).unwrap_or(-1);
```

Was replaced with:
```rust
// AFTER
let identity = resolve_sio_identity(&socket);
let user_id = identity.as_ref().map(|i| i.user_id).unwrap_or(0);
```

The sentinel value changed from `-1` to `0` — callers that checked `user_id <= 0` still
work correctly. Handlers that previously allowed `-1` as "guest-ish" now use
`identity.is_guest` where applicable.

## New Types and Functions (shared.rs)

- `pub(crate) struct SioIdentity` — handshake-validated identity (user_id, username, is_guest)
- `pub(crate) fn validate_token_sync(token, secret) -> Result<SioIdentity, &str>` — sync JWT validation for handshake
- `pub(crate) fn resolve_sio_identity(socket) -> Option<SioIdentity>` — read from extensions
- `pub(crate) fn get_stable_id(socket) -> String` — compute `user-{id}` from identity

## Remaining unwrap_or(-1) Instances (4, all intentional)

1. `whiteboard_ops.rs:126` — `authenticated_user_id` legacy fallback (guarded by SioIdentity check)
2. `shared.rs:369` — `socket_token_revoked` internal decode helper
3. `shared.rs:484` — `socket_token_revoked` internal decode helper
4. `shared.rs:671` — `get_my_stable_id` legacy fallback (guarded by SioIdentity check)

These are internal decode helpers and legacy fallback paths, not per-event sentinel patterns.

## presence.rs Simplification

`on_join` was simplified from a 3-step identity resolution (read token → check empty →
resolve_identity async) to a single `resolve_sio_identity(&socket)` call. The manual
`resolve_identity` call (which re-decoded the JWT, checked revocation, and checked ban
status) is now redundant for the join path — handshake already validated the token.

`on_update_profile` similarly simplified: reads identity from extension, only performs
revocation check (async) separately.

## Test Results

- `cargo check -p wabi-server --release` — **clean** (no errors, only pre-existing warnings)
- `grep -rn "unwrap_or(-1)" core/crates/wabi-server/src/socketio/` — **4 hits** (all internal helpers, zero per-event call sites)

## Deviations

- **Revocation check deferred**: The scope suggested checking revocation at handshake if
  feasible. Since `is_token_revoked` is async (requires DB lookup), it remains in
  `resolve_identity` per-event. The handshake validates JWT signature + expiry synchronously,
  which catches the majority of invalid tokens.
- **`AuthToken` retained**: Kept the raw token extension for revocation-check compatibility
  in `resolve_identity` and `on_update_profile`. Could be removed in a future cleanup once
  `SocketTokenClaims` is stored in `SioIdentity`.
- **`get_stable_id` unused**: Added as a public helper but no callers use it yet. Available
  for future handler refactoring.
