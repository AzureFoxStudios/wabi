//! Whiteboard API routes — image upload & file serving
//!
//! Implements:
//! - POST /api/whiteboard/boards/:boardId/images — upload a whiteboard image
//! - GET  /api/whiteboard/boards/:boardId/files/:fileId — serve a whiteboard file
//! - GET  /api/whiteboard/boards/:boardId/document — fetch a board document
//! - PUT  /api/whiteboard/boards/:boardId/document — persist a board document
//!
//! Socket.IO events (whiteboard:join, whiteboard:leave, whiteboard:snapshot)
//! are handled in socketio.rs.

use axum::{
    body::Body,
    extract::{Path, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::fs;
use tokio::io::AsyncWriteExt;

use crate::auth_extractor::AuthUser;
use crate::error::Result;
use crate::socketio::whiteboard_versions;
use crate::state::AppState;
use crate::upload_registry::UploadKind;
use wabidb::engine::wabi_store::WabiStore;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Max whiteboard document size (2 MB) — enforced on snapshot save via Socket.IO.
#[allow(dead_code)]
pub const WHITEBOARD_MAX_DOCUMENT_BYTES: usize = 2 * 1024 * 1024;

/// Max whiteboard live-collab payload (128 KB).
#[allow(dead_code)]
pub const WHITEBOARD_MAX_LIVE_PAYLOAD_BYTES: usize = 128 * 1024;

/// Default max upload size for whiteboard images (10 MB).
const MAX_IMAGE_UPLOAD_BYTES: usize = 10 * 1024 * 1024;

/// Max whiteboard font upload size (10 MB).
const MAX_FONT_UPLOAD_BYTES: usize = 10 * 1024 * 1024;

/// Prefix for whiteboard-scoped upload file IDs.
const WHITEBOARD_UPLOAD_PREFIX: &str = "wbi-";

/// Prefix for whiteboard-scoped font upload file IDs.
const WHITEBOARD_FONT_UPLOAD_PREFIX: &str = "wbf-";

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/// Create the whiteboard API router.
pub fn routes(state: Arc<AppState>) -> Router<Arc<AppState>> {
    Router::new()
        .route("/boards/{board_id}/images", post(upload_whiteboard_image))
        .route(
            "/boards/{board_id}/fonts",
            get(list_whiteboard_fonts).post(upload_whiteboard_font),
        )
        .route(
            "/boards/{board_id}/files/{file_id}",
            get(serve_whiteboard_file),
        )
        .route(
            "/boards/{board_id}/document",
            get(get_board_document).put(put_board_document),
        )
        .with_state(state)
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/// Generate a scope tag from a board ID (SHA-256, first 16 hex chars).
fn whiteboard_scope_tag(board_id: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(board_id.as_bytes());
    hex::encode(hasher.finalize())[..16].to_string()
}

/// Create a unique file ID scoped to a board.
fn create_whiteboard_file_id(board_id: &str, file_name: &str) -> String {
    let tag = whiteboard_scope_tag(board_id);
    let nonce = format!("{:x}", rand::random::<u64>());
    let safe_name = sanitize_filename(file_name);
    format!(
        "{}{}-{}-{}-{}",
        WHITEBOARD_UPLOAD_PREFIX,
        tag,
        timestamp_millis(),
        nonce,
        safe_name
    )
}

/// Check that a file ID belongs to whiteboard uploads and is scoped to the given board.
fn is_whiteboard_file_id_for_board(board_id: &str, file_id: &str) -> bool {
    let prefix = format!(
        "{}{}-",
        WHITEBOARD_UPLOAD_PREFIX,
        whiteboard_scope_tag(board_id)
    );
    file_id.starts_with(&prefix)
}

/// Check that a file ID belongs to whiteboard font uploads and is scoped to the given board.
fn is_whiteboard_font_file_id_for_board(board_id: &str, file_id: &str) -> bool {
    let prefix = format!(
        "{}{}-",
        WHITEBOARD_FONT_UPLOAD_PREFIX,
        whiteboard_scope_tag(board_id)
    );
    file_id.starts_with(&prefix)
}

/// Check if an extension is an allowed font extension (case-insensitive).
fn is_allowed_font_extension(ext: &str) -> bool {
    matches!(
        ext.to_ascii_lowercase().as_str(),
        "woff2" | "woff" | "ttf" | "otf"
    )
}

/// Create a unique font file ID scoped to a board.
fn create_whiteboard_font_file_id(board_id: &str, file_name: &str) -> String {
    let tag = whiteboard_scope_tag(board_id);
    let nonce = format!("{:x}", rand::random::<u64>());
    let safe_name = sanitize_filename(file_name);
    format!(
        "{}{}-{}-{}-{}",
        WHITEBOARD_FONT_UPLOAD_PREFIX,
        tag,
        timestamp_millis(),
        nonce,
        safe_name
    )
}

/// Extract the sanitized file name tail from a font file ID.
///
/// The id format is `wbf-<tag>-<timestamp>-<nonce>-<sanitized-name>`.
/// We strip the `wbf-<tag>-` prefix, then skip exactly two `-`-separated
/// segments (timestamp and nonce), and return the remainder.
fn extract_font_filename(board_id: &str, file_id: &str) -> Option<String> {
    let tag = whiteboard_scope_tag(board_id);
    let prefix = format!("{}{}-", WHITEBOARD_FONT_UPLOAD_PREFIX, tag);
    if !file_id.starts_with(&prefix) {
        return None;
    }
    let tail = &file_id[prefix.len()..];
    // tail is "<timestamp>-<nonce>-<sanitized-name>"
    let first_dash = tail.find('-')?;
    let rest = &tail[first_dash + 1..];
    let second_dash = rest.find('-')?;
    let sanitized = &rest[second_dash + 1..];
    if sanitized.is_empty() {
        return None;
    }
    Some(sanitized.to_string())
}

/// Derive a font family name from a sanitized file name: file stem with whitespace collapsed.
fn font_family_from_filename(file_name: &str) -> String {
    let stem = std::path::Path::new(file_name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(file_name);
    // collapse whitespace: split on whitespace and re-join with single space
    stem.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Simple filename sanitizer — strips path separators and null bytes.
fn sanitize_filename(name: &str) -> String {
    name.chars()
        .filter(|c| *c != '/' && *c != '\\' && *c != '\0')
        .collect::<String>()
}

fn timestamp_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

/// Resolve the on-disk path for an upload file ID.
///
/// WABI_AUDIT_REPORT.md finding #10: now uses `safe_join` to reject
/// absolute paths, ".." components, null bytes, and any input that
/// would escape the uploads directory after canonicalization.
fn resolve_upload_path(uploads_dir: &str, file_id: &str) -> PathBuf {
    use super::path_util::safe_join;
    let base = std::path::Path::new(uploads_dir);
    safe_join(base, file_id).unwrap_or_else(|_| {
        // Fall back to a non-existent path inside the base. Callers that
        // open this path will get NotFound, which is the correct safe
        // behavior for invalid input.
        base.join("__invalid_path__")
    })
}

/// Check channel access for a user + optional guest session.
async fn can_access_channel(
    state: &AppState,
    user_id: Option<i64>,
    _guest_session_id: Option<&str>,
    channel_id: &str,
) -> bool {
    // Owner always has access
    if let Some(uid) = user_id {
        if *state.owner_user_id.read().await == Some(uid) {
            return true;
        }
        // Admin always has access
        if state.is_admin(uid).await {
            return true;
        }
    }

    // Check WDB for channel membership. Pass the user id so only channels the
    // user actually belongs to are returned — listing with None returns every
    // channel, which never tests membership.
    if let Some(uid) = user_id {
        if let Ok(channels) = state.wdb.list_channels(Some(uid as u64)).await {
            for ch in &channels {
                if ch.channel_id == channel_id {
                    return true;
                }
            }
        }
    }
    false
}

// ---------------------------------------------------------------------------
// Request / Response types
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WhiteboardImageUploadResponse {
    success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    board_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    file_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    file_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    file_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    file_size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    mime_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WhiteboardFontUploadResponse {
    success: bool,
    font_id: String,
    family: String,
    file_name: String,
    file_size: u64,
    mime_type: String,
    file_url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WhiteboardFontInfo {
    font_id: String,
    family: String,
    file_name: String,
    file_size: u64,
    mime_type: String,
    file_url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WhiteboardFontListResponse {
    success: bool,
    fonts: Vec<WhiteboardFontInfo>,
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/// POST /api/whiteboard/boards/:boardId/images
///
/// Upload an image file for a whiteboard board.
/// Accepts multipart/form-data with a `file` or `image` field.
async fn upload_whiteboard_image(
    State(state): State<Arc<AppState>>,
    Path(board_id): Path<String>,
    auth: AuthUser,
    mut multipart: axum::extract::Multipart,
) -> Result<impl IntoResponse> {
    // Auth check
    let user_id = auth.user_id;

    // Validate board ID
    let board_id = board_id.trim().to_string();
    if board_id.is_empty() {
        return Ok(json_error_response(
            StatusCode::BAD_REQUEST,
            "Invalid whiteboard id",
        ));
    }

    // Check channel access (board IDs are channel:xxx)
    let channel_id = if board_id.starts_with("channel:") {
        board_id
            .strip_prefix("channel:")
            .unwrap_or(&board_id)
            .to_string()
    } else {
        // For non-channel-scoped boards, look up the scope
        board_id.clone()
    };

    if !can_access_channel(&state, Some(user_id), None, &channel_id).await {
        return Ok(json_error_response(StatusCode::FORBIDDEN, "Access denied"));
    }

    // Extract file from multipart
    let mut file_data: Vec<u8> = Vec::new();
    let mut file_name = "whiteboard-image.bin".to_string();
    let mut mime_type = "application/octet-stream".to_string();

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| anyhow::anyhow!(e))?
    {
        let name = field.name().unwrap_or("").to_string();
        match name.as_str() {
            "file" | "image" => {
                file_name = field
                    .file_name()
                    .unwrap_or("whiteboard-image.bin")
                    .to_string();
                mime_type = field
                    .content_type()
                    .unwrap_or("application/octet-stream")
                    .to_string();
                file_data = field
                    .bytes()
                    .await
                    .map_err(|e| anyhow::anyhow!(e))?
                    .to_vec();
            }
            _ => {}
        }
    }

    if file_data.is_empty() {
        return Ok(json_error_response(
            StatusCode::BAD_REQUEST,
            "Image file is required (multipart/form-data)",
        ));
    }

    if file_data.len() > MAX_IMAGE_UPLOAD_BYTES {
        return Ok(json_error_response(
            StatusCode::PAYLOAD_TOO_LARGE,
            "Whiteboard image exceeds server request limit",
        ));
    }

    // Create uploads dir if needed
    let uploads_dir = &state.config.uploads_dir;
    if !std::path::Path::new(uploads_dir).exists() {
        tokio::fs::create_dir_all(uploads_dir).await?;
    }

    // Generate file ID and path
    let safe_file_name = sanitize_filename(&file_name);
    let file_id = create_whiteboard_file_id(&board_id, &safe_file_name);
    let file_path = resolve_upload_path(uploads_dir, &file_id);

    // Write file
    let mut file = fs::File::create(&file_path).await?;
    file.write_all(&file_data).await?;
    file.flush().await?;
    drop(file);

    let file_url = format!(
        "/api/whiteboard/boards/{}/files/{}",
        urlencoding::encode(&board_id),
        urlencoding::encode(&file_id),
    );

    tracing::info!(
        "[Whiteboard] Image uploaded: {} ({} bytes) for board {}",
        safe_file_name,
        file_data.len(),
        board_id,
    );

    // Record ownership (ops metadata, not authz). Whiteboard files land in the
    // generic `/uploads/` URL space, so they belong in the registry too.
    state
        .upload_registry
        .record(
            &file_id,
            &safe_file_name,
            Some(channel_id.clone()),
            Some(user_id),
            UploadKind::Whiteboard,
            file_data.len() as u64,
        )
        .await;

    let response = WhiteboardImageUploadResponse {
        success: true,
        board_id: Some(board_id),
        file_id: Some(file_id),
        file_url: Some(file_url),
        file_name: Some(safe_file_name),
        file_size: Some(file_data.len() as u64),
        mime_type: Some(mime_type),
        error: None,
    };

    Ok(Json(response).into_response())
}

/// POST /api/whiteboard/boards/:boardId/fonts
///
/// Upload a font file for a whiteboard board.
/// Accepts multipart/form-data with a `file` or `font` field.
async fn upload_whiteboard_font(
    State(state): State<Arc<AppState>>,
    Path(board_id): Path<String>,
    auth: AuthUser,
    mut multipart: axum::extract::Multipart,
) -> Result<impl IntoResponse> {
    let user_id = auth.user_id;

    let board_id = board_id.trim().to_string();
    if board_id.is_empty() {
        return Ok(json_error_response(
            StatusCode::BAD_REQUEST,
            "Invalid whiteboard id",
        ));
    }

    let channel_id = if board_id.starts_with("channel:") {
        board_id
            .strip_prefix("channel:")
            .unwrap_or(&board_id)
            .to_string()
    } else {
        board_id.clone()
    };

    if !can_access_channel(&state, Some(user_id), None, &channel_id).await {
        return Ok(json_error_response(StatusCode::FORBIDDEN, "Access denied"));
    }

    let mut file_data: Vec<u8> = Vec::new();
    let mut file_name = "whiteboard-font.bin".to_string();
    let mut _mime_type = "application/octet-stream".to_string();

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| anyhow::anyhow!(e))?
    {
        let name = field.name().unwrap_or("").to_string();
        match name.as_str() {
            "file" | "font" => {
                file_name = field
                    .file_name()
                    .unwrap_or("whiteboard-font.bin")
                    .to_string();
                _mime_type = field
                    .content_type()
                    .unwrap_or("application/octet-stream")
                    .to_string();
                file_data = field
                    .bytes()
                    .await
                    .map_err(|e| anyhow::anyhow!(e))?
                    .to_vec();
            }
            _ => {}
        }
    }

    if file_data.is_empty() {
        return Ok(json_error_response(
            StatusCode::BAD_REQUEST,
            "Font file is required (multipart/form-data)",
        ));
    }

    if file_data.len() > MAX_FONT_UPLOAD_BYTES {
        return Ok(json_error_response(
            StatusCode::PAYLOAD_TOO_LARGE,
            "Font exceeds server request limit",
        ));
    }

    let safe_file_name = sanitize_filename(&file_name);
    // Validate extension case-insensitive
    let ext = std::path::Path::new(&safe_file_name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");
    if !is_allowed_font_extension(ext) {
        return Ok(json_error_response(
            StatusCode::BAD_REQUEST,
            "Font file must be .woff2, .woff, .ttf or .otf",
        ));
    }

    let uploads_dir = &state.config.uploads_dir;
    if !std::path::Path::new(uploads_dir).exists() {
        tokio::fs::create_dir_all(uploads_dir).await?;
    }

    let file_id = create_whiteboard_font_file_id(&board_id, &safe_file_name);
    let file_path = resolve_upload_path(uploads_dir, &file_id);

    let mut file = fs::File::create(&file_path).await?;
    file.write_all(&file_data).await?;
    file.flush().await?;
    drop(file);

    let mime_type = std::path::Path::new(&safe_file_name)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| mime_guess::from_ext(e).first_or_octet_stream().to_string())
        .unwrap_or_else(|| "application/octet-stream".to_string());

    let family = font_family_from_filename(&safe_file_name);

    let file_url = format!(
        "/api/whiteboard/boards/{}/files/{}",
        urlencoding::encode(&board_id),
        urlencoding::encode(&file_id),
    );

    tracing::info!(
        "[Whiteboard] Font uploaded: {} ({} bytes) for board {}",
        safe_file_name,
        file_data.len(),
        board_id,
    );

    state
        .upload_registry
        .record(
            &file_id,
            &safe_file_name,
            Some(channel_id.clone()),
            Some(user_id),
            UploadKind::Whiteboard,
            file_data.len() as u64,
        )
        .await;

    let response = WhiteboardFontUploadResponse {
        success: true,
        font_id: file_id,
        family,
        file_name: safe_file_name,
        file_size: file_data.len() as u64,
        mime_type,
        file_url,
    };

    Ok(Json(response).into_response())
}

/// GET /api/whiteboard/boards/:boardId/fonts
///
/// List fonts for a whiteboard board by scanning the uploads directory.
async fn list_whiteboard_fonts(
    State(state): State<Arc<AppState>>,
    Path(board_id): Path<String>,
    auth: AuthUser,
) -> Result<impl IntoResponse> {
    let user_id = auth.user_id;

    let board_id = board_id.trim().to_string();
    if board_id.is_empty() {
        return Ok(json_error_response(
            StatusCode::BAD_REQUEST,
            "Invalid whiteboard id",
        ));
    }

    let channel_id = if board_id.starts_with("channel:") {
        board_id
            .strip_prefix("channel:")
            .unwrap_or(&board_id)
            .to_string()
    } else {
        board_id.clone()
    };

    if !can_access_channel(&state, Some(user_id), None, &channel_id).await {
        return Ok(json_error_response(StatusCode::FORBIDDEN, "Access denied"));
    }

    let uploads_dir = &state.config.uploads_dir;
    let prefix = format!(
        "{}{}-",
        WHITEBOARD_FONT_UPLOAD_PREFIX,
        whiteboard_scope_tag(&board_id)
    );

    let mut fonts: Vec<WhiteboardFontInfo> = Vec::new();

    match tokio::fs::read_dir(uploads_dir).await {
        Ok(mut dir) => {
            while let Ok(Some(entry)) = dir.next_entry().await {
                let file_name_os = entry.file_name();
                let file_name_str = match file_name_os.to_str() {
                    Some(s) => s.to_string(),
                    None => continue,
                };
                if !file_name_str.starts_with(&prefix) {
                    continue;
                }
                let ext = std::path::Path::new(&file_name_str)
                    .extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("");
                if !is_allowed_font_extension(ext) {
                    continue;
                }
                let recovered = match extract_font_filename(&board_id, &file_name_str) {
                    Some(v) => v,
                    None => continue,
                };
                let family = font_family_from_filename(&recovered);
                let mime_type = std::path::Path::new(&recovered)
                    .extension()
                    .and_then(|e| e.to_str())
                    .map(|e| mime_guess::from_ext(e).first_or_octet_stream().to_string())
                    .unwrap_or_else(|| "application/octet-stream".to_string());
                let file_url = format!(
                    "/api/whiteboard/boards/{}/files/{}",
                    urlencoding::encode(&board_id),
                    urlencoding::encode(&file_name_str),
                );
                let file_size = entry
                    .metadata()
                    .await
                    .map(|m| m.len())
                    .unwrap_or(0);
                fonts.push(WhiteboardFontInfo {
                    font_id: file_name_str.clone(),
                    family,
                    file_name: recovered,
                    file_size,
                    mime_type,
                    file_url,
                });
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            // Return empty list when dir does not exist
        }
        Err(e) => {
            return Ok(json_error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("Failed to list fonts: {}", e),
            ));
        }
    }

    fonts.sort_by(|a, b| a.file_name.cmp(&b.file_name));

    let response = WhiteboardFontListResponse {
        success: true,
        fonts,
    };

    Ok(Json(response).into_response())
}

/// GET /api/whiteboard/boards/:boardId/files/:fileId
///
/// Serve a whiteboard file by board ID and file ID.
async fn serve_whiteboard_file(
    State(state): State<Arc<AppState>>,
    Path((board_id, file_id)): Path<(String, String)>,
    auth: AuthUser,
) -> Result<impl IntoResponse> {
    // Auth check — require a valid token. Guests cannot access whiteboard files.
    let user_id = auth.user_id;

    let board_id = board_id.trim().to_string();
    if board_id.is_empty() {
        return Ok(json_error_response(
            StatusCode::BAD_REQUEST,
            "Invalid whiteboard id",
        ));
    }

    // Validate file ID is scoped to this board (image `wbi-` or font `wbf-` uploads)
    if !is_whiteboard_file_id_for_board(&board_id, &file_id)
        && !is_whiteboard_font_file_id_for_board(&board_id, &file_id)
    {
        return Ok(Response::builder()
            .status(StatusCode::FORBIDDEN)
            .body(Body::from("Access denied"))
            .unwrap());
    }

    // Check channel access
    let channel_id = if board_id.starts_with("channel:") {
        board_id
            .strip_prefix("channel:")
            .unwrap_or(&board_id)
            .to_string()
    } else {
        board_id.clone()
    };

    if !can_access_channel(&state, Some(user_id), None, &channel_id).await {
        return Ok(Response::builder()
            .status(StatusCode::FORBIDDEN)
            .body(Body::from("Access denied"))
            .unwrap());
    }

    // Serve the file
    let file_path = resolve_upload_path(&state.config.uploads_dir, &file_id);
    match fs::read(&file_path).await {
        Ok(data) => {
            // Guess content type from extension
            let content_type = file_path
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| mime_guess::from_ext(e).first_or_octet_stream().to_string())
                .unwrap_or_else(|| "application/octet-stream".to_string());

            Ok(Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, &content_type)
                .header(header::CACHE_CONTROL, "private, max-age=300")
                .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
                .header(
                    header::CONTENT_SECURITY_POLICY,
                    "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src 'self'",
                )
                .body(Body::from(data))
                .unwrap())
        }
        Err(_) => Ok(Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Body::from("File not found"))
            .unwrap()),
    }
}

/// GET /api/whiteboard/boards/:boardId/document
///
/// Fetch a board document. Auth + channel membership required; 404 when the
/// board has never been saved.
async fn get_board_document(
    State(state): State<Arc<AppState>>,
    Path(board_id): Path<String>,
    auth: AuthUser,
) -> Result<impl IntoResponse> {
    let user_id = auth.user_id;

    let board_id = board_id.trim().to_string();
    if board_id.is_empty() {
        return Ok(json_error_response(
            StatusCode::BAD_REQUEST,
            "Invalid whiteboard id",
        ));
    }

    let channel_id = if board_id.starts_with("channel:") {
        board_id
            .strip_prefix("channel:")
            .unwrap_or(&board_id)
            .to_string()
    } else {
        board_id.clone()
    };

    if !can_access_channel(&state, Some(user_id), None, &channel_id).await {
        return Ok(json_error_response(StatusCode::FORBIDDEN, "Access denied"));
    }

    match state.wdb.get_whiteboard_doc(&board_id).await {
        Ok(Some(doc)) => match serde_json::from_str::<serde_json::Value>(&doc) {
            Ok(v) => Ok((StatusCode::OK, Json(v)).into_response()),
            Err(_) => Ok(json_error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Stored document is not valid JSON",
            )),
        },
        Ok(None) => Ok(json_error_response(
            StatusCode::NOT_FOUND,
            "Board document not found",
        )),
        Err(e) => Ok(json_error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("Failed to read board document: {}", e),
        )),
    }
}

/// PUT /api/whiteboard/boards/:boardId/document
///
/// Persist a board document. Auth + membership + size + version check
/// (409 on stale version). The server bumps the version on success, matching
/// the socket snapshot path, and returns the new version in the response.
async fn put_board_document(
    State(state): State<Arc<AppState>>,
    Path(board_id): Path<String>,
    auth: AuthUser,
    body: axum::body::Bytes,
) -> Result<Response> {
    let user_id = auth.user_id;

    if body.len() > WHITEBOARD_MAX_DOCUMENT_BYTES {
        return Ok(json_error_response(
            StatusCode::PAYLOAD_TOO_LARGE,
            "Board document exceeds 2MB limit",
        ));
    }

    let parsed: serde_json::Value =
        serde_json::from_slice(&body).map_err(|e| anyhow::anyhow!("invalid document JSON: {}", e))?;
    if !parsed.is_object() {
        return Ok(json_error_response(
            StatusCode::BAD_REQUEST,
            "Document must be a JSON object",
        ));
    }

    let board_id = board_id.trim().to_string();
    if board_id.is_empty() {
        return Ok(json_error_response(
            StatusCode::BAD_REQUEST,
            "Invalid whiteboard id",
        ));
    }

    let channel_id = if board_id.starts_with("channel:") {
        board_id
            .strip_prefix("channel:")
            .unwrap_or(&board_id)
            .to_string()
    } else {
        board_id.clone()
    };

    if !can_access_channel(&state, Some(user_id), None, &channel_id).await {
        return Ok(json_error_response(StatusCode::FORBIDDEN, "Access denied"));
    }

    // Version check: in-memory map first (shared with socket snapshot),
    // then the persisted doc's version, else 0 for a fresh board.
    let client_version = parsed.get("version").and_then(|v| v.as_u64()).unwrap_or(0);
    let mapped = whiteboard_versions().lock().unwrap().get(&board_id).copied();
    let current = match mapped {
        Some(v) => v,
        None => match state.wdb.get_whiteboard_doc(&board_id).await {
            Ok(Some(doc)) => serde_json::from_str::<serde_json::Value>(&doc)
                .ok()
                .and_then(|d| d.get("version").and_then(|v| v.as_u64()))
                .unwrap_or(0),
            _ => 0,
        },
    };
    if client_version != current {
        return Ok(json_error_response(
            StatusCode::CONFLICT,
            &format!(
                "Version mismatch: client {}, server {}",
                client_version, current
            ),
        ));
    }

    let new_version = client_version + 1;
    let mut doc = parsed;
    doc["version"] = serde_json::json!(new_version);
    let serialized = serde_json::to_string(&doc).unwrap_or_default();

    match state.wdb.put_whiteboard_doc(&board_id, &serialized).await {
        Ok(()) => {
            whiteboard_versions()
                .lock()
                .unwrap()
                .insert(board_id.clone(), new_version);
            Ok(Json(serde_json::json!({
                "success": true,
                "boardId": board_id,
                "version": new_version,
            }))
            .into_response())
        }
        Err(e) => Ok(json_error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("Failed to persist board document: {}", e),
        )),
    }
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------



// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

fn json_error_response(status: StatusCode, message: &str) -> Response {
    (
        status,
        [(header::CONTENT_TYPE, "application/json")],
        serde_json::json!({ "success": false, "error": message }).to_string(),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_allowed_font_extension_valid() {
        assert!(is_allowed_font_extension("woff2"));
        assert!(is_allowed_font_extension("woff"));
        assert!(is_allowed_font_extension("ttf"));
        assert!(is_allowed_font_extension("otf"));
        assert!(is_allowed_font_extension("WOFF2"));
        assert!(is_allowed_font_extension("Woff"));
        assert!(is_allowed_font_extension("TTF"));
        assert!(is_allowed_font_extension("OTF"));
        assert!(is_allowed_font_extension("WoFf2"));
    }

    #[test]
    fn test_is_allowed_font_extension_invalid() {
        assert!(!is_allowed_font_extension("png"));
        assert!(!is_allowed_font_extension("jpg"));
        assert!(!is_allowed_font_extension("txt"));
        assert!(!is_allowed_font_extension(""));
        assert!(!is_allowed_font_extension("woff3"));
        assert!(!is_allowed_font_extension("ttf "));
    }

    #[test]
    fn test_font_family_from_filename() {
        assert_eq!(font_family_from_filename("MyFont.woff2"), "MyFont");
        assert_eq!(font_family_from_filename("My Font Bold.ttf"), "My Font Bold");
        assert_eq!(
            font_family_from_filename("My   Font   Regular.woff"),
            "My Font Regular"
        );
        assert_eq!(font_family_from_filename("Whitespace   .otf"), "Whitespace");
        assert_eq!(
            font_family_from_filename("no-extension"),
            "no-extension"
        );
        assert_eq!(font_family_from_filename("  spaced   name  .ttf"), "spaced name");
    }

    #[test]
    fn test_create_whiteboard_font_file_id_prefix() {
        let board_id = "channel:123";
        let file_id = create_whiteboard_font_file_id(board_id, "font.woff2");
        assert!(file_id.starts_with(WHITEBOARD_FONT_UPLOAD_PREFIX));
        assert!(is_whiteboard_font_file_id_for_board(board_id, &file_id));
        assert!(!is_whiteboard_font_file_id_for_board("other-board", &file_id));
        // should not be recognized as image file id
        assert!(!is_whiteboard_file_id_for_board(board_id, &file_id));
    }

    #[test]
    fn test_is_whiteboard_font_file_id_for_board() {
        let board_id = "my-board";
        let tag = whiteboard_scope_tag(board_id);
        let good = format!("{}-{}-{}-{}-{}", "wbf", tag, "123456", "abc", "font.woff2");
        let good2 = format!("{}{}-123-abc-font.woff2", WHITEBOARD_FONT_UPLOAD_PREFIX, tag);
        assert!(is_whiteboard_font_file_id_for_board(board_id, &good2));
        assert!(is_whiteboard_font_file_id_for_board(board_id, &good));
        let bad = format!("{}{}-123-abc-font.woff2", WHITEBOARD_UPLOAD_PREFIX, tag);
        assert!(!is_whiteboard_font_file_id_for_board(board_id, &bad));
        assert!(!is_whiteboard_font_file_id_for_board("other", &good2));
    }

    #[test]
    fn test_extract_font_filename_simple() {
        let board_id = "channel:test-board";
        let tag = whiteboard_scope_tag(board_id);
        let file_id = format!("{}{}-{}-{}-{}", WHITEBOARD_FONT_UPLOAD_PREFIX, tag, "1234567890", "abc123", "MyFont.woff2");
        let tail = extract_font_filename(board_id, &file_id).unwrap();
        assert_eq!(tail, "MyFont.woff2");
    }

    #[test]
    fn test_extract_font_filename_with_dashes() {
        let board_id = "board-with-dashes";
        let tag = whiteboard_scope_tag(board_id);
        let file_id = format!("{}{}-{}-{}-{}", WHITEBOARD_FONT_UPLOAD_PREFIX, tag, "deadbeef", "cafebabe", "my-font-bold-italic.woff2");
        let tail = extract_font_filename(board_id, &file_id).unwrap();
        assert_eq!(tail, "my-font-bold-italic.woff2");
    }

    #[test]
    fn test_extract_font_filename_invalid_prefix() {
        let board_id = "my-board";
        let tag = whiteboard_scope_tag(board_id);
        let file_id = format!("{}{}-{}-{}-{}", WHITEBOARD_UPLOAD_PREFIX, tag, "123", "abc", "font.woff2");
        assert!(extract_font_filename(board_id, &file_id).is_none());
    }

    #[test]
    fn test_extract_font_filename_wrong_board() {
        let board_id = "board-a";
        let other = "board-b";
        let tag = whiteboard_scope_tag(board_id);
        let file_id = format!("{}{}-{}-{}-{}", WHITEBOARD_FONT_UPLOAD_PREFIX, tag, "123", "abc", "font.ttf");
        assert!(extract_font_filename(other, &file_id).is_none());
    }

    #[test]
    fn test_extract_font_filename_missing_segments() {
        let board_id = "board-x";
        let tag = whiteboard_scope_tag(board_id);
        let file_id = format!("{}{}-{}", WHITEBOARD_FONT_UPLOAD_PREFIX, tag, "onlyone");
        assert!(extract_font_filename(board_id, &file_id).is_none());
        let file_id2 = format!("{}{}-{}-{}", WHITEBOARD_FONT_UPLOAD_PREFIX, tag, "123", "abc");
        // this would be prefix + "123-abc" -> tail "123-abc" has one dash, second dash missing? Actually "123-abc" has one dash, extracting would try to find second dash in "abc" -> None
        // But file_id2 is wbf-<tag>-123-abc where sanitized name missing, should be None because remainder empty
        // Let's test with sanitized missing: after skipping two segments, remainder empty -> None
        // In this case tail is "123-abc" -> first dash at 3, rest "abc" -> no second dash -> None
        assert!(extract_font_filename(board_id, &file_id2).is_none());
    }
}
