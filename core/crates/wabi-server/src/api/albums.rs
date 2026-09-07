use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::Json,
    routing::{delete, get, put},
    Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

use crate::auth_extractor::AuthUser;
use crate::error::{AppError, Result};
use crate::state::AppState;
use wabidb::engine::wabi_store::WabiStore;

fn album_json(album: &wabidb::domain::Album, item_count: usize, preview_items: Vec<Value>) -> Value {
    json!({
        "id": album.album_id,
        "scope_type": album.scope_type,
        "scope_id": album.scope_id,
        "name": album.name,
        "description": album.description,
        "cover_url": album.cover_url,
        "created_at": album.created_at_micros,
        "updated_at": album.updated_at_micros,
        "owner_user_id": album.owner_user_id,
        "item_count": item_count,
        "preview_items": preview_items,
    })
}

fn item_json(item: &wabidb::domain::AlbumItem) -> Value {
    json!({
        "id": item.item_id,
        "album_id": item.album_id,
        "attachment_url": item.url,
        "attachment_name": item.name,
        "attachment_size": item.size,
        "attachment_mime": item.mime,
        "caption": item.caption,
        "sort_order": item.sort_order,
        "created_at": item.created_at_micros,
    })
}

fn preview_items(items: &[wabidb::domain::AlbumItem]) -> Vec<Value> {
    items.iter().take(4).map(item_json).collect()
}

async fn require_scope(state: &AppState, auth: &AuthUser, scope_type: &str, scope_id: &str) -> Result<()> {
    if !matches!(scope_type, "channel" | "dm") {
        return Err(AppError::BadRequest("Unknown album scope".into()));
    }
    // The channel's persisted kind decides privacy, not the caller's scopeType.
    crate::channel_access::require_access(state, auth.user_id, scope_id).await?;
    Ok(())
}

async fn authorized_album(state: &AppState, auth: &AuthUser, album_id: &str) -> Result<wabidb::domain::Album> {
    // IDs are globally sequence-assigned, but the index is scope-keyed. Resolve
    // the stored parent before accessing items or accepting any mutations.
    let proj = state.wdb.engine().projection_state();
    let mut found = None;
    let mut failure = None;
    proj.for_each("albums", |_key, value| {
        match wabidb::projections::albums::decode_record(value) {
            Ok(r) if r.album_id == album_id && !r.is_deleted => {
                if found.is_some() {
                    failure = Some(AppError::Internal("Duplicate album ID".into()));
                }
                found = Some(wabidb::domain::Album::from(r));
            }
            Ok(_) => (),
            Err(e) => failure = Some(e.into()),
        }
    });
    if let Some(e) = failure { return Err(e); }
    let album = found.ok_or_else(|| AppError::NotFound("Album not found".into()))?;
    require_scope(state, auth, &album.scope_type, &album.scope_id).await?;
    Ok(album)
}

pub fn routes(state: Arc<AppState>) -> Router<Arc<AppState>> {
    Router::new()
        .route("/", get(list_albums).post(create_album))
        .route("/{id}", get(get_album).delete(delete_album))
        .route("/{id}/items", get(list_items).post(add_item))
        .route("/{id}/items/reorder", put(reorder_items))
        .route("/{id}/items/{item_id}", delete(delete_item))
        .route("/{id}/featured", put(set_featured))
        .with_state(state)
}

#[derive(Debug, Deserialize)]
struct ListAlbumsQuery {
    #[serde(alias = "scopeType")]
    scope_type: String,
    #[serde(alias = "scopeId")]
    scope_id: String,
    #[serde(default = "default_limit")]
    limit: u32,
}

fn default_limit() -> u32 {
    100
}

#[derive(Debug, Deserialize)]
struct CreateAlbumPayload {
    #[serde(alias = "scopeType")]
    scope_type: String,
    #[serde(alias = "scopeId")]
    scope_id: String,
    name: String,
}

#[derive(Debug, Deserialize)]
struct AddItemPayload {
    #[serde(alias = "attachmentUrl")]
    attachment_url: String,
    #[serde(alias = "attachmentName")]
    attachment_name: String,
    #[serde(alias = "attachmentSize")]
    attachment_size: Option<i64>,
    #[serde(alias = "attachmentMime")]
    attachment_mime: Option<String>,
    #[serde(alias = "messageId")]
    message_id: Option<String>,
    caption: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ReorderItemsPayload {
    #[serde(alias = "itemIds")]
    item_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct SetFeaturedPayload {
    #[serde(default)]
    featured: bool,
}

async fn list_albums(
    auth: AuthUser,
    State(state): State<Arc<AppState>>,
    Query(query): Query<ListAlbumsQuery>,
) -> Result<Json<Value>> {
    require_scope(&state, &auth, &query.scope_type, &query.scope_id).await?;
    let albums = state.wdb.list_albums(&query.scope_type, &query.scope_id).await?;
    let mut albums: Vec<wabidb::domain::Album> = albums;
    albums.sort_by(|a, b| b.updated_at_micros.cmp(&a.updated_at_micros));
    albums.truncate(query.limit as usize);
    let mut result: Vec<Value> = Vec::with_capacity(albums.len());
    for album in &albums {
        let items = state.wdb.list_items(&album.album_id).await?;
        result.push(album_json(album, items.len(), preview_items(&items)));
    }
    Ok(Json(json!({ "albums": result })))
}

async fn create_album(
    auth: AuthUser,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<CreateAlbumPayload>,
) -> Result<Json<Value>> {
    require_scope(&state, &auth, &payload.scope_type, &payload.scope_id).await?;
    let album_id = state
        .wdb
        .create_album(&payload.scope_type, &payload.scope_id, &payload.name, auth.user_id as u64)
        .await?;
    let album = state
        .wdb
        .get_album(&payload.scope_type, &payload.scope_id, &album_id)
        .await?
        .ok_or_else(|| wabidb::error::WabiError::InternalInvariantViolated {
            invariant: "created album missing after projection acknowledgment".into(),
        })?;
    Ok(Json(json!({ "album": album_json(&album, 0, Vec::new()) })))
}

async fn get_album(
    auth: AuthUser,
    State(state): State<Arc<AppState>>,
    Path(album_id): Path<String>,
) -> Result<Json<Value>> {
    let album = authorized_album(&state, &auth, &album_id).await?;
    let items = state.wdb.list_items(&album.album_id).await?;
    Ok(Json(json!({ "album": album_json(&album, items.len(), preview_items(&items)) })))
}

async fn delete_album(
    auth: AuthUser,
    State(state): State<Arc<AppState>>,
    Path(album_id): Path<String>,
) -> Result<StatusCode> {
    let album = authorized_album(&state, &auth, &album_id).await?;
    if album.owner_user_id != auth.user_id as u64 && !state.is_admin(auth.user_id).await
        && !state.has_role(auth.user_id, "Moderator").await {
        return Err(AppError::Forbidden("Only the album owner or an administrator can delete it".into()));
    }
    state.wdb.delete_album(&album.scope_type, &album.scope_id, &album_id, auth.user_id as u64).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn list_items(
    auth: AuthUser,
    State(state): State<Arc<AppState>>,
    Path(album_id): Path<String>,
) -> Result<Json<Value>> {
    let album = authorized_album(&state, &auth, &album_id).await?;
    let items = state.wdb.list_items(&album_id).await?;
    let sorted = {
        let mut s = items;
        s.sort_by_key(|i| i.sort_order);
        s
    };
    Ok(Json(json!({
        "album": album_json(&album, sorted.len(), preview_items(&sorted)),
        "items": sorted.iter().map(item_json).collect::<Vec<_>>()
    })))
}

async fn add_item(
    auth: AuthUser,
    State(state): State<Arc<AppState>>,
    Path(album_id): Path<String>,
    Json(payload): Json<AddItemPayload>,
) -> Result<Json<Value>> {
    authorized_album(&state, &auth, &album_id).await?;
    let item_id = state
        .wdb
        .add_item(
            &album_id,
            &payload.attachment_url,
            &payload.attachment_name,
            payload.caption.as_deref(),
            auth.user_id as u64,
        )
        .await?;
    let item = state.wdb.list_items(&album_id).await?.into_iter().find(|i| i.item_id == item_id)
        .ok_or_else(|| AppError::Internal("Item missing after projection acknowledgment".into()))?;
    Ok(Json(json!({ "item": item_json(&item) })))
}

async fn delete_item(
    auth: AuthUser,
    State(state): State<Arc<AppState>>,
    Path((album_id, item_id)): Path<(String, String)>,
) -> Result<StatusCode> {
    authorized_album(&state, &auth, &album_id).await?;
    if !state.wdb.list_items(&album_id).await?.iter().any(|i| i.item_id == item_id) {
        return Err(AppError::NotFound("Album item not found".into()));
    }
    state.wdb.delete_item(&album_id, &item_id, auth.user_id as u64).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn reorder_items(
    auth: AuthUser,
    State(state): State<Arc<AppState>>,
    Path(album_id): Path<String>,
    Json(_payload): Json<ReorderItemsPayload>,
) -> Result<(StatusCode, Json<Value>)> {
    authorized_album(&state, &auth, &album_id).await?;
    // v1: reorder_items is not yet implemented through WabiDB.
    // The projection handles sort_order; a future card can add a
    // dedicated reorder event type.
    Ok((StatusCode::NOT_IMPLEMENTED, Json(json!({ "error": "Album reordering is not yet supported" }))))
}

async fn set_featured(
    auth: AuthUser,
    State(state): State<Arc<AppState>>,
    Path(album_id): Path<String>,
    Json(_payload): Json<SetFeaturedPayload>,
) -> Result<(StatusCode, Json<Value>)> {
    authorized_album(&state, &auth, &album_id).await?;
    // v1: set_featured is not yet persisted in the albums projection.
    // A future card can add is_featured to AlbumRecord.
    Ok((StatusCode::NOT_IMPLEMENTED, Json(json!({ "error": "Featured albums are not yet supported" }))))
}
