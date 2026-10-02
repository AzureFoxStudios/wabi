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
    http::{header, HeaderMap, HeaderValue, StatusCode},
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

    Ok((blob_download_headers(&meta), bytes))
}

/// Blob metadata, including the declared MIME and original name, comes from
/// uploaders. Apply the same sandbox as `/uploads/` and force download rather
/// than allowing an HTML/SVG navigation to execute under the Authority origin.
fn blob_download_headers(meta: &crate::blobs::BlobMeta) -> HeaderMap {
    let mut headers = HeaderMap::new();
    for (name, value) in super::upload::upload_response_headers() {
        headers.insert(name, value);
    }
    headers.insert(
        header::CONTENT_TYPE,
        meta.mime_type
            .parse::<mime_guess::Mime>()
            .ok()
            // Wildcards describe acceptable media ranges, not a downloaded
            // representation's type.
            .filter(|mime| {
                !mime.type_().as_str().is_empty()
                    && !mime.subtype().as_str().is_empty()
                    && mime.type_() != "*"
                    && mime.subtype() != "*"
            })
            .and_then(|_| HeaderValue::from_str(&meta.mime_type).ok())
            .unwrap_or_else(|| HeaderValue::from_static("application/octet-stream")),
    );
    headers.insert(
        header::CONTENT_DISPOSITION,
        download_disposition(&meta.original_name),
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    headers
}

fn download_disposition(original_name: &str) -> HeaderValue {
    // Do not propagate directory components or controls into browser download
    // names. Bound Unicode characters before encoding to keep the header small.
    let basename = original_name.rsplit(['/', '\\']).next().unwrap_or_default();
    let cleaned: String = basename
        .chars()
        .filter(|character| !character.is_control())
        .take(128)
        .collect();
    let cleaned = cleaned.trim_matches(['.', ' ']);
    let name = if cleaned.is_empty() {
        "download.bin"
    } else {
        cleaned
    };
    let fallback: String = name
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, ' ' | '.' | '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect();
    let mut encoded = String::new();
    for byte in name.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            encoded.push(char::from(byte));
        } else {
            use std::fmt::Write;
            write!(&mut encoded, "%{byte:02X}").expect("writing to a string succeeds");
        }
    }
    HeaderValue::from_str(&format!(
        "attachment; filename=\"{fallback}\"; filename*=UTF-8''{encoded}"
    ))
    .expect("download disposition contains only safe ASCII")
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

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::{to_bytes, Body},
        http::Request,
    };
    use tower::ServiceExt;

    #[test]
    fn download_names_cannot_inject_headers_or_directory_components() {
        assert_eq!(
            download_disposition("../../diagram.svg").to_str().unwrap(),
            "attachment; filename=\"diagram.svg\"; filename*=UTF-8''diagram.svg"
        );
        let hostile = download_disposition("C:\\folder\\evil\";\r\nX-Injected: yes.svg");
        let value = hostile.to_str().unwrap();
        assert!(value.starts_with("attachment; filename=\""));
        assert!(!value.contains(['\r', '\n', '\\']));
        assert_eq!(value.matches('"').count(), 2);
        assert!(value.contains("%22%3B"));
        assert!(value.contains("%3A%20"));
        assert_eq!(
            download_disposition("../.. /").to_str().unwrap(),
            "attachment; filename=\"download.bin\"; filename*=UTF-8''download.bin"
        );
        let unicode = download_disposition("図面.glb");
        assert!(unicode
            .to_str()
            .unwrap()
            .contains("filename*=UTF-8''%E5%9B%B3%E9%9D%A2.glb"));
        assert!(download_disposition(&"図".repeat(100_000)).as_bytes().len() < 2048);
    }

    #[test]
    fn malformed_declared_mime_uses_a_safe_fallback() {
        for mime_type in [
            "text/html\r\nX-Injected: yes",
            "",
            "not-a-mime",
            "text/",
            "text/; charset=utf-8",
            "text/html; charset=\"unfinished",
            "image/*",
            "*/*",
        ] {
            let meta = crate::blobs::BlobMeta {
                original_name: "payload.html".into(),
                mime_type: mime_type.into(),
                ..Default::default()
            };
            let headers = blob_download_headers(&meta);
            assert_eq!(
                headers[header::CONTENT_TYPE],
                "application/octet-stream",
                "invalid MIME {mime_type:?}"
            );
            assert!(!headers.contains_key("x-injected"));
            assert_eq!(headers[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
            assert!(headers[header::CONTENT_SECURITY_POLICY]
                .to_str()
                .unwrap()
                .contains("sandbox"));
        }
    }

    #[tokio::test]
    async fn real_blob_route_sandboxes_active_mime_preserves_bytes_and_supports_head() {
        let dir = tempfile::tempdir().unwrap();
        let state = Arc::new(
            AppState::new(crate::config::ServerConfig {
                host: "127.0.0.1".into(),
                port: 0,
                data_dir: dir.path().to_string_lossy().into_owned(),
                uploads_dir: dir.path().join("uploads").to_string_lossy().into_owned(),
                jwt_secret: "blob-download-contract-secret-32-characters".into(),
                turn_enabled: false,
                turn_uri: None,
                turn_secret: None,
                node_id: "blob-test".into(),
                is_primary: true,
                server_role: crate::config::ServerRole::Authority,
                authority_url: None,
                admin_user_ids: vec![],
                blacklist_file: dir
                    .path()
                    .join("blacklist.txt")
                    .to_string_lossy()
                    .into_owned(),
                max_body_size: None,
                mesh_enabled: false,
                mesh_peers: vec![],
                lore: crate::config::LoreAddonConfig::default(),
            })
            .await
            .unwrap(),
        );
        let app = routes(Arc::clone(&state)).with_state(Arc::clone(&state));
        for (name, mime, bytes) in [
            (
                "../../payload.html",
                "text/html; charset=utf-8",
                b"<script>localStorage.clear()</script>".as_slice(),
            ),
            (
                "図面.svg",
                "image/svg+xml; charset=\"UTF-8\"",
                b"<svg onload=alert(1)></svg>".as_slice(),
            ),
        ] {
            let meta = state
                .blob_registry
                .store_blob(
                    bytes,
                    name.into(),
                    mime.into(),
                    Some("fixture-uploader".into()),
                    None,
                    None,
                    None,
                )
                .await
                .unwrap();
            let response = app
                .clone()
                .oneshot(
                    Request::get(format!("/{}", meta.hash))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let headers = response.headers();
            assert_eq!(headers[header::CONTENT_TYPE], mime);
            assert_eq!(headers[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
            assert!(headers[header::CONTENT_SECURITY_POLICY]
                .to_str()
                .unwrap()
                .contains("sandbox"));
            assert!(headers[header::CONTENT_DISPOSITION]
                .to_str()
                .unwrap()
                .starts_with("attachment;"));
            assert_eq!(headers[header::CACHE_CONTROL], "private, no-store");
            assert_eq!(headers[header::REFERRER_POLICY], "no-referrer");
            assert_eq!(
                to_bytes(response.into_body(), 1024).await.unwrap().as_ref(),
                bytes
            );
            let head = app
                .clone()
                .oneshot(
                    Request::head(format!("/{}", meta.hash))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(head.status(), StatusCode::OK);
            assert_eq!(head.headers()[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
            assert!(to_bytes(head.into_body(), 1024).await.unwrap().is_empty());
        }
        let missing = app
            .oneshot(Request::get("/absent").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(missing.status(), StatusCode::NOT_FOUND);
    }
}
