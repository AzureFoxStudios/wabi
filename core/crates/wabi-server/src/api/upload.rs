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

use crate::error::Result;
use crate::state::AppState;

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
    State(state): State<Arc<AppState>>,
    Json(req): Json<InitUploadRequest>,
) -> Result<Json<InitUploadResponse>> {
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
    upload_token: String,
}

/// Upload a chunk
async fn upload_chunk(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ChunkQuery>,
    body: axum::body::Bytes,
) -> Result<Json<InitUploadResponse>> {
    // Look up session (clone to release the read lock before the async file ops)
    let session = state
        .upload_state
        .sessions
        .read()
        .await
        .get(&query.upload_id)
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("Upload session not found"))?;

    if session.upload_token != query.upload_token {
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
        upload_token: query.upload_token,
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
    Json(req): Json<CompleteUploadRequest>,
) -> Result<Json<CompleteUploadResponse>> {
    let session = state
        .upload_state
        .sessions
        .write()
        .await
        .remove(&req.upload_id)
        .ok_or_else(|| anyhow::anyhow!("Upload session not found"))?;

    // Verify token
    if session.upload_token != req.upload_token {
        return Err(anyhow::anyhow!("Invalid upload token").into());
    }

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
/// Saves the file, persists the avatar URL to STDB, then broadcasts
/// `group-avatar-updated` to all connected clients.
async fn upload_group_avatar(
    State(state): State<Arc<AppState>>,
    mut multipart: axum::extract::Multipart,
) -> Result<Json<GroupAvatarResponse>> {
    use tokio::io::AsyncWriteExt;

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

    // Persist avatar URL to STDB
    if let Err(e) = state
        .stdb
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
    let mut rx = state.sio_broadcast_tx.subscribe();
    if let Ok(io) = rx.recv().await {
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

/// POST /api/upload-profile-picture
/// Accepts multipart form with a `profilePicture` field.
/// Saves the file to the uploads directory and returns { profilePictureUrl }.
/// The caller is responsible for broadcasting the new URL via the socket update-profile event.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfilePictureResponse {
    pub profile_picture_url: String,
}

pub async fn upload_profile_picture(
    State(state): State<Arc<AppState>>,
    mut multipart: axum::extract::Multipart,
) -> Result<Json<ProfilePictureResponse>> {
    use tokio::io::AsyncWriteExt;

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

    Ok(Json(ProfilePictureResponse {
        profile_picture_url,
    }))
}
