//! Full application router (health/metrics + API + WS + uploads + static SPA
//! fallback + middleware). Lives in the lib crate so integration tests can
//! exercise `serve_static` — the fallback is wired here, not inside
//! `create_api_router`. Extracted verbatim from `main.rs` (Phase 1 boot
//! optimization); no behavior change beyond the boot-brand injection and the
//! sw.js/manifest cache-header fixes documented in
//! docs/plans/2026-08-26-boot-optimization.md.

use crate::auth_extractor::OptionalAuthUser;
use crate::state::{AppState, ComposedIndexCache};
use axum::{
    extract::DefaultBodyLimit,
    http::{header::CACHE_CONTROL, header::CONTENT_TYPE, StatusCode},
    response::IntoResponse,
    routing::get,
    Json, Router,
};
use rust_embed::RustEmbed;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tower_http::compression::CompressionLayer;
use tower_http::cors::CorsLayer;
use tower_http::timeout::TimeoutLayer;
use tower_http::trace::TraceLayer;
use wabidb::engine::wabi_store::WabiStore;

/// Serve a file from the uploads directory
async fn serve_upload(
    _auth: OptionalAuthUser,
    axum::extract::Path(filename): axum::extract::Path<String>,
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
) -> impl IntoResponse {
    // Defend against path traversal: filename must not contain '/' or '\' or '..'
    if filename.contains('/') || filename.contains('\\') || filename.contains("..") {
        return (axum::http::StatusCode::BAD_REQUEST, "Invalid filename").into_response();
    }

    let uploads_dir = PathBuf::from(&state.config.uploads_dir);
    let file_path = uploads_dir.join(&filename);

    // Must be inside uploads_dir (no symlink escapes)
    let canonical = std::fs::canonicalize(&uploads_dir).ok();
    let file_canonical = std::fs::canonicalize(&file_path).ok();

    match (canonical, file_canonical) {
        (Some(canon_uploads), Some(canon_file)) => {
            if !canon_file.starts_with(&canon_uploads) {
                // Path traversal attempted
                return (axum::http::StatusCode::FORBIDDEN, "Forbidden").into_response();
            }
        }
        _ => {
            return (axum::http::StatusCode::NOT_FOUND, "File not found").into_response();
        }
    }

    // WS-6b: revoked files return 410 Gone.
    if state.upload_registry.is_revoked(&filename).await {
        return (axum::http::StatusCode::GONE, "File has been revoked").into_response();
    }

    match tokio::fs::read(&file_path).await {
        Ok(data) => {
            let mime = mime_guess::from_path(&file_path).first_or_octet_stream();
            tracing::debug!(
                "Serving upload: {:?} ({} bytes, {})",
                file_path,
                data.len(),
                mime
            );
            // Harden user-uploaded content: disallow MIME sniffing and sandbox
            // it behind a strict CSP so an SVG/image cannot execute script or
            // reach other origins.
            let mut headers = axum::http::HeaderMap::new();
            headers.insert(axum::http::header::CONTENT_TYPE, mime.as_ref().parse().unwrap());
            for (k, v) in crate::api::upload::upload_response_headers() {
                headers.insert(k, v);
            }
            // WS-6a: cache control + referrer policy for uploaded files.
            // Upload filenames are content-UUIDs (never overwritten), so they are
            // safe to cache far longer than a session — 1h max-age made every
            // avatar/background re-download after an hour (visible boot lag).
            // The SW media cache still enforces logout-time purge + revocation
            // returns 410 before this header matters.
            headers.insert(
                axum::http::header::CACHE_CONTROL,
                "private, max-age=31536000, immutable".parse().unwrap(),
            );
            headers.insert(
                axum::http::header::REFERRER_POLICY,
                "no-referrer".parse().unwrap(),
            );
            (headers, data).into_response()
        }
        Err(e) => {
            tracing::debug!("Upload file not found: {:?} — {}", file_path, e);
            (axum::http::StatusCode::NOT_FOUND, "File not found").into_response()
        }
    }
}

/// Embedded static assets from frontend build
#[derive(RustEmbed)]
#[folder = "../../../frontend/build"]
#[exclude = "*.gitkeep"]
struct StaticAssets;

/// Build the CORS layer based on `WABI_CORS_ORIGINS`.
///
/// - If `WABI_CORS_ORIGINS` is set to a non-empty, comma-separated list of
///   origins, only those exact origins are allowed (with credentials).
/// - If unset/empty, mirror the request Origin — but ONLY when it is a safe
///   local origin (localhost, 127.0.0.1, or a Tailscale 100.x address). This
///   keeps dev/self-host convenient without reflecting arbitrary attacker
///   origins on a publicly reachable, unconfigured server.
fn build_cors_layer() -> CorsLayer {
    let allowed_origins = std::env::var("WABI_CORS_ORIGINS")
        .ok()
        .map(|s| {
            s.split(',')
                .map(|o| o.trim().to_string())
                .filter(|o| !o.is_empty())
                .collect::<Vec<_>>()
        })
        .filter(|v| !v.is_empty());

    let allow_origin = match allowed_origins {
        Some(origins) => {
            let parsed = origins
                .iter()
                .filter_map(|o| o.parse::<axum::http::HeaderValue>().ok())
                .collect::<Vec<_>>();
            tower_http::cors::AllowOrigin::list(parsed)
        }
        None => {
            // Safe-local mirror fallback.
            tower_http::cors::AllowOrigin::predicate(|origin: &axum::http::HeaderValue, _| {
                origin
                    .to_str()
                    .map(|s| is_safe_local_origin(s))
                    .unwrap_or(false)
            })
        }
    };

    CorsLayer::new()
        .allow_origin(allow_origin)
        .allow_methods([
            axum::http::Method::GET,
            axum::http::Method::POST,
            axum::http::Method::PUT,
            axum::http::Method::DELETE,
            axum::http::Method::OPTIONS,
            axum::http::Method::PATCH,
        ])
        .allow_headers([
            axum::http::header::AUTHORIZATION,
            axum::http::header::CONTENT_TYPE,
            axum::http::header::ACCEPT,
            axum::http::header::ORIGIN,
            axum::http::header::HeaderName::from_static("x-requested-with"),
        ])
        .allow_credentials(true)
}

/// Returns true for origins that are safe to mirror on an unconfigured server:
/// localhost, 127.0.0.1, and Tailscale 100.x.x.x (CGNAT range).
fn is_safe_local_origin(origin: &str) -> bool {
    // Parse "scheme://host[:port]" — only inspect the host.
    let host_port = match origin.split_once("://") {
        Some((_, rest)) => rest.split('/').next().unwrap_or(rest),
        None => origin.split('/').next().unwrap_or(origin),
    };
    // Extract the host portion. IPv6 addresses are bracketed: [::1]:8080.
    let host = if host_port.starts_with('[') {
        // Take everything between '[' and the first ']'.
        host_port
            .split(']')
            .next()
            .and_then(|s| s.strip_prefix('['))
            .unwrap_or(host_port)
    } else {
        host_port.split(':').next().unwrap_or(host_port)
    };

    if host == "localhost" || host == "127.0.0.1" || host == "::1" || host == "0.0.0.0" {
        return true;
    }
    // Tailscale IPv4 CGNAT range: 100.64.0.0/10.
    if let Ok(octets) = host.parse::<std::net::Ipv4Addr>() {
        let [a, b, _, _] = octets.octets();
        if a == 100 && b >= 64 && b <= 127 {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod cors_tests {
    use super::is_safe_local_origin;

    #[test]
    fn accept_localhost() {
        assert!(is_safe_local_origin("http://localhost"));
        assert!(is_safe_local_origin("https://localhost"));
    }

    #[test]
    fn accept_localhost_with_port() {
        assert!(is_safe_local_origin("http://localhost:3000"));
        assert!(is_safe_local_origin("https://localhost:5173"));
    }

    #[test]
    fn accept_ipv4_loopback() {
        assert!(is_safe_local_origin("http://127.0.0.1"));
        assert!(is_safe_local_origin("http://127.0.0.1:3000"));
        assert!(is_safe_local_origin("https://127.0.0.1:5173"));
    }

    #[test]
    fn accept_ipv6_loopback() {
        assert!(is_safe_local_origin("http://[::1]"));
        assert!(is_safe_local_origin("http://[::1]:8080"));
        assert!(is_safe_local_origin("https://[::1]:443"));
    }

    #[test]
    fn accept_tailscale_cgnat() {
        assert!(is_safe_local_origin("http://100.64.0.1"));
        assert!(is_safe_local_origin("http://100.100.100.100:8080"));
        assert!(is_safe_local_origin("https://100.127.255.255:443"));
    }

    #[test]
    fn reject_localhost_subdomain_attack() {
        // origin.starts_with("https://localhost") would incorrectly accept this
        assert!(!is_safe_local_origin("https://localhost.evil.com"));
        assert!(!is_safe_local_origin("http://localhost.evil.com:3000"));
    }

    #[test]
    fn reject_external_origins() {
        assert!(!is_safe_local_origin("https://example.com"));
        assert!(!is_safe_local_origin("https://evil.com:3000"));
        assert!(!is_safe_local_origin("http://192.168.1.1"));
    }

    #[test]
    fn reject_1x_public_tailscale() {
        // 100.128.x.x is outside the 100.64.0.0/10 CGNAT range
        assert!(!is_safe_local_origin("http://100.128.0.1"));
        assert!(!is_safe_local_origin("http://100.63.255.255"));
    }

    #[test]
    fn accept_plain_no_scheme() {
        // Some clients send Origin without scheme
        assert!(is_safe_local_origin("localhost"));
        assert!(is_safe_local_origin("127.0.0.1"));
    }
}

/// Health check endpoint
async fn health_check(
    axum::extract::State(state): axum::extract::State<std::sync::Arc<crate::state::AppState>>,
) -> impl IntoResponse {
    let healthy = state.wdb.is_healthy();
    (
        if healthy {
            axum::http::StatusCode::OK
        } else {
            axum::http::StatusCode::SERVICE_UNAVAILABLE
        },
        Json(serde_json::json!({
            "status": if healthy { "ok" } else { "degraded" },
            "service": "wabi-server",
            "role": "authority",
            "version": env!("CARGO_PKG_VERSION"),
            "timestamp": chrono::Utc::now().to_rfc3339()
        })),
    )
}

/// Liveness probe — process is up and can respond.
async fn liveness_check() -> impl IntoResponse {
    Json(serde_json::json!({
        "status": "ok",
        "service": "wabi-server",
    }))
}

/// Readiness probe — engine is answering. Cheap projection read.
async fn readiness_check(
    axum::extract::State(state): axum::extract::State<std::sync::Arc<crate::state::AppState>>,
) -> axum::response::Response {
    if !state.wdb.is_healthy() {
        return (
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({ "status": "degraded", "engine": "not_ready" })),
        )
            .into_response();
    }
    match state.wdb.list_users().await {
        Ok(_) => (
            axum::http::StatusCode::OK,
            Json(serde_json::json!({ "status": "ok", "engine": "ready" })),
        )
            .into_response(),
        Err(e) => (
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({ "status": "degraded", "engine": "not_ready", "reason": format!("{e}") })),
        )
            .into_response(),
    }
}

/// Prometheus metrics endpoint. Reads from the global static state.
async fn metrics_handler() -> axum::response::Response {
    let body = crate::metrics::render_prometheus();
    (
        axum::http::StatusCode::OK,
        [(axum::http::header::CONTENT_TYPE, "text/plain; version=0.0.4")],
        body,
    )
        .into_response()
}

/// Middleware: count each request and record its latency. Cheap atomic ops.
async fn metrics_middleware(
    request: axum::http::Request<axum::body::Body>,
    next: axum::middleware::Next,
) -> axum::response::Response {
    crate::metrics::MetricsState::record_request();
    let start = std::time::Instant::now();
    let response = next.run(request).await;
    crate::metrics::MetricsState::record_latency_ms(start.elapsed().as_millis() as u64);
    response
}

/// Escape admin-entered strings before they are placed into HTML attributes.
fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

/// Strict hex-color guard for theme-color injection (CSS-injection defense).
/// Accepts `#RGB` through `#RRGGBBAA`; rejects anything else.
fn is_hex_color(s: &str) -> bool {
    let hex = s.strip_prefix('#').unwrap_or("");
    (3..=8).contains(&hex.len()) && hex.chars().all(|c| c.is_ascii_hexdigit())
}

/// Compose index.html with server-injected brand tokens so first paint is
/// branded with zero extra requests (Phase 1 boot optimization). Cached
/// against admin_policies.json mtime — no explicit invalidation needed:
/// admin rebrand edits change the mtime and the next request recomposes.
///
/// Fail-open by design: a missing token (stale embedded build) or unreadable
/// policy serves the raw embedded shell with default Wabi branding.
async fn composed_index_html(state: &Arc<AppState>) -> Vec<u8> {
    use std::sync::atomic::{AtomicBool, Ordering};
    static TOKEN_WARNED: AtomicBool = AtomicBool::new(false);

    let policy = crate::api::public::load_frontend_metadata_policy(&state.config.data_dir);
    let policy_mtime = std::fs::metadata(
        PathBuf::from(&state.config.data_dir).join("admin_policies.json"),
    )
    .and_then(|m| m.modified())
    .ok();
    let brand_json = crate::api::public::build_boot_brand_json(&policy);
    let has_custom_brand = brand_json.is_some();

    // Fast path: unchanged policy → reuse the composed body.
    {
        let cached = state.composed_index.read().await;
        if let Some(cache) = cached.as_ref() {
            if cache.policy_mtime == policy_mtime && cache.has_custom_brand == has_custom_brand {
                return cache.body.clone();
            }
        }
    }

    let raw = match StaticAssets::get("index.html") {
        Some(content) => String::from_utf8_lossy(&content.data).into_owned(),
        None => return Vec::new(),
    };

    let mut html = raw;
    if let Some(brand_json) = brand_json {
        const TOKEN: &str = "/*__WABI_SERVER_BRAND__*/null";
        if html.contains(TOKEN) {
            html = html.replacen(TOKEN, &format!(" {}", brand_json), 1);
        } else if !TOKEN_WARNED.swap(true, Ordering::Relaxed) {
            tracing::warn!(
                "boot-brand token missing from embedded index.html (stale frontend build?) — serving unbranded"
            );
        }

        let name = policy
            .get("displayName")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty());
        let icon = policy
            .get("iconUrl")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty());
        let accent = policy
            .get("accentColor")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty());

        if let Some(name) = name {
            html = html.replace(
                "<title data-wabi-brand-title>Wabi</title>",
                &format!("<title>{}</title>", html_escape(name)),
            );
        }
        if let Some(icon) = icon {
            html = html.replace(
                "href=\"/favicon.png\" data-wabi-favicon",
                &format!("href=\"{}\" data-wabi-favicon", html_escape(icon)),
            );
        }
        if let Some(accent) = accent {
            // Reject anything that isn't a plain hex color — this string would
            // otherwise land inside an HTML attribute/CSS context.
            if is_hex_color(accent) {
                html = html.replace(
                    "content=\"#0f0c29\" data-wabi-theme-color",
                    &format!("content=\"{}\" data-wabi-theme-color", accent),
                );
            }
        }
    }

    let body = html.into_bytes();
    *state.composed_index.write().await = Some(ComposedIndexCache {
        policy_mtime,
        has_custom_brand,
        body: body.clone(),
    });
    body
}

/// Serve static assets with SPA fallback
async fn serve_static(
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    uri: axum::extract::OriginalUri,
) -> axum::response::Response {
    let path = uri.0.path().trim_start_matches('/');
    let path = if path.is_empty() || path == "/" {
        "index.html"
    } else {
        path
    };

    // Cache policy: the SPA entry (index.html) must be revalidated on every
    // load so rapid redeploys never strand a client on a stale chunk graph.
    // sw.js must also revalidate — its freshness was previously saved only by
    // the `?v=` query trick — and an immutable-cached manifest.webmanifest
    // hides rebrands (name/icons) from installed PWAs for up to a year.
    // Hashed immutable assets (_app/...) are safe to cache forever.
    let cache = if path == "index.html"
        || path == "sw.js"
        || path == "manifest.webmanifest"
        || path == "manifest.json"
        || path.ends_with("service-worker.js")
    {
        "no-cache"
    } else {
        "public, max-age=31536000, immutable"
    };

    match StaticAssets::get(path) {
        Some(content) => {
            let mime = mime_guess::from_path(path).first_or_octet_stream();
            let body: Vec<u8> = if path == "index.html" {
                composed_index_html(&state).await
            } else {
                content.data.to_vec()
            };
            let mut response =
                ([(CONTENT_TYPE, mime.as_ref()), (CACHE_CONTROL, cache)], body).into_response();
            if path == "index.html" {
                // WS-6a: referrer policy on the SPA index.html response.
                response.headers_mut().insert(
                    axum::http::header::REFERRER_POLICY,
                    "no-referrer".parse().unwrap(),
                );
            }
            response
        }
        None => {
            // API paths that reach the static fallback are genuinely missing
            // routes. Return 404 JSON so the frontend's optional-endpoint
            // guards (isEndpointUnsupported) can degrade gracefully instead
            // of crashing on HTML.
            if path == "api" || path.starts_with("api/") {
                return (
                    StatusCode::NOT_FOUND,
                    [(CONTENT_TYPE, "application/json")],
                    axum::Json(serde_json::json!({ "error": "not_found" })),
                )
                    .into_response();
            }
            // SPA fallback — deep links (e.g. /channels/x) get the SAME
            // composed shell as "/", so branding never flickers on
            // non-root navigations.
            (
                [(CONTENT_TYPE, "text/html"), (CACHE_CONTROL, "no-cache")],
                composed_index_html(&state).await,
            )
                .into_response()
        }
    }
}

/// Build the full application router. Extracted from `main()` so tests can
/// reach the fallback (`serve_static`).
pub fn build_app_router(state: Arc<AppState>) -> Router {
    let max_body_bytes = state.config.max_body_size.unwrap_or(50 * 1024 * 1024 * 1024);

    // Rate limiting (configurable via env, default: 10 req/s, burst 20)
    let rate_limit_rps = std::env::var("WABI_RATE_LIMIT_RPS")
        .ok()
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(10);
    let rate_limit_burst = std::env::var("WABI_RATE_LIMIT_BURST")
        .ok()
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(20);
    let rate_limit_state =
        crate::rate_limit::RateLimitState::new(rate_limit_rps, rate_limit_burst);

    Router::new()
        // Health checks (no rate limit)
        .route("/health", get(health_check))
        // Liveness probe — process is up
        .route("/livez", get(liveness_check))
        // Readiness probe — engine is answering
        .route("/readyz", get(readiness_check))
        // Prometheus metrics (public if WABI_METRICS_PUBLIC=true)
        .route("/metrics", get(metrics_handler))
        // API routes — timeout + metrics scoped to /api so uploads and
        // static SPA fallback are NOT cut by the timeout.
        .nest(
            "/api",
            crate::api::routes::create_api_router(state.clone())
                .layer(axum::middleware::from_fn(metrics_middleware))
                .layer(TimeoutLayer::new(Duration::from_secs(
                    std::env::var("WABI_HTTP_TIMEOUT_SECS")
                        .ok()
                        .and_then(|s| s.parse::<u64>().ok())
                        .unwrap_or(30),
                ))),
        )
        // WebSocket endpoint (plain WS, kept for future use)
        .nest("/ws", crate::websocket::ws_router(state.clone()))
        // Uploaded media files
        .route("/uploads/{filename}", get(serve_upload))
        // Static assets (SPA fallback)
        .fallback(serve_static)
        // Middleware
        .layer(axum::middleware::from_fn_with_state(
            rate_limit_state,
            crate::rate_limit::rate_limit_middleware,
        ))
        // Socket.IO layer (must be added before the router is finalised)
        .layer(crate::socketio::create_socket_layer(state.clone()))
        .layer(build_cors_layer())
        // Compress JS/CSS/JSON/SVG responses (br preferred, gzip fallback).
        // The SPA bundle ships multi-MB chunks; this cuts them ~4-5x on the wire.
        .layer(CompressionLayer::new())
        .layer(TraceLayer::new_for_http())
        .layer(DefaultBodyLimit::max(max_body_bytes))
        .with_state(state)
}
