---
name: wabidb-api-handlers
description: "Learn the wabi-server REST API handler patterns — route registration, auth, payloads, error handling, and all endpoint groups."
---

# WabiDB API Handlers

This skill covers the Axum-based REST API in `wabi-server`, including route registration patterns, authentication extractors, payload deserialization, error mapping, and the handler conventions used across all endpoint groups.

## When to Use

- Adding a new REST endpoint to wabi-server
- Understanding how handlers read/write through `state.wdb`
- Debugging API error responses
- Following the pattern for auth-optional vs auth-required endpoints

## Prerequisites

- Familiarity with Axum web framework
- Understanding of the `WabiStore` trait (see wabidb-store-trait skill)

## Key Files

| File | Purpose |
|------|---------|
| `wabi-server/src/api/mod.rs` | Module declarations |
| `wabi-server/src/api/routes.rs` | Route tree assembly |
| `wabi-server/src/api/*.rs` | Individual handler modules |
| `wabi-server/src/auth_extractor.rs` | `AuthUser` and `OptionalAuthUser` extractors |
| `wabi-server/src/error.rs` | `AppError` enum → HTTP responses |
| `wabi-server/src/state.rs` | `AppState` with `wdb: Arc<WdbAdapter>` |

## Route Registration

### Module Pattern

Each endpoint group has a `routes()` function returning an `axum::Router`:

```rust
// api/wiki.rs
pub fn routes(state: Arc<AppState>) -> axum::Router<Arc<AppState>> {
    axum::Router::new()
        .route("/{channel_id}/pages", axum::routing::get(list_pages).post(create_page))
        .route("/{channel_id}/pages/{page_id}", axum::routing::get(get_page).put(update_page).delete(delete_page))
        .route_layer(axum::middleware::from_fn_with_state(state.clone(), crate::channel_access::require_channel))
        .with_state(state)
}
```

### Route Tree Assembly

In `api/routes.rs`, each module is nested at a path prefix:

```rust
pub fn create_api_router(state: Arc<AppState>) -> Router<Arc<AppState>> {
    Router::new()
        .nest("/auth", auth::routes(state.clone()))
        .nest("/channels", channels::routes(state.clone()))
        .nest("/messages", messages::routes(state.clone()))
        .nest("/albums", albums::routes(state.clone()))
        .nest("/wiki", wiki::routes(state.clone()))
        .nest("/forum", forum::routes(state.clone()))
        .nest("/incidents", incidents::routes(state.clone()))
        .nest("/calls", calls::routes(state.clone()))
        // ...
}
```

### Module Registration

In `api/mod.rs`, each module is declared as `pub mod wiki;`.

## Handler Patterns

### State Access

All handlers extract `AppState` via Axum's `State` extractor:

```rust
async fn list_pages(
    State(state): State<Arc<AppState>>,
    Path(channel_id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let pages = state.wdb.list_wiki_pages(&channel_id).await?;
    Ok(Json(json!({ "pages": pages })))
}
```

### Auth Extractors

Two extractors in `auth_extractor.rs`:

| Extractor | Accepts | When to Use |
|-----------|---------|-------------|
| `AuthUser` | Account JWT or `Bot <token>` | Authenticated reads AND writes; also enforce resource access |
| `OptionalAuthUser` | Optional account credential | Deliberately public resources with optional personalization only |

`AuthUser` has `user_id: i64` and `username: String`.

Do not infer public access from GET/read-only semantics. Channel-content routers
(wiki/forum/gallery/incidents) install `channel_access::require_channel` as a
route layer: every route must have `{channel_id}`. The state-only read handler
example above is safe only behind that guard. For body IDs or different path
shapes, use `AuthUser` plus `channel_access::require_access` before any read,
cache insertion, write or push. Albums resolve their persisted scope first.
Both Dm and GroupDm are membership-only even for owners/admins; never infer
membership from ID spelling or restore an empty-membership DM fallback.
Discovery/self-join of ordinary channels is a separate policy, not content auth.
Check nested IDs against their actual parent before mutations: several adapter
compatibility update methods can upsert missing IDs. Test with a permitted
channel path and another channel's record ID, not only with anonymous requests.

Regression gate: `cargo test -p wabi-server --features addons --test channel_access_contract`
(real Axum + WabiDB + Engine.IO polling, including private event fanout).

Lore external-tool tokens are explicitly **not account credentials**. Only
`api/lore_auth.rs`'s `LoreReadUser`, `LoreWriteUser`, and optional signed-download
variant accept `wblore_…`. They enforce the token's exact channel, current
membership, active registered principal, scope and revocation floors. Keep
account `AuthUser` on token-management, repo-management and code-execution
handlers. Existing role gates still apply after extraction. A new endpoint
must deliberately opt into a scoped extractor; never restore the generic
AuthUser fallback or rely on a method-only middleware guard.

Regression gate: `cargo test -p wabi-server --features addons --test lore_credential_contract`.

Persisted call create/join/leave accept an optional canonical decimal-string
`membership_revision` query fence. Check it under the existing membership read
gate and session lock before mutation, even for an otherwise idempotent request.
The browser pins it across auth retries so delayed writes cannot join/leave a
re-added member's new call. It does not replace resource authorization; omission
retains legacy scope checks. Do not encode this ephemeral request precondition
into postcard call records. `call_state_contract` covers stale create/join/leave.

Socket.IO group consent is ephemeral `account -> admitted socket IDs` in
`GroupCallParticipants`, with account-deduplicated counts. Sender device
admission gates group relay/signaling/recording; disconnect/leave retires that
device, membership removal retires every account device. Do not restore an
account-only set or let a sibling disconnect clear the calling device's consent.
Non-ringing `call-initiate { rejoin: true, membershipRevision }` requires the
original revision under the membership gate, even when rebuilding empty runtime
state. The client must readmit before rebuilding media on a new socket object.
No postcard record changes are involved; `channel_access_contract` covers
unadmitted-device denial, overlapping reconnect, quiet readmission and stale
revision rejection.

```rust
async fn create_page(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(channel_id): Path<String>,
    Json(payload): Json<CreatePagePayload>,
) -> Result<Json<Value>, AppError> {
    // auth.user_id is available
}
```

### Payload Deserialization

Use `#[derive(Deserialize)]` with `#[serde(alias = "camelCase")]` for JS-compatible field names:

```rust
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateIncidentPayload {
    title: String,
    description: String,
    severity: String,
}
```

### Read-Then-Write Pattern

Write handlers follow this pattern:
1. Validate input (optional)
2. Call `state.wdb.create_*(...)` which returns the new ID
3. Read back the created entity
4. Return the entity as JSON

```rust
async fn create_incident(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(channel_id): Path<String>,
    Json(payload): Json<CreateIncidentPayload>,
) -> Result<Json<Value>, AppError> {
    let incident_id = state.wdb.create_incident(&channel_id, &payload.title, &payload.description, &payload.severity, auth.user_id as u64).await?;
    let incident = state.wdb.get_incident(&channel_id, &incident_id).await?
        .ok_or_else(|| AppError::Internal("incident created but not found in projection".into()))?;
    Ok(Json(json!(incident)))
}
```

### Error Handling

`AppError` enum maps to HTTP status codes:

| Variant | HTTP Status | When |
|---------|-------------|------|
| `BadRequest` | 400 | Invalid input |
| `Unauthorized` | 401 | Missing/invalid auth |
| `NotFound` | 404 | Entity not found |
| `Internal` | 500 | Unexpected errors |
| `Wdb(WabiError)` | varies | Database errors |

The `?` operator converts `wabidb::error::WabiError` to `AppError` automatically via `From` impl.

## All Endpoint Groups

| Group | Prefix | Module | Endpoints |
|-------|--------|--------|-----------|
| Auth | `/auth` | `auth.rs` | login, register, token refresh |
| Channels | `/channels` | `channels.rs` | list, get, create, delete |
| Messages | `/messages` | `messages.rs` | list, send |
| Albums | `/albums` | `albums.rs` | list, get, create, delete, add item, delete item |
| Wiki | `/wiki` | `wiki.rs` | list pages, get page, create page, update page, delete page, list revisions, get revision |
| Forum | `/forum` | `forum.rs` | list threads, create thread, list posts, create post, edit post, delete post, vote, mark solution |
| Gallery | `/gallery` | `gallery.rs` | list works, upload work, get work, edit work, delete work, list feedback, add feedback, delete feedback |
| Incidents | `/incidents` | `incidents.rs` | list, get, create, update, resolve |
| Calls | `/calls` | `calls.rs` | create, join, leave, end session, emit signal |
| Upload | `/upload` | `upload.rs` | file upload, profile picture |
| Blobs | `/blobs` | `blobs.rs` | content-addressed blob storage |
| Users | `/user` | `user.rs` | get user, update profile |
| Admin | `/admin` | `admin.rs` | policies (get/save by key), compression config/metrics, runtime guardrails, payment blocks, dashboard stats, revoke user/all/token, transfer-ownership, recovery-codes, **users/reset-password**, **users/clear-login-lockout** |
| Payments | `/payments` | `payments.rs` | provider integration |
| Nodes | `/nodes` | `nodes.rs` | helper node registry |
| Mesh | `/mesh` | `mesh.rs` | multi-node coordination |
| Media | `/media` | `media.rs` | SFU assignment |
| Jobs | `/jobs` | `jobs.rs` | async job queue |
| Standby | `/standby` | `standby.rs` | snapshot receive |
| Sync | `/sync` | `sync.rs` | replication sync |
| LAN | `/lan` | `lan.rs` | local route tokens |

### Admin auth (headers-based)

Admin handlers use admin_auth for shared account-access authentication, revocation
and the owner/admin check; admin_auth_stepup additionally requires X-Stepup-Token.
Do not introduce a signature-only JWT decoder: refresh, pre-auth, scoped Lore
and step-up tokens are not account access credentials. Payments handlers share
this account boundary. Revoke/transfer operations retain step-up. Password reset
does not claim a newly implemented frontend step-up flow.

### Admin user password reset (2026-09-08)

POST /api/admin/users/reset-password takes targetUserId, newPassword and optional
temporary. Authenticate → reject self/owner/guest targets and temporary:true →
validate/hash → await WabiDB user update → revoke target credentials.
The UI offers a permanent reset with confirmation, never a temporary/force-change
promise. The old clear-login-lockout endpoint is a no-op, not a usable recovery
action, and is no longer presented in Settings. Revocation file durability is
separate from the WabiDB password write; do not infer atomicity across them.

### Administrative policy and health contracts (2026-09-08)

Payments access lives in WabiDB at policy:payments_access; Admin and payment
routes use the same resolver/saver and awaited application. Legacy JSON is a
fallback only when truly absent; only an authenticated admin may import it.
Corrupt reads fail closed; explicit empty allowlists never restore permissions.
See docs/architecture/POLICY_SYSTEM.md for exact migration/envelope rules.

GET /api/admin/stats is admin-only. User/channel/audit read failures return 503,
not successful zeros. extra.health contains writer/projection status, monotonic
uptime (fractional seconds), nullable process RSS and string appliedCommitSeq.
committedSeq is null: no trustworthy durable watermark is exposed. recentAudit
is a bounded newest-ten summary of existing role/channel-settings events,
without raw payloads/private conversation names or invented actor/time fields.
This is not moderation-report intake, host monitoring or an integrity scrub.

Socket.IO broadcast note: SocketIo::emit is async in the pinned socketioxide
version; dropping its future sends nothing. Await the post-projection broadcast
and report delivery errors. SocketRef::emit has a different synchronous return
shape. The real Admin browser badge assign/remove checks caught this distinction
in badges_ops.rs; compilation and projection tests alone did not.
Badge mutations use current resolve_identity, not only the cached handshake
identity. Private error/success receipts echo an optional bounded requestId,
targetUserId and badgeId; request correlation is not broadcast to other clients.
The browser confirms the requested badge state through the authoritative update,
and ignores uncorrelated late errors from legacy callers.

Established sockets deliberately outlive access-token expiry to preserve healthy
calls. Their shared revocation lookup verifies the original signature/claims
without checking exp, so expiry cannot hide subject/iat from account/global
revocation floors. New handshakes still reject expired credentials. Invalid
claims fail closed. Individual-jti entries still expire from the existing
revocation store after exp+1h: do not claim indefinite per-token eviction from
the account/global-floor tests. No serialized record was changed for this fix.

## ChannelKind Mapping

When creating channels, the `channel_type` string is mapped to `ChannelKind` in `channels.rs`:

```rust
let channel_kind = match req.channel_type.as_str() {
    "text" | "" => ChannelKind::Text,
    "voice" => ChannelKind::Voice,
    "dm" => ChannelKind::Dm,
    "group_dm" => ChannelKind::GroupDm,
    "announcement" => ChannelKind::Announcement,
    "whiteboard" => ChannelKind::Whiteboard,
    "wiki" => ChannelKind::Wiki,
    "forum" => ChannelKind::Forum,
    "incident" => ChannelKind::Incident,
    _ => ChannelKind::Text,
};
```

## Adding a New Handler Module

1. Create `api/my_feature.rs` with a `routes()` function
2. Add `pub mod my_feature;` to `api/mod.rs`
3. Add `use super::my_feature;` to `api/routes.rs`
4. Add `.nest("/my-feature", my_feature::routes(state.clone()))` to the router
5. Follow the read/write/auth patterns above
