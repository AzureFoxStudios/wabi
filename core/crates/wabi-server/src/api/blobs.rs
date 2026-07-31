//! Blob upload / download / route API.
//!
//! - POST /api/blobs/upload — raw body = blob bytes, query params for metadata.
//! - GET  /api/blobs/{hash} — download blob.
//! - GET  /api/blobs/{hash}/meta — get blob metadata.
//! - GET  /api/blobs — list non-deleted blobs.
//!
//! Phase 3: primary stores all blobs. Helper cache nodes mirror via jobs later.

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::auth_extractor::{AuthUser, OptionalAuthUser};
use crate::blobs::BlobRegistryError;
use crate::state::AppState;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadBlobQuery {
    #[serde(default = "default_name")]
    pub original_name: String,
    #[serde(default = "default_mime")]
    pub mime_type: String,
    pub channel_id: Option<String>,
    pub message_id: Option<String>,
}

fn default_name() -> String {
    "unnamed.bin".to_string()
}
fn default_mime() -> String {
    "application/octet-stream".to_string()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadBlobResponse {
    pub hash: String,
    pub meta: crate::blobs::BlobMeta,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlobListResponse {
    pub blobs: Vec<crate::blobs::BlobMeta>,
}

pub fn routes(state: Arc<AppState>) -> Router<Arc<AppState>> {
    Router::new()
        .route("/upload", post(upload_blob))
        .route("/", get(list_blobs))
        .route("/{hash}", get(download_blob))
        .route("/{hash}/meta", get(blob_meta))
        .with_state(state)
}

/// POST /api/blobs/upload
/// Body is the raw blob bytes. Metadata in query params.
async fn upload_blob(
    auth: AuthUser,
    State(state): State<Arc<AppState>>,
    Query(q): Query<UploadBlobQuery>,
    body: axum::body::Bytes,
) -> Result<Json<UploadBlobResponse>, BlobApiError> {
    if auth.is_guest {
        return Err(BlobApiError::Unauthorized);
    }
    let uploaded_by = Some(auth.user_id.to_string());
    let meta = state
        .blob_registry
        .store_blob(
            &body,
            q.original_name,
            q.mime_type,
            uploaded_by,
            q.channel_id,
            q.message_id,
            None,
        )
        .await
        .map_err(BlobApiError::from)?;

    Ok(Json(UploadBlobResponse {
        hash: meta.hash.clone(),
        meta,
    }))
}

/// GET /api/blobs/{hash}
async fn download_blob(
    _auth: OptionalAuthUser,
    State(state): State<Arc<AppState>>,
    Path(hash): Path<String>,
) -> Result<impl IntoResponse, BlobApiError> {
    let meta = state
        .blob_registry
        .get_meta(&hash)
        .await
        .ok_or(BlobApiError::NotFound)?;

    let path = state.blob_registry.blob_path(&hash);
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|e| BlobApiError::Io(e.to_string()))?;

    Ok((
        [(axum::http::header::CONTENT_TYPE, meta.mime_type.clone())],
        bytes,
    ))
}

/// GET /api/blobs/{hash}/meta
async fn blob_meta(
    _auth: OptionalAuthUser,
    State(state): State<Arc<AppState>>,
    Path(hash): Path<String>,
) -> Result<Json<crate::blobs::BlobMeta>, BlobApiError> {
    let meta = state
        .blob_registry
        .get_meta(&hash)
        .await
        .ok_or(BlobApiError::NotFound)?;
    Ok(Json(meta))
}

/// GET /api/blobs/
async fn list_blobs(
    auth: AuthUser,
    State(state): State<Arc<AppState>>,
) -> Result<Json<BlobListResponse>, BlobApiError> {
    if !state.is_admin(auth.user_id).await {
        return Err(BlobApiError::Unauthorized);
    }
    let blobs = state.blob_registry.list_blobs().await;
    Ok(Json(BlobListResponse { blobs }))
}

#[derive(Debug)]
pub enum BlobApiError {
    Registry(BlobRegistryError),
    NotFound,
    Unauthorized,
    Io(String),
}

impl From<BlobRegistryError> for BlobApiError {
    fn from(e: BlobRegistryError) -> Self {
        BlobApiError::Registry(e)
    }
}

impl IntoResponse for BlobApiError {
    fn into_response(self) -> axum::response::Response {
        let (status, body) = match &self {
            BlobApiError::Registry(BlobRegistryError::NotFound) | BlobApiError::NotFound => {
                (StatusCode::NOT_FOUND, "blob not found")
            }
            BlobApiError::Registry(BlobRegistryError::HashMismatch) => {
                (StatusCode::BAD_REQUEST, "hash mismatch")
            }
            BlobApiError::Registry(BlobRegistryError::AlreadyExists) => {
                (StatusCode::CONFLICT, "already exists")
            }
            BlobApiError::Registry(BlobRegistryError::Io(msg)) | BlobApiError::Io(msg) => {
                tracing::error!("blob io error: {}", msg);
                (StatusCode::INTERNAL_SERVER_ERROR, "storage error")
            }
            BlobApiError::Unauthorized => {
                return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
            }
        };
        (status, body).into_response()
    }
}
