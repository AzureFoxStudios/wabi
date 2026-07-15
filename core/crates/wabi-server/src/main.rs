//! Wabi Server - Self-Hosted Server with API
//!
//! Single binary that serves:
//! - Embedded frontend static files
//! - HTTP API routes (auth, channels, messages, user)
//! - Health check endpoints
//! - WebSocket real-time communication

mod adapter;
mod anchor;
mod api;
mod auth_extractor;
mod blacklist;
mod blobs;
mod config;
mod error;
mod helper_api;
mod helper_client;
mod jobs;
mod lan;
mod mdns;
mod media;
mod mesh;
#[cfg(feature = "wabi-lore")]
mod lore;
mod nodes;
mod rate_limit;
mod replication_transport;
mod socketio;
mod socketio_impl;
mod standby;
mod state;
mod websocket;
use crate::blacklist::BlacklistManager;
use crate::nodes::NodeCapability;
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
use wabidb::engine::wabi_store::WabiStore;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::signal;
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;
use tracing::info;

use crate::api::routes::create_api_router;
use crate::config::{ServerConfig, ServerRole};

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

    /// Run this binary as a helper node instead of a primary server
    #[arg(long)]
    helper_mode: bool,

    /// URL of the primary Wabi server when running as helper
    #[arg(long)]
    primary_url: Option<String>,

    /// Pairing token to use when joining as a helper
    #[arg(long)]
    pairing_token: Option<String>,

    /// When in helper mode, optionally advertise a LAN-reachable bind address
    /// (e.g. 192.168.1.42:9999) so the authority can issue signed route tokens
    /// pointing LAN clients to this helper directly.
    #[arg(long, value_name = "HOST:PORT")]
    lan_reachable_at: Option<String>,
}

/// Maintenance: delete messages whose author has no corresponding user
/// record. These "ghost" messages render as `Unknown user` / `1` because the
/// author id (e.g. an early/test account) was never persisted as a profile.
/// Run with `WABI_PURGE_ORPHANS=1 WABIDB_ROOT_KEY=... wabi-server --data-dir ./data`.
async fn purge_orphaned_messages(data_dir: &str) -> anyhow::Result<()> {
    use crate::adapter::WdbAdapter;
    use wabidb::engine::wabi_store::WabiStore;

    info!("purge-orphans: opening store at {}", data_dir);
    let adapter = WdbAdapter::open(std::path::Path::new(data_dir)).await?;
    let channels = adapter.list_channels(None).await?;
    info!("purge-orphans: channels found = {}", channels.len());
    for ch in &channels {
        info!("purge-orphans: channel_id={} name={:?}", ch.channel_id, ch.name);
    }
    let all = adapter.list_all_messages_typed().await?;
    info!("purge-orphans: total messages in projection = {}", all.len());
    let users = adapter.list_users().await?;
    info!("purge-orphans: total users = {}", users.len());
    for u in &users {
        info!(
            "purge-orphans: USER id={} username={:?}",
            u.user_id, u.username
        );
    }
    for m in &all {
        let author = adapter.get_user(m.author_user_id).await.ok().flatten();
        info!(
            "purge-orphans: ALL msg={} channel_id={} author_user_id={} has_author={} content={:?}",
            m.message_id, m.channel_id, m.author_user_id, author.is_some(),
            m.content.chars().take(20).collect::<String>()
        );
    }
    let mut purged = 0usize;
    for ch in channels {
        let msgs = adapter.list_messages_typed(&ch.channel_id, 100_000).await?;
        for m in msgs {
            let author = adapter.get_user(m.author_user_id).await.ok().flatten();
            let username = author.as_ref().map(|u| u.username.clone()).unwrap_or_default();
            info!(
                "purge-orphans: chan={} msg={} author_user_id={} has_author={} username={:?}",
                ch.channel_id, m.message_id, m.author_user_id, author.is_some(), username
            );
            let has_author = author.is_some();
            if !has_author {
                info!(
                    "purge-orphans: deleting {} (author {}) in {}",
                    m.message_id, m.author_user_id, ch.channel_id
                );
                adapter.delete_message(&m.message_id, 75).await?;
                purged += 1;
            }
        }
    }
    info!("purge-orphans: done, purged {} message(s)", purged);
    Ok(())
}

/// Resolve the JWT signing secret.
///
/// Priority: `JWT_SECRET` env var > persisted `<data_dir>/jwt_secret` >
/// freshly generated + persisted. We never fall back to a hardcoded weak
/// default, because a known secret lets anyone forge tokens for any user
/// (including the owner).
fn resolve_jwt_secret(data_dir: &str) -> String {
    const WEAK: &str = "dev-secret-change-in-production";
    if let Ok(env) = std::env::var("JWT_SECRET") {
        if !env.is_empty() && env != WEAK {
            return env;
        }
        if env == WEAK {
            tracing::warn!("[security] JWT_SECRET is set to the weak built-in default; set a strong secret");
            return env;
        }
    }
    let path = std::path::PathBuf::from(data_dir).join("jwt_secret");
    if let Ok(s) = std::fs::read_to_string(&path) {
        let t = s.trim().to_string();
        if !t.is_empty() {
            return t;
        }
    }
    let secret = format!("{}{}", uuid::Uuid::new_v4(), uuid::Uuid::new_v4());
    if let Err(e) = std::fs::write(&path, &secret) {
        tracing::warn!("[security] failed to persist jwt_secret: {e}");
    } else {
        tracing::info!("[security] generated and persisted a new jwt_secret to {path:?}");
    }
    secret
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

    // One-shot maintenance mode: purge messages whose author no longer
    // exists as a user (orphaned/ghost messages). Triggered via the
    // WABI_PURGE_ORPHANS env var so it doesn't disturb clap arg parsing.
    if std::env::var("WABI_PURGE_ORPHANS").is_ok() {
        let data_dir = std::env::var("WABI_PURGE_DATA_DIR").unwrap_or_else(|_| "./data".to_string());
        return purge_orphaned_messages(&data_dir).await;
    }

    let args = Args::parse();

    info!("🚀 Wabi Node v{}", env!("CARGO_PKG_VERSION"));

    // --- Helper mode: outbound worker, no listening socket ---
    if args.helper_mode {
        let Some(primary_url) = args.primary_url else {
            tracing::error!("--primary-url is required when using --helper-mode");
            std::process::exit(1);
        };
        let display_name = std::env::var("HOSTNAME")
            .unwrap_or_else(|_| format!("wabi-helper-{}", uuid::Uuid::new_v4().simple()));
        let jwt_secret = resolve_jwt_secret(&args.data_dir);
        helper_client::run_helper(
            primary_url,
            args.pairing_token,
            display_name,
            vec![
                NodeCapability::CpuWorker,
                NodeCapability::ThumbnailWorker,
                NodeCapability::TranscodeWorker,
                NodeCapability::SearchIndexer,
                NodeCapability::MediaRelay,
            ],
            args.data_dir,
            args.lan_reachable_at,
            Some(jwt_secret),
        )
        .await;
        return Ok(());
    }

    // Compute uploads_dir and blacklist_file before data_dir is consumed
    let uploads_dir =
        std::env::var("UPLOADS_DIR").unwrap_or_else(|_| format!("{}/uploads", args.data_dir));
    let blacklist_file = std::env::var("WABI_BLACKLIST_FILE")
        .unwrap_or_else(|_| format!("{}/blacklist.txt", args.data_dir));
    let server_role = ServerRole::from_env();
    let authority_url = std::env::var("WABI_AUTHORITY_URL").ok();

    let jwt_secret = resolve_jwt_secret(&args.data_dir);

    let config = ServerConfig {
        host: args.host,
        port: args.port,
        data_dir: args.data_dir,
        uploads_dir,
        jwt_secret: jwt_secret,
        turn_enabled: false,
        turn_uri: None,
        turn_secret: None,
        node_id: "node-1".to_string(),
        is_primary: true,
        mesh_enabled: std::env::var("WABI_MESH_ENABLED")
            .ok()
            .and_then(|s| s.parse::<bool>().ok())
            .unwrap_or(false),
        mesh_peers: std::env::var("WABI_MESH_PEERS")
            .unwrap_or_default()
            .split(',')
            .filter_map(|s| {
                let s = s.trim();
                if s.is_empty() { None } else { Some(s.to_string()) }
            })
            .collect(),
        server_role: server_role.clone(),
        authority_url: authority_url.clone(),
        admin_user_ids: std::env::var("WABI_ADMIN_USER_IDS")
            .unwrap_or_default()
            .split(',')
            .filter_map(|s| s.trim().parse::<i64>().ok())
            .collect(),
        blacklist_file,
        max_body_size: std::env::var("WABI_MAX_BODY_SIZE")
            .ok()
            .and_then(|s| s.parse::<usize>().ok()),
        lore: crate::config::LoreAddonConfig {
            enabled: std::env::var("WABI_LORE_ENABLED")
                .ok()
                .and_then(|s| s.parse::<bool>().ok())
                .unwrap_or(false),
            mode: std::env::var("WABI_LORE_MODE")
                .unwrap_or_else(|_| "sidecar".into()),
            server_url: std::env::var("WABI_LORE_SERVER_URL")
                .unwrap_or_else(|_| "lore://localhost:10000".into()),
            binary_path: std::env::var("WABI_LORE_BINARY_PATH")
                .unwrap_or_else(|_| "lore".into()),
            data_dir: std::env::var("WABI_LORE_DATA_DIR")
                .unwrap_or_else(|_| "/var/wabi/lore".into()),
            default_blob_max_size_mb: std::env::var("WABI_LORE_MAX_BLOB_MB")
                .ok()
                .and_then(|s| s.parse::<u32>().ok())
                .unwrap_or(1024),
            auto_create_repos: std::env::var("WABI_LORE_AUTO_CREATE")
                .ok()
                .and_then(|s| s.parse::<bool>().ok())
                .unwrap_or(true),
            recordings_channel_name: std::env::var("WABI_LORE_RECORDINGS_CHANNEL")
                .ok()
                .filter(|s| !s.is_empty()),
        },
    };

    // Ensure data directory exists
    std::fs::create_dir_all(&config.data_dir)?;

    // Ensure uploads directory exists
    std::fs::create_dir_all(&config.uploads_dir)?;
    // Ensure temp directory for uploads exists
    std::fs::create_dir_all(format!("{}/.tmp", config.uploads_dir))?;

    info!("📡 Starting server on {}:{}", config.host, config.port);

    // Initialize mesh service if enabled
    let mesh_service = if config.mesh_enabled {
        let mesh_config = crate::mesh::MeshConfig {
            node_id: config.node_id.clone(),
            is_primary: config.is_primary,
            mesh_enabled: config.mesh_enabled,
            mesh_peers: config.mesh_peers.clone(),
        };
        match crate::mesh::MeshService::new(mesh_config, config.mesh_peers.clone()).await {
            Ok(service) => Some(service),
            Err(e) => {
                tracing::warn!("[mesh] Failed to initialize mesh service: {}", e);
                None
            }
        }
    } else {
        None
    };

    // Create application state
    let state = Arc::new(AppState::new(config.clone()).await?);

    // Set mesh service in application state if initialized
    if let Some(mesh) = mesh_service {
        state.set_mesh_service(Arc::new(mesh)).await;
    }

    // Stale heartbeat detector: marks helpers offline if >120s since last heartbeat
    {
        let state = state.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(60));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                interval.tick().await;
                let offline = state
                    .node_registry
                    .mark_stale_nodes_offline(std::time::Duration::from_secs(120))
                    .await;
                for node in offline {
                    tracing::info!("[stale-detector] node {} marked offline", node.node_id);
                }
            }
        });
    }

    // Stale job reaper: requeue jobs claimed by offline/helpers that vanished
    {
        let state = state.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(300));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                interval.tick().await;
                let reaped = state
                    .job_queue
                    .reap_stale_jobs(&state.node_registry, std::time::Duration::from_secs(600))
                    .await;
                for job in reaped {
                    tracing::info!(
                        "[stale-job-reaper] job {} requeued (node vanished)",
                        job.job_id
                    );
                }
            }
        });
    }

    // Load blacklist
    let blacklist = BlacklistManager::new(config.blacklist_file.clone());
    if let Err(e) = blacklist.load_from_file().await {
        tracing::warn!("[blacklist] Failed to load: {}", e);
    }
    state.set_blacklist(blacklist).await;

    // Spawn the periodic cleanup task for expired blacklist entries.
    // WABI_AUDIT_REPORT.md #6 + WABI_BAN_SYSTEM_MEMORY_FIX.md.
    // JoinHandle is dropped — the task runs until process exit. Future
    // work: store in AppState for graceful shutdown.
    let blacklist_arc = state.blacklist.read().await.clone();
    if let Some(mgr) = blacklist_arc {
        let _blacklist_cleanup_handle = crate::blacklist::spawn_blacklist_cleanup_loop(mgr);
    }

    // WDB had a one-time "register the ingest key with the database"
    // call. WDB has no equivalent. The block was removed in the WDB
    // migration; ingest is handled by WdbAdapter::bootstrap_ingest_key
    // (a no-op stub for compat) and the WDB command pipeline.

    // WDB had a one-time "seed default channels" call. WDB creates
    // channels on demand via the create_channel endpoint. Block removed.

    // Initialize Lore addon service if enabled
    #[cfg(feature = "wabi-lore")]
    if config.lore.enabled {
        let lore_config = crate::lore::LoreConfig {
            enabled: true,
            mode: match config.lore.mode.as_str() {
                "embedded" => crate::lore::LoreMode::Embedded,
                "remote" => crate::lore::LoreMode::Remote,
                _ => crate::lore::LoreMode::Sidecar,
            },
            lore_server_url: config.lore.server_url.clone(),
            lore_binary_path: std::path::PathBuf::from(&config.lore.binary_path),
            lore_data_dir: std::path::PathBuf::from(&config.lore.data_dir),
            default_blob_max_size_mb: config.lore.default_blob_max_size_mb,
            recordings_channel_name: config
                .lore
                .recordings_channel_name
                .clone()
                .unwrap_or_else(|| "Recordings".into()),
        };
        let service = crate::lore::LoreService::new(lore_config);
        if let Err(e) = service.health_check().await {
            tracing::warn!("[lore] Health check failed: {} — Lore addon disabled", e);
        } else {
            // Rehydrate the in-memory repo index from durable WDB records so
            // Lore survives a restart (the index is not persisted on its own).
            if let Ok(records) = state.wdb.list_lore_repos().await {
                if !records.is_empty() {
                    let count = records.len();
                    service.load_existing_repos(
                        records
                            .into_iter()
                            .map(|r| crate::lore::LoreRepoSeed {
                                channel_id: r.channel_id,
                                repo_name: r.repo_name,
                                lore_server_url: r.lore_server_url,
                                created_by: r.created_by,
                                created_at_micros: r.created_at_micros,
                            })
                            .collect(),
                    );
                    tracing::info!("[lore] Rehydrated {} Lore repo(s) from WDB", count);
                }
            }
            let lore_service = Arc::new(service);
            state.set_lore_service(lore_service).await;
            tracing::info!("[lore] Lore addon initialized");
        }
    }

    // Build Socket.IO layer (must be added before the router is finalised)
    let sio_layer = socketio::create_socket_layer(state.clone());

    // Spawn the subscription bridge: engine → Socket.IO push delivery.
    // Waits for the SocketIo instance (sent to sio_broadcast_tx during
    // layer creation), then reads from the engine's delivery broadcast
    // and emits matching events to the appropriate Socket.IO rooms.
    {
        let mut sio_rx = state.sio_broadcast_tx.subscribe();
        let delivery_rx = state.wdb.engine().delivery_receiver();
        tokio::spawn(async move {
            // Wait for the SocketIo instance to arrive on the broadcast.
            let io = match sio_rx.recv().await {
                Ok(io) => io,
                Err(_) => {
                    tracing::error!("subscription bridge: failed to receive SocketIo instance");
                    return;
                }
            };
            let mut delivery_rx = delivery_rx;
            while let Ok(delivery) = delivery_rx.recv().await {
                let stream_id = &delivery.stream_id;
                let event_type = &delivery.event_type;
                // Deserialize payload as JSON and emit to the stream's room.
                let payload: serde_json::Value = match serde_json::from_slice(&delivery.payload) {
                    Ok(v) => v,
                    Err(_) => {
                        tracing::debug!(
                            "subscription bridge: non-JSON payload for {} (event_type={}), skipping",
                            stream_id,
                            event_type,
                        );
                        continue;
                    }
                };
                let event_data = serde_json::json!({
                    "type": event_type,
                    "streamId": stream_id,
                    "commitSeq": delivery.commit_seq,
                    "payload": payload,
                });
                let _ = io.to(delivery.stream_id).emit(event_type, &event_data);
                // Also emit to the specific consumer for targeted delivery.
                let _ = io.to(delivery.consumer_id).emit(event_type, &event_data);
            }
        });
    }

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

    let max_body_bytes = config.max_body_size.unwrap_or(50 * 1024 * 1024 * 1024);

    // Rate limiting (configurable via env, default: 10 req/s, burst 20)
    let rate_limit_rps = std::env::var("WABI_RATE_LIMIT_RPS")
        .ok()
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(10);
    let rate_limit_burst = std::env::var("WABI_RATE_LIMIT_BURST")
        .ok()
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(20);
    let rate_limit_state = rate_limit::RateLimitState::new(rate_limit_rps, rate_limit_burst);

    // Build router
    let app = Router::new()
        // Health checks (no rate limit)
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
        .layer(axum::middleware::from_fn_with_state(
            rate_limit_state,
            rate_limit::rate_limit_middleware,
        ))
        .layer(sio_layer)
        .layer(cors)
        .layer(TraceLayer::new_for_http())
        .layer(DefaultBodyLimit::max(max_body_bytes))
        .with_state(state);

    // Bind and serve
    let addr = SocketAddr::from(([0, 0, 0, 0, 0, 0, 0, 0], config.port));
    let listener = TcpListener::bind(addr).await?;

    info!("✅ Server ready");
    info!("🌐 Frontend: http://localhost:{}", config.port);
    info!("🔌 API: http://localhost:{}/api", config.port);
    info!("🔧 Operator break-glass available on loopback (set WABI_OPERATOR_SECRET)");

    // Graceful shutdown signal
    let shutdown_signal = async {
        let ctrl_c = async {
            signal::ctrl_c()
                .await
                .expect("failed to install Ctrl+C handler");
        };

        #[cfg(unix)]
        let terminate = async {
            signal::unix::signal(signal::unix::SignalKind::terminate())
                .expect("failed to install SIGTERM handler")
                .recv()
                .await;
        };

        #[cfg(not(unix))]
        let terminate = std::future::pending::<()>();

        tokio::select! {
            _ = ctrl_c => {
                info!("Received Ctrl+C, starting graceful shutdown...");
            }
            _ = terminate => {
                info!("Received SIGTERM, starting graceful shutdown...");
            }
        }
    };

    axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
        .with_graceful_shutdown(shutdown_signal)
        .await?;

    info!("Server shut down gracefully");
    Ok(())
}

/// Health check endpoint
async fn health_check() -> impl IntoResponse {
    Json(serde_json::json!({
        "status": "ok",
        "service": "wabi-server",
        "role": "authority",
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
