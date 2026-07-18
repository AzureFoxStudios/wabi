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
        .route("/{channel_id}/pages", axum::routing::get(list_pages).post(create_page))
        .route(
            "/{channel_id}/pages/{page_id}",
            axum::routing::get(get_page).put(update_page).delete(delete_page),
        )
        .route(
            "/{channel_id}/pages/{page_id}/revisions",
            axum::routing::get(list_revisions),
        )
        .route(
            "/{channel_id}/pages/{page_id}/revisions/{revision_id}",
            axum::routing::get(get_revision),
        )
        .with_state(state)
}

async fn list_pages(
    State(state): State<Arc<AppState>>,
    Path(channel_id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let pages = state.wdb.list_wiki_pages(&channel_id).await?;
    Ok(Json(json!({ "pages": pages })))
}

async fn get_page(
    State(state): State<Arc<AppState>>,
    Path((channel_id, page_id)): Path<(String, String)>,
) -> Result<Json<Value>, AppError> {
    let page = state
        .wdb
        .get_wiki_page(&channel_id, &page_id)
        .await?
        .ok_or_else(|| AppError::NotFound("wiki page not found".into()))?;
    Ok(Json(json!(page)))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreatePagePayload {
    title: String,
    body: String,
    #[serde(default)]
    parent_page_id: Option<String>,
    #[serde(default)]
    slug: Option<String>,
    #[serde(default)]
    order_index: Option<i64>,
}

async fn create_page(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(channel_id): Path<String>,
    Json(payload): Json<CreatePagePayload>,
) -> Result<Json<Value>, AppError> {
    let page_id = state
        .wdb
        .create_wiki_page(
            &channel_id,
            &payload.title,
            &payload.body,
            auth.user_id as u64,
            payload.parent_page_id.as_deref().unwrap_or(""),
            payload.slug.as_deref().unwrap_or(""),
            payload.order_index.unwrap_or(0),
        )
        .await?;
    let page = state
        .wdb
        .get_wiki_page(&channel_id, &page_id)
        .await?
        .ok_or_else(|| AppError::Internal("page created but not found in projection".into()))?;
    Ok(Json(json!(page)))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdatePagePayload {
    title: String,
    body: String,
    #[serde(default)]
    parent_page_id: Option<String>,
    #[serde(default)]
    slug: Option<String>,
    #[serde(default)]
    order_index: Option<i64>,
}

async fn update_page(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path((channel_id, page_id)): Path<(String, String)>,
    Json(payload): Json<UpdatePagePayload>,
) -> Result<Json<Value>, AppError> {
    state
        .wdb
        .update_wiki_page(
            &channel_id,
            &page_id,
            &payload.title,
            &payload.body,
            auth.user_id as u64,
            payload.parent_page_id.as_deref().unwrap_or(""),
            payload.slug.as_deref().unwrap_or(""),
            payload.order_index.unwrap_or(0),
        )
        .await?;
    let page = state
        .wdb
        .get_wiki_page(&channel_id, &page_id)
        .await?
        .ok_or_else(|| AppError::NotFound("wiki page not found".into()))?;
    Ok(Json(json!(page)))
}

async fn delete_page(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path((channel_id, page_id)): Path<(String, String)>,
) -> Result<Json<Value>, AppError> {
    state
        .wdb
        .delete_wiki_page(&channel_id, &page_id, auth.user_id as u64)
        .await?;
    Ok(Json(json!({ "deleted": true })))
}

async fn list_revisions(
    State(state): State<Arc<AppState>>,
    Path((channel_id, page_id)): Path<(String, String)>,
) -> Result<Json<Value>, AppError> {
    let revisions = state
        .wdb
        .list_wiki_revisions(&channel_id, &page_id)
        .await?;
    Ok(Json(json!({ "revisions": revisions })))
}

async fn get_revision(
    State(state): State<Arc<AppState>>,
    Path((channel_id, page_id, revision_id)): Path<(String, String, String)>,
) -> Result<Json<Value>, AppError> {
    let revision = state
        .wdb
        .get_wiki_revision(&channel_id, &page_id, &revision_id)
        .await?
        .ok_or_else(|| AppError::NotFound("wiki revision not found".into()))?;
    Ok(Json(json!(revision)))
}
