use axum::extract::{Path, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

use crate::auth_extractor::AuthUser;
use crate::error::AppError;
use crate::state::AppState;
use wabidb::engine::wabi_store::WabiStore;

fn thread_locks() -> &'static crate::call_access::SessionLocks {
    static LOCKS: std::sync::OnceLock<crate::call_access::SessionLocks> =
        std::sync::OnceLock::new();
    LOCKS.get_or_init(Default::default)
}

async fn can_moderate(
    state: &AppState,
    auth: &AuthUser,
    channel_id: &str,
) -> Result<bool, AppError> {
    let channel = crate::channel_access::require_access(state, auth.user_id, channel_id).await?;
    Ok(!auth.is_guest
        && auth.user_id > 0
        && !crate::channel_access::is_conversation(channel.channel_kind)
        && (state.is_admin(auth.user_id).await || state.has_role(auth.user_id, "Moderator").await))
}

async fn live_post(
    state: &AppState,
    channel_id: &str,
    thread_id: &str,
    post_id: &str,
) -> Result<wabidb::domain::ForumPost, AppError> {
    state
        .wdb
        .get_forum_post(channel_id, thread_id, post_id)
        .await?
        .filter(|post| !post.is_deleted)
        .ok_or_else(|| AppError::NotFound("forum post not found".into()))
}

pub fn routes(state: Arc<AppState>) -> axum::Router<Arc<AppState>> {
    axum::Router::new()
        .route(
            "/{channel_id}/threads",
            axum::routing::get(list_threads).post(create_thread),
        )
        .route(
            "/{channel_id}/threads/{thread_id}/posts",
            axum::routing::get(list_posts).post(create_post),
        )
        .route(
            "/{channel_id}/threads/{thread_id}/posts/{post_id}",
            axum::routing::put(update_post).delete(delete_post),
        )
        .route(
            "/{channel_id}/threads/{thread_id}/posts/{post_id}/vote",
            axum::routing::post(vote_post),
        )
        .route(
            "/{channel_id}/threads/{thread_id}/posts/{post_id}/solution",
            axum::routing::post(mark_solution),
        )
        .route_layer(axum::middleware::from_fn_with_state(
            state.clone(),
            crate::channel_access::require_channel_with_read_gate,
        ))
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
    title: Option<String>,
    tags: Option<Vec<String>>,
    category: Option<String>,
}

async fn create_thread(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(channel_id): Path<String>,
    Json(payload): Json<CreateThreadPayload>,
) -> Result<Json<Value>, AppError> {
    let admission = crate::channel_access::admit_mutation(&state, &auth).await?;
    let operation_state = state.clone();
    admission
        .run(&operation_state, async move {
            crate::channel_access::require_participation(&state, auth.user_id, &channel_id).await?;
            let post_id = state
                .wdb
                .create_forum_thread(
                    &channel_id,
                    &payload.body,
                    auth.user_id as u64,
                    payload.title.as_deref(),
                    payload.tags.as_deref(),
                    payload.category.as_deref(),
                )
                .await?;
            let post = state
                .wdb
                .get_forum_post(&channel_id, &post_id, &post_id)
                .await?
                .ok_or_else(|| {
                    AppError::Internal("thread created but not found in projection".into())
                })?;
            Ok(Json(json!(post)))
        })
        .await
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
    tags: Option<Vec<String>>,
}

async fn create_post(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path((channel_id, thread_id)): Path<(String, String)>,
    Json(payload): Json<CreatePostPayload>,
) -> Result<Json<Value>, AppError> {
    let admission = crate::channel_access::admit_mutation(&state, &auth).await?;
    let operation_state = state.clone();
    admission
        .run(&operation_state, async move {
            crate::channel_access::require_participation(&state, auth.user_id, &channel_id).await?;
            let _thread = thread_locks()
                .lock(&format!("{channel_id}:{thread_id}"))
                .await;
            state
                .wdb
                .get_forum_post(&channel_id, &thread_id, &thread_id)
                .await?
                .filter(|post| !post.is_deleted && post.is_thread_starter)
                .ok_or_else(|| AppError::NotFound("forum thread not found".into()))?;
            let post_id = state
                .wdb
                .create_forum_post(
                    &channel_id,
                    &thread_id,
                    &payload.body,
                    auth.user_id as u64,
                    payload.tags.as_deref(),
                )
                .await?;
            let post = state
                .wdb
                .get_forum_post(&channel_id, &thread_id, &post_id)
                .await?
                .ok_or_else(|| {
                    AppError::Internal("post created but not found in projection".into())
                })?;
            Ok(Json(json!(post)))
        })
        .await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdatePostPayload {
    body: String,
    title: Option<String>,
    tags: Option<Vec<String>>,
    category: Option<String>,
}

async fn update_post(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path((channel_id, thread_id, post_id)): Path<(String, String, String)>,
    Json(payload): Json<UpdatePostPayload>,
) -> Result<Json<Value>, AppError> {
    let admission = crate::channel_access::admit_mutation(&state, &auth).await?;
    let operation_state = state.clone();
    admission
        .run(&operation_state, async move {
            crate::channel_access::require_participation(&state, auth.user_id, &channel_id).await?;
            let _thread = thread_locks()
                .lock(&format!("{channel_id}:{thread_id}"))
                .await;
            let existing = live_post(&state, &channel_id, &thread_id, &post_id).await?;
            if existing.author_user_id != auth.user_id as u64
                && !can_moderate(&state, &auth, &channel_id).await?
            {
                // The existing category organizer updates other members' thread
                // metadata. It must not also replace text under their identity.
                let channel =
                    crate::channel_access::require_access(&state, auth.user_id, &channel_id)
                        .await?;
                if crate::channel_access::is_conversation(channel.channel_kind)
                    || payload.body != existing.body
                    || payload.title.as_deref().unwrap_or("") != existing.title
                {
                    return Err(AppError::Forbidden(
                        "Only the author or a moderator can edit this post's text".into(),
                    ));
                }
            }
            state
                .wdb
                .update_forum_post(
                    &channel_id,
                    &thread_id,
                    &post_id,
                    &payload.body,
                    auth.user_id as u64,
                    payload.title.as_deref(),
                    payload.tags.as_deref(),
                    payload.category.as_deref(),
                )
                .await?;
            let post = state
                .wdb
                .get_forum_post(&channel_id, &thread_id, &post_id)
                .await?
                .ok_or_else(|| AppError::NotFound("forum post not found".into()))?;
            Ok(Json(json!(post)))
        })
        .await
}

async fn delete_post(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path((channel_id, thread_id, post_id)): Path<(String, String, String)>,
) -> Result<Json<Value>, AppError> {
    let admission = crate::channel_access::admit_mutation(&state, &auth).await?;
    let operation_state = state.clone();
    admission
        .run(&operation_state, async move {
            crate::channel_access::require_participation(&state, auth.user_id, &channel_id).await?;
            let _thread = thread_locks()
                .lock(&format!("{channel_id}:{thread_id}"))
                .await;
            let existing = live_post(&state, &channel_id, &thread_id, &post_id).await?;
            if existing.author_user_id != auth.user_id as u64
                && !can_moderate(&state, &auth, &channel_id).await?
            {
                return Err(AppError::Forbidden(
                    "Only the author or a moderator can delete this post".into(),
                ));
            }
            state
                .wdb
                .delete_forum_post(&channel_id, &thread_id, &post_id, auth.user_id as u64)
                .await?;
            Ok(Json(json!({ "deleted": true })))
        })
        .await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VotePayload {
    direction: String,
}

async fn vote_post(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path((channel_id, thread_id, post_id)): Path<(String, String, String)>,
    Json(payload): Json<VotePayload>,
) -> Result<Json<Value>, AppError> {
    let admission = crate::channel_access::admit_mutation(&state, &auth).await?;
    let operation_state = state.clone();
    admission
        .run(&operation_state, async move {
            crate::channel_access::require_participation(&state, auth.user_id, &channel_id).await?;
            let _thread = thread_locks()
                .lock(&format!("{channel_id}:{thread_id}"))
                .await;
            live_post(&state, &channel_id, &thread_id, &post_id).await?;
            if !matches!(payload.direction.as_str(), "up" | "down") {
                return Err(AppError::BadRequest(
                    "Vote direction must be up or down".into(),
                ));
            }
            state
                .wdb
                .vote_forum_post(
                    &channel_id,
                    &thread_id,
                    &post_id,
                    &payload.direction,
                    auth.user_id as u64,
                )
                .await?;
            let post = state
                .wdb
                .get_forum_post(&channel_id, &thread_id, &post_id)
                .await?
                .ok_or_else(|| AppError::NotFound("forum post not found".into()))?;
            Ok(Json(json!(post)))
        })
        .await
}

async fn mark_solution(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path((channel_id, thread_id, post_id)): Path<(String, String, String)>,
) -> Result<Json<Value>, AppError> {
    let admission = crate::channel_access::admit_mutation(&state, &auth).await?;
    let operation_state = state.clone();
    admission
        .run(&operation_state, async move {
            crate::channel_access::require_participation(&state, auth.user_id, &channel_id).await?;
            let _thread = thread_locks()
                .lock(&format!("{channel_id}:{thread_id}"))
                .await;
            live_post(&state, &channel_id, &thread_id, &post_id).await?;
            live_post(&state, &channel_id, &thread_id, &thread_id)
                .await?
                .is_thread_starter
                .then_some(())
                .ok_or_else(|| AppError::NotFound("forum thread not found".into()))?;
            state
                .wdb
                .mark_forum_solution(&channel_id, &thread_id, &post_id, auth.user_id as u64)
                .await?;
            let post = state
                .wdb
                .get_forum_post(&channel_id, &thread_id, &post_id)
                .await?
                .ok_or_else(|| AppError::NotFound("forum post not found".into()))?;
            Ok(Json(json!(post)))
        })
        .await
}
