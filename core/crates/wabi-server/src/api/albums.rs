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

use crate::auth_extractor::{AuthUser, OptionalAuthUser};
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
    _auth: OptionalAuthUser,
    State(state): State<Arc<AppState>>,
    Query(query): Query<ListAlbumsQuery>,
) -> Result<Json<Value>> {
    let albums = state.wdb.list_albums(&query.scope_type, &query.scope_id).await?;
    let mut albums: Vec<wabidb::domain::Album> = albums;
    albums.sort_by(|a, b| b.updated_at_micros.cmp(&a.updated_at_micros));
    albums.truncate(query.limit as usize);
    let mut result: Vec<Value> = Vec::with_capacity(albums.len());
    for album in &albums {
        let items = state.wdb.list_items(&album.album_id).await.unwrap_or_default();
        result.push(album_json(album, items.len(), preview_items(&items)));
    }
    Ok(Json(json!({ "albums": result })))
}

async fn create_album(
    auth: AuthUser,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<CreateAlbumPayload>,
) -> Result<Json<Value>> {
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
    _auth: OptionalAuthUser,
    State(state): State<Arc<AppState>>,
    Path(album_id): Path<String>,
) -> Result<Json<Value>> {
    use wabidb::projections::albums;
    let proj = state.wdb.engine().projection_state();
    let mut found: Option<wabidb::domain::Album> = None;
    proj.for_each("albums", |_key, value| {
        if found.is_some() {
            return;
        }
        if let Ok(r) = albums::decode_record(value) {
            if r.album_id == album_id {
                found = Some(wabidb::domain::Album::from(r));
            }
        }
    });
    match found {
        Some(album) => {
            let items = state.wdb.list_items(&album.album_id).await.unwrap_or_default();
            Ok(Json(json!({ "album": album_json(&album, items.len(), preview_items(&items)) })))
        }
        None => Ok(Json(json!({ "error": "Album not found" }))),
    }
}

async fn delete_album(
    _auth: AuthUser,
    State(state): State<Arc<AppState>>,
    Path(album_id): Path<String>,
) -> Result<StatusCode> {
    use wabidb::projections::albums;
    let proj = state.wdb.engine().projection_state();
    let mut scope: Option<(String, String)> = None;
    proj.for_each("albums", |_key, value| {
        if scope.is_some() {
            return;
        }
        if let Ok(r) = albums::decode_record(value) {
            if r.album_id == album_id && !r.is_deleted {
                scope = Some((r.scope_type, r.scope_id));
            }
        }
    });
    if let Some((scope_type, scope_id)) = scope {
        state
            .wdb
            .delete_album(&scope_type, &scope_id, &album_id, 0)
            .await?;
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn list_items(
    _auth: OptionalAuthUser,
    State(state): State<Arc<AppState>>,
    Path(album_id): Path<String>,
) -> Result<Json<Value>> {
    let items = state.wdb.list_items(&album_id).await?;
    let sorted = {
        let mut s = items;
        s.sort_by_key(|i| i.sort_order);
        s
    };
    Ok(Json(json!({
        "items": sorted.iter().map(item_json).collect::<Vec<_>>()
    })))
}

async fn add_item(
    auth: AuthUser,
    State(state): State<Arc<AppState>>,
    Path(album_id): Path<String>,
    Json(payload): Json<AddItemPayload>,
) -> Result<Json<Value>> {
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
    let item = wabidb::domain::AlbumItem {
        item_id,
        album_id,
        url: payload.attachment_url,
        name: payload.attachment_name,
        size: payload.attachment_size,
        mime: payload.attachment_mime,
        caption: payload.caption,
        sort_order: 0,
        created_at_micros: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_micros() as i64)
            .unwrap_or(0),
        is_deleted: false,
    };
    Ok(Json(json!({ "item": item_json(&item) })))
}

async fn delete_item(
    _auth: AuthUser,
    State(state): State<Arc<AppState>>,
    Path((album_id, item_id)): Path<(String, String)>,
) -> Result<StatusCode> {
    state.wdb.delete_item(&album_id, &item_id, 0).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn reorder_items(
    State(_state): State<Arc<AppState>>,
    Path(_album_id): Path<String>,
    Json(_payload): Json<ReorderItemsPayload>,
) -> Result<Json<Value>> {
    // v1: reorder_items is not yet implemented through WabiDB.
    // The projection handles sort_order; a future card can add a
    // dedicated reorder event type.
    Ok(Json(json!({ "items": [] })))
}

async fn set_featured(
    State(_state): State<Arc<AppState>>,
    Path(_album_id): Path<String>,
    Json(_payload): Json<SetFeaturedPayload>,
) -> Result<Json<Value>> {
    // v1: set_featured is not yet persisted in the albums projection.
    // A future card can add is_featured to AlbumRecord.
    Ok(Json(json!({ "album": serde_json::Value::Null })))
}
