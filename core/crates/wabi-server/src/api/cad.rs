//! CAD import helpers.
//!
//! Wabi keeps proprietary/source CAD bytes separate from its normal preview
//! formats. DWG is converted by an optional LibreDWG `dwg2dxf` helper into
//! ASCII DXF, then the existing read-only DXF viewer handles rendering and
//! review markup. The helper is invoked directly (never through a shell).

use axum::{
    body::Body,
    extract::DefaultBodyLimit,
    http::{header, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Serialize;
use std::{
    env,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::process::Command;
use uuid::Uuid;

use crate::{auth_extractor::AuthUser, state::AppState};

const MAX_DWG_BYTES: usize = 20 * 1024 * 1024;
const MAX_DXF_BYTES: u64 = 20 * 1024 * 1024;
const CONVERT_TIMEOUT: Duration = Duration::from_secs(45);
const PROBE_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Serialize)]
struct CadCapabilities {
    dwg_to_dxf: bool,
    converter: Option<&'static str>,
    max_dwg_bytes: usize,
    max_dxf_bytes: u64,
}

struct ScratchDir(PathBuf);

impl ScratchDir {
    async fn create() -> std::io::Result<Self> {
        let path = env::temp_dir().join(format!("wabi-cad-{}", Uuid::new_v4()));
        tokio::fs::create_dir(&path).await?;
        Ok(Self(path))
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for ScratchDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

pub fn routes(state: Arc<AppState>) -> Router<Arc<AppState>> {
    Router::new()
        .route("/capabilities", get(capabilities))
        .route(
            "/dwg-to-dxf",
            post(convert_dwg_to_dxf).layer(DefaultBodyLimit::max(MAX_DWG_BYTES)),
        )
        .with_state(state)
}

fn converter_binary() -> String {
    env::var("WABI_DWG2DXF_BIN")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "dwg2dxf".to_string())
}

async fn converter_available() -> bool {
    let mut command = Command::new(converter_binary());
    command.arg("--version").kill_on_drop(true);
    matches!(
        tokio::time::timeout(PROBE_TIMEOUT, command.output()).await,
        Ok(Ok(output)) if output.status.success()
    )
}

async fn capabilities(_auth: AuthUser) -> Json<CadCapabilities> {
    let available = converter_available().await;
    Json(CadCapabilities {
        dwg_to_dxf: available,
        converter: available.then_some("libredwg-dwg2dxf"),
        max_dwg_bytes: MAX_DWG_BYTES,
        max_dxf_bytes: MAX_DXF_BYTES,
    })
}

fn json_error(status: StatusCode, message: impl Into<String>) -> Response {
    (status, Json(serde_json::json!({ "error": message.into() }))).into_response()
}

fn probable_dwg(bytes: &[u8]) -> bool {
    // Autodesk DWG releases use an ASCII ACxxxx file signature. This cheap
    // gate catches accidental uploads before the external parser sees them;
    // LibreDWG remains the authoritative decoder.
    bytes.len() >= 6
        && bytes.starts_with(b"AC")
        && bytes[2..6].iter().all(|byte| byte.is_ascii_alphanumeric())
}

fn stderr_excerpt(stderr: &[u8]) -> String {
    let text = String::from_utf8_lossy(stderr);
    let cleaned: String = text
        .chars()
        .filter(|ch| *ch == '\n' || *ch == '\t' || !ch.is_control())
        .take(800)
        .collect();
    cleaned.trim().to_string()
}

async fn convert_dwg_to_dxf(_auth: AuthUser, body: axum::body::Bytes) -> Response {
    if body.is_empty() {
        return json_error(StatusCode::BAD_REQUEST, "DWG body is empty.");
    }
    if body.len() > MAX_DWG_BYTES {
        return json_error(StatusCode::PAYLOAD_TOO_LARGE, "DWG exceeds Wabi's 20 MB preview limit.");
    }
    if !probable_dwg(&body) {
        return json_error(StatusCode::UNSUPPORTED_MEDIA_TYPE, "The uploaded bytes do not look like a DWG file.");
    }
    if !converter_available().await {
        return json_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "DWG preview requires LibreDWG's dwg2dxf helper on this Wabi server. Set WABI_DWG2DXF_BIN if it is installed outside PATH.",
        );
    }

    let scratch = match ScratchDir::create().await {
        Ok(value) => value,
        Err(error) => {
            tracing::warn!(?error, "failed to create CAD conversion scratch directory");
            return json_error(StatusCode::INTERNAL_SERVER_ERROR, "Could not prepare the DWG converter.");
        }
    };
    let input = scratch.path().join("source.dwg");
    let output = scratch.path().join("preview.dxf");
    if let Err(error) = tokio::fs::write(&input, &body).await {
        tracing::warn!(?error, "failed to stage DWG conversion input");
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, "Could not stage the DWG preview.");
    }

    let mut command = Command::new(converter_binary());
    command
        .arg("-y")
        .arg("-o")
        .arg(&output)
        .arg(&input)
        .current_dir(scratch.path())
        .kill_on_drop(true);

    let result = match tokio::time::timeout(CONVERT_TIMEOUT, command.output()).await {
        Ok(Ok(value)) => value,
        Ok(Err(error)) => {
            tracing::warn!(?error, "failed to launch dwg2dxf");
            return json_error(StatusCode::SERVICE_UNAVAILABLE, "The DWG converter could not be started.");
        }
        Err(_) => {
            return json_error(StatusCode::GATEWAY_TIMEOUT, "DWG conversion exceeded the 45 second preview limit.");
        }
    };

    if !result.status.success() {
        let detail = stderr_excerpt(&result.stderr);
        tracing::warn!(status = ?result.status.code(), stderr = %detail, "dwg2dxf rejected DWG input");
        return json_error(
            StatusCode::UNPROCESSABLE_ENTITY,
            if detail.is_empty() {
                "LibreDWG could not convert this DWG file.".to_string()
            } else {
                format!("LibreDWG could not convert this DWG file: {detail}")
            },
        );
    }

    let metadata = match tokio::fs::metadata(&output).await {
        Ok(value) => value,
        Err(_) => return json_error(StatusCode::UNPROCESSABLE_ENTITY, "DWG conversion completed without a DXF preview."),
    };
    if metadata.len() == 0 {
        return json_error(StatusCode::UNPROCESSABLE_ENTITY, "DWG conversion produced an empty DXF preview.");
    }
    if metadata.len() > MAX_DXF_BYTES {
        return json_error(StatusCode::PAYLOAD_TOO_LARGE, "Converted DXF exceeds Wabi's 20 MB browser preview limit.");
    }

    let bytes = match tokio::fs::read(&output).await {
        Ok(value) => value,
        Err(error) => {
            tracing::warn!(?error, "failed to read converted DXF");
            return json_error(StatusCode::INTERNAL_SERVER_ERROR, "Could not read the converted DXF preview.");
        }
    };

    let mut response = Response::new(Body::from(bytes));
    *response.status_mut() = StatusCode::OK;
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/plain; charset=utf-8"));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_static("inline; filename=preview.dxf"),
    );
    headers.insert("x-content-type-options", HeaderValue::from_static("nosniff"));
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_modern_dwg_signature_without_accepting_random_bytes() {
        assert!(probable_dwg(b"AC1032rest-of-file"));
        assert!(probable_dwg(b"AC1018rest-of-file"));
        assert!(!probable_dwg(b"PK\x03\x04not-dwg"));
        assert!(!probable_dwg(b""));
    }

    #[test]
    fn stderr_excerpt_removes_controls_and_bounds_output() {
        let noisy = vec![b'x'; 1200];
        assert_eq!(stderr_excerpt(&noisy).len(), 800);
        assert_eq!(stderr_excerpt(b"bad\0thing\n"), "badthing");
    }
}
