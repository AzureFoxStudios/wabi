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
mod app_router;
mod auth_extractor;
mod blacklist;
mod blobs;
mod bot_delivery;
mod bot_registry;
mod config;
mod error;
mod helper_api;
mod helper_client;
mod jobs;
mod lan;
mod mdns;
mod media;
mod mesh;
mod metrics;
#[cfg(feature = "wabi-lore")]
mod lore;
mod nodes;
mod rate_limit;
mod replication_transport;
mod secrets;
mod socketio;
mod socketio_impl;
mod standby;
mod state;
mod upload_registry;
mod websocket;
use crate::blacklist::BlacklistManager;
use crate::nodes::NodeCapability;
use crate::state::AppState;
use clap::Parser;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::signal;
use tracing::info;
use wabidb::engine::wabi_store::WabiStore;

use crate::config::{ServerConfig, ServerRole};
use crate::secrets::resolve_jwt_secret;

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
/// Run with `WABI_PURGE_ORPHANS=1 wabi-server --data-dir ./data`.
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


#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Initialize logging
    // Default: info level, file appender with daily rotation (max 7 days)
    let log_rotation_days: usize = std::env::var("WABI_LOG_RETENTION_DAYS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(7);
    let log_dir = std::env::var("WABI_LOG_DIR").unwrap_or_else(|_| "./logs".to_string());
    let _ = std::fs::create_dir_all(&log_dir);
    let file_appender = tracing_appender::rolling::daily(&log_dir, "wabi-server.log");
    let (non_blocking, _guard) = tracing_appender::non_blocking(file_appender);
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("wabi_server=info".parse()?)
                .add_directive("tower_http=debug".parse()?),
        )
        .with_writer(non_blocking)
        .with_ansi(false)
        .with_target(false)
        .compact()
        .init();
    // Spawn a background task to prune rotated log files older than log_rotation_days
    let log_dir_clone = log_dir.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(86_400));
        loop {
            interval.tick().await;
            if let Ok(entries) = std::fs::read_dir(&log_dir_clone) {
                let cutoff = std::time::SystemTime::now()
                    .checked_sub(std::time::Duration::from_secs(
                        (log_rotation_days as u64).saturating_mul(86_400),
                    ))
                    .unwrap_or(std::time::SystemTime::now());
                for entry in entries.flatten() {
                    if let Ok(md) = entry.metadata() {
                        if md.is_file() && md.modified().map(|m| m <= cutoff).unwrap_or(false) {
                            let _ = std::fs::remove_file(entry.path());
                        }
                    }
                }
            }
        }
    });

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

    // Auto-register the Hermes service bot on startup so cron jobs and
    // outbound deliveries can emit messages as this bot account.
    let hermes_state = state.clone();
    tokio::spawn(async move {
        match crate::api::bots::ensure_hermes_bot(&hermes_state).await {
            Ok(id) => tracing::info!("[bot:hermes] ready: {}", id),
            Err(e) => tracing::warn!("[bot:hermes] registration failed: {e}"),
        }
    });

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

    // Live room ephemeral reaper: evicts expired messages by TTL and enforces
    // the message cap for all live (session-only) channels every 5 seconds.
    {
        let state = state.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(5));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                interval.tick().await;
                let Some(io) = state.sio.read().await.clone() else {
                    tracing::warn!("[live-reaper] SocketIo handle not available, skipping tick");
                    continue;
                };

                // Snapshot the live channel set under the label lock.
                let live_channels: Vec<String> = {
                    let labels = state.channel_auto_delete_label.read().await;
                    labels
                        .iter()
                        .filter(|(_, v)| v.as_str() == "live")
                        .map(|(k, _)| k.clone())
                        .collect()
                };

                for channel in &live_channels {
                    // Resolve per-channel TTL and cap.
                    let ttl = state
                        .live_channel_ttl_ms
                        .read()
                        .await
                        .get(channel)
                        .copied()
                        .unwrap_or(10 * 60 * 1000);
                    let cap = state
                        .live_channel_cap
                        .read()
                        .await
                        .get(channel)
                        .copied()
                        .unwrap_or(1000);
                    let now = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_millis() as i64)
                        .unwrap_or(0);

                    // Collect expired ids under a write lock, then drop lock and emit.
                    let expired_ids: Vec<String> = {
                        let mut session = state.session_messages.write().await;
                        let msgs = match session.get_mut(channel) {
                            Some(msgs) => msgs,
                            None => continue,
                        };
                        crate::state::reap_live_channel_buffer(msgs, ttl, cap, now)
                    };

                    // Emit message-deleted for each expired id (outside the lock).
                    for id in &expired_ids {
                        let payload = serde_json::json!({"channelId": channel, "messageId": id});
                        let _ = io.to(channel.clone()).emit("message-deleted", &payload).await;
                    }

                    if !expired_ids.is_empty() {
                        tracing::debug!("[live-reaper] channel {} evicted {} messages", channel, expired_ids.len());
                    }
                }
            }
        });
    }

    // Load blacklist
    // Durable retention sweep: detached per-message timers cannot survive a
    // restart, so periodically reconcile persisted messages against each
    // channel's retention policy as well.
    {
        let state = state.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(60));
            loop {
                interval.tick().await;
                let channels = match state.wdb.list_channels(None).await {
                    Ok(channels) => channels,
                    Err(error) => {
                        tracing::warn!("[retention-reaper] failed to list channels: {error}");
                        continue;
                    }
                };
                let now_micros = chrono::Utc::now().timestamp_micros();
                for channel in channels {
                    // Effective TTL = min(in-memory map TTL, WDB policy, product
                    // default). The in-memory channel_auto_delete_ms map carries
                    // sub-day presets (5s..24h) that per-message timers used to
                    // enforce; the sweep must honor them too or short-TTL
                    // channels would silently become 24h. (perf audit #5)
                    let map_ttl_ms = state
                        .channel_auto_delete_ms
                        .read()
                        .await
                        .get(&channel.channel_id)
                        .copied()
                        .filter(|ms| *ms > 0);
                    let db_ttl_ms: Option<i64> =
                        match state.wdb.get_channel_retention(&channel.channel_id).await {
                            Ok(Some(policy)) if policy.days > 0 => {
                                Some(policy.days as i64 * 86_400_000_000)
                            }
                            Ok(Some(_)) => None, // days == 0: explicit keep-forever
                            Ok(None) => Some(86_400_000_000),
                            Err(error) => {
                                tracing::warn!(channel = %channel.channel_id, "[retention-reaper] policy lookup failed: {error}");
                                continue;
                            }
                        };
                    let effective_ms = match (map_ttl_ms, db_ttl_ms) {
                        (None, None) => continue,
                        (Some(a), None) => a as i64 * 1_000_000,
                        (None, Some(b)) => b,
                        (Some(a), Some(b)) => (a as i64 * 1_000_000).min(b),
                    };
                    let cutoff = now_micros.saturating_sub(effective_ms);
                    let messages = match state.wdb.list_messages_typed(&channel.channel_id, 1000).await {
                        Ok(messages) => messages,
                        Err(error) => {
                            tracing::warn!(channel = %channel.channel_id, "[retention-reaper] message lookup failed: {error}");
                            continue;
                        }
                    };
                    for message in messages.into_iter().filter(|message| message.created_at_micros <= cutoff) {
                        if state.wdb.delete_message(&message.message_id, 0).await.is_err() {
                            continue;
                        }
                        state.session_messages.write().await.entry(channel.channel_id.clone()).or_default().retain(|item| item.get("id").and_then(|value| value.as_str()) != Some(message.message_id.as_str()));
                        if let Some(io) = state.sio.read().await.clone() {
                            let _ = io.to(channel.channel_id.clone()).emit("message-deleted", &serde_json::json!({"channelId": channel.channel_id, "messageId": message.message_id})).await;
                        }
                    }
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

    // Initialize the Tailcat private-access transport: load persisted
    // settings and auto-respawn the listener if it was enabled before a
    // restart. Disabled (the default) = no subprocess, zero footprint.
    state.tailcat.init().await;

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
                    service
                        .load_existing_repos(
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
                        )
                        .await;
                    tracing::info!("[lore] Rehydrated {} Lore repo(s) from WDB", count);
                }
            }
            let lore_service = Arc::new(service);
            state.set_lore_service(lore_service).await;
            tracing::info!("[lore] Lore addon initialized");
        }
    }

    // Spawn the subscription bridge: engine → Socket.IO push delivery.
    // Reads from the engine's delivery broadcast and emits matching events
    // to the appropriate Socket.IO rooms.
    {
        let state_clone = state.clone();
        let delivery_rx = state.wdb.engine().delivery_receiver();
        tokio::spawn(async move {
            // Wait for the SocketIo instance to be available.
            let io = loop {
                if let Some(io) = state_clone.sio.read().await.clone() {
                    break io;
                }
                tracing::warn!("subscription bridge: SocketIo handle not available, retrying in 1s");
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
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

    // Build the full application router. Extracted into app_router.rs so
    // integration tests can exercise the static SPA fallback (it lives on
    // this router, not inside create_api_router). The Socket.IO layer is
    // created there too — it must be added before the router is finalised.
    let app = crate::app_router::build_app_router(state.clone());

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
