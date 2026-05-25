//! Wabi Server - Self-Hosted Server with API
//!
//! Single binary that serves:
//! - Embedded frontend static files
//! - HTTP API routes (auth, channels, messages, user)
//! - Health check endpoints
//! - WebSocket real-time communication

mod api;
mod blacklist;
mod config;
mod db;
mod error;
mod nodes;
mod socketio;
mod state;
mod websocket;

use crate::blacklist::BlacklistManager;
use crate::state::AppState;
use axum::{
    extract::DefaultBodyLimit,
    http::{header::CONTENT_TYPE, StatusCode},
    response::IntoResponse,
    routing::get,
    Json, Router,
};
use clap::Parser;
use rust_embed::RustEmbed;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::net::TcpListener;
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;
use tracing::info;

use crate::api::routes::create_api_router;
use crate::config::ServerConfig;

/// Serve a file from the uploads directory
async fn serve_upload(
    axum::extract::Path(filename): axum::extract::Path<String>,
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
) -> impl axum::response::IntoResponse {
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

    match tokio::fs::read(&file_path).await {
        Ok(data) => {
            let mime = mime_guess::from_path(&file_path).first_or_octet_stream();
            tracing::debug!(
                "Serving upload: {:?} ({} bytes, {})",
                file_path,
                data.len(),
                mime
            );
            ([(axum::http::header::CONTENT_TYPE, mime.as_ref())], data).into_response()
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

/// Wabi Node CLI arguments
#[derive(Parser, Debug)]
#[command(author, version, about = "Wabi self-hosted server")]
struct Args {
    /// Server port
    #[arg(short, long, default_value = "3000")]
    port: u16,

    /// Server host
    #[arg(long, default_value = "0.0.0.0")]
    host: String,

    /// Data directory
    #[arg(long, default_value = "./data")]
    data_dir: String,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Initialize logging
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("wabi_server=info".parse()?)
                .add_directive("tower_http=debug".parse()?),
        )
        .init();

    let args = Args::parse();

    info!("🚀 Wabi Node v{}", env!("CARGO_PKG_VERSION"));

    // Compute uploads_dir and blacklist_file before data_dir is consumed
    let uploads_dir =
        std::env::var("UPLOADS_DIR").unwrap_or_else(|_| format!("{}/uploads", args.data_dir));
    let blacklist_file = std::env::var("WABI_BLACKLIST_FILE")
        .unwrap_or_else(|_| format!("{}/blacklist.txt", args.data_dir));

    let config = ServerConfig {
        host: args.host,
        port: args.port,
        data_dir: args.data_dir,
        uploads_dir,
        jwt_secret: std::env::var("JWT_SECRET")
            .unwrap_or_else(|_| "dev-secret-change-in-production".to_string()),
        turn_enabled: false,
        turn_uri: None,
        turn_secret: None,
        stdb_uri: std::env::var("WABI_STDB_SERVER")
            .unwrap_or_else(|_| "http://localhost:3100".to_string()),
        stdb_database: std::env::var("WABI_STDB_DATABASE")
            .unwrap_or_else(|_| "wabi-state-benchmark-v2".to_string()),
        node_id: "node-1".to_string(),
        is_primary: true,
        mesh_enabled: false,
        mesh_peers: vec![],
        admin_user_ids: std::env::var("WABI_ADMIN_USER_IDS")
            .unwrap_or_default()
            .split(',')
            .filter_map(|s| s.trim().parse::<i64>().ok())
            .collect(),
        blacklist_file,
    };

    // Ensure data directory exists
    std::fs::create_dir_all(&config.data_dir)?;

    // Ensure uploads directory exists
    std::fs::create_dir_all(&config.uploads_dir)?;
    // Ensure temp directory for uploads exists
    std::fs::create_dir_all(format!("{}/.tmp", config.uploads_dir))?;

    info!("📡 Starting server on {}:{}", config.host, config.port);

    // Create application state
    let state = Arc::new(AppState::new(config.clone()));

    // Load blacklist
    let blacklist = BlacklistManager::new(config.blacklist_file.clone());
    if let Err(e) = blacklist.load_from_file().await {
        tracing::warn!("[blacklist] Failed to load: {}", e);
    }
    state.set_blacklist(blacklist).await;

    // Register ingest key with STDB (safe to call every boot)
    if let Err(e) = state.stdb.bootstrap_ingest_key().await {
        tracing::warn!(
            "[stdb] ingest key bootstrap failed: {:#} — ingest events may be rejected",
            e
        );
    }

    // Seed default channels on first boot
    if let Err(e) = state.stdb.seed_default_channels().await {
        tracing::warn!("[stdb] channel seed failed: {}", e);
    }

    // Build Socket.IO layer (must be added before the router is finalised)
    let sio_layer = socketio::create_socket_layer(state.clone());

    // Build CORS layer — mirror request origin so credentialed requests work.
    // Cannot combine allow_credentials(true) with wildcard headers — list them.
    let cors = CorsLayer::new()
        .allow_origin(tower_http::cors::AllowOrigin::mirror_request())
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
        .allow_credentials(true);

    // Build router
    let app = Router::new()
        // Health checks
        .route("/health", get(health_check))
        // API routes (must come before static files)
        .nest("/api", create_api_router(state.clone()))
        // WebSocket endpoint (plain WS, kept for future use)
        .nest("/ws", websocket::ws_router(state.clone()))
        // Uploaded media files
        .route("/uploads/{filename}", get(serve_upload))
        // Static assets (SPA fallback)
        .fallback(serve_static)
        // Middleware
        .layer(sio_layer)
        .layer(cors)
        .layer(TraceLayer::new_for_http())
        .layer(DefaultBodyLimit::max(50 * 1024 * 1024))
        .with_state(state);

    // Bind and serve
    let addr = SocketAddr::from(([0, 0, 0, 0], config.port));
    let listener = TcpListener::bind(addr).await?;

    info!("✅ Server ready");
    info!("🌐 Frontend: http://localhost:{}", config.port);
    info!("🔌 API: http://localhost:{}/api", config.port);

    axum::serve(listener, app).await?;

    Ok(())
}

/// Health check endpoint
async fn health_check() -> impl IntoResponse {
    Json(serde_json::json!({
        "status": "ok",
        "service": "wabi-server",
        "version": env!("CARGO_PKG_VERSION"),
        "timestamp": chrono::Utc::now().to_rfc3339()
    }))
}

/// Serve static assets with SPA fallback
async fn serve_static(uri: axum::extract::OriginalUri) -> impl IntoResponse {
    let path = uri.0.path().trim_start_matches('/');
    let path = if path.is_empty() || path == "/" {
        "index.html"
    } else {
        path
    };

    match StaticAssets::get(path) {
        Some(content) => {
            let mime = mime_guess::from_path(path).first_or_octet_stream();
            ([(CONTENT_TYPE, mime.as_ref())], content.data).into_response()
        }
        None => {
            // SPA fallback
            match StaticAssets::get("index.html") {
                Some(content) => ([(CONTENT_TYPE, "text/html")], content.data).into_response(),
                None => StatusCode::NOT_FOUND.into_response(),
            }
        }
    }
}
