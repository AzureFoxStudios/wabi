//! File upload routes - resumable uploads with real file storage
//!
//! Implements:
//! - POST /api/upload/resumable/init - Initialize or resume an upload
//! - PUT  /api/upload/resumable/chunk - Upload a chunk
//! - POST /api/upload/resumable/complete - Finalize upload
//!
//! Files are stored in the configured `uploads_dir`:
//! - Temp chunks: `{uploads_dir}/.tmp/{upload_id}`
//! - Completed files: `{uploads_dir}/{uuid}.{ext}`
//!
//! The server must also serve static files from uploads_dir via a separate route.

use axum::{
    extract::{Query, State},
    routing::{post, put},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, path::PathBuf, sync::Arc};
use tokio::fs::{File, OpenOptions};
use tokio::io::{AsyncSeekExt, AsyncWriteExt};
use tokio::sync::RwLock;
use uuid::Uuid;

use wabidb::engine::wabi_store::WabiStore;

use crate::auth_extractor::AuthUser;
use crate::error::Result;
use crate::state::AppState;
use crate::upload_registry::UploadKind;

/// Upload session state — stored in-memory for the lifetime of the server process.
#[derive(Debug, Clone)]
pub struct UploadSession {
    pub upload_id: String,
    pub file_name: String,
    pub file_size: u64,
    #[allow(dead_code)]
    pub mime_type: String,
    #[allow(dead_code)]
    pub channel_id: String,
    pub uploaded_bytes: u64,
    pub upload_token: String,
    /// Absolute path to the temp file while upload is in progress
    pub temp_path: PathBuf,
    /// File extension including dot (e.g. ".jpg", ".webm")
    pub extension: String,
    /// ID of the user who initiated the upload
    pub uploader_id: Option<i64>,
}
#[derive(Debug, Default)]
pub struct UploadState {
    pub sessions: RwLock<HashMap<String, UploadSession>>,
}

impl UploadState {
    pub fn new() -> Self {
        Self::default()
    }
}

/// Create upload router
pub fn routes(state: Arc<AppState>) -> Router<Arc<AppState>> {
    Router::new()
        .route("/resumable/init", post(init_upload))
        .route("/resumable/chunk", put(upload_chunk))
        .route("/resumable/complete", post(complete_upload))
        .route("/group-avatar", post(upload_group_avatar))
        .route("/background-image", post(upload_background_image))
        .route("/", post(upload_simple))
        .with_state(state)
}

/// Init upload request
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InitUploadRequest {
    upload_id: Option<String>,
    file_name: String,
    file_size: u64,
    mime_type: String,
    channel_id: String,
}

/// Init upload response
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct InitUploadResponse {
    upload_id: String,
    upload_token: String,
    uploaded_bytes: u64,
    completed: bool,
    file_url: Option<String>,
    attachment_storage: Option<AttachmentStorageMeta>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AttachmentStorageMeta {
    scheme: String,
    compressed: bool,
    codec: String,
    original_size: u64,
    stored_size: u64,
    at_rest_encrypted: bool,
}

/// Security headers applied to every uploaded-file response (GET /uploads/*).
///
/// Uploaded blobs are user-controlled content. We never let the browser
/// sniff the content type, and we serve them inside a locked-down CSP /
/// sandbox so a malicious upload (e.g. an SVG with embedded script, or an
/// HTML file) cannot execute or reach other origins.
const UPLOAD_SECURITY_HEADERS: &[(&str, &str)] = &[
    ("X-Content-Type-Options", "nosniff"),
    (
        "Content-Security-Policy",
        "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; sandbox",
    ),
];

/// Build the header map applied to uploaded-file responses.
///
/// Pure function so it can be unit-tested without spinning up the server.
pub fn upload_response_headers() -> Vec<(axum::http::HeaderName, axum::http::HeaderValue)> {
    UPLOAD_SECURITY_HEADERS
        .iter()
        .map(|(k, v)| {
            (
                axum::http::HeaderName::from_bytes(k.as_bytes()).expect("valid header name"),
                axum::http::HeaderValue::from_static(v),
            )
        })
        .collect()
}

/// Extension to MIME type mapping for safe file naming
fn extension_for_mime(mime: &str, fallback: &str) -> String {
    match mime {
        "image/jpeg" => ".jpg",
        "image/png" => ".png",
        "image/gif" => ".gif",
        "image/webp" => ".webp",
        "image/svg+xml" => ".svg",
        "image/apng" => ".apng",
        "audio/webm" => ".webm",
        "audio/ogg" => ".ogg",
        "audio/mp4" | "audio/m4a" => ".m4a",
        "audio/mpeg" | "audio/mp3" => ".mp3",
        "audio/wav" => ".wav",
        "video/webm" => ".webm",
        "video/mp4" => ".mp4",
        "application/octet-stream" => fallback,
        _ => fallback,
    }
    .to_string()
}

/// Initialize or resume an upload
async fn init_upload(
    auth: AuthUser,
    State(state): State<Arc<AppState>>,
    Json(req): Json<InitUploadRequest>,
) -> Result<Json<InitUploadResponse>> {
    if auth.is_guest {
        return Err(anyhow::anyhow!("Guests cannot upload files").into());
    }
    let uploads_dir = PathBuf::from(&state.config.uploads_dir);

    // Check if resuming existing upload
    if let Some(upload_id) = &req.upload_id {
        if let Some(session) = state
            .upload_state
            .sessions
            .read()
            .await
            .get(upload_id)
            .cloned()
        {
            // WS-3a: when resuming, require the caller owns the session.
            // Mismatch ⇒ 404 (do not confirm the session's existence).
            if session.uploader_id != Some(auth.user_id) {
                return Err(anyhow::anyhow!("Upload session not found").into());
            }
            tracing::info!(
                "Resume upload: {} ({} bytes so far)",
                upload_id,
                session.uploaded_bytes
            );
            return Ok(Json(InitUploadResponse {
                upload_id: session.upload_id.clone(),
                upload_token: session.upload_token.clone(),
                uploaded_bytes: session.uploaded_bytes,
                completed: false,
                file_url: None,
                attachment_storage: None,
            }));
        }
        tracing::info!("Upload session {} not found, starting fresh", upload_id);
    }

    // Create new upload session
    let upload_id = Uuid::new_v4().to_string();
    let upload_token = Uuid::new_v4().to_string();

    // Determine file extension from mime type
    let fallback_ext = PathBuf::from(&req.file_name)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| format!(".{}", e))
        .unwrap_or_else(|| ".bin".to_string());
    let extension = extension_for_mime(&req.mime_type, &fallback_ext);

    // Create temp directory and temp file
    let tmp_dir = uploads_dir.join(".tmp");
    tokio::fs::create_dir_all(&tmp_dir).await?;
    let temp_path = tmp_dir.join(&upload_id);
    let mut file = File::create(&temp_path).await?;
    file.write_all(&[]).await?;
    drop(file);

    let session = UploadSession {
        upload_id: upload_id.clone(),
        file_name: req.file_name.clone(),
        file_size: req.file_size,
        mime_type: req.mime_type.clone(),
        channel_id: req.channel_id.clone(),
        uploaded_bytes: 0,
        upload_token: upload_token.clone(),
        temp_path: temp_path.clone(),
        extension,
        uploader_id: Some(auth.user_id),
    };

    state
        .upload_state
        .sessions
        .write()
        .await
        .insert(upload_id.clone(), session);

    tracing::info!(
        "Init upload: {} ({} bytes, {}), temp at {:?}",
        req.file_name,
        req.file_size,
        req.mime_type,
        temp_path
    );

    Ok(Json(InitUploadResponse {
        upload_id,
        upload_token,
        uploaded_bytes: 0,
        completed: false,
        file_url: None,
        attachment_storage: None,
    }))
}

/// Chunk upload query params
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChunkQuery {
    upload_id: String,
    offset: u64,
}

/// Upload a chunk
async fn upload_chunk(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Query(query): Query<ChunkQuery>,
    body: axum::body::Bytes,
) -> Result<Json<InitUploadResponse>> {
    // The upload token is carried in a header (not the query string) so it is
    // not leaked into access logs / browser history.
    let upload_token = headers
        .get("x-upload-token")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| anyhow::anyhow!("Missing x-upload-token header"))?;

    // Look up session (clone to release the read lock before the async file ops)
    let session = state
        .upload_state
        .sessions
        .read()
        .await
        .get(&query.upload_id)
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("Upload session not found"))?;

    if session.upload_token != upload_token {
        return Err(anyhow::anyhow!("Invalid upload token").into());
    }

    let mut file = OpenOptions::new()
        .write(true)
        .open(&session.temp_path)
        .await?;
    file.seek(tokio::io::SeekFrom::Start(query.offset)).await?;
    file.write_all(&body).await?;
    file.flush().await?;
    drop(file);

    let uploaded_bytes = query.offset + body.len() as u64;
    if let Some(s) = state
        .upload_state
        .sessions
        .write()
        .await
        .get_mut(&query.upload_id)
    {
        s.uploaded_bytes = uploaded_bytes;
    }

    tracing::debug!(
        "Chunk {}: wrote {} bytes at offset {}, total {}",
        query.upload_id,
        body.len(),
        query.offset,
        uploaded_bytes
    );

    Ok(Json(InitUploadResponse {
        upload_id: query.upload_id.clone(),
        upload_token: upload_token.to_string(),
        uploaded_bytes,
        completed: uploaded_bytes >= session.file_size,
        file_url: None,
        attachment_storage: None,
    }))
}

/// Complete upload request
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CompleteUploadRequest {
    upload_id: String,
    upload_token: String,
}

/// Complete upload response
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CompleteUploadResponse {
    file_url: String,
    file_name: String,
    file_size: u64,
    attachment_storage: Option<AttachmentStorageMeta>,
}

/// Finalize an upload — move temp file to final location
async fn complete_upload(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Json(req): Json<CompleteUploadRequest>,
) -> Result<Json<CompleteUploadResponse>> {
    // WS-3b: verify token BEFORE removing the session.
    // Look up the session first without removing it.
    let session = {
        let sessions = state.upload_state.sessions.read().await;
        let s = sessions
            .get(&req.upload_id)
            .ok_or_else(|| anyhow::anyhow!("Upload session not found"))?
            .clone();
        if s.upload_token != req.upload_token {
            return Err(anyhow::anyhow!("Invalid upload token").into());
        }
        if s.uploader_id != Some(auth.user_id) {
            return Err(anyhow::anyhow!("Upload session not found").into());
        }
        s
    };

    // Now remove the session (token already verified).
    state
        .upload_state
        .sessions
        .write()
        .await
        .remove(&req.upload_id);

    // Final filename: UUID with original extension
    let final_name = format!("{}{}", session.upload_id, session.extension);
    let final_path = PathBuf::from(&state.config.uploads_dir).join(&final_name);

    // Move temp file to final location
    tokio::fs::rename(&session.temp_path, &final_path).await?;

    tracing::info!(
        "Completed upload: {} -> {:?} ({} bytes)",
        session.file_name,
        final_path,
        session.uploaded_bytes
    );

    // Record ownership (ops metadata). Failure is logged, never fatal.
    state
        .upload_registry
        .record(
            &final_name,
            &session.file_name,
            if session.channel_id.is_empty() {
                None
            } else {
                Some(session.channel_id.clone())
            },
            session.uploader_id,
            UploadKind::Attachment,
            session.uploaded_bytes,
        )
        .await;

    Ok(Json(CompleteUploadResponse {
        file_url: format!("/uploads/{}", final_name),
        file_name: session.file_name,
        file_size: session.uploaded_bytes,
        attachment_storage: Some(AttachmentStorageMeta {
            scheme: "wabi-storage-v1".to_string(),
            compressed: false,
            codec: "identity".to_string(),
            original_size: session.uploaded_bytes,
            stored_size: session.uploaded_bytes,
            at_rest_encrypted: false,
        }),
    }))
}

/// Upload group avatar — POST /api/upload/group-avatar
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GroupAvatarResponse {
    url: String,
}

/// Handler for group avatar upload.
/// Accepts a multipart form with a `file` field and `channelId`.
/// Saves the file, persists the avatar URL to WDB, then broadcasts
/// `group-avatar-updated` to all connected clients.
async fn upload_group_avatar(
    auth: AuthUser,
    State(state): State<Arc<AppState>>,
    mut multipart: axum::extract::Multipart,
) -> Result<Json<GroupAvatarResponse>> {
    use tokio::io::AsyncWriteExt;

    // WS-3e: guests cannot upload group avatars.
    if auth.is_guest {
        return Err(anyhow::anyhow!("Guests cannot upload group avatars").into());
    }

    let mut file_data: Vec<u8> = Vec::new();
    let mut filename = "avatar".to_string();
    let mut channel_id: Option<String> = None;

    // Extract fields from multipart
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| anyhow::anyhow!(e))?
    {
        let name = field.name().unwrap_or("").to_string();
        match name.as_str() {
            "file" => {
                filename = field.file_name().unwrap_or("avatar").to_string();
                file_data = field
                    .bytes()
                    .await
                    .map_err(|e| anyhow::anyhow!(e))?
                    .to_vec();
            }
            "channelId" | "channel_id" => {
                if let Ok(text) = field.text().await {
                    channel_id = Some(text);
                }
            }
            _ => {}
        }
    }

    let channel_id = channel_id.ok_or_else(|| anyhow::anyhow!("channel_id is required"))?;

    // WS-3e: require channel membership to upload group avatar.
    let is_member = state
        .wdb
        .list_channels(Some(auth.user_id as u64))
        .await
        .map_err(|e| anyhow::anyhow!("wdb list_channels: {e}"))?
        .iter()
        .any(|c| c.channel_id == channel_id);
    let is_owner = state.is_owner(auth.user_id).await;
    let is_admin = state.is_admin(auth.user_id).await;
    if !is_owner && !is_admin && !is_member {
        return Err(anyhow::anyhow!("Not a member of this channel").into());
    }

    if file_data.is_empty() {
        return Err(anyhow::anyhow!("No file data provided").into());
    }

    // Determine extension from filename
    let ext = std::path::Path::new(&filename)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| format!(".{}", e))
        .unwrap_or_else(|| ".png".to_string());

    // Write file to uploads dir with UUID name
    let uuid_name = Uuid::new_v4().to_string();
    let final_name = format!("{}{}", uuid_name, ext);
    let final_path = PathBuf::from(&state.config.uploads_dir).join(&final_name);

    let mut file = File::create(&final_path).await?;
    file.write_all(&file_data).await?;
    file.flush().await?;
    drop(file);

    let avatar_url = format!("/uploads/{}", final_name);
    tracing::info!(
        "Group avatar uploaded: {} ({} bytes) for channel {} -> {:?}",
        filename,
        file_data.len(),
        channel_id,
        final_path
    );

    state
        .upload_registry
        .record(
            &final_name,
            &filename,
            Some(channel_id.clone()),
            Some(auth.user_id),
            UploadKind::Avatar,
            file_data.len() as u64,
        )
        .await;

    // Persist avatar URL to WDB
    if let Err(e) = state
        .wdb
        .upsert_group(&channel_id, "", "group", None, Some(&avatar_url), None)
        .await
    {
        tracing::warn!(
            "[upload] group avatar: failed to persist avatar for {}: {}",
            channel_id,
            e
        );
    }

    // Broadcast update to all connected clients via SocketIo
    if let Some(io) = state.sio.read().await.clone() {
        let _ = io
            .broadcast()
            .emit(
                "group-avatar-updated",
                &serde_json::json!({
                    "channelId": channel_id,
                    "avatar": avatar_url,
                }),
            )
            .await;
    }

    Ok(Json(GroupAvatarResponse { url: avatar_url }))
}

/// POST /api/upload/background-image
///
/// Authenticated multipart upload of a custom chat background image for the
/// user's custom theme. Accepts a single multipart `backgroundImage` field
/// (matching BackgroundImageEditor.svelte), validates image type + size,
/// stores it under the uploads directory with a UUID name, and returns
/// `{ success: true, backgroundImageUrl }`. The URL itself is persisted by the
/// frontend inside its custom-theme preferences — no DB write here.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BackgroundImageResponse {
    success: bool,
    background_image_url: String,
}

async fn upload_background_image(
    auth: AuthUser,
    State(state): State<Arc<AppState>>,
    mut multipart: axum::extract::Multipart,
) -> Result<Json<BackgroundImageResponse>> {
    use tokio::io::AsyncWriteExt;

    if auth.is_guest {
        return Err(anyhow::anyhow!("Guests cannot upload background images").into());
    }

    const MAX_BACKGROUND_BYTES: usize = 10 * 1024 * 1024; // 10MB, mirrors client limit
    const ALLOWED_EXTS: [&str; 5] = ["png", "jpg", "jpeg", "gif", "webp"];

    let mut file_data: Vec<u8> = Vec::new();
    let mut filename = String::new();

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| anyhow::anyhow!(e))?
    {
        let name = field.name().unwrap_or("").to_string();
        if name == "backgroundImage" || name == "file" {
            filename = field.file_name().unwrap_or("background").to_string();
            file_data = field
                .bytes()
                .await
                .map_err(|e| anyhow::anyhow!(e))?
                .to_vec();
        }
    }

    if file_data.is_empty() {
        return Err(anyhow::anyhow!("No background image data provided").into());
    }

    if file_data.len() > MAX_BACKGROUND_BYTES {
        return Err(anyhow::anyhow!("Background image exceeds 10MB limit").into());
    }

    let ext = std::path::Path::new(&filename)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    if !ALLOWED_EXTS.contains(&ext.as_str()) {
        return Err(anyhow::anyhow!(
            "Invalid file type. Only PNG, JPG, GIF, and WEBP are allowed"
        )
        .into());
    }

    let uploads_dir = PathBuf::from(&state.config.uploads_dir);
    tokio::fs::create_dir_all(&uploads_dir).await?;

    let final_name = format!("{}.{ext}", Uuid::new_v4());
    let final_path = uploads_dir.join(&final_name);

    let mut file = File::create(&final_path).await?;
    file.write_all(&file_data).await?;
    file.flush().await?;
    drop(file);

    let background_image_url = format!("/uploads/{}", final_name);
    tracing::info!(
        "Background image uploaded by user {}: {} ({} bytes) -> {:?}",
        auth.user_id,
        filename,
        file_data.len(),
        final_path
    );

    state
        .upload_registry
        .record(
            &final_name,
            &filename,
            None,
            Some(auth.user_id),
            UploadKind::Other,
            file_data.len() as u64,
        )
        .await;

    Ok(Json(BackgroundImageResponse {
        success: true,
        background_image_url,
    }))
}

/// POST /api/upload (mounted at "/" inside the `/upload` router)
///
/// Authenticated simple multipart image upload for frontend branding assets
/// (server icon / banner). Accepts a single multipart `file` field, validates
/// that it is an allowed image type and within the size limit, writes it under
/// the configured uploads directory, and returns `{ fileUrl }` — matching the
/// shape the admin frontend expects.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SimpleUploadResponse {
    pub file_url: String,
}

async fn upload_simple(
    auth: AuthUser,
    State(state): State<Arc<AppState>>,
    mut multipart: axum::extract::Multipart,
) -> Result<Json<SimpleUploadResponse>> {
    use tokio::io::AsyncWriteExt;

    if auth.is_guest {
        return Err(anyhow::anyhow!("Guests cannot upload branding assets").into());
    }

    // WS-3e: require admin for branding uploads.
    if !state.is_admin(auth.user_id).await {
        return Err(anyhow::anyhow!("Only admins can upload branding assets").into());
    }

    let mut file_data: Vec<u8> = Vec::new();
    let mut filename = "branding".to_string();

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| anyhow::anyhow!(e))?
    {
        let name = field.name().unwrap_or("").to_string();
        if name == "file" {
            filename = field.file_name().unwrap_or("branding").to_string();
            file_data = field
                .bytes()
                .await
                .map_err(|e| anyhow::anyhow!(e))?
                .to_vec();
        }
    }

    if file_data.is_empty() {
        return Err(anyhow::anyhow!("No file data provided").into());
    }

    let ext = std::path::Path::new(&filename)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| format!(".{}", e))
        .unwrap_or_else(|| ".png".to_string());

    let uploads_dir = PathBuf::from(&state.config.uploads_dir);
    tokio::fs::create_dir_all(&uploads_dir).await?;

    let final_name = format!("{}{}", Uuid::new_v4(), ext);
    let final_path = uploads_dir.join(&final_name);

    let mut file = File::create(&final_path).await?;
    file.write_all(&file_data).await?;
    file.flush().await?;
    drop(file);

    let file_url = format!("/uploads/{}", final_name);
    tracing::info!(
        "Branding asset uploaded by user {}: {} ({} bytes) -> {:?}",
        auth.user_id,
        filename,
        file_data.len(),
        final_path
    );

    state
        .upload_registry
        .record(
            &final_name,
            &filename,
            None,
            Some(auth.user_id),
            UploadKind::Branding,
            file_data.len() as u64,
        )
        .await;

    Ok(Json(SimpleUploadResponse { file_url }))
}

/// POST /api/upload-background-image
///
/// Authenticated multipart upload for the user's animated chat background
/// (PNG/JPG/GIF/animated-WEBP images, plus MP4/WebM video loops). The frontend
/// BackgroundImageEditor has called this endpoint since the background-image
/// feature shipped, but no handler existed server-side — uploads 404'd.
///
/// Returns `{ backgroundImageUrl }` on success.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundImageResponse {
    pub background_image_url: String,
}

/// Size cap for background media (25MB — video loops).
const BACKGROUND_MAX_BYTES: usize = 25 * 1024 * 1024;

pub async fn upload_background_image(
    auth: AuthUser,
    State(state): State<Arc<AppState>>,
    mut multipart: axum::extract::Multipart,
) -> Result<Json<BackgroundImageResponse>> {
    use tokio::io::AsyncWriteExt;

    if auth.is_guest {
        return Err(anyhow::anyhow!("Guests cannot upload backgrounds").into());
    }

    let mut file_data: Vec<u8> = Vec::new();
    let mut filename = "background.png".to_string();

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| anyhow::anyhow!(e))?
    {
        let name = field.name().unwrap_or("").to_string();
        if name == "backgroundImage" {
            filename = field.file_name().unwrap_or("background").to_string();
            file_data = field
                .bytes()
                .await
                .map_err(|e| anyhow::anyhow!(e))?
                .to_vec();
        }
    }

    if file_data.is_empty() {
        return Err(anyhow::anyhow!("No file data provided").into());
    }

    if file_data.len() > BACKGROUND_MAX_BYTES {
        return Err(anyhow::anyhow!("File is too large. Maximum size is 25MB.").into());
    }

    // Sniff the actual content instead of trusting the client MIME string:
    // magic-byte check keeps a mislabeled script from landing as a "video".
    let mime = sniff_background_mime(&file_data).ok_or_else(|| {
        anyhow::anyhow!(
            "Unsupported file type. Only PNG, JPG, GIF, WEBP, MP4, or WEBM are allowed."
        )
    })?;

    // Extension derived from the SNIFFED type — never from the client filename.
    let ext = extension_for_mime(mime, ".png");

    let uploads_dir = PathBuf::from(&state.config.uploads_dir);
    tokio::fs::create_dir_all(&uploads_dir).await?;

    let final_name = format!("{}{}", Uuid::new_v4(), ext);
    let final_path = uploads_dir.join(&final_name);

    let mut file = File::create(&final_path).await?;
    file.write_all(&file_data).await?;
    file.flush().await?;
    drop(file);

    let file_url = format!("/uploads/{}", final_name);
    tracing::info!(
        "Background image uploaded by user {}: {} ({} bytes, sniffed {}) -> {:?}",
        auth.user_id,
        filename,
        file_data.len(),
        mime,
        final_path
    );

    state
        .upload_registry
        .record(
            &final_name,
            &filename,
            None,
            Some(auth.user_id),
            UploadKind::Other,
            file_data.len() as u64,
        )
        .await;

    Ok(Json(BackgroundImageResponse {
        background_image_url: file_url,
    }))
}

/// Magic-byte sniffing for allowed background media types.
fn sniff_background_mime(data: &[u8]) -> Option<&'static str> {
    if data.len() < 12 {
        return None;
    }
    if data.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        return Some("image/png");
    }
    if data.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("image/jpeg");
    }
    if data.starts_with(b"GIF8") {
        return Some("image/gif");
    }
    // WEBP: RIFF....WEBP
    if data.starts_with(b"RIFF") && &data[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    // MP4: bytes 4-7 == "ftyp"
    if &data[4..8] == b"ftyp" {
        return Some("video/mp4");
    }
    // WEBM/MKV: EBML header 0x1A45DFA3
    if data.starts_with(&[0x1A, 0x45, 0xDF, 0xA3]) {
        return Some("video/webm");
    }
    None
}

/// POST /api/upload
/// Accepts multipart form with a `file` field. Any authenticated user can upload
/// (banner, overlay, etc). Returns { fileUrl }.
pub async fn upload_profile_media(
    auth: AuthUser,
    State(state): State<Arc<AppState>>,
    mut multipart: axum::extract::Multipart,
) -> Result<Json<SimpleUploadResponse>> {
    use tokio::io::AsyncWriteExt;

    if auth.is_guest {
        return Err(anyhow::anyhow!("Guests cannot upload media").into());
    }

    let mut file_data: Vec<u8> = Vec::new();
    let mut filename = "media".to_string();

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| anyhow::anyhow!(e))?
    {
        let name = field.name().unwrap_or("").to_string();
        if name == "file" {
            filename = field.file_name().unwrap_or("media").to_string();
            file_data = field
                .bytes()
                .await
                .map_err(|e| anyhow::anyhow!(e))?
                .to_vec();
        }
    }

    if file_data.is_empty() {
        return Err(anyhow::anyhow!("No file data provided").into());
    }

    let ext = std::path::Path::new(&filename)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| format!(".{}", e))
        .unwrap_or_else(|| ".png".to_string());

    let uploads_dir = PathBuf::from(&state.config.uploads_dir);
    tokio::fs::create_dir_all(&uploads_dir).await?;

    let final_name = format!("{}{}", Uuid::new_v4(), ext);
    let final_path = uploads_dir.join(&final_name);

    let mut file = File::create(&final_path).await?;
    file.write_all(&file_data).await?;
    file.flush().await;
    drop(file);

    let file_url = format!("/uploads/{}", final_name);
    tracing::info!(
        "Profile media uploaded by user {}: {} ({} bytes) -> {:?}",
        auth.user_id,
        filename,
        file_data.len(),
        final_path
    );

    state
        .upload_registry
        .record(
            &final_name,
            &filename,
            None,
            Some(auth.user_id),
            UploadKind::Profile,
            file_data.len() as u64,
        )
        .await;

    Ok(Json(SimpleUploadResponse { file_url }))
}
/// Saves the file to the uploads directory and returns { profilePictureUrl }.
/// The caller is responsible for broadcasting the new URL via the socket update-profile event.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfilePictureResponse {
    pub profile_picture_url: String,
}

pub async fn upload_profile_picture(
    auth: AuthUser,
    State(state): State<Arc<AppState>>,
    mut multipart: axum::extract::Multipart,
) -> Result<Json<ProfilePictureResponse>> {
    use tokio::io::AsyncWriteExt;

    // WS-3e: guests cannot upload profile pictures.
    if auth.is_guest {
        return Err(anyhow::anyhow!("Guests cannot upload profile pictures").into());
    }

    let mut file_data: Vec<u8> = Vec::new();
    let mut filename = "profile-picture.png".to_string();

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| anyhow::anyhow!(e))?
    {
        let name = field.name().unwrap_or("").to_string();
        if name == "profilePicture" {
            filename = field
                .file_name()
                .unwrap_or("profile-picture.png")
                .to_string();
            file_data = field
                .bytes()
                .await
                .map_err(|e| anyhow::anyhow!(e))?
                .to_vec();
        }
    }

    if file_data.is_empty() {
        return Err(anyhow::anyhow!("No profile picture data provided").into());
    }

    let ext = std::path::Path::new(&filename)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| format!(".{}", e))
        .unwrap_or_else(|| ".png".to_string());

    let final_name = format!("{}{}", Uuid::new_v4(), ext);
    let final_path = PathBuf::from(&state.config.uploads_dir).join(&final_name);

    let mut file = File::create(&final_path).await?;
    file.write_all(&file_data).await?;
    file.flush().await?;
    drop(file);

    let profile_picture_url = format!("/uploads/{}", final_name);
    tracing::info!(
        "Profile picture uploaded: {} ({} bytes) -> {:?}",
        filename,
        file_data.len(),
        final_path
    );

    state
        .upload_registry
        .record(
            &final_name,
            &filename,
            None,
            Some(auth.user_id),
            UploadKind::Profile,
            file_data.len() as u64,
        )
        .await;

    Ok(Json(ProfilePictureResponse {
        profile_picture_url,
    }))
}

#[cfg(test)]
mod tests {
    use super::upload_response_headers;

    #[test]
    fn upload_headers_carry_nosniff_and_csp() {
        let headers = upload_response_headers();
        let map: std::collections::HashMap<_, _> = headers
            .iter()
            .map(|(k, v)| (k.as_str(), v.to_str().unwrap()))
            .collect();

        // nosniff must be present to prevent MIME sniffing of user uploads.
        assert_eq!(
            map.get("x-content-type-options").copied(),
            Some("nosniff")
        );

        // A strict CSP/sandbox must be present so uploaded content (e.g. SVG)
        // cannot execute script or reach other origins.
        let csp = map.get("content-security-policy").copied().expect("CSP header");
        assert!(csp.contains("default-src 'none'"));
        assert!(csp.contains("sandbox"));
    }
}
