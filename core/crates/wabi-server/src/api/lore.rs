use std::sync::Arc;

use axum::{
    extract::{Path, Query, State},
    response::IntoResponse,
    Json, Router,
};
use serde::Deserialize;
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tracing::info;

use crate::auth_extractor::{AuthUser, OptionalAuthUser};
use crate::error::{AppError, Result};
use crate::state::AppState;
use wabidb::engine::wabi_store::WabiStore;

/// HMAC-SHA256 signature helper for signed download URLs (L7).
/// Payload: `{channel_id}|{user_id}|{path}|{expires}` — user is embedded so
/// membership can be re-checked at download time, not just at mint time.
fn lore_signature(secret: &str, channel_id: i64, user_id: i64, path: &str, expires: i64) -> String {
    use hmac::{Hmac, Mac};
    use sha2::Sha256;
    type HmacSha256 = Hmac<Sha256>;
    let mut mac =
        HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC accepts any key size");
    mac.update(format!("{channel_id}|{user_id}|{path}|{expires}").as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

/// Workspace-role gates for Lore (L8).
/// Owner/Admin/Developer = full edit; Artist = asset-write only; Viewer = read-only.
async fn lore_role(state: &AppState, user_id: i64) -> Option<String> {
    state
        .wdb
        .get_user_role("default-workspace", user_id as u64)
        .await
        .ok()
        .flatten()
}

async fn can_edit_lore(state: &AppState, user_id: i64) -> bool {
    if state.is_owner(user_id).await || state.is_admin(user_id).await {
        return true;
    }
    match lore_role(state, user_id).await.map(|r| r.to_ascii_lowercase()) {
        Some(r) => matches!(r.as_str(), "owner" | "admin" | "developer"),
        None => false,
    }
}

async fn can_asset_write_lore(state: &AppState, user_id: i64) -> bool {
    if can_edit_lore(state, user_id).await {
        return true;
    }
    match lore_role(state, user_id).await.map(|r| r.to_ascii_lowercase()) {
        Some(r) => r == "artist",
        None => false,
    }
}

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
        // L7: signed download URL mint (AuthUser + membership at mint time)
        .route("/repos/{channel_id}/signed-url", axum::routing::get(signed_download_url))
        // Repo history
        .route("/repos/{channel_id}/history", axum::routing::get(repo_history))
        // Branch operations
        .route("/repos/{channel_id}/branches", axum::routing::get(list_branches).post(create_branch))
        .route("/repos/{channel_id}/branches/{branch_name}/merge", axum::routing::post(merge_branch))
        // Health
        .route("/health", axum::routing::get(health_check))
        // Call recording upload (auto-resolves the configured Recordings channel)
        .route("/recordings", axum::routing::post(upload_recording))
        // P4: Editor bridge — ephemeral code-server sessions
        .route("/repos/{channel_id}/editor", axum::routing::post(start_editor_session).delete(stop_editor_session))
        .route("/repos/{channel_id}/editor/sessions", axum::routing::get(list_editor_sessions))
        // P5: Script collaboration — run scripts from the repo
        .route("/repos/{channel_id}/scripts/run", axum::routing::post(run_script))
        .route("/repos/{channel_id}/scripts/active", axum::routing::get(list_active_scripts))
        .route("/repos/{channel_id}/scripts/{script_id}/cancel", axum::routing::post(cancel_script))
        // P7: Off-box mirroring — publish to GitHub/GitLab/S3
        .route("/repos/{channel_id}/mirror", axum::routing::post(register_mirror).get(get_mirror_config).delete(remove_mirror))
        .route("/repos/{channel_id}/mirror/run", axum::routing::post(run_mirror))
        .route("/repos/{channel_id}/mirror/configs", axum::routing::get(list_mirror_configs))
        .with_state(state)
}

async fn ensure_channel_member(
    state: &AppState,
    channel_id: i64,
    user_id: i64,
) -> Result<()> {
    let ch_str = format!("ch_{:x}", channel_id);
    let members = state.wdb.list_channel_members(&ch_str).await?;
    if !members.iter().any(|m| m.user_id == user_id as u64) {
        return Err(AppError::Forbidden(format!(
            "User {user_id} is not a member of channel {channel_id}"
        )));
    }
    Ok(())
}

async fn lore_service(state: &AppState) -> Result<Arc<wabi_lore::LoreService>> {
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
) -> Result<Json<serde_json::Value>> {
    let channel_id = payload["channelId"].as_i64().unwrap_or(0);
    ensure_channel_member(&state, channel_id, auth.user_id).await?;
    // L8: repo management = Owner/Admin/Developer
    if !can_edit_lore(&state, auth.user_id).await {
        return Err(AppError::Forbidden("Lore repo operations require Owner/Admin/Developer role".into()));
    }
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
    auth: AuthUser,
    Path(channel_id): Path<i64>,
) -> Result<Json<serde_json::Value>> {
    ensure_channel_member(&state, channel_id, auth.user_id).await?;
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
) -> Result<Json<serde_json::Value>> {
    ensure_channel_member(&state, channel_id, auth.user_id).await?;
    // L8: repo management = Owner/Admin/Developer
    if !can_edit_lore(&state, auth.user_id).await {
        return Err(AppError::Forbidden("Lore repo operations require Owner/Admin/Developer role".into()));
    }
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
) -> Result<Json<serde_json::Value>> {
    ensure_channel_member(&state, channel_id, auth.user_id).await?;
    // L8: commits = Owner/Admin/Developer
    if !can_edit_lore(&state, auth.user_id).await {
        return Err(AppError::Forbidden("Lore commits require Owner/Admin/Developer role".into()));
    }
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
    auth: AuthUser,
    Path(channel_id): Path<i64>,
    Query(query): Query<ListFilesQuery>,
) -> Result<Json<serde_json::Value>> {
    ensure_channel_member(&state, channel_id, auth.user_id).await?;
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
) -> Result<Json<serde_json::Value>> {
    ensure_channel_member(&state, channel_id, auth.user_id).await?;
    // L8: asset writes = Owner/Admin/Developer/Artist
    if !can_asset_write_lore(&state, auth.user_id).await {
        return Err(AppError::Forbidden("Lore asset uploads require at least Artist role".into()));
    }
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
) -> Result<Json<serde_json::Value>> {
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

    ensure_channel_member(&state, lore_channel_id, auth.user_id).await?;

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
    expires: Option<i64>,
    uid: Option<i64>,
    sig: Option<String>,
    download: Option<u8>,
}

/// Query for the signed-URL mint endpoint (L7).
#[derive(Deserialize)]
struct SignedUrlQuery {
    path: String,
    revision: Option<String>,
    expires: Option<i64>,
}

/// GET /repos/{channel_id}/signed-url?path=...&revision=...&expires=...
/// Requires AuthUser + channel membership. Returns a short-lived HMAC-signed
/// download URL usable from <a href>/window.open without a Bearer header.
async fn signed_download_url(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
    Query(query): Query<SignedUrlQuery>,
) -> Result<Json<serde_json::Value>> {
    ensure_channel_member(&state, channel_id, auth.user_id).await?;

    let now = chrono::Utc::now().timestamp();
    let ttl = query.expires.unwrap_or(now + 300);
    let expires = ttl.clamp(now + 60, now + 3600);

    let sig = lore_signature(
        &state.config.jwt_secret,
        channel_id,
        auth.user_id,
        &query.path,
        expires,
    );

    let mut url = format!(
        "/api/addons/lore/repos/{}/files/{}?expires={}&uid={}&sig={}",
        channel_id,
        urlencoding::encode(&query.path),
        expires,
        auth.user_id,
        sig
    );
    if let Some(rev) = &query.revision {
        url.push_str(&format!("&revision={}", urlencoding::encode(rev)));
    }

    Ok(Json(serde_json::json!({
        "url": url,
        "expiresAt": expires,
    })))
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
    auth: OptionalAuthUser,
    Path((channel_id, path)): Path<(i64, String)>,
    Query(query): Query<DownloadQuery>,
    headers: axum::http::HeaderMap,
) -> Result<axum::response::Response> {
    // L7: signed-URL path — no Bearer header required; membership was checked
    // at mint time and is re-checked here via the embedded uid.
    let user_id = if let (Some(expires), Some(uid), Some(sig)) =
        (query.expires, query.uid, query.sig.as_deref())
    {
        let now = chrono::Utc::now().timestamp();
        if now > expires || expires - now > 3600 {
            return Err(AppError::Forbidden("signed URL expired".into()));
        }
        let expected =
            lore_signature(&state.config.jwt_secret, channel_id, uid, &path, expires);
        if sig != expected {
            return Err(AppError::Forbidden("invalid signed URL signature".into()));
        }
        uid
    } else {
        let user = auth
            .0
            .ok_or_else(|| AppError::Unauthorized("Authentication required".into()))?;
        user.user_id
    };
    ensure_channel_member(&state, channel_id, user_id).await?;
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
    let mut builder = axum::response::Response::builder()
        .status(axum::http::StatusCode::OK)
        .header(axum::http::header::CONTENT_TYPE, mime.as_ref())
        .header(axum::http::header::CONTENT_LENGTH, data.len().to_string())
        .header(axum::http::header::ACCEPT_RANGES, "bytes");
    // L7: ?download=1 → attachment disposition (direct web save)
    if query.download == Some(1) {
        let filename = path.rsplit('/').next().unwrap_or("download");
        builder = builder.header(
            axum::http::header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{}\"", filename.replace('"', "_")),
        );
    }
    let resp = builder.body(axum::body::Body::from(data)).unwrap();
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
) -> Result<Json<serde_json::Value>> {
    ensure_channel_member(&state, channel_id, auth.user_id).await?;
    // L8: asset writes = Owner/Admin/Developer/Artist
    if !can_asset_write_lore(&state, auth.user_id).await {
        return Err(AppError::Forbidden("Lore asset deletion requires at least Artist role".into()));
    }
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
) -> Result<Json<serde_json::Value>> {
    ensure_channel_member(&state, channel_id, auth.user_id).await?;
    // L8: asset writes = Owner/Admin/Developer/Artist
    if !can_asset_write_lore(&state, auth.user_id).await {
        return Err(AppError::Forbidden("Lore locking requires at least Artist role".into()));
    }
    let lore = lore_service(&state).await?;
    lore.lock_file(channel_id, &path, auth.user_id).await?;

    Ok(Json(serde_json::json!({ "status": "ok", "locked_by": auth.user_id })))
}

async fn unlock_file(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path((channel_id, path)): Path<(i64, String)>,
) -> Result<Json<serde_json::Value>> {
    ensure_channel_member(&state, channel_id, auth.user_id).await?;
    // L8: asset writes = Owner/Admin/Developer/Artist
    if !can_asset_write_lore(&state, auth.user_id).await {
        return Err(AppError::Forbidden("Lore unlocking requires at least Artist role".into()));
    }
    let lore = lore_service(&state).await?;
    lore.unlock_file(channel_id, &path).await?;

    Ok(Json(serde_json::json!({ "status": "ok" })))
}

// -- History & Diff --

async fn repo_history(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
) -> Result<Json<serde_json::Value>> {
    ensure_channel_member(&state, channel_id, auth.user_id).await?;
    let lore = lore_service(&state).await?;
    let history = lore.file_history(channel_id, "").await?;
    Ok(Json(serde_json::json!(history)))
}

async fn file_level_history(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path((channel_id, path)): Path<(i64, String)>,
) -> Result<Json<serde_json::Value>> {
    ensure_channel_member(&state, channel_id, auth.user_id).await?;
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
    auth: AuthUser,
    Path((channel_id, path)): Path<(i64, String)>,
    Query(query): Query<DiffQuery>,
) -> Result<axum::response::Response> {
    ensure_channel_member(&state, channel_id, auth.user_id).await?;
    let lore = lore_service(&state).await?;
    let diff = lore.file_diff(channel_id, &path, &query.from, &query.to).await?;

    Ok(([(axum::http::header::CONTENT_TYPE, "text/plain")], diff).into_response())
}

// -- Branches --

async fn list_branches(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
) -> Result<Json<serde_json::Value>> {
    ensure_channel_member(&state, channel_id, auth.user_id).await?;
    let lore = lore_service(&state).await?;
    let branches = lore.list_branches(channel_id).await?;
    Ok(Json(serde_json::json!({ "branches": branches })))
}

async fn create_branch(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
    Json(payload): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>> {
    ensure_channel_member(&state, channel_id, auth.user_id).await?;
    // L8: branch management = Owner/Admin/Developer
    if !can_edit_lore(&state, auth.user_id).await {
        return Err(AppError::Forbidden("Lore branch operations require Owner/Admin/Developer role".into()));
    }
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
) -> Result<Json<serde_json::Value>> {
    ensure_channel_member(&state, channel_id, auth.user_id).await?;
    // L8: branch management = Owner/Admin/Developer
    if !can_edit_lore(&state, auth.user_id).await {
        return Err(AppError::Forbidden("Lore branch operations require Owner/Admin/Developer role".into()));
    }
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

// -- P4: Editor Bridge --

#[derive(Deserialize)]
struct EditorSessionRequest {
    repo_path: Option<String>,
}

async fn start_editor_session(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
    Json(payload): Json<EditorSessionRequest>,
) -> Result<Json<serde_json::Value>> {
    ensure_channel_member(&state, channel_id, auth.user_id).await?;
    if !can_edit_lore(&state, auth.user_id).await {
        return Err(AppError::Forbidden("Editor sessions require Owner/Admin/Developer role".into()));
    }
    let lore = lore_service(&state).await?;
    let session = lore
        .editor_bridge
        .start_session(channel_id, auth.user_id, payload.repo_path)
        .await?;
    Ok(Json(serde_json::json!({ "session": session })))
}

async fn stop_editor_session(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
) -> Result<Json<serde_json::Value>> {
    ensure_channel_member(&state, channel_id, auth.user_id).await?;
    let lore = lore_service(&state).await?;
    // Stop all sessions for this channel (simplification: stop by listing)
    let sessions = lore.editor_bridge.list_sessions().await;
    for s in sessions {
        if s.channel_id == channel_id {
            let _ = lore.editor_bridge.stop_session(&s.session_id).await;
        }
    }
    Ok(Json(serde_json::json!({ "status": "ok", "stopped": "all" })))
}

async fn list_editor_sessions(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
) -> Result<Json<serde_json::Value>> {
    ensure_channel_member(&state, channel_id, auth.user_id).await?;
    let lore = lore_service(&state).await?;
    let sessions: Vec<_> = lore
        .editor_bridge
        .list_sessions()
        .await
        .into_iter()
        .filter(|s| s.channel_id == channel_id)
        .collect();
    Ok(Json(serde_json::json!({ "sessions": sessions })))
}

// -- P5: Script Runner --

#[derive(Deserialize)]
struct RunScriptRequest {
    script_path: String,
    arguments: Option<Vec<String>>,
    working_dir: Option<String>,
}

async fn run_script(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
    Json(payload): Json<RunScriptRequest>,
) -> Result<Json<serde_json::Value>> {
    ensure_channel_member(&state, channel_id, auth.user_id).await?;
    if !can_edit_lore(&state, auth.user_id).await {
        return Err(AppError::Forbidden("Script execution requires Owner/Admin/Developer role".into()));
    }
    let lore = lore_service(&state).await?;
    let working_dir = payload.working_dir.unwrap_or_else(|| {
        format!(
            "{}/{}",
            lore.lore_server_url().replace("lore://", ""),
            channel_id
        )
    });
    let result = lore
        .script_runner
        .run_script(
            channel_id,
            auth.user_id,
            payload.script_path,
            payload.arguments.unwrap_or_default(),
            working_dir,
        )
        .await?;
    Ok(Json(serde_json::json!({ "result": result })))
}

async fn list_active_scripts(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
) -> Result<Json<serde_json::Value>> {
    ensure_channel_member(&state, channel_id, auth.user_id).await?;
    let lore = lore_service(&state).await?;
    let active: Vec<_> = lore
        .script_runner
        .list_active()
        .await
        .into_iter()
        .filter(|s| s.channel_id == channel_id)
        .collect();
    Ok(Json(serde_json::json!({ "active": active })))
}

async fn cancel_script(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path((channel_id, script_id)): Path<(i64, String)>,
) -> Result<Json<serde_json::Value>> {
    ensure_channel_member(&state, channel_id, auth.user_id).await?;
    let lore = lore_service(&state).await?;
    lore.script_runner.cancel_script(&script_id).await?;
    Ok(Json(serde_json::json!({ "status": "ok", "cancelled": script_id })))
}

// -- P7: Off-box Mirror --

#[derive(Deserialize)]
struct MirrorConfigRequest {
    backend: Option<String>,
    remote_url: String,
    branches: Option<Vec<String>>,
    tags: Option<bool>,
    auto_mirror: Option<bool>,
}

async fn register_mirror(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
    Json(payload): Json<MirrorConfigRequest>,
) -> Result<Json<serde_json::Value>> {
    ensure_channel_member(&state, channel_id, auth.user_id).await?;
    if !can_edit_lore(&state, auth.user_id).await {
        return Err(AppError::Forbidden("Mirror config requires Owner/Admin role".into()));
    }
    let lore = lore_service(&state).await?;
    let backend = match payload.backend.as_deref().unwrap_or("git") {
        "github" => wabi_lore::mirror::MirrorBackend::GitHub,
        "gitlab" => wabi_lore::mirror::MirrorBackend::GitLab,
        "s3" => wabi_lore::mirror::MirrorBackend::S3,
        _ => wabi_lore::mirror::MirrorBackend::GenericGit,
    };
    let config = wabi_lore::mirror::MirrorConfig {
        channel_id,
        backend,
        remote_url: payload.remote_url,
        branches: payload.branches.unwrap_or_default(),
        tags: payload.tags.unwrap_or(true),
        auto_mirror: payload.auto_mirror.unwrap_or(false),
        mirror_on_push: false,
        credentials_secret_id: None,
        last_mirror_at: None,
        last_mirror_status: None,
    };
    lore.mirror.register_mirror(config).await?;
    Ok(Json(serde_json::json!({ "status": "ok", "channel_id": channel_id })))
}

async fn get_mirror_config(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
) -> Result<Json<serde_json::Value>> {
    ensure_channel_member(&state, channel_id, auth.user_id).await?;
    let lore = lore_service(&state).await?;
    match lore.mirror.get_config(channel_id).await {
        Some(config) => Ok(Json(serde_json::json!(config))),
        None => Err(AppError::NotFound("No mirror configuration for this channel".into())),
    }
}

async fn remove_mirror(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
) -> Result<Json<serde_json::Value>> {
    ensure_channel_member(&state, channel_id, auth.user_id).await?;
    if !can_edit_lore(&state, auth.user_id).await {
        return Err(AppError::Forbidden("Mirror removal requires Owner/Admin role".into()));
    }
    let lore = lore_service(&state).await?;
    lore.mirror.remove_mirror(channel_id).await?;
    Ok(Json(serde_json::json!({ "status": "ok" })))
}

async fn run_mirror(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
) -> Result<Json<serde_json::Value>> {
    ensure_channel_member(&state, channel_id, auth.user_id).await?;
    if !can_edit_lore(&state, auth.user_id).await {
        return Err(AppError::Forbidden("Mirror run requires Owner/Admin role".into()));
    }
    let lore = lore_service(&state).await?;
    let result = lore.mirror.mirror(channel_id).await?;
    Ok(Json(serde_json::json!({ "result": result })))
}

async fn list_mirror_configs(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
) -> Result<Json<serde_json::Value>> {
    ensure_channel_member(&state, channel_id, auth.user_id).await?;
    let lore = lore_service(&state).await?;
    let configs: Vec<_> = lore
        .mirror
        .list_configs()
        .await
        .into_iter()
        .filter(|c| c.channel_id == channel_id)
        .collect();
    Ok(Json(serde_json::json!({ "configs": configs })))
}
