use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::Json,
    routing::{delete, get, put},
    Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
};

use crate::{error::Result, state::AppState};

#[derive(Clone)]
struct AlbumRecord {
    id: i64,
    scope_type: String,
    scope_id: String,
    name: String,
    created_at: i64,
    updated_at: i64,
    owner_user_id: i64,
    is_featured: bool,
}

#[derive(Clone)]
struct AlbumItemRecord {
    id: i64,
    album_id: i64,
    attachment_url: String,
    attachment_name: String,
    attachment_size: Option<i64>,
    attachment_mime: Option<String>,
    message_id: Option<String>,
    caption: Option<String>,
    sort_order: i64,
    created_at: i64,
}

#[derive(Default)]
struct AlbumMemoryStore {
    next_album_id: i64,
    next_item_id: i64,
    albums: HashMap<i64, AlbumRecord>,
    items: HashMap<i64, Vec<AlbumItemRecord>>,
}

static ALBUM_STORE: OnceLock<Mutex<AlbumMemoryStore>> = OnceLock::new();

fn store() -> &'static Mutex<AlbumMemoryStore> {
    ALBUM_STORE.get_or_init(|| Mutex::new(AlbumMemoryStore {
        next_album_id: 1,
        next_item_id: 1,
        albums: HashMap::new(),
        items: HashMap::new(),
    }))
}

fn now_ts() -> i64 {
    chrono::Utc::now().timestamp()
}

fn album_json(album: &AlbumRecord, item_count: usize, preview_items: Vec<Value>) -> Value {
    json!({
        "id": album.id,
        "scope_type": album.scope_type,
        "scope_id": album.scope_id,
        "name": album.name,
        "created_at": album.created_at,
        "updated_at": album.updated_at,
        "owner_user_id": album.owner_user_id,
        "featured_item_id": if album.is_featured { Some(1_i64) } else { None },
        "isFeatured": album.is_featured,
        "item_count": item_count,
        "preview_items": preview_items,
    })
}

fn item_json(item: &AlbumItemRecord) -> Value {
    json!({
        "id": item.id,
        "album_id": item.album_id,
        "attachment_url": item.attachment_url,
        "attachment_name": item.attachment_name,
        "attachment_size": item.attachment_size,
        "attachment_mime": item.attachment_mime,
        "message_id": item.message_id,
        "caption": item.caption,
        "sort_order": item.sort_order,
        "created_at": item.created_at,
    })
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
    item_ids: Vec<i64>,
}

#[derive(Debug, Deserialize)]
struct SetFeaturedPayload {
    #[serde(default)]
    featured: bool,
}

async fn list_albums(
    State(_state): State<Arc<AppState>>,
    Query(query): Query<ListAlbumsQuery>,
) -> Result<Json<Value>> {
    let guard = store().lock().expect("album store lock poisoned");
    let mut albums = guard
        .albums
        .values()
        .filter(|album| album.scope_type == query.scope_type && album.scope_id == query.scope_id)
        .cloned()
        .collect::<Vec<_>>();
    albums.sort_by_key(|album| -album.updated_at);
    albums.truncate(query.limit as usize);
    let result = albums
        .iter()
        .map(|album| {
            let items = guard.items.get(&album.id).cloned().unwrap_or_default();
            let preview = items.iter().take(4).map(item_json).collect::<Vec<_>>();
            album_json(album, items.len(), preview)
        })
        .collect::<Vec<_>>();
    Ok(Json(json!({ "albums": result })))
}

async fn create_album(
    State(_state): State<Arc<AppState>>,
    Json(payload): Json<CreateAlbumPayload>,
) -> Result<Json<Value>> {
    let mut guard = store().lock().expect("album store lock poisoned");
    let now = now_ts();
    let id = guard.next_album_id;
    guard.next_album_id += 1;
    let album = AlbumRecord {
        id,
        scope_type: payload.scope_type,
        scope_id: payload.scope_id,
        name: payload.name,
        created_at: now,
        updated_at: now,
        owner_user_id: 1,
        is_featured: false,
    };
    guard.albums.insert(id, album.clone());
    Ok(Json(json!({ "album": album_json(&album, 0, Vec::new()) })))
}

async fn get_album(State(_state): State<Arc<AppState>>, Path(album_id): Path<i64>) -> Result<Json<Value>> {
    let guard = store().lock().expect("album store lock poisoned");
    let Some(album) = guard.albums.get(&album_id) else {
        return Ok(Json(json!({ "error": "Album not found" })));
    };
    let items = guard.items.get(&album_id).cloned().unwrap_or_default();
    let preview = items.iter().take(4).map(item_json).collect::<Vec<_>>();
    Ok(Json(json!({ "album": album_json(album, items.len(), preview) })))
}

async fn delete_album(State(_state): State<Arc<AppState>>, Path(album_id): Path<i64>) -> Result<StatusCode> {
    let mut guard = store().lock().expect("album store lock poisoned");
    guard.albums.remove(&album_id);
    guard.items.remove(&album_id);
    Ok(StatusCode::NO_CONTENT)
}

async fn list_items(State(_state): State<Arc<AppState>>, Path(album_id): Path<i64>) -> Result<Json<Value>> {
    let guard = store().lock().expect("album store lock poisoned");
    let Some(album) = guard.albums.get(&album_id) else {
        return Ok(Json(json!({ "error": "Album not found", "items": [] })));
    };
    let items = guard.items.get(&album_id).cloned().unwrap_or_default();
    let mut sorted = items;
    sorted.sort_by_key(|item| item.sort_order);
    Ok(Json(json!({
        "album": album_json(album, sorted.len(), Vec::new()),
        "items": sorted.iter().map(item_json).collect::<Vec<_>>()
    })))
}

async fn add_item(
    State(_state): State<Arc<AppState>>,
    Path(album_id): Path<i64>,
    Json(payload): Json<AddItemPayload>,
) -> Result<Json<Value>> {
    let mut guard = store().lock().expect("album store lock poisoned");
    let now = now_ts();
    let item_id = guard.next_item_id;
    guard.next_item_id += 1;
    let sort_order = guard.items.get(&album_id).map(|items| items.len() as i64).unwrap_or(0);
    let item = AlbumItemRecord {
        id: item_id,
        album_id,
        attachment_url: payload.attachment_url,
        attachment_name: payload.attachment_name,
        attachment_size: payload.attachment_size,
        attachment_mime: payload.attachment_mime,
        message_id: payload.message_id,
        caption: payload.caption,
        sort_order,
        created_at: now,
    };
    guard.items.entry(album_id).or_default().push(item.clone());
    if let Some(album) = guard.albums.get_mut(&album_id) {
        album.updated_at = now;
    }
    Ok(Json(json!({ "item": item_json(&item) })))
}

async fn delete_item(
    State(_state): State<Arc<AppState>>,
    Path((album_id, item_id)): Path<(i64, i64)>,
) -> Result<StatusCode> {
    let mut guard = store().lock().expect("album store lock poisoned");
    if let Some(items) = guard.items.get_mut(&album_id) {
        items.retain(|item| item.id != item_id);
    }
    if let Some(album) = guard.albums.get_mut(&album_id) {
        album.updated_at = now_ts();
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn reorder_items(
    State(_state): State<Arc<AppState>>,
    Path(album_id): Path<i64>,
    Json(payload): Json<ReorderItemsPayload>,
) -> Result<Json<Value>> {
    let mut guard = store().lock().expect("album store lock poisoned");
    if let Some(items) = guard.items.get_mut(&album_id) {
        for (index, item_id) in payload.item_ids.iter().enumerate() {
            if let Some(item) = items.iter_mut().find(|item| item.id == *item_id) {
                item.sort_order = index as i64;
            }
        }
        items.sort_by_key(|item| item.sort_order);
        let result = items.iter().map(item_json).collect::<Vec<_>>();
        return Ok(Json(json!({ "items": result })));
    }
    Ok(Json(json!({ "items": [] })))
}

async fn set_featured(
    State(_state): State<Arc<AppState>>,
    Path(album_id): Path<i64>,
    Json(payload): Json<SetFeaturedPayload>,
) -> Result<Json<Value>> {
    let mut guard = store().lock().expect("album store lock poisoned");
    for album in guard.albums.values_mut() {
        album.is_featured = false;
    }
    let updated = if let Some(album) = guard.albums.get_mut(&album_id) {
        album.is_featured = payload.featured;
        album.updated_at = now_ts();
        Some(album.clone())
    } else {
        None
    };
    let album = updated.map(|album| album_json(&album, guard.items.get(&album_id).map(Vec::len).unwrap_or(0), Vec::new()));
    Ok(Json(json!({ "album": album })))
}
