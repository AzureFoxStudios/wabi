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
use tokio::sync::{Mutex, RwLock};
use tower_http::limit::RequestBodyLimitLayer;
use uuid::Uuid;

use crate::auth_extractor::AuthUser;
use crate::error::Result;
use crate::state::AppState;
use crate::upload_registry::UploadKind;

const MAX_RESUMABLE_CHUNK_BYTES: usize = 8 * 1024 * 1024;

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
    /// Serialize chunks and completion for this upload without blocking others.
    pub write_gate: Arc<Mutex<()>>,
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
        .route(
            "/resumable/chunk",
            put(upload_chunk).layer(RequestBodyLimitLayer::new(MAX_RESUMABLE_CHUNK_BYTES)),
        )
        .route("/resumable/complete", post(complete_upload))
        .route("/group-avatar", post(upload_group_avatar))
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

/// The refusal for an HLS playlist upload.
pub const HLS_PLAYLIST_REFUSED: &str = "HLS playlists (#EXTM3U) cannot be uploaded: a browser playing one fetches media from whatever hosts the playlist names, whatever type the file is served as.";

/// Streaming check for an HLS playlist: after an optional UTF-8 byte-order
/// mark and any amount of ASCII whitespace (no length cap, so padding does
/// not get past it), the bytes start with the tag `#EXTM3U` (any case, which
/// only refuses more) as a whole token: followed by whitespace or the end of
/// the data, so `#EXTM3U8 notes` is not one. Browsers that play HLS natively
/// follow a playlist to segments on other hosts even when it is served as
/// `video/mp4` with `nosniff`. UTF-16 text, a comment line before the tag,
/// the tag after an `ftyp` box or inside gzip are not valid playlists
/// (RFC 8216) and are not refused; that is not verified against a native player.
#[derive(Default)]
pub struct PlaylistSniffer {
    bom: Vec<u8>,
    past_bom: bool,
    head: Vec<u8>,
    decided: Option<bool>,
}

const HLS_TAG: &[u8] = b"#EXTM3U";
const UTF8_BOM: &[u8] = b"\xEF\xBB\xBF";

impl PlaylistSniffer {
    /// Feed the next bytes; returns the answer once it is known.
    pub fn feed(&mut self, bytes: &[u8]) -> Option<bool> {
        for &byte in bytes {
            if self.decided.is_some() {
                break;
            }
            self.step(byte);
        }
        self.decided
    }

    fn step(&mut self, byte: u8) {
        if !self.past_bom {
            self.bom.push(byte);
            if UTF8_BOM.starts_with(&self.bom) {
                if self.bom.len() == UTF8_BOM.len() {
                    self.past_bom = true;
                }
                return;
            }
            // Not a BOM after all: the bytes held back are ordinary content.
            self.past_bom = true;
            for held in std::mem::take(&mut self.bom) {
                self.step(held);
                if self.decided.is_some() {
                    return;
                }
            }
            return;
        }
        if self.head.is_empty() && byte.is_ascii_whitespace() {
            return;
        }
        if self.head.len() == HLS_TAG.len() {
            self.decided = Some(byte.is_ascii_whitespace());
            return;
        }
        self.head.push(byte);
        if !HLS_TAG[..self.head.len()].eq_ignore_ascii_case(&self.head) {
            self.decided = Some(false);
        }
    }

    /// The answer at the end of the data.
    pub fn finish(mut self) -> bool {
        if let Some(decided) = self.decided {
            return decided;
        }
        if !self.past_bom {
            // Fewer bytes than a BOM, all of them a BOM prefix: not a tag.
            let held = std::mem::take(&mut self.bom);
            self.past_bom = true;
            if self.feed(&held).is_some() {
                return self.decided == Some(true);
            }
        }
        self.head.len() == HLS_TAG.len()
    }
}

/// True when `bytes` (a whole upload) is an HLS playlist; see [`PlaylistSniffer`].
pub fn is_hls_playlist(bytes: &[u8]) -> bool {
    let mut sniffer = PlaylistSniffer::default();
    sniffer.feed(bytes);
    sniffer.finish()
}

/// Refuse an upload whose bytes are an HLS playlist, with a 400.
pub fn refuse_hls_playlist(bytes: &[u8]) -> Result<()> {
    if is_hls_playlist(bytes) {
        return Err(crate::error::AppError::BadRequest(HLS_PLAYLIST_REFUSED.into()));
    }
    Ok(())
}

/// Refuse a staged upload file that is an HLS playlist, reading only as far
/// as the answer needs (all of a file that is nothing but whitespace).
pub async fn refuse_hls_playlist_file(path: &std::path::Path) -> Result<()> {
    let mut file = tokio::fs::File::open(path).await?;
    let mut sniffer = PlaylistSniffer::default();
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        let read = tokio::io::AsyncReadExt::read(&mut file, &mut buffer).await?;
        if read == 0 || sniffer.feed(&buffer[..read]).is_some() {
            break;
        }
    }
    if sniffer.finish() {
        return Err(crate::error::AppError::BadRequest(HLS_PLAYLIST_REFUSED.into()));
    }
    Ok(())
}

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
    if !req.channel_id.is_empty() {
        let channel = crate::channel_access::require_participation(&state, auth.user_id, &req.channel_id).await?;
        // Before any session, temp file or log line exists: a conversation that
        // is encrypted or pending accepts only client-encrypted opaque files.
        drop(crate::api::e2ee::admit_channel_upload(&state, &channel, auth.user_id, &req.file_name, &req.mime_type).await?);
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
        write_gate: Arc::new(Mutex::new(())),
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

fn validated_chunk_end(
    uploaded_so_far: u64,
    declared_size: u64,
    offset: u64,
    chunk_len: usize,
) -> std::result::Result<u64, &'static str> {
    let end = offset
        .checked_add(chunk_len as u64)
        .ok_or("Upload chunk exceeds declared file size")?;
    if chunk_len > MAX_RESUMABLE_CHUNK_BYTES || offset != uploaded_so_far || end > declared_size {
        return Err("Upload chunk offset or size is invalid");
    }
    Ok(end)
}

fn complete_size_matches(uploaded_bytes: u64, declared_size: u64, actual_size: u64) -> bool {
    uploaded_bytes == declared_size && actual_size == declared_size
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

    let _gate = session.write_gate.lock().await;
    let uploaded_so_far = state
        .upload_state
        .sessions
        .read()
        .await
        .get(&query.upload_id)
        .map(|current| current.uploaded_bytes)
        .ok_or_else(|| anyhow::anyhow!("Upload session not found"))?;
    let end = validated_chunk_end(uploaded_so_far, session.file_size, query.offset, body.len())
        .map_err(anyhow::Error::msg)?;

    let mut file = OpenOptions::new()
        .write(true)
        .open(&session.temp_path)
        .await?;
    if file.metadata().await?.len() != uploaded_so_far {
        return Err(anyhow::anyhow!("Upload staging bytes do not match session position").into());
    }
    file.seek(tokio::io::SeekFrom::Start(query.offset)).await?;
    file.write_all(&body).await?;
    file.flush().await?;
    drop(file);

    let uploaded_bytes = end;
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
/// A completion the room's encryption policy refused will never succeed:
/// remove its staged plaintext and its session, so the bytes do not stay on
/// disk and a retry does not repeat the sniff, fsync and hash. Unreadable
/// encryption state keeps both (completion can be retried after a restore).
async fn discard_refused_upload(state: &AppState, upload_id: &str, session: &UploadSession, error: &crate::error::AppError) {
    if !crate::api::e2ee::upload_refusal_is_final(error) {
        return;
    }
    state.upload_state.sessions.write().await.remove(upload_id);
    match tokio::fs::remove_file(&session.temp_path).await {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => tracing::warn!("[upload] could not remove a refused staged upload: {e}"),
    }
}

async fn complete_upload(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Json(req): Json<CompleteUploadRequest>,
) -> Result<Json<CompleteUploadResponse>> {
    // Verify the token before touching the file or session state.
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
    let _gate = session.write_gate.lock().await;
    let session = {
        let sessions = state.upload_state.sessions.read().await;
        sessions
            .get(&req.upload_id)
            .filter(|current| {
                current.upload_token == req.upload_token
                    && current.uploader_id == Some(auth.user_id)
            })
            .ok_or_else(|| anyhow::anyhow!("Upload session not found"))?
            .clone()
    };
    if session.uploaded_bytes != session.file_size {
        return Err(anyhow::anyhow!("Upload is incomplete").into());
    }
    let room_owner_precondition = if session.channel_id.is_empty() {
        None
    } else {
        Some(
            state
                .wdb
                .room_owner_precondition(&session.channel_id, "complete_upload")?,
        )
    };

    // Final filename: UUID with original extension
    let final_name = format!("{}{}", session.upload_id, session.extension);
    let final_path = PathBuf::from(&state.config.uploads_dir).join(&final_name);

    // A cheap admission check before the expensive work: a room that is
    // already encrypted or pending refuses at once. The decision that counts
    // is the locked re-check below.
    if !session.channel_id.is_empty() {
        let channel = crate::channel_access::require_participation(&state, auth.user_id, &session.channel_id)
            .await?;
        if let Err(error) = crate::api::e2ee::admit_channel_upload(&state, &channel, auth.user_id, &session.file_name, &session.mime_type).await {
            discard_refused_upload(&state, &req.upload_id, &session, &error).await;
            return Err(error);
        }
    }

    // The slow part first, without the encryption-policy lock (it is global:
    // holding it while hashing a large file would stall every conversation
    // send). The session's write gate keeps the staged bytes unchanged.
    let staged = tokio::fs::try_exists(&session.temp_path).await?;
    let sha256 = if staged {
        refuse_hls_playlist_file(&session.temp_path).await?;
        let file = OpenOptions::new()
            .write(true)
            .open(&session.temp_path)
            .await?;
        if !complete_size_matches(
            session.uploaded_bytes,
            session.file_size,
            file.metadata().await?.len(),
        ) {
            return Err(anyhow::anyhow!("Upload bytes do not match declared size").into());
        }
        file.sync_all().await?;
        drop(file);
        crate::upload_registry::sync_upload_directory(
            session
                .temp_path
                .parent()
                .ok_or_else(|| anyhow::anyhow!("Upload staging path has no parent"))?,
        )
        .await?;
        crate::upload_registry::sha256_file(&session.temp_path).await?
    } else {
        // A previous completion may have renamed the file but failed its
        // directory sync. Keep the session so a retry can finish publication.
        let meta = state.upload_registry.get(&final_name).await;
        if !meta.is_some_and(|meta| meta.size == session.file_size) {
            return Err(anyhow::anyhow!("Upload staging file is missing").into());
        }
        if tokio::fs::metadata(&final_path).await?.len() != session.file_size {
            return Err(anyhow::anyhow!("Published upload size changed").into());
        }
        crate::upload_registry::sha256_file(&final_path).await?
    };

    // The room may have become encrypted or pending since init. Admission is
    // decided under the encryption-policy lock, and that lock is held until
    // the name is recorded, the publication committed and the bytes renamed,
    // so the room cannot change state between the decision and publication.
    let _encryption_policy = if session.channel_id.is_empty() {
        None
    } else {
        let channel = crate::channel_access::require_participation(&state, auth.user_id, &session.channel_id)
            .await?;
        match crate::api::e2ee::admit_channel_upload(&state, &channel, auth.user_id, &session.file_name, &session.mime_type).await {
            Ok(guard) => guard,
            Err(error) => {
                discard_refused_upload(&state, &req.upload_id, &session, &error).await;
                return Err(error);
            }
        }
    };
    if staged {
        // Persist ownership while the bytes remain in the private staging path.
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
                session.file_size,
            )
            .await?;
        state
            .upload_registry
            .prepare_published(
                &final_name,
                &sha256,
                state.wdb.engine(),
                room_owner_precondition.clone(),
            )
            .await?;
        tokio::fs::rename(&session.temp_path, &final_path).await?;
    } else {
        state
            .upload_registry
            .prepare_published(
                &final_name,
                &sha256,
                state.wdb.engine(),
                room_owner_precondition,
            )
            .await?;
    }
    drop(_encryption_policy);
    crate::upload_registry::sync_upload_directory(&PathBuf::from(&state.config.uploads_dir))
        .await?;
    state
        .upload_state
        .sessions
        .write()
        .await
        .remove(&req.upload_id);
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
/// Group avatars have no durable model yet. Never rewrite a group's owner,
/// kind or name via the former compatibility upsert, or create an orphan upload.
async fn upload_group_avatar(_auth: AuthUser) -> (axum::http::StatusCode, Json<serde_json::Value>) {
    (
        axum::http::StatusCode::NOT_IMPLEMENTED,
        Json(serde_json::json!({
            "error": "Group avatars are not yet supported; nothing was changed",
            "code": "NOT_IMPLEMENTED"
        })),
    )
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
    refuse_hls_playlist(&file_data)?;
    let final_path = uploads_dir.join(&final_name);

    state
        .upload_registry
        .publish_bytes(
            &uploads_dir,
            state.wdb.engine(),
            &final_name,
            &filename,
            None,
            None,
            Some(auth.user_id),
            UploadKind::Branding,
            &file_data,
        )
        .await?;

    let file_url = format!("/uploads/{}", final_name);
    tracing::info!(
        "Branding asset uploaded by user {}: {} ({} bytes) -> {:?}",
        auth.user_id,
        filename,
        file_data.len(),
        final_path
    );

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
    refuse_hls_playlist(&file_data)?;
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
    refuse_hls_playlist(&file_data)?;
    let final_path = uploads_dir.join(&final_name);

    state
        .upload_registry
        .publish_bytes(
            &uploads_dir,
            state.wdb.engine(),
            &final_name,
            &filename,
            None,
            None,
            Some(auth.user_id),
            UploadKind::Other,
            &file_data,
        )
        .await?;

    let file_url = format!("/uploads/{}", final_name);
    tracing::info!(
        "Background image uploaded by user {}: {} ({} bytes, sniffed {}) -> {:?}",
        auth.user_id,
        filename,
        file_data.len(),
        mime,
        final_path
    );

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

const PROFILE_MEDIA_MAX_BYTES: usize = 10 * 1024 * 1024;

fn profile_media_extension(data: &[u8]) -> std::result::Result<String, String> {
    if data.len() > PROFILE_MEDIA_MAX_BYTES {
        return Err("Profile image is too large. Maximum size is 10 MiB.".into());
    }
    let mime = sniff_background_mime(data)
        .filter(|mime| mime.starts_with("image/"))
        .ok_or_else(|| "Profile images must be PNG, JPEG, GIF, or WebP.".to_owned())?;
    Ok(extension_for_mime(mime, ".png"))
}

/// POST /api/upload
/// Accepts multipart form with a `file` field. Any authenticated user can upload
/// PNG/JPEG/GIF/WebP profile images up to 10 MiB, preserving animation bytes.
/// Returns { fileUrl }; dimensions are recommendations, not a file constraint.
pub async fn upload_profile_media(
    auth: AuthUser,
    State(state): State<Arc<AppState>>,
    mut multipart: axum::extract::Multipart,
) -> Result<Json<SimpleUploadResponse>> {
    if auth.is_guest {
        return Err(anyhow::anyhow!("Guests cannot upload media").into());
    }

    let mut file_data: Vec<u8> = Vec::new();
    let mut filename = "media".to_string();

    while let Some(mut field) = multipart
        .next_field()
        .await
        .map_err(|e| anyhow::anyhow!(e))?
    {
        let name = field.name().unwrap_or("").to_string();
        if name == "file" {
            filename = field.file_name().unwrap_or("media").to_string();
            file_data.clear();
            while let Some(chunk) = field
                .chunk()
                .await
                .map_err(|error| anyhow::anyhow!(error))?
            {
                if file_data.len().saturating_add(chunk.len()) > PROFILE_MEDIA_MAX_BYTES {
                    return Err(crate::error::AppError::BadRequest(
                        "Profile image is too large. Maximum size is 10 MiB.".into(),
                    ));
                }
                file_data.extend_from_slice(&chunk);
            }
        }
    }

    if file_data.is_empty() {
        return Err(anyhow::anyhow!("No file data provided").into());
    }

    refuse_hls_playlist(&file_data)?;
    let ext = profile_media_extension(&file_data).map_err(crate::error::AppError::BadRequest)?;

    let uploads_dir = PathBuf::from(&state.config.uploads_dir);
    tokio::fs::create_dir_all(&uploads_dir).await?;

    let final_name = format!("{}{}", Uuid::new_v4(), ext);
    refuse_hls_playlist(&file_data)?;
    let final_path = uploads_dir.join(&final_name);

    state
        .upload_registry
        .publish_bytes(
            &uploads_dir,
            state.wdb.engine(),
            &final_name,
            &filename,
            None,
            None,
            Some(auth.user_id),
            UploadKind::Profile,
            &file_data,
        )
        .await?;

    let file_url = format!("/uploads/{}", final_name);
    tracing::info!(
        "Profile media uploaded by user {}: {} ({} bytes) -> {:?}",
        auth.user_id,
        filename,
        file_data.len(),
        final_path
    );

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

    let uploads_dir = PathBuf::from(&state.config.uploads_dir);
    let final_name = format!("{}{}", Uuid::new_v4(), ext);
    refuse_hls_playlist(&file_data)?;
    let final_path = uploads_dir.join(&final_name);

    state
        .upload_registry
        .publish_bytes(
            &uploads_dir,
            state.wdb.engine(),
            &final_name,
            &filename,
            None,
            None,
            Some(auth.user_id),
            UploadKind::Profile,
            &file_data,
        )
        .await?;

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

#[cfg(test)]
mod tests {
    use super::{complete_size_matches, upload_response_headers, validated_chunk_end};

    #[test]
    fn profile_media_uses_bounded_image_signatures_and_canonical_extensions() {
        use super::{profile_media_extension, PROFILE_MEDIA_MAX_BYTES};
        for (bytes, extension) in [
            (&b"\x89PNG\r\n\x1a\n1234"[..], ".png"),
            (&b"\xff\xd8\xff123456789"[..], ".jpg"),
            (&b"GIF89a1234567"[..], ".gif"),
            (&b"RIFF1234WEBP"[..], ".webp"),
        ] {
            assert_eq!(profile_media_extension(bytes).unwrap(), extension);
        }
        for bytes in [
            &b"RIFFWEBP1234"[..],
            &b"GIF89a"[..],
            &b"<svg>bad</svg>"[..],
            &b"1234ftyp1234"[..],
        ] {
            assert!(profile_media_extension(bytes).is_err());
        }
        let mut oversized = vec![0; PROFILE_MEDIA_MAX_BYTES + 1];
        oversized[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
        assert!(profile_media_extension(&oversized)
            .unwrap_err()
            .contains("10 MiB"));
        oversized.pop();
        assert_eq!(profile_media_extension(&oversized).unwrap(), ".png");
    }

    #[test]
    fn resumable_chunks_must_append_within_the_declared_size() {
        assert_eq!(validated_chunk_end(4, 10, 4, 6), Ok(10));
        assert!(validated_chunk_end(4, 10, 3, 1).is_err());
        assert!(validated_chunk_end(4, 10, 4, 7).is_err());
        assert!(validated_chunk_end(4, u64::MAX, u64::MAX, 1).is_err());
        assert!(validated_chunk_end(0, u64::MAX, 0, 8 * 1024 * 1024 + 1).is_err());
    }

    #[test]
    fn completion_requires_all_declared_bytes_on_disk() {
        assert!(complete_size_matches(10, 10, 10));
        assert!(!complete_size_matches(9, 10, 10));
        assert!(!complete_size_matches(10, 10, 9));
    }

    #[test]
    fn hls_playlist_detection_skips_bom_and_whitespace_only() {
        let padded = |n: usize, pad: u8| { let mut v = vec![pad; n]; v.extend_from_slice(b"#EXTM3U\nx.ts"); v };
        let mut yes: Vec<Vec<u8>> = [&b"#EXTM3U"[..], b"#EXTM3U\n#EXTINF:1,\nx.ts", b"#EXTM3U\r\n", b"#EXTM3U x", b"\xEF\xBB\xBF#EXTM3U", b" \r\n\t#EXTM3U", b"#extm3u\n"]
            .iter().map(|b| b.to_vec()).collect();
        yes.extend([padded(4089, b' '), padded(4093, b' '), padded(5000, b'\n'), padded(3 * 1024 * 1024, b'\t')]);
        for bytes in &yes {
            assert!(super::is_hls_playlist(bytes), "{:?}", &bytes[..bytes.len().min(16)]);
            // Fed in small pieces, the streaming check agrees.
            let mut sniffer = super::PlaylistSniffer::default();
            for piece in bytes.chunks(3) { sniffer.feed(piece); }
            assert!(sniffer.finish());
        }
        for no in [&b""[..], b"\xEF", b"\xEF\xBB\xBF", b"   ", b"#EXTM3", b"x#EXTM3U", b"\xEF\xBB#EXTM3U", b"\x00\x00\x00\x18ftypmp42", b"# EXTM3U", b"#EXTM3U8 notes", b"#EXTM3Ux"] {
            assert!(!super::is_hls_playlist(no), "{no:?}");
        }
        assert!(super::refuse_hls_playlist(b"#EXTM3U").is_err());
        assert!(super::refuse_hls_playlist(b"plain text").is_ok());
    }

    #[test]
    fn upload_headers_carry_nosniff_and_csp() {
        let headers = upload_response_headers();
        let map: std::collections::HashMap<_, _> = headers
            .iter()
            .map(|(k, v)| (k.as_str(), v.to_str().unwrap()))
            .collect();

        // nosniff must be present to prevent MIME sniffing of user uploads.
        assert_eq!(map.get("x-content-type-options").copied(), Some("nosniff"));

        // A strict CSP/sandbox must be present so uploaded content (e.g. SVG)
        // cannot execute script or reach other origins.
        let csp = map
            .get("content-security-policy")
            .copied()
            .expect("CSP header");
        assert!(csp.contains("default-src 'none'"));
        assert!(csp.contains("sandbox"));
    }
}
