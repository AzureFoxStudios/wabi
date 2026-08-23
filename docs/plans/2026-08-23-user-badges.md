# 2026-08-23 — User Badges (assignable, event-sourced)

Adds user-assignable badges rendered next to names across the frontend,
mirroring the existing RBAC architecture end-to-end. No postcard-encoded
records were modified — the badge domain has its own projection index
(golden rule 5 satisfied by construction).

## WabiDB

- New projection `core/crates/wabidb/src/projections/badges.rs`
  (`BadgesProjection`), registered in `build_type_registry()`:
  - Event types: `badge_assigned`, `badge_removed`
  - Index: `user_badges`, keyed `(user_id u64 LE ++ len-prefixed badge_id)`
  - Record: `UserBadgeRecord { user_id, badge_id, assigned_by, assigned_at_micros }`
    — serde JSON encoded (payloads arrive as JSON via the adapter's generic
    ingest funnel; removal deletes the key so replay is idempotent).
- `WabiStore::list_user_badges(user_id)` trait method with default `Ok(vec![])`;
  overridden in the `WdbAdapter` to prefix-scan the live index.

## wabi-server

- `ingest_event("badges", "assign_badge" | "remove_badge", payload)` routes
  through `WdbAdapter::run(...)` into stream `badges:user-{id}` (durable).
- Socket commands (socketio/badges_ops.rs), all admin-gated via
  `AppState::is_admin`:
  - `get-badge-catalog` → emits `badge-catalog`
  - `assign-badge { targetUserId, badgeId }` → fanout `user-badges-updated
    { userId: "user-{id}", dbUserId, badges: [{ id, icon, label }] }`
  - `remove-badge { targetUserId, badgeId }` → same fanout shape
- Static catalog `BADGE_CATALOG` (id/icon/label). Role-derived badges
  (owner/admin/mod/staff/bot) are intentionally NOT in the catalog; they
  render client-side from `highestRole`.
- User views now include `"badges": [{ id, icon, label }]`:
  - presence.rs profile-view builder
  - shared.rs `connected_user_to_view`
- Pre-existing main breakage fixed en route: `api/steam.rs` now defines
  `SharedHttpClient` / `shared_http_client()` expected by `state.rs`, and the
  fetch path uses the shared client instead of building one per request.

## Frontend (Phase 2b)

Consumes `badges` on `UserView`, renders via a shared RoleBadge component
(role-derived tones + assignable icons), assignment UI in admin surfaces.

## Tests

- `cargo test -p wabidb badges` — 5 unit tests (assign/list, idempotent
  removal + replay, reassign overwrite, junk-payload skip, record roundtrip)
- `cargo test -p wabi-server` — 227 existing tests green.
