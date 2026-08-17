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

/// Prefix for whiteboard-scoped upload file IDs.
const WHITEBOARD_UPLOAD_PREFIX: &str = "wbi-";

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/// Create the whiteboard API router.
pub fn routes(state: Arc<AppState>) -> Router<Arc<AppState>> {
    Router::new()
        .route("/boards/{board_id}/images", post(upload_whiteboard_image))
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
    headers: axum::http::HeaderMap,
    mut multipart: axum::extract::Multipart,
) -> Result<impl IntoResponse> {
    // Auth check
    let user_id = extract_user_id(&headers, &state.config.jwt_secret)?;

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

/// GET /api/whiteboard/boards/:boardId/files/:fileId
///
/// Serve a whiteboard file by board ID and file ID.
async fn serve_whiteboard_file(
    State(state): State<Arc<AppState>>,
    Path((board_id, file_id)): Path<(String, String)>,
    headers: axum::http::HeaderMap,
) -> Result<impl IntoResponse> {
    // Auth check (optional — allow guests with session cookie too)
    let user_id = extract_user_id_optional(&headers, &state.config.jwt_secret);

    let board_id = board_id.trim().to_string();
    if board_id.is_empty() {
        return Ok(json_error_response(
            StatusCode::BAD_REQUEST,
            "Invalid whiteboard id",
        ));
    }

    // Validate file ID is scoped to this board
    if !is_whiteboard_file_id_for_board(&board_id, &file_id) {
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

    if let Some(uid) = user_id {
        if !can_access_channel(&state, Some(uid), None, &channel_id).await {
            return Ok(Response::builder()
                .status(StatusCode::FORBIDDEN)
                .body(Body::from("Access denied"))
                .unwrap());
        }
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
    headers: axum::http::HeaderMap,
) -> Result<impl IntoResponse> {
    let user_id = extract_user_id(&headers, &state.config.jwt_secret)?;

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
    headers: axum::http::HeaderMap,
    body: axum::body::Bytes,
) -> Result<Response> {
    let user_id = extract_user_id(&headers, &state.config.jwt_secret)?;

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

fn extract_user_id(headers: &axum::http::HeaderMap, jwt_secret: &str) -> anyhow::Result<i64> {
    use jsonwebtoken::{decode, DecodingKey, Validation};

    let auth = headers
        .get("authorization")
        .ok_or_else(|| anyhow::anyhow!("Authentication required"))?
        .to_str()
        .map_err(|_| anyhow::anyhow!("invalid authorization header"))?;
    let token = auth
        .strip_prefix("Bearer ")
        .ok_or_else(|| anyhow::anyhow!("missing Bearer prefix"))?;

    #[derive(serde::Deserialize)]
    struct Claims {
        sub: String,
    }

    let key = DecodingKey::from_secret(jwt_secret.as_bytes());
    let mut v = Validation::default();
    v.validate_exp = true;
    v.leeway = 60;
    let c =
        decode::<Claims>(token, &key, &v).map_err(|e| anyhow::anyhow!("invalid token: {}", e))?;
    c.claims
        .sub
        .parse::<i64>()
        .map_err(|_| anyhow::anyhow!("invalid user_id in token"))
}

fn extract_user_id_optional(headers: &axum::http::HeaderMap, jwt_secret: &str) -> Option<i64> {
    extract_user_id(headers, jwt_secret).ok()
}

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
