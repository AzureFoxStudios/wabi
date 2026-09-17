use axum::extract::{Path, State};
use axum::Json;
use serde::Deserialize;
use std::sync::Arc;
use serde_json::{json, Value};

use crate::auth_extractor::AuthUser;
use crate::error::AppError;
use crate::state::AppState;
use wabidb::engine::wabi_store::WabiStore;

pub fn routes(state: Arc<AppState>) -> axum::Router<Arc<AppState>> {
    axum::Router::new()
        .route("/{channel_id}/works", axum::routing::get(list_works).post(upload_work))
        .route(
            "/{channel_id}/works/{work_id}",
            axum::routing::get(get_work).put(edit_work).delete(delete_work),
        )
        .route(
            "/{channel_id}/works/{work_id}/feedback",
            axum::routing::get(list_feedback).post(add_feedback),
        )
        .route(
            "/{channel_id}/works/{work_id}/feedback/{feedback_id}",
            axum::routing::delete(delete_feedback),
        )
        .route_layer(axum::middleware::from_fn_with_state(state.clone(), crate::channel_access::require_channel))
        .with_state(state)
}

async fn list_works(
    State(state): State<Arc<AppState>>,
    Path(channel_id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let works = state.wdb.list_gallery_works(&channel_id).await?;
    Ok(Json(json!({ "works": works })))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadWorkPayload {
    title: String,
    caption: String,
    attachment_url: String,
    mime_type: String,
    category: String,
    is_wip: bool,
}

async fn upload_work(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(channel_id): Path<String>,
    Json(payload): Json<UploadWorkPayload>,
) -> Result<Json<Value>, AppError> {
    let work_id = state
        .wdb
        .upload_gallery_work(
            &channel_id,
            &payload.title,
            &payload.caption,
            &payload.attachment_url,
            &payload.mime_type,
            &payload.category,
            payload.is_wip,
            auth.user_id as u64,
        )
        .await?;
    let work = state
        .wdb
        .get_gallery_work(&channel_id, &work_id)
        .await?
        .ok_or_else(|| AppError::Internal("work created but not found in projection".into()))?;
    Ok(Json(json!(work)))
}

async fn get_work(
    State(state): State<Arc<AppState>>,
    Path((channel_id, work_id)): Path<(String, String)>,
) -> Result<Json<Value>, AppError> {
    let work = state
        .wdb
        .get_gallery_work(&channel_id, &work_id)
        .await?
        .ok_or_else(|| AppError::NotFound("gallery work not found".into()))?;
    Ok(Json(json!(work)))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EditWorkPayload {
    title: String,
    caption: String,
    category: String,
    is_wip: bool,
}

async fn edit_work(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path((channel_id, work_id)): Path<(String, String)>,
    Json(payload): Json<EditWorkPayload>,
) -> Result<Json<Value>, AppError> {
    state.wdb.get_gallery_work(&channel_id, &work_id).await?
        .filter(|work| !work.is_deleted)
        .ok_or_else(|| AppError::NotFound("gallery work not found".into()))?;
    state
        .wdb
        .edit_gallery_work(
            &channel_id,
            &work_id,
            &payload.title,
            &payload.caption,
            &payload.category,
            payload.is_wip,
            auth.user_id as u64,
        )
        .await?;
    let work = state
        .wdb
        .get_gallery_work(&channel_id, &work_id)
        .await?
        .ok_or_else(|| AppError::NotFound("gallery work not found".into()))?;
    Ok(Json(json!(work)))
}

async fn delete_work(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path((channel_id, work_id)): Path<(String, String)>,
) -> Result<Json<Value>, AppError> {
    state
        .wdb
        .delete_gallery_work(&channel_id, &work_id, auth.user_id as u64)
        .await?;
    Ok(Json(json!({ "deleted": true })))
}

async fn list_feedback(
    State(state): State<Arc<AppState>>,
    Path((channel_id, work_id)): Path<(String, String)>,
) -> Result<Json<Value>, AppError> {
    resolve_feedback_work(&state, &channel_id, &work_id).await?;
    let feedback = state.wdb.list_gallery_feedback(&channel_id, &work_id).await?;
    Ok(Json(json!({ "feedback": feedback })))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddFeedbackPayload {
    comment: String,
    x_percent: f32,
    y_percent: f32,
}

async fn add_feedback(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path((channel_id, work_id)): Path<(String, String)>,
    Json(payload): Json<AddFeedbackPayload>,
) -> Result<Json<Value>, AppError> {
    resolve_feedback_work(&state, &channel_id, &work_id).await?;
    let feedback_id = state
        .wdb
        .add_gallery_feedback(
            &channel_id,
            &work_id,
            &payload.comment,
            payload.x_percent,
            payload.y_percent,
            auth.user_id as u64,
        )
        .await?;
    // Return the feedback list after adding.
    let feedback = state.wdb.list_gallery_feedback(&channel_id, &work_id).await?;
    Ok(Json(json!({ "feedbackId": feedback_id, "feedback": feedback })))
}

async fn delete_feedback(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path((channel_id, work_id, feedback_id)): Path<(String, String, String)>,
) -> Result<Json<Value>, AppError> {
    resolve_feedback_work(&state, &channel_id, &work_id).await?;
    state
        .wdb
        .delete_gallery_feedback(&channel_id, &work_id, &feedback_id, auth.user_id as u64)
        .await?;
    Ok(Json(json!({ "deleted": true })))
}

/// Split a gallery-list derived id (`album-{albumId}-item-{itemId}`) into its
/// parts. The round-trip check rejects smuggled extra segments; ids that do
/// not follow the derived shape are not album references at all.
fn parse_album_item_work_id(work_id: &str) -> Option<(String, String)> {
    let rest = work_id.strip_prefix("album-")?;
    let (album_id, item_id) = rest.split_once("-item-")?;
    if album_id.is_empty() || item_id.is_empty() {
        return None;
    }
    if format!("album-{album_id}-item-{item_id}") != work_id {
        return None;
    }
    Some((album_id.to_string(), item_id.to_string()))
}

/// Confirm a feedback work id names a readable resource in this channel.
///
/// Real gallery works keep their existing check. Album-derived ids resolve
/// against the actual album record: the album must live in the channel from
/// the URL path (scope-keyed lookup, so another channel's album id cannot
/// alias in) and the item must currently exist in it. Nothing is created on
/// view, and channel authorization stays with the `require_channel`
/// middleware plus the album's own scope check. Unknown ids are 404.
async fn resolve_feedback_work(
    state: &AppState,
    channel_id: &str,
    work_id: &str,
) -> Result<(), AppError> {
    if let Some(work) = state.wdb.get_gallery_work(channel_id, work_id).await? {
        if !work.is_deleted {
            return Ok(());
        }
        return Err(AppError::NotFound("gallery work not found".into()));
    }
    if let Some((album_id, item_id)) = parse_album_item_work_id(work_id) {
        // Scope-keyed: only an album owned by this channel resolves here.
        let album = state
            .wdb
            .get_album("channel", channel_id, &album_id)
            .await?
            .filter(|album| !album.is_deleted);
        if let Some(album) = album {
            debug_assert_eq!(album.scope_id, channel_id);
            let items = state.wdb.list_items(&album_id).await?;
            if items.iter().any(|item| item.item_id == item_id) {
                return Ok(());
            }
        }
    }
    Err(AppError::NotFound("gallery work not found".into()))
}
