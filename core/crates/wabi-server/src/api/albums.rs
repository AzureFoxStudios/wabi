// Media Albums API
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::Json,
    routing::{delete, get, post, put},
    Router,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

pub fn routes(state: Arc<AppState>) -> Router<Arc<AppState>> {
    Router::new()
        .route("/", get(list_albums).post(create_album))
        .route("/:id", get(get_album).delete(delete_album))
        .route("/:id/items", get(list_items).post(add_item))
        .route("/:id/items/:item_id", delete(delete_item))
        .route("/:id/items/reorder", put(reorder_items))
        .route("/:id/featured", put(set_featured))
        .with_state(state)
}

#[derive(Debug, Deserialize)]
struct ListAlbumsQuery {
    scope_type: String,
    scope_id: String,
    #[serde(default = "default_limit")]
    limit: u32,
}

fn default_limit() -> u32 {
    100
}

#[derive(Debug, Deserialize)]
struct CreateAlbumPayload {
    scope_type: String,
    scope_id: String,
    name: String,
}

#[derive(Debug, Deserialize)]
struct AddItemPayload {
    attachment_url: String,
    attachment_name: String,
    attachment_size: Option<i64>,
    attachment_mime: Option<String>,
    message_id: Option<String>,
    caption: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ReorderItemsPayload {
    item_ids: Vec<i64>,
}

#[derive(Debug, Deserialize)]
struct SetFeaturedPayload {
    item_id: i64,
}

async fn list_albums(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ListAlbumsQuery>,
) -> ApiResult<Json<serde_json::Value>> {
    let mut conn = state.db.connection().await?;

    let albums = sqlx::query_as::<_, (i64, String, String, String, i64, i64, i64, Option<i64>)>(
        r#"
        SELECT id, scope_type, scope_id, name, created_at, updated_at, owner_user_id, featured_item_id
        FROM media_albums
        WHERE scope_type = $1 AND scope_id = $2
        ORDER BY updated_at DESC
        LIMIT $3
        "#,
    )
    .bind(&query.scope_type)
    .bind(&query.scope_id)
    .bind(query.limit as i64)
    .fetch_all(&mut conn)
    .await?;

    let mut result = Vec::new();
    for (id, scope_type, scope_id, name, created_at, updated_at, owner_user_id, featured_item_id) in albums {
        let item_count: (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM media_album_items WHERE album_id = $1"
        )
        .bind(id)
        .fetch_one(&mut conn)
        .await?;

        let preview_items: Vec<(i64, String, String, Option<String>)> = sqlx::query_as(
            r#"
            SELECT id, attachment_url, attachment_name, caption
            FROM media_album_items
            WHERE album_id = $1
            ORDER BY sort_order ASC
            LIMIT 4
            "#,
        )
        .bind(id)
        .fetch_all(&mut conn)
        .await?;

        result.push(serde_json::json!({
            "id": id,
            "scope_type": scope_type,
            "scope_id": scope_id,
            "name": name,
            "created_at": created_at,
            "updated_at": updated_at,
            "owner_user_id": owner_user_id,
            "featured_item_id": featured_item_id,
            "item_count": item_count.0,
            "preview_items": preview_items.into_iter().map(|(id, url, name, caption)| serde_json::json!({
                "id": id,
                "attachment_url": url,
                "attachment_name": name,
                "caption": caption
            })).collect::<Vec<_>>()
        }));
    }

    Ok(Json(serde_json::json!({ "albums": result })))
}

async fn create_album(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<CreateAlbumPayload>,
) -> ApiResult<Json<serde_json::Value>> {
    let mut conn = state.db.connection().await?;

    let now = chrono::Utc::now().timestamp();
    let owner_user_id = 1i64;

    let album_id = sqlx::query_scalar::<_, i64>(
        r#"
        INSERT INTO media_albums (scope_type, scope_id, name, created_at, updated_at, owner_user_id)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id
        "#,
    )
    .bind(&payload.scope_type)
    .bind(&payload.scope_id)
    .bind(&payload.name)
    .bind(now)
    .bind(now)
    .bind(owner_user_id)
    .fetch_one(&mut conn)
    .await?;

    Ok(Json(serde_json::json!({
        "album": {
            "id": album_id,
            "scope_type": payload.scope_type,
            "scope_id": payload.scope_id,
            "name": payload.name,
            "created_at": now,
            "updated_at": now,
            "owner_user_id": owner_user_id,
            "featured_item_id": Option::<i64>::None,
            "item_count": 0,
            "preview_items": Vec::<serde_json::Value>::new()
        }
    })))
}

async fn get_album(
    State(state): State<Arc<AppState>>,
    Path(album_id): Path<i64>,
) -> ApiResult<Json<serde_json::Value>> {
    let mut conn = state.db.connection().await?;

    let album: (i64, String, String, String, i64, i64, i64, Option<i64>) = sqlx::query_as(
        r#"
        SELECT id, scope_type, scope_id, name, created_at, updated_at, owner_user_id, featured_item_id
        FROM media_albums
        WHERE id = $1
        "#,
    )
    .bind(album_id)
    .fetch_one(&mut conn)
    .await
    .map_err(|_| ApiError::NotFound("Album not found".to_string()))?;

    let item_count: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM media_album_items WHERE album_id = $1"
    )
    .bind(album_id)
    .fetch_one(&mut conn)
    .await?;

    Ok(Json(serde_json::json!({
        "album": {
            "id": album.0,
            "scope_type": album.1,
            "scope_id": album.2,
            "name": album.3,
            "created_at": album.4,
            "updated_at": album.5,
            "owner_user_id": album.6,
            "featured_item_id": album.7,
            "item_count": item_count.0
        }
    })))
}

async fn delete_album(
    State(state): State<Arc<AppState>>,
    Path(album_id): Path<i64>,
) -> ApiResult<StatusCode> {
    let mut conn = state.db.connection().await?;

    sqlx::query("DELETE FROM media_albums WHERE id = $1")
        .bind(album_id)
        .execute(&mut conn)
        .await?;

    Ok(StatusCode::NO_CONTENT)
}

async fn list_items(
    State(state): State<Arc<AppState>>,
    Path(album_id): Path<i64>,
    Query(query): Query<std::collections::HashMap<String, String>>,
) -> ApiResult<Json<serde_json::Value>> {
    let mut conn = state.db.connection().await?;

    let limit: i64 = query.get("limit")
        .and_then(|s| s.parse().ok())
        .unwrap_or(300);

    let items: Vec<(i64, i64, String, String, Option<i64>, Option<String>, Option<String>, i64, i64)> = sqlx::query_as(
        r#"
        SELECT id, album_id, attachment_url, attachment_name, attachment_size, attachment_mime, message_id, caption, sort_order, created_at
        FROM media_album_items
        WHERE album_id = $1
        ORDER BY sort_order ASC
        LIMIT $2
        "#,
    )
    .bind(album_id)
    .bind(limit)
    .fetch_all(&mut conn)
    .await?;

    let album: (i64, String, String, String) = sqlx::query_as(
        "SELECT id, scope_type, scope_id, name FROM media_albums WHERE id = $1"
    )
    .bind(album_id)
    .fetch_one(&mut conn)
    .await
    .map_err(|_| ApiError::NotFound("Album not found".to_string()))?;

    let result = items.into_iter().map(|(id, album_id, url, name, size, mime, msg_id, caption, sort, created)| serde_json::json!({
        "id": id,
        "album_id": album_id,
        "attachment_url": url,
        "attachment_name": name,
        "attachment_size": size,
        "attachment_mime": mime,
        "message_id": msg_id,
        "caption": caption,
        "sort_order": sort,
        "created_at": created
    })).collect::<Vec<_>>();

    Ok(Json(serde_json::json!({
        "album": {
            "id": album.0,
            "scope_type": album.1,
            "scope_id": album.2,
            "name": album.3
        },
        "items": result
    })))
}

async fn add_item(
    State(state): State<Arc<AppState>>,
    Path(album_id): Path<i64>,
    Json(payload): Json<AddItemPayload>,
) -> ApiResult<Json<serde_json::Value>> {
    let mut conn = state.db.connection().await?;

    let now = chrono::Utc::now().timestamp();

    let max_order: Option<i64> = sqlx::query_scalar(
        "SELECT MAX(sort_order) FROM media_album_items WHERE album_id = $1"
    )
    .bind(album_id)
    .fetch_one(&mut conn)
    .await?;

    let sort_order = max_order.map(|o| o + 1).unwrap_or(0);

    let item_id = sqlx::query_scalar::<_, i64>(
        r#"
        INSERT INTO media_album_items (album_id, attachment_url, attachment_name, attachment_size, attachment_mime, message_id, caption, sort_order, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING id
        "#,
    )
    .bind(album_id)
    .bind(&payload.attachment_url)
    .bind(&payload.attachment_name)
    .bind(payload.attachment_size)
    .bind(payload.attachment_mime.as_deref())
    .bind(payload.message_id.as_deref())
    .bind(payload.caption.as_deref())
    .bind(sort_order)
    .bind(now)
    .fetch_one(&mut conn)
    .await?;

    sqlx::query("UPDATE media_albums SET updated_at = $1 WHERE id = $2")
        .bind(now)
        .bind(album_id)
        .execute(&mut conn)
        .await?;

    Ok(Json(serde_json::json!({
        "item": {
            "id": item_id,
            "album_id": album_id,
            "attachment_url": payload.attachment_url,
            "attachment_name": payload.attachment_name,
            "attachment_size": payload.attachment_size,
            "attachment_mime": payload.attachment_mime,
            "message_id": payload.message_id,
            "caption": payload.caption,
            "sort_order": sort_order,
            "created_at": now
        }
    })))
}

async fn delete_item(
    State(state): State<Arc<AppState>>,
    Path((album_id, item_id)): Path<(i64, i64)>,
) -> ApiResult<StatusCode> {
    let mut conn = state.db.connection().await?;

    sqlx::query("DELETE FROM media_album_items WHERE album_id = $1 AND id = $2")
        .bind(album_id)
        .bind(item_id)
        .execute(&mut conn)
        .await?;

    let now = chrono::Utc::now().timestamp();
    sqlx::query("UPDATE media_albums SET updated_at = $1 WHERE id = $2")
        .bind(now)
        .bind(album_id)
        .execute(&mut conn)
        .await?;

    Ok(StatusCode::NO_CONTENT)
}

async fn reorder_items(
    State(state): State<Arc<AppState>>,
    Path(album_id): Path<i64>,
    Json(payload): Json<ReorderItemsPayload>,
) -> ApiResult<StatusCode> {
    let mut conn = state.db.connection().await?;

    let mut tx = conn.begin().await?;

    for (index, item_id) in payload.item_ids.iter().enumerate() {
        sqlx::query("UPDATE media_album_items SET sort_order = $1 WHERE id = $2 AND album_id = $3")
            .bind(index as i64)
            .bind(item_id)
            .bind(album_id)
            .execute(&mut *tx)
            .await?;
    }

    tx.commit().await?;

    let now = chrono::Utc::now().timestamp();
    sqlx::query("UPDATE media_albums SET updated_at = $1 WHERE id = $2")
        .bind(now)
        .bind(album_id)
        .execute(&mut conn)
        .await?;

    Ok(StatusCode::OK)
}

async fn set_featured(
    State(state): State<Arc<AppState>>,
    Path(album_id): Path<i64>,
    Json(payload): Json<SetFeaturedPayload>,
) -> ApiResult<StatusCode> {
    let mut conn = state.db.connection().await?;

    sqlx::query("UPDATE media_albums SET featured_item_id = $1, updated_at = $2 WHERE id = $3")
        .bind(payload.item_id)
        .bind(chrono::Utc::now().timestamp())
        .bind(album_id)
        .execute(&mut conn)
        .await?;

    Ok(StatusCode::OK)
}
