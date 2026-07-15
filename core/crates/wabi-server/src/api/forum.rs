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
        .route("/{channel_id}/threads", axum::routing::get(list_threads).post(create_thread))
        .route(
            "/{channel_id}/threads/{thread_id}/posts",
            axum::routing::get(list_posts).post(create_post),
        )
        .route(
            "/{channel_id}/threads/{thread_id}/posts/{post_id}",
            axum::routing::put(update_post).delete(delete_post),
        )
        .with_state(state)
}

async fn list_threads(
    State(state): State<Arc<AppState>>,
    Path(channel_id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let threads = state.wdb.list_forum_threads(&channel_id).await?;
    Ok(Json(json!({ "threads": threads })))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateThreadPayload {
    body: String,
}

async fn create_thread(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(channel_id): Path<String>,
    Json(payload): Json<CreateThreadPayload>,
) -> Result<Json<Value>, AppError> {
    let post_id = state
        .wdb
        .create_forum_thread(&channel_id, &payload.body, auth.user_id as u64)
        .await?;
    let post = state
        .wdb
        .get_forum_post(&channel_id, &post_id, &post_id)
        .await?
        .ok_or_else(|| AppError::Internal("thread created but not found in projection".into()))?;
    Ok(Json(json!(post)))
}

async fn list_posts(
    State(state): State<Arc<AppState>>,
    Path((channel_id, thread_id)): Path<(String, String)>,
) -> Result<Json<Value>, AppError> {
    let posts = state.wdb.list_forum_posts(&channel_id, &thread_id).await?;
    Ok(Json(json!({ "posts": posts })))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreatePostPayload {
    body: String,
}

async fn create_post(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path((channel_id, thread_id)): Path<(String, String)>,
    Json(payload): Json<CreatePostPayload>,
) -> Result<Json<Value>, AppError> {
    let post_id = state
        .wdb
        .create_forum_post(&channel_id, &thread_id, &payload.body, auth.user_id as u64)
        .await?;
    let post = state
        .wdb
        .get_forum_post(&channel_id, &thread_id, &post_id)
        .await?
        .ok_or_else(|| AppError::Internal("post created but not found in projection".into()))?;
    Ok(Json(json!(post)))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdatePostPayload {
    body: String,
}

async fn update_post(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path((channel_id, thread_id, post_id)): Path<(String, String, String)>,
    Json(payload): Json<UpdatePostPayload>,
) -> Result<Json<Value>, AppError> {
    state
        .wdb
        .update_forum_post(&channel_id, &thread_id, &post_id, &payload.body, auth.user_id as u64)
        .await?;
    let post = state
        .wdb
        .get_forum_post(&channel_id, &thread_id, &post_id)
        .await?
        .ok_or_else(|| AppError::NotFound("forum post not found".into()))?;
    Ok(Json(json!(post)))
}

async fn delete_post(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path((channel_id, thread_id, post_id)): Path<(String, String, String)>,
) -> Result<Json<Value>, AppError> {
    state
        .wdb
        .delete_forum_post(&channel_id, &thread_id, &post_id, auth.user_id as u64)
        .await?;
    Ok(Json(json!({ "deleted": true })))
}
