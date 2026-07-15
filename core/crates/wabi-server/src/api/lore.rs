use std::sync::Arc;

use axum::{
    extract::{Path, Query, State},
    response::IntoResponse,
    Json, Router,
};
use serde::Deserialize;
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tracing::info;

use crate::auth_extractor::AuthUser;
use crate::error::AppError;
use crate::state::AppState;
use wabidb::engine::wabi_store::WabiStore;

pub fn routes(state: Arc<AppState>) -> Router<Arc<AppState>> {
    Router::new()
        // Repo management
        .route("/repos", axum::routing::post(create_repo))
        .route("/repos/{channel_id}", axum::routing::get(get_repo).delete(delete_repo))
        .route("/repos/{channel_id}/snapshot", axum::routing::post(snapshot))
        // File operations
        .route("/repos/{channel_id}/files", axum::routing::get(list_files))
        .route("/repos/{channel_id}/files/{*path}", axum::routing::put(upload_file).get(download_file).delete(delete_file))
        .route("/repos/{channel_id}/files/{*path}/lock", axum::routing::post(lock_file).delete(unlock_file))
        .route("/repos/{channel_id}/files/{*path}/history", axum::routing::get(file_level_history))
        .route("/repos/{channel_id}/files/{*path}/diff", axum::routing::get(file_diff))
        // Repo history
        .route("/repos/{channel_id}/history", axum::routing::get(repo_history))
        // Branch operations
        .route("/repos/{channel_id}/branches", axum::routing::get(list_branches).post(create_branch))
        .route("/repos/{channel_id}/branches/{branch_name}/merge", axum::routing::post(merge_branch))
        // Health
        .route("/health", axum::routing::get(health_check))
        // Call recording upload (auto-resolves the configured Recordings channel)
        .route("/recordings", axum::routing::post(upload_recording))
        .with_state(state)
}

async fn lore_service(state: &AppState) -> Result<Arc<wabi_lore::LoreService>, AppError> {
    state
        .lore_service
        .read()
        .await
        .clone()
        .ok_or_else(|| AppError::Internal("Lore addon not initialized".into()))
}

// -- Repo management --

async fn create_repo(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Json(payload): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, AppError> {
    let channel_id = payload["channelId"].as_i64().unwrap_or(0);
    let repo_name = payload["repoName"].as_str().unwrap_or("default");

    let lore = lore_service(&state).await?;
    let repo = lore
        .create_repo(channel_id, auth.user_id, repo_name)
        .await?;

    state
        .wdb
        .lore_create_repo(channel_id, repo_name, &repo.lore_server_url, auth.user_id)
        .await?;

    info!(?repo.id, channel_id, repo_name, "Lore repo created via API");
    Ok(Json(serde_json::json!(repo)))
}

async fn get_repo(
    State(state): State<Arc<AppState>>,
    _auth: AuthUser,
    Path(channel_id): Path<i64>,
) -> Result<Json<serde_json::Value>, AppError> {
    let lore = lore_service(&state).await?;
    match lore.get_repo(channel_id).await {
        Some(repo) => Ok(Json(serde_json::json!(repo))),
        None => Err(AppError::NotFound("No Lore repo for this channel".into())),
    }
}

async fn delete_repo(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
) -> Result<Json<serde_json::Value>, AppError> {
    let lore = lore_service(&state).await?;
    lore.delete_repo(channel_id).await?;

    state
        .wdb
        .lore_delete_repo(channel_id, auth.user_id)
        .await?;

    info!(channel_id, "Lore repo deleted via API");
    Ok(Json(serde_json::json!({ "status": "ok" })))
}

#[derive(Deserialize)]
struct SnapshotPayload {
    message: String,
}

async fn snapshot(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
    Json(payload): Json<SnapshotPayload>,
) -> Result<Json<serde_json::Value>, AppError> {
    let lore = lore_service(&state).await?;
    let revision = lore.commit_staged(channel_id, &payload.message, auth.user_id).await?;

    let repo = lore.get_repo(channel_id).await;
    if let Some(repo) = repo {
        let _ = state
            .wdb
            .lore_commit(channel_id, &revision.hash, &repo.repo_name, "*snapshot", &payload.message, auth.user_id)
            .await;
    }

    Ok(Json(serde_json::json!({ "revision": revision })))
}

// -- File operations --

#[derive(Deserialize)]
struct ListFilesQuery {
    prefix: Option<String>,
}

async fn list_files(
    State(state): State<Arc<AppState>>,
    _auth: AuthUser,
    Path(channel_id): Path<i64>,
    Query(query): Query<ListFilesQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let lore = lore_service(&state).await?;
    let files = lore.list_files(channel_id, query.prefix.as_deref()).await?;
    Ok(Json(serde_json::json!(files)))
}

#[derive(Deserialize)]
struct UploadQuery {
    message: Option<String>,
    repo_path: Option<String>,
}

async fn upload_file(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path((channel_id, path)): Path<(i64, String)>,
    Query(query): Query<UploadQuery>,
    body: axum::body::Bytes,
) -> Result<Json<serde_json::Value>, AppError> {
    let message = query.message.unwrap_or_else(|| "Upload via API".into());
    let repo_path = query.repo_path.unwrap_or_else(|| path.clone());

    let tmp_dir = std::env::temp_dir();
    let tmp_path = tmp_dir.join(format!("lore-upload-{}", uuid::Uuid::new_v4()));
    tokio::fs::write(&tmp_path, &body).await?;

    let lore = lore_service(&state).await?;
    let (revision, file_info) = lore
        .upload_file(channel_id, tmp_path.to_str().unwrap_or("/dev/null"), &repo_path, &message, auth.user_id)
        .await?;

    let _ = tokio::fs::remove_file(&tmp_path).await;

    let repo = lore.get_repo(channel_id).await;
    if let Some(repo) = repo {
        let _ = state
            .wdb
            .lore_commit(channel_id, &revision.hash, &repo.repo_name, &repo_path, &message, auth.user_id)
            .await;
    }

    Ok(Json(serde_json::json!({ "revision": revision, "file": file_info })))
}

/// Query parameters for [`upload_recording`].
#[derive(Debug, Deserialize)]
struct UploadRecordingQuery {
    /// Commit message recorded in the Lore repo.
    message: Option<String>,
    /// Destination file name within the channel's `recordings/` folder.
    filename: Option<String>,
}

/// Upload a finished call recording to the configured "Recordings" Asset Storage
/// channel.
///
/// The target channel is resolved by name from `LoreConfig.recordings_channel_name`
/// (default "Recordings"). If no such channel exists, the request 404s — the
/// operator is expected to create the channel once. The raw request body is the
/// file bytes (`application/octet-stream`), mirroring [`upload_file`].
async fn upload_recording(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Query(query): Query<UploadRecordingQuery>,
    body: axum::body::Bytes,
) -> Result<Json<serde_json::Value>, AppError> {
    let lore = lore_service(&state).await?;
    let channel_name = lore.recordings_channel_name().to_string();

    // Resolve the Recordings channel by name.
    let channels = state.wdb.get_channels_raw().await?;
    let channel = channels
        .iter()
        .find(|c| c.get("name").and_then(|v| v.as_str()) == Some(channel_name.as_str()))
        .ok_or_else(|| {
            AppError::NotFound(format!("Recordings channel '{channel_name}' not found"))
        })?;

    let channel_id_str = channel
        .get("channel_id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| AppError::Internal("Recordings channel missing id".into()))?;
    let lore_channel_id = channel_id_str
        .strip_prefix("ch_")
        .and_then(|hex| i64::from_str_radix(hex, 16).ok())
        .ok_or_else(|| {
            AppError::Internal(format!("Invalid Recordings channel id {channel_id_str}"))
        })?;

    // The resolved channel must actually be a Lore-backed Asset Storage
    // channel. If a non-asset-storage channel happens to share the name, or its
    // repo was never created, fail cleanly with 404 rather than an opaque
    // internal error from the upload path.
    if lore.get_repo(lore_channel_id).await.is_none() {
        return Err(AppError::NotFound(format!(
            "Recordings channel '{channel_name}' is not an Asset Storage channel with a Lore repo"
        )));
    }

    let filename = query
        .filename
        .unwrap_or_else(|| format!("recording-{}.webm", uuid::Uuid::new_v4()));
    let repo_path = format!("recordings/{filename}");
    let message = query
        .message
        .unwrap_or_else(|| format!("Call recording {filename}"));

    let tmp_dir = std::env::temp_dir();
    let tmp_path = tmp_dir.join(format!("lore-recording-{}", uuid::Uuid::new_v4()));
    tokio::fs::write(&tmp_path, &body).await?;

    let (revision, file_info) = lore
        .upload_file(
            lore_channel_id,
            tmp_path.to_str().unwrap_or("/dev/null"),
            &repo_path,
            &message,
            auth.user_id,
        )
        .await?;

    let _ = tokio::fs::remove_file(&tmp_path).await;

    let repo = lore.get_repo(lore_channel_id).await;
    if let Some(repo) = repo {
        let _ = state
            .wdb
            .lore_commit(
                lore_channel_id,
                &revision.hash,
                &repo.repo_name,
                &repo_path,
                &message,
                auth.user_id,
            )
            .await;
    }

    Ok(Json(serde_json::json!({
        "revision": revision,
        "file": file_info,
        "path": repo_path,
    })))
}

#[derive(Deserialize)]
struct DownloadQuery {
    revision: Option<String>,
}

/// Parse a `Range: bytes=START-END` or `bytes=START-` header.
/// Returns `(start, end)` inclusive byte positions, or `None` if unparseable.
fn parse_byte_range(range_str: &str, file_size: u64) -> Option<(u64, u64)> {
    let range_str = range_str.strip_prefix("bytes=")?;
    let (start_str, end_str) = range_str.split_once('-')?;
    let start: u64 = start_str.parse().ok()?;
    if start >= file_size {
        return None;
    }
    let end = if end_str.is_empty() {
        file_size - 1
    } else {
        end_str.parse::<u64>().ok()?.min(file_size - 1)
    };
    if end < start {
        return None;
    }
    Some((start, end))
}

/// Build a stable cache file name from channel_id, path, and optional revision.
fn cache_path(channel_id: i64, path: &str, revision: Option<&str>) -> std::path::PathBuf {
    let mut key = format!("{}_{}", channel_id, path.replace('/', "_"));
    if let Some(rev) = revision {
        key.push('_');
        key.push_str(rev);
    }
    // Sanitize: only alphanumeric, underscore, dash
    let sanitized: String = key
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    let tmp_dir = std::env::temp_dir().join("wabi-lore-cache");
    tmp_dir.join(sanitized)
}

async fn download_file(
    State(state): State<Arc<AppState>>,
    _auth: AuthUser,
    Path((channel_id, path)): Path<(i64, String)>,
    Query(query): Query<DownloadQuery>,
    headers: axum::http::HeaderMap,
) -> Result<axum::response::Response, AppError> {
    let tmp_path = cache_path(channel_id, &path, query.revision.as_deref());
    tokio::fs::create_dir_all(tmp_path.parent().unwrap_or(std::path::Path::new("."))).await?;

    // Download via Lore CLI if not cached
    if !tokio::fs::try_exists(&tmp_path).await.unwrap_or(false) {
        let lore = lore_service(&state).await?;
        lore.download_file(
            channel_id,
            &path,
            tmp_path.to_str().unwrap_or("/dev/null"),
            query.revision.as_deref(),
        )
        .await?;
    }

    let file_size = tokio::fs::metadata(&tmp_path).await?.len();
    let mime = mime_guess::from_path(&path).first_or_octet_stream();

    // Schedule cleanup after 5 minutes
    let cleanup_path = tmp_path.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(300)).await;
        let _ = tokio::fs::remove_file(&cleanup_path).await;
    });

    // Try to serve a byte range
    if let Some(range_val) = headers.get(axum::http::header::RANGE) {
        if let Ok(range_str) = range_val.to_str() {
            if let Some((start, end)) = parse_byte_range(range_str, file_size) {
                let length = end - start + 1;
                let mut buf = vec![0u8; length as usize];
                let mut file = tokio::fs::File::open(&tmp_path).await?;
                file.seek(std::io::SeekFrom::Start(start)).await?;
                file.read_exact(&mut buf).await?;

                let resp = axum::response::Response::builder()
                    .status(axum::http::StatusCode::PARTIAL_CONTENT)
                    .header(axum::http::header::CONTENT_TYPE, mime.as_ref())
                    .header(
                        axum::http::header::CONTENT_RANGE,
                        format!("bytes {}-{}/{}", start, end, file_size),
                    )
                    .header(axum::http::header::CONTENT_LENGTH, length.to_string())
                    .header(axum::http::header::ACCEPT_RANGES, "bytes")
                    .body(axum::body::Body::from(buf))
                    .unwrap();
                return Ok(resp);
            }
        }
    }

    // Full content
    let data = tokio::fs::read(&tmp_path).await?;
    let resp = axum::response::Response::builder()
        .status(axum::http::StatusCode::OK)
        .header(axum::http::header::CONTENT_TYPE, mime.as_ref())
        .header(axum::http::header::CONTENT_LENGTH, data.len().to_string())
        .header(axum::http::header::ACCEPT_RANGES, "bytes")
        .body(axum::body::Body::from(data))
        .unwrap();
    Ok(resp)
}

#[derive(Deserialize)]
struct DeleteFilePayload {
    message: Option<String>,
}

async fn delete_file(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path((channel_id, path)): Path<(i64, String)>,
    Json(payload): Json<DeleteFilePayload>,
) -> Result<Json<serde_json::Value>, AppError> {
    let message = payload.message.unwrap_or_else(|| "Deleted via API".into());

    let lore = lore_service(&state).await?;
    lore.delete_file(channel_id, &path, &message).await?;

    info!(channel_id, path, "File deleted from Lore repo");
    Ok(Json(serde_json::json!({ "status": "ok" })))
}

// -- File locking --

async fn lock_file(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path((channel_id, path)): Path<(i64, String)>,
) -> Result<Json<serde_json::Value>, AppError> {
    let lore = lore_service(&state).await?;
    lore.lock_file(channel_id, &path, auth.user_id).await?;

    Ok(Json(serde_json::json!({ "status": "ok", "locked_by": auth.user_id })))
}

async fn unlock_file(
    State(state): State<Arc<AppState>>,
    _auth: AuthUser,
    Path((channel_id, path)): Path<(i64, String)>,
) -> Result<Json<serde_json::Value>, AppError> {
    let lore = lore_service(&state).await?;
    lore.unlock_file(channel_id, &path).await?;

    Ok(Json(serde_json::json!({ "status": "ok" })))
}

// -- History & Diff --

async fn repo_history(
    State(state): State<Arc<AppState>>,
    _auth: AuthUser,
    Path(channel_id): Path<i64>,
) -> Result<Json<serde_json::Value>, AppError> {
    let lore = lore_service(&state).await?;
    let history = lore.file_history(channel_id, "").await?;
    Ok(Json(serde_json::json!(history)))
}

async fn file_level_history(
    State(state): State<Arc<AppState>>,
    _auth: AuthUser,
    Path((channel_id, path)): Path<(i64, String)>,
) -> Result<Json<serde_json::Value>, AppError> {
    let lore = lore_service(&state).await?;
    let history = lore.file_level_history(channel_id, &path).await?;
    Ok(Json(serde_json::json!(history)))
}

#[derive(Deserialize)]
struct DiffQuery {
    from: String,
    to: String,
}

async fn file_diff(
    State(state): State<Arc<AppState>>,
    _auth: AuthUser,
    Path((channel_id, path)): Path<(i64, String)>,
    Query(query): Query<DiffQuery>,
) -> Result<axum::response::Response, AppError> {
    let lore = lore_service(&state).await?;
    let diff = lore.file_diff(channel_id, &path, &query.from, &query.to).await?;

    Ok(([(axum::http::header::CONTENT_TYPE, "text/plain")], diff).into_response())
}

// -- Branches --

async fn list_branches(
    State(state): State<Arc<AppState>>,
    _auth: AuthUser,
    Path(channel_id): Path<i64>,
) -> Result<Json<serde_json::Value>, AppError> {
    let lore = lore_service(&state).await?;
    let branches = lore.list_branches(channel_id).await?;
    Ok(Json(serde_json::json!({ "branches": branches })))
}

async fn create_branch(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
    Json(payload): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, AppError> {
    let branch_name = payload["name"].as_str().unwrap_or("feature");
    let base_revision = payload["baseRevision"].as_str();

    let lore = lore_service(&state).await?;
    lore.create_branch(channel_id, branch_name, base_revision).await?;

    Ok(Json(serde_json::json!({ "status": "ok", "branch": branch_name, "created_by": auth.user_id })))
}

async fn merge_branch(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path((channel_id, branch_name)): Path<(i64, String)>,
) -> Result<Json<serde_json::Value>, AppError> {
    let lore = lore_service(&state).await?;
    lore.merge_branch(channel_id, &branch_name).await?;

    info!(channel_id, branch_name, "Branch merged via API");
    Ok(Json(serde_json::json!({ "status": "ok", "branch": branch_name, "merged_by": auth.user_id })))
}

// -- Health --

async fn health_check(
    State(state): State<Arc<AppState>>,
) -> Json<serde_json::Value> {
    let lore = state.lore_service.read().await;
    match lore.as_ref() {
        Some(service) => {
            match service.health_check().await {
                Ok(_) => Json(serde_json::json!({ "status": "ok", "addon": "lore" })),
                Err(e) => Json(serde_json::json!({ "status": "error", "addon": "lore", "error": e.to_string() })),
            }
        }
        None => Json(serde_json::json!({ "status": "disabled", "addon": "lore" })),
    }
}
