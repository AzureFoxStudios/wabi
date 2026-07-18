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
    state
        .wdb
        .delete_gallery_feedback(&channel_id, &work_id, &feedback_id, auth.user_id as u64)
        .await?;
    Ok(Json(json!({ "deleted": true })))
}
