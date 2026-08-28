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
| `AuthUser` | `Authorization: Bearer <token>` | Write endpoints (create, update, delete) |
| `OptionalAuthUser` | Optional Bearer token | Read endpoints that personalize results |

`AuthUser` has `user_id: i64` and `username: String`.

**Read (public)**: no auth extractor
**Write (auth required)**: `auth: AuthUser` in the handler signature

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

Admin handlers use `admin_auth(&headers, &state)` (Bearer token + role check) or `admin_auth_stepup` (also requires `X-Stepup-Token` from `POST /api/auth/stepup`). Destructive ops like revoke/transfer-ownership use stepup — BUT `reset_user_password` uses plain `admin_auth` because the frontend admin UI sends no stepup token (no frontend stepup flow exists anywhere yet).

### Admin user password reset (2026-08-06)

`POST /api/admin/users/reset-password` — body `{ targetUserId, newPassword, temporary? }`. Pattern: `admin_auth` → validate ≥6 chars → `get_user` (404 if missing, 400 if guest-only/empty hash) → `bcrypt::hash` → `state.wdb.update_user(user_id, UserUpdate { password_hash })` → `state.revoke_user(user_id)` → `{ success: true }`. The frontend called this endpoint for a long time before the backend implemented it (dead-API gap). `POST /api/admin/users/clear-login-lockout` is an honest no-op (no lockout store exists server-side).

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
