//! Application state shared across handlers

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::{broadcast, Mutex, RwLock};

use crate::adapter::WdbAdapter;
use crate::api::upload::UploadState;
use crate::blacklist::BlacklistManager;
use crate::blobs::BlobRegistry;
use crate::bot_registry::BotRegistry;
use crate::community_roster::CommunityRosterStore;
use crate::config::ServerConfig;
use crate::jobs::JobQueue;
use crate::lore_roles::LoreRoleStore;
use crate::nodes::NodeRegistry;
use crate::replication_transport::ReqwestTransport;
use crate::upload_registry::UploadRegistry;
use wabidb::engine::wabi_store::WabiStore;
use wabidb::retention::tombstone::TombstoneTable;

pub(crate) fn ensure_authority_not_fenced(data_dir: &str) -> anyhow::Result<()> {
    for (name, status) in [
        ("writer-fenced-v1", "writer-fenced"),
        ("activation-pending-v1", "activation-pending"),
        ("live-checkpoint-v1", "inactive live checkpoint"),
    ] {
        let marker = Path::new(data_dir).join("wabidb").join(name);
        match std::fs::symlink_metadata(&marker) {
            Ok(_) => anyhow::bail!(
                "Authority data directory is {status}; refusing to serve from {}",
                marker.display()
            ),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

/// In-memory message cache shared between Socket.IO and HTTP handlers.
/// channel_id → Vec of message JSON objects (capped at 1000 per channel).
pub type SessionMessages = Arc<RwLock<HashMap<String, Vec<serde_json::Value>>>>;

/// Composed (brand-injected) index.html, cached against the read policy value.
/// Phase 1 boot optimization: the server stamps its identity into the
/// SPA shell so first paint is branded with zero extra requests. In-memory
/// Rust state only — no persistence.
#[derive(Clone)]
pub struct ComposedIndexCache {
    pub policy: serde_json::Value,
    /// Whether the cached body carries an injected brand (fast-path key).
    pub has_custom_brand: bool,
    pub body: Vec<u8>,
}

/// Shared application state
pub struct AppState {
    pub config: ServerConfig,
    /// Monotonic server lifetime, including initialization; never starts on the
    /// first health/dashboard request. Runtime-only, not a persisted record.
    pub started_at: std::time::Instant,
    pub network_health: crate::api::network_health::Sampler,
    pub instance_operations: crate::instance_operations::InstanceOperations,
    pub boosters: crate::api::boosters::Boosters,
    /// WabiDB engine handle. The source of truth for all persistence.
    /// Concrete `WdbAdapter` (not the trait object) — `WabiStore` is not
    /// yet dyn-compatible (its async fns need a Send bound for `dyn Trait`).
    /// Can switch to `Arc<dyn WabiStore>` once the trait gets the fix.
    pub wdb: Arc<WdbAdapter>,
    /// Signed, owner-approved entry point list; an address is never identity.
    pub community_roster: CommunityRosterStore,
    #[allow(dead_code)]
    pub channels: RwLock<ChannelManager>,
    pub session_messages: SessionMessages,
    /// channel_id -> auto-delete duration in milliseconds (None/0 = off).
    /// In-memory for full preset support (5s..90d); also mirrored to WDB days when >= 1d.
    pub channel_auto_delete_ms: Arc<RwLock<HashMap<String, u64>>>,
    pub retention_policy_lock: tokio::sync::Mutex<()>,
    /// Channels with any sub-minute retention epoch. Hydrated before serving
    /// and updated with each policy change; the fast sweep never rereads the
    /// complete sidecar on every tick.
    pub fast_retention_channels: Arc<RwLock<HashSet<String>>>,
    /// channel_id -> frontend label (e.g. "5s", "24h") for channel-updated payloads
    pub channel_auto_delete_label: Arc<RwLock<HashMap<String, String>>>,
    /// Per-channel live room TTL in milliseconds. Default: 10 minutes.
    pub live_channel_ttl_ms: Arc<RwLock<HashMap<String, u64>>>,
    /// Per-channel live room message count cap. Default: 1000.
    pub live_channel_cap: Arc<RwLock<HashMap<String, u64>>>,
    // Tombstone table for retention — tracks soft-deleted messages pending compaction.
    pub tombstone_table: Arc<RwLock<TombstoneTable>>,
    pub owner_user_id: Arc<RwLock<Option<i64>>>,
    /// Serialises the fresh-server setup window (create user + claim
    /// ownership) so concurrent first registrations can't interleave:
    /// exactly one account is created before an owner exists.
    pub setup_claim_lock: tokio::sync::Mutex<()>,
    /// Private supervisor capability; never returned to browser clients or persisted.
    pub desktop_bootstrap_token: Option<String>,
    /// Orders legacy payment-policy import against either administrative save
    /// route. Runtime coordination only; WabiDB remains authoritative.
    pub payment_policy_lock: tokio::sync::Mutex<()>,
    /// Token revocation state. A stolen/compromised JWT can be killed
    /// without rotating the signing secret: individual `jti`s, entire
    /// users, or all tokens issued before an `epoch` can be revoked.
    /// Legacy import path; canonical mutations no longer write this sidecar.
    pub revocation_file: PathBuf,
    pub revocations: Arc<RwLock<RevocationStore>>,
    /// One-time recovery codes that let the owner regain access when locked
    /// out (e.g. password changed by an attacker). Maps code-hash -> owner id.
    /// Legacy import path; canonical issuance/consumption no longer write it.
    pub recovery_file: PathBuf,
    pub recovery_codes: Arc<RwLock<HashMap<String, i64>>>,
    /// Upload session state (in-memory, not persisted)
    pub upload_state: UploadState,
    /// Core helper-node registry (authority-owned; not federation)
    pub node_registry: NodeRegistry,
    /// Job queue for helper-node worker offload
    pub job_queue: JobQueue,
    /// Content-addressed blob registry
    pub blob_registry: BlobRegistry,
    /// Bot account registry (opaque-token lifecycle: create/rotate/disable)
    pub bot_registry: BotRegistry,
    /// Ownership registry for files under `/uploads/` (ops metadata, not authz)
    pub upload_registry: UploadRegistry,
    /// Media room routing registry (voice/video assignment to helper nodes)
    pub media_registry: crate::media::MediaRoomRegistry,
    /// Current Socket.IO handle for HTTP handlers that need to broadcast.
    pub sio: std::sync::RwLock<Option<socketioxide::SocketIo>>,
    /// Shared socket.io presence map (socket_id → ConnectedUser). Populated
    /// by `create_socket_layer` at startup; lets HTTP handlers (admin
    /// metrics) read online-socket counts without going through SioState.
    pub connected_users: crate::socketio::ConnectedUsers,
    /// Blacklist manager for bans
    pub blacklist: RwLock<Option<Arc<BlacklistManager>>>,
    /// One serialized Server Center policy/case store shared by HTTP and live sends.
    pub(crate) server_center: Arc<RwLock<crate::api::server_center::ServerCenterStore>>,
    /// Runtime add-on switches (in-app; see addon_switches.rs). Env vars win.
    pub addon_switches: RwLock<crate::addon_switches::AddonSwitches>,
    /// Lore addon service for version-controlled binary storage
    #[cfg(feature = "wabi-lore")]
    pub lore_service: RwLock<Option<Arc<crate::lore::LoreService>>>,
    /// Orders private-membership transitions against socket admission, snapshots
    /// and persisted call consent. Always acquire BEFORE call/voice/group locks.
    /// Socket dispatch owns read guards; group lifecycle commands own writers.
    /// Helpers called inside either boundary must not acquire it recursively.
    pub membership_gate: Arc<RwLock<()>>,
    /// Serialize each call's authorize/read/write/push boundary.
    pub call_session_locks: crate::call_access::SessionLocks,
    /// Channel that internal call-session handlers push (session_id, WsMessage) to.
    /// WebSocket connections subscribe and filter by their own session set.
    pub call_session_push: broadcast::Sender<(String, Arc<crate::websocket::WsMessage>)>,
    /// Per-server ephemeral Steam link handoffs and bounded request budgets.
    /// No raw library cache or live activity history. See api/steam.rs.
    pub steam_cache: Arc<Mutex<crate::api::steam::SteamCache>>,
    /// Shared HTTP client for Steam upstream fetches — one connection pool
    /// instead of a fresh client (TLS handshake) per cache miss.
    pub steam_http: crate::api::steam::SharedHttpClient,
    /// Guest creation rate limiter (IP → count). WS-5b.
    pub guest_rate_limiter: Arc<RwLock<HashMap<String, (u32, i64)>>>,
    pub registration_rate_limiter: Arc<RwLock<HashMap<String, (u32, i64)>>>,
    /// Tailcat private-access transport (unconditionally compiled, runtime-
    /// gated — disabled = no subprocess, zero footprint). See
    /// core/addons/tailcat/backend and docs/plans/2026-09-01-tailcat-private-access.md.
    pub tailcat: Arc<wabi_tailcat::TailcatManager>,
    /// Parsed profile_media per user (t_55544bc2). The init payload builds a
    /// UserView for every registered user on every socket connect; each used
    /// to serde_json-parse that user's whole layout_json. Cache maps
    /// user_id → (raw layout string, parsed profile_media); invalidated when
    /// the stored layout string changes.
    pub profile_media_cache:
        Arc<RwLock<HashMap<u64, (String, Option<serde_json::Map<String, serde_json::Value>>)>>>,
    /// User-defined Lore role tiers (capability bundles in
    /// `<data_dir>/lore_roles.json` + configurable default policy).
    pub lore_roles: Arc<LoreRoleStore>,
    /// Composed (brand-injected) index.html. Keyed by admin_policies.json
    /// mtime — admin rebrands are picked up on the next request without
    /// explicit invalidation.
    pub composed_index: tokio::sync::RwLock<Option<ComposedIndexCache>>,
}

/// Channel manager for broadcast channels
pub struct ChannelManager {
    /// Map of channel ID to broadcast sender
    #[allow(dead_code)]
    pub channel_broadcasts:
        std::collections::HashMap<i64, tokio::sync::broadcast::Sender<ChannelEvent>>,
}

/// Channel event for broadcasting
#[derive(Clone, Debug)]
#[allow(dead_code)]
pub enum ChannelEvent {
    Message {
        channel_id: i64,
        message_id: i64,
        content: String,
    },
    Typing {
        channel_id: i64,
        user_id: i64,
        is_typing: bool,
    },
    UserJoined {
        channel_id: i64,
        user_id: i64,
    },
    UserLeft {
        channel_id: i64,
        user_id: i64,
    },
}

/// Persisted token-revocation state.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct RevocationStore {
    /// Tokens with `iat` earlier than this epoch (unix seconds) are rejected.
    /// Bumping it effectively revokes every outstanding token at once.
    pub epoch: u64,
    /// Individually revoked token IDs (`jti`) → the revoked token's `exp`
    /// (unix seconds). REST and new socket handshakes reject expired tokens;
    /// entries are pruned after exp+1h to bound file growth. Established sockets
    /// may outlive exp, so individual-jti revocation is only retained for that
    /// window. User/global revocation floors remain effective afterward.
    /// Legacy format was a bare `HashSet<String>`; deserialized via a
    /// backward-compat shim in `load_revocations`.
    #[serde(default)]
    pub jtis: HashMap<String, u64>,
    /// Entire revoked user IDs (all their tokens rejected).
    pub users: HashSet<i64>,
    /// Per-user "tokens issued before this unix-second are revoked" watermark.
    /// Set on a self-service password change to force re-auth on stale
    /// sessions on other devices. Tokens minted after the watermark (fresh
    /// logins) stay valid; the token that performed the change is kept alive
    /// via `user_jti_exemptions`. Serialized with `#[serde(default)]` so
    /// pre-existing revocation files without the field load unchanged.
    #[serde(default)]
    pub user_iat_revoked: HashMap<i64, u64>,
    /// jtis kept alive past their user's `user_iat_revoked` watermark (the
    /// session that performed the change). Replaced wholesale on every
    /// subsequent change, so it holds at most one jti per user and cannot
    /// grow without bound. Serialized with `#[serde(default)]`.
    #[serde(default)]
    pub user_jti_exemptions: HashMap<i64, HashSet<String>>,
}

impl RevocationStore {
    /// Capture the revocation cut associated with an authentication proof.
    pub(crate) fn account_watermark(&self, user_id: i64) -> (u64, u64) {
        (
            self.epoch,
            self.user_iat_revoked.get(&user_id).copied().unwrap_or(0),
        )
    }

    fn next_user_floor(&self, user_id: i64, now: i64) -> u64 {
        let (epoch, floor) = self.account_watermark(user_id);
        (now.max(0) as u64)
            .saturating_add(1)
            .max(epoch.saturating_add(1))
            .max(floor.saturating_add(1))
    }

    /// Pure revocation decision used by `AppState::is_token_revoked`.
    /// `sub` is the user id, `iat` the token's issued-at timestamp.
    pub fn is_revoked(&self, jti: &str, sub: i64, iat: i64) -> bool {
        // Global epoch revokes everything issued before it.
        if self.epoch != 0 && (iat as u64) < self.epoch {
            return true;
        }
        // Whole-user revocation (admin/operator/recovery) wins over any jti.
        if self.users.contains(&sub) {
            return true;
        }
        // Per-user watermark from a password change: pre-watermark tokens are
        // rejected unless their jti is the exempted current session.
        if let Some(watermark) = self.user_iat_revoked.get(&sub) {
            if (iat as u64) < *watermark {
                let exempt = self
                    .user_jti_exemptions
                    .get(&sub)
                    .map(|set| set.contains(jti))
                    .unwrap_or(false);
                if !exempt {
                    return true;
                }
            }
        }
        // Explicitly revoked jti.
        if !jti.is_empty() && self.jtis.contains_key(jti) {
            return true;
        }
        false
    }

    /// Drop individual-jti revocations after exp+1h to bound on-disk growth.
    /// REST/new handshakes reject expired JWTs independently. Established
    /// sockets can outlive that window: use account/global floors when their
    /// access must remain revoked beyond it. Do not mistake this retention
    /// limit for a universal guarantee that expired tokens have no live socket.
    pub fn prune_expired_jtis(&mut self, now_unix: u64) {
        // Grace window of one hour: never race the clock edge between the
        // token's own exp validation (which has leeway) and this prune.
        let cutoff = now_unix.saturating_sub(3600);
        self.jtis.retain(|_, exp| *exp > cutoff);
    }
}

impl AppState {
    /// Socket.IO is installed synchronously while the router is constructed.
    /// A Tokio try_write could lose this handle forever if a startup reader
    /// happened to hold the lock at that instant.
    pub fn set_socket_io(&self, io: socketioxide::SocketIo) {
        *self.sio.write().expect("Socket.IO handle lock poisoned") = Some(io);
    }

    /// Clone the handle before any async broadcast so the lock is never held
    /// across an await point.
    pub fn socket_io(&self) -> Option<socketioxide::SocketIo> {
        self.sio
            .read()
            .expect("Socket.IO handle lock poisoned")
            .clone()
    }

    /// Build the application state. Opens the WabiDB engine at
    /// `<data_dir>/wabidb/`. WDB is fully decommissioned — no WDB
    /// initialization, no compat shim.
    pub async fn new(config: ServerConfig) -> anyhow::Result<Self> {
        Self::new_with_desktop_bootstrap(config, None).await
    }

    pub async fn new_with_desktop_bootstrap(
        config: ServerConfig,
        desktop_bootstrap_token: Option<String>,
    ) -> anyhow::Result<Self> {
        anyhow::ensure!(
            crate::config::valid_node_id(&config.node_id),
            "invalid Authority node ID"
        );
        // A retired Authority must not load writable sidecars or bind HTTP /
        // Socket.IO after its WabiDB writer has been durably fenced. The
        // engine alone rejects canonical commits; other state still lives in
        // file-backed stores, so refusing the whole server is the safe default.
        ensure_authority_not_fenced(&config.data_dir)?;
        if let Some(token) = &desktop_bootstrap_token {
            anyhow::ensure!(
                token.len() >= 32,
                "Desktop bootstrap capability must have at least 32 characters"
            );
        }
        let blacklist = BlacklistManager::new(config.blacklist_file.clone());
        blacklist.load_from_file().await?;
        crate::api::server_center::validate_sidecar(&config.data_dir)?;
        let server_center = Arc::new(RwLock::new(crate::api::server_center::ServerCenterStore::load(
            PathBuf::from(&config.data_dir).join("server_center.json"),
        )));
        let started_at = std::time::Instant::now();
        let instance_operations = crate::instance_operations::InstanceOperations::default();
        let boosters = crate::api::boosters::Boosters::open(&config.data_dir)?;
        // Resolve exact storage policy before accepting requests or opening WabiDB.
        // A background hydration task can let the first Live message persist.
        let retention_labels = crate::api::retention_policy::all(&config.data_dir)?;
        let retention_timers = retention_labels
            .iter()
            .filter_map(|(channel, label)| {
                crate::api::retention_policy::timed_ms(label).map(|ms| (channel.clone(), ms))
            })
            .collect();
        let fast_retention_channels =
            crate::api::retention_policy::fast_sweep_channels(&config.data_dir)?
                .into_iter()
                .collect();
        let owner_user_id = Arc::new(RwLock::new(None));
        let addon_switches =
            RwLock::new(crate::addon_switches::AddonSwitches::load(&config.data_dir));
        let node_registry = NodeRegistry::new_persistent(
            config.node_id.clone(),
            PathBuf::from(&config.data_dir).join("node_registry.json"),
        )?;
        let job_queue =
            JobQueue::new_persistent(PathBuf::from(&config.data_dir).join("job_queue.json"));
        let blob_registry = BlobRegistry::new_persistent(PathBuf::from(&config.data_dir));
        let bot_registry = BotRegistry::new_persistent(PathBuf::from(&config.data_dir));
        let upload_registry = UploadRegistry::new_for_authority(
            PathBuf::from(&config.data_dir),
            PathBuf::from(&config.uploads_dir),
        )?;
        let media_registry =
            crate::media::MediaRoomRegistry::new_persistent(PathBuf::from(&config.data_dir));

        // Open the WabiDB engine. This is the new source of truth.
        let wdb_data_dir = PathBuf::from(&config.data_dir).join("wabidb");
        std::fs::create_dir_all(&wdb_data_dir)?;

        // If a peer endpoint is configured, enable replication.
        let peer_endpoint = std::env::var("WABIDB_PEER_ENDPOINT")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let sync_interval_micros = std::env::var("WABIDB_SYNC_INTERVAL_MS")
            .ok()
            .and_then(|s| s.parse::<u64>().ok())
            .map(|ms| ms.saturating_mul(1_000))
            .unwrap_or(30_000_000); // default 30s
        let wdb: Arc<WdbAdapter> = if let Some(endpoint) = peer_endpoint {
            let allow_private_http = std::env::var("WABIDB_ALLOW_PRIVATE_HTTP")
                .ok()
                .map(|value| value.trim().eq_ignore_ascii_case("true"))
                .unwrap_or(false);
            ReqwestTransport::validate_peer_endpoint(&endpoint, allow_private_http)?;
            let mut wdb_config = WdbAdapter::resolved_config(&wdb_data_dir)?;
            let root_key = match &wdb_config.bootstrap_source {
                wabidb::crypto::bootstrap::BootstrapSource::Provided(key) => key,
                _ => unreachable!("resolved WabiDB config always provides the root key"),
            };
            let fingerprint = wabidb::replication::replica_fingerprint(root_key);
            let mut transport = ReqwestTransport::new(wdb_data_dir.clone(), fingerprint)
                .with_uploads_dir(PathBuf::from(&config.uploads_dir));
            if std::env::var("WABIDB_REPLICATE_SIDECARS")
                .ok()
                .is_some_and(|value| {
                    matches!(
                        value.trim().to_ascii_lowercase().as_str(),
                        "1" | "true" | "yes"
                    )
                })
            {
                transport = transport.with_instance_dir(PathBuf::from(&config.data_dir));
            }
            let transport = Arc::new(transport);
            let rep_config = wabidb::replication::config::ReplicationConfig::new(
                &endpoint,
                sync_interval_micros,
                5_000_000, // 5 second max lag
            );
            wdb_config.sync_transport = Some(transport);
            wdb_config.replication_config = Some(rep_config);
            tracing::info!(
                "WabiDB replication enabled → peer {} (interval {}µs)",
                endpoint,
                sync_interval_micros
            );
            Arc::new(
                WdbAdapter::open_with_config_and_node_id(wdb_config, config.node_id.clone())
                    .await?,
            )
        } else {
            Arc::new(
                WdbAdapter::open_with_node_id(&wdb_data_dir, config.node_id.clone()).await?,
            )
        };
        // Also cover a marker created while the engine was opening.
        anyhow::ensure!(
            !wdb.engine().local_writer_fenced().await,
            "Authority data directory became writer-fenced during startup"
        );
        ensure_authority_not_fenced(&config.data_dir)?;
        upload_registry.reconcile_revocations(wdb.engine()).await?;
        upload_registry
            .reconcile_published_assets(Path::new(&config.uploads_dir), wdb.engine())
            .await?;
        let community_root_key = crate::secrets::resolve_root_key(&wdb_data_dir)?;
        let community_roster = CommunityRosterStore::open_canonical(
            &config.data_dir,
            &community_root_key,
            wdb.engine(),
        )
        .await?;

        // Load the authoritative owner from the WDB store (migrating the
        // legacy JSON file if needed). Must happen after the engine opens.
        let owner_val = Self::load_owner(wdb.as_ref(), &config.data_dir).await?;
        *owner_user_id.write().await = owner_val;

        // Load persisted token-revocation state.
        let revocation_file = Self::revocation_file_path(&config.data_dir);
        let revocations = Arc::new(RwLock::new(crate::auth_revocations::open(&config.data_dir, wdb.engine()).await?));

        // Load persisted recovery codes.
        let recovery_file = Self::recovery_file_path(&config.data_dir);
        let recovery_codes = Arc::new(RwLock::new(crate::recovery_codes::open(&config.data_dir, wdb.engine()).await?));

        let tailcat = wabi_tailcat::TailcatManager::new(
            config.port,
            std::path::Path::new(config.data_dir.as_str()),
        );
        // User-defined Lore roles: seed `<data_dir>/lore_roles.json` when
        // missing and publish the process-global handle read by the sync
        // `server_role_catalog()`.
        let lore_roles = LoreRoleStore::open(&config.data_dir);
        crate::api::server_center::spawn_evidence_expiry_loop(&server_center, instance_operations.clone());
        Ok(Self {
            config,
            started_at,
            network_health: crate::api::network_health::Sampler::default(),
            instance_operations,
            boosters,
            wdb,
            community_roster,
            channels: RwLock::new(ChannelManager {
                channel_broadcasts: std::collections::HashMap::new(),
            }),
            session_messages: Arc::new(RwLock::new(HashMap::new())),
            channel_auto_delete_ms: Arc::new(RwLock::new(retention_timers)),
            retention_policy_lock: tokio::sync::Mutex::new(()),
            fast_retention_channels: Arc::new(RwLock::new(fast_retention_channels)),
            channel_auto_delete_label: Arc::new(RwLock::new(retention_labels)),
            live_channel_ttl_ms: Arc::new(RwLock::new(HashMap::new())),
            live_channel_cap: Arc::new(RwLock::new(HashMap::new())),
            tombstone_table: Arc::new(RwLock::new(TombstoneTable::new())),
            owner_user_id,
            setup_claim_lock: tokio::sync::Mutex::new(()),
            desktop_bootstrap_token,
            payment_policy_lock: tokio::sync::Mutex::new(()),
            revocation_file,
            revocations,
            recovery_file,
            recovery_codes,
            upload_state: UploadState::new(),
            node_registry,
            job_queue,
            blob_registry,
            bot_registry,
            upload_registry,
            media_registry,
            sio: std::sync::RwLock::new(None),
            connected_users: Arc::new(RwLock::new(HashMap::new())),
            blacklist: RwLock::new(Some(Arc::new(blacklist))),
            server_center,
            addon_switches,
            #[cfg(feature = "wabi-lore")]
            lore_service: RwLock::new(None),
            membership_gate: Default::default(),
            call_session_locks: Default::default(),
            call_session_push: {
                let (tx, _) = broadcast::channel(1024);
                tx
            },
            steam_cache: Arc::new(Mutex::new(Default::default())),
            steam_http: crate::api::steam::shared_http_client(),
            guest_rate_limiter: Arc::new(RwLock::new(HashMap::new())),
            registration_rate_limiter: Arc::new(RwLock::new(HashMap::new())),
            tailcat,
            lore_roles,
            profile_media_cache: Arc::new(RwLock::new(HashMap::new())),
            composed_index: tokio::sync::RwLock::new(None),
        })
    }

    /// Set the blacklist manager (called during startup)
    pub async fn set_blacklist(&self, blacklist: BlacklistManager) {
        let mut guard = self.blacklist.write().await;
        *guard = Some(Arc::new(blacklist));
    }

    /// Get the blacklist manager (if loaded)
    pub async fn get_blacklist(&self) -> Option<Arc<BlacklistManager>> {
        let guard = self.blacklist.read().await;
        guard.clone()
    }

    /// Effective runtime state of a compiled-in add-on: env → persisted → default.
    pub async fn addon_enabled(&self, id: &str, env_var: Option<&str>, default: bool) -> bool {
        self.addon_switches
            .read()
            .await
            .resolve(id, env_var, default)
    }

    /// Persist an in-app add-on switch change (owner action).
    pub async fn set_addon_enabled(&self, id: &str, enabled: bool) -> anyhow::Result<()> {
        let mut guard = self.addon_switches.write().await;
        guard.set(id, enabled);
        guard.save(&self.config.data_dir)
    }

    /// Set the Lore service (called during startup)
    #[cfg(feature = "wabi-lore")]
    pub async fn set_lore_service(&self, lore: Arc<crate::lore::LoreService>) {
        let mut guard = self.lore_service.write().await;
        *guard = Some(lore);
    }

    /// Load the owner from the authoritative WDB store.
    async fn load_owner(wdb: &WdbAdapter, _data_dir: &str) -> anyhow::Result<Option<i64>> {
        Ok(wdb.get_owner_user_id().await?.map(|id| id as i64))
    }

    /// Returns true if the server has no owner yet (first-run state).
    pub async fn needs_setup(&self) -> bool {
        self.owner_user_id.read().await.is_none()
    }

    /// Claim ownership. Returns true if this user claimed it (i.e., was
    /// the first registrant). Persists to the WDB store so it is the
    /// authoritative source of truth and survives restarts.
    /// Fails silently if an owner already exists.
    pub async fn claim_ownership(&self, user_id: i64, _username: &str) -> anyhow::Result<bool> {
        let owner = Arc::clone(&self.owner_user_id);
        let wdb = Arc::clone(&self.wdb);
        Ok(self.instance_operations.spawn(async move {
            let mut guard = owner.write_owned().await;
            if guard.is_some() { return Ok(false); }
            wdb.claim_owner(user_id as u64).await?;
            *guard = Some(user_id);
            tracing::info!("[setup] owner claimed by user_id={}", user_id);
            Ok::<_, wabidb::error::WabiError>(true)
        }).await??)
    }

    /// Serialize ownership writes with code recovery and publish only after
    /// durability/application. A caller's disappearance does not stop the
    /// owned worker. An expected owner prevents a stale transfer from winning.
    pub async fn set_owner_durably(&self, user_id: i64, expected_owner: Option<i64>) -> wabidb::error::Result<bool> {
        let owner = Arc::clone(&self.owner_user_id);
        let wdb = Arc::clone(&self.wdb);
        self.instance_operations.spawn(async move {
            let mut guard = owner.write_owned().await;
            if expected_owner.is_some_and(|expected| *guard != Some(expected)) { return Ok(false); }
            if user_id <= 0 || wdb.get_user(user_id as u64).await?.is_none() {
                return Err(wabidb::error::WabiError::Validation {
                    command: "set_owner".into(), reason: "target account does not exist".into(),
                });
            }
            wdb.claim_owner(user_id as u64).await?;
            *guard = Some(user_id);
            Ok(true)
        }).await.map_err(|error| wabidb::error::WabiError::InternalInvariantViolated {
            invariant: format!("owner publication task failed; inspect canonical owner state: {error}"),
        })?
    }

    /// Get the highest role for a user from WDB RBAC (default workspace).
    /// Maps Owner/Admin/Moderator by name; `None` ⇒ `"Guest"` for guest
    /// tokens, else `"Member"`. Used by `on_join_channel` min_role gate.
    pub async fn get_user_highest_role(&self, user_id: i64) -> String {
        if self.is_owner(user_id).await {
            return "Owner".to_string();
        }
        match self
            .wdb
            .get_user_role("default-workspace", user_id as u64)
            .await
        {
            Ok(role) => match role.as_deref() {
                Some("Owner") => "Owner".to_string(),
                Some("Admin") => "Admin".to_string(),
                Some("Moderator") => "Moderator".to_string(),
                // Artist/Developer are workspace (RBAC) tiers surfaced by exact
                // stored-role match — same rule as effective_user_role.
                Some("Developer") => "Developer".to_string(),
                Some("Artist") => "Artist".to_string(),
                _ => "Member".to_string(),
            },
            Err(_) => "Member".to_string(),
        }
    }

    /// Returns true if the user is the server owner (first registrant).
    pub async fn is_owner(&self, user_id: i64) -> bool {
        match *self.owner_user_id.read().await {
            Some(owner) => owner == user_id,
            None => false,
        }
    }

    /// Returns true if `user_id` is a registered bot account.
    pub async fn is_bot_user(&self, user_id: u64) -> bool {
        self.bot_registry.is_bot(user_id).await
    }

    /// Returns true if the user holds `role` (or a higher role) in the
    /// default workspace, per the live `rbac_roles` projection.
    pub async fn has_role(&self, user_id: i64, role: &str) -> bool {
        let current = match self
            .wdb
            .get_user_role("default-workspace", user_id as u64)
            .await
        {
            Ok(Some(r)) => r,
            _ => return false,
        };
        let rank = |r: &str| match r {
            "Owner" => 3,
            "Admin" => 2,
            "Moderator" => 1,
            // Artist/Developer (and any other unknown role) rank 0: they are
            // orthogonal workspace tiers for Lore access, never moderation or
            // admin powers, so they can never satisfy a Moderator/Admin check.
            _ => 0,
        };
        rank(&current) >= rank(role)
    }

    /// Returns true if the user is the server owner, is listed in the
    /// configured `admin_user_ids`, or holds the `Admin` (or higher) role.
    pub async fn is_admin(&self, user_id: i64) -> bool {
        if self.is_owner(user_id).await {
            return true;
        }
        if self.config.admin_user_ids.contains(&user_id) {
            return true;
        }
        self.has_role(user_id, "Admin").await
    }

    // ─── Token revocation ────────────────────────────────────────────────────

    fn revocation_file_path(data_dir: &str) -> PathBuf {
        PathBuf::from(data_dir).join("revocations.json")
    }

    /// Compatibility parser retained for callers/tests. Authority startup uses
    /// the strict decoder below and refuses corrupt legacy denial state.
    pub fn load_legacy_revocations_str(s: &str) -> RevocationStore {
        Self::decode_legacy_revocations_str(s).unwrap_or_default()
    }

    pub(crate) fn decode_legacy_revocations_str(s: &str) -> anyhow::Result<RevocationStore> {
        let json: serde_json::Value = serde_json::from_str(s)?;
        let object = json.as_object().ok_or_else(|| anyhow::anyhow!("revocations must be an object"))?;
        if object.keys().any(|key| !matches!(key.as_str(), "epoch" | "jtis" | "users" | "user_iat_revoked" | "user_jti_exemptions")) {
            anyhow::bail!("unknown field in legacy revocations");
        }
        if let Ok(v) = serde_json::from_str::<RevocationStore>(s) { return Ok(v); }
        #[derive(Deserialize)]
        struct LegacyRevocationStore {
            #[serde(default)] epoch: u64,
            #[serde(default)] jtis: Vec<String>,
            #[serde(default)] users: HashSet<i64>,
            #[serde(default)] user_iat_revoked: HashMap<i64, u64>,
            #[serde(default)] user_jti_exemptions: HashMap<i64, HashSet<String>>,
        }
        let legacy: LegacyRevocationStore = serde_json::from_str(s)?;
        Ok(RevocationStore {
            epoch: legacy.epoch,
            jtis: legacy.jtis.into_iter().map(|jti| (jti, u64::MAX)).collect(),
            users: legacy.users, user_iat_revoked: legacy.user_iat_revoked,
            user_jti_exemptions: legacy.user_jti_exemptions,
        })
    }

    /// The owned task finishes commit AND auth-view publication if the caller
    /// disconnects. Dropping a request must not strand a durable denial behind
    /// the running Authority's in-memory view. Its write guard covers both.
    async fn update_revocations<F>(&self, build: F) -> wabidb::error::Result<()>
    where F: FnOnce(&RevocationStore) -> Option<wabidb::projections::auth_revocations::Operation> + Send + 'static {
        use wabidb::projections::auth_revocations::Operation;
        let revocations = Arc::clone(&self.revocations);
        let wdb = Arc::clone(&self.wdb);
        self.instance_operations.spawn(async move {
            let mut guard = revocations.write_owned().await;
            let Some(operation) = build(&guard) else { return Ok(()); };
            let cutoff = (chrono::Utc::now().timestamp().max(0) as u64).saturating_sub(3600);
            let updated_jti = match &operation { Operation::Token { jti, .. } => Some(jti.as_str()), _ => None };
            let expired: Vec<_> = guard.jtis.iter()
                .filter(|(jti, exp)| **exp <= cutoff && Some(jti.as_str()) != updated_jti)
                .take(256).map(|(jti, exp)| (jti.clone(), *exp)).collect();
            let mut operations = vec![operation.clone()];
            operations.extend(expired.iter().map(|(jti, exp)| Operation::PruneToken {
                jti: jti.clone(), expires_at: *exp, cutoff,
            }));
            crate::auth_revocations::commit(wdb.engine(), false, operations).await?;
            match operation {
                Operation::Token { jti, expires_at } => { guard.jtis.insert(jti, expires_at); },
                Operation::UserFloor { user_id, floor, exempt_jtis, clear_legacy } => {
                    guard.user_iat_revoked.insert(user_id, floor);
                    if exempt_jtis.is_empty() { guard.user_jti_exemptions.remove(&user_id); }
                    else { guard.user_jti_exemptions.insert(user_id, exempt_jtis.into_iter().collect()); }
                    if clear_legacy { guard.users.remove(&user_id); }
                },
                Operation::GlobalFloor { epoch } => guard.epoch = epoch,
                Operation::ClearLegacyUser { user_id } => { guard.users.remove(&user_id); },
                _ => unreachable!("Authority mutation builder only creates canonical revocation operations"),
            }
            for (jti, exp) in expired {
                if guard.jtis.get(&jti) == Some(&exp) { guard.jtis.remove(&jti); }
            }
            Ok(())
        }).await.map_err(|error| wabidb::error::WabiError::InternalInvariantViolated {
            invariant: format!("revocation publication task failed; inspect canonical denial state: {error}"),
        })?
    }

    pub async fn revoke_token_with_exp(&self, jti: String, exp: i64) -> wabidb::error::Result<()> {
        use wabidb::projections::auth_revocations::Operation;
        if jti.is_empty() { return Ok(()); }
        self.update_revocations(move |guard| Some(Operation::Token {
            expires_at: (exp.max(0) as u64).max(guard.jtis.get(&jti).copied().unwrap_or(0)), jti,
        })).await
    }

    /// Force existing sessions out; a future password login remains possible.
    pub async fn revoke_user(&self, user_id: i64) -> wabidb::error::Result<()> {
        use wabidb::projections::auth_revocations::Operation;
        self.update_revocations(move |guard| Some(Operation::UserFloor {
            user_id, floor: guard.next_user_floor(user_id, chrono::Utc::now().timestamp()),
            exempt_jtis: vec![], clear_legacy: true,
        })).await
    }

    pub async fn clear_legacy_user_revocation(&self, user_id: i64) -> wabidb::error::Result<()> {
        use wabidb::projections::auth_revocations::Operation;
        self.update_revocations(move |guard| guard.users.contains(&user_id)
            .then_some(Operation::ClearLegacyUser { user_id })).await
    }

    /// Keep only the caller's session while advancing the user's cutoff.
    pub async fn revoke_user_other_sessions(&self, user_id: i64, exempt_jti: &str) -> wabidb::error::Result<()> {
        use wabidb::projections::auth_revocations::Operation;
        let exempt_jtis = if exempt_jti.is_empty() { vec![] } else { vec![exempt_jti.to_owned()] };
        self.update_revocations(move |guard| Some(Operation::UserFloor {
            user_id, floor: guard.next_user_floor(user_id, chrono::Utc::now().timestamp()),
            exempt_jtis, clear_legacy: false,
        })).await
    }

    pub async fn revoke_all_tokens(&self) -> wabidb::error::Result<()> {
        use wabidb::projections::auth_revocations::Operation;
        self.update_revocations(|guard| Some(Operation::GlobalFloor {
            epoch: (chrono::Utc::now().timestamp().max(0) as u64).saturating_add(1)
                .max(guard.epoch.saturating_add(1))
                .max(guard.user_iat_revoked.values().copied().max().unwrap_or(0).saturating_add(1)),
        })).await
    }

    pub async fn is_token_revoked(&self, jti: &str, sub: i64, iat: i64) -> bool {
        self.revocations.read().await.is_revoked(jti, sub, iat)
    }

    // ─── Recovery-code legacy import path ───────────────────────────────────

    fn recovery_file_path(data_dir: &str) -> PathBuf {
        PathBuf::from(data_dir).join("recovery_codes.json")
    }

}

/// Partition a live channel's in-memory message buffer into alive and expired,
/// enforcing TTL and cap. Returns the IDs of expired (evicted) messages.
/// Used by the live room reaper task. Pure function for testability.
pub fn reap_live_channel_buffer(
    msgs: &mut Vec<serde_json::Value>,
    ttl_ms: u64,
    cap: u64,
    now: i64,
) -> Vec<String> {
    let mut alive: Vec<serde_json::Value> = Vec::with_capacity(msgs.len());
    let mut expired: Vec<String> = Vec::new();
    for m in msgs.drain(..) {
        let born = m.get("bornAt").and_then(|v| v.as_i64()).unwrap_or(0);
        if now - born >= ttl_ms as i64 {
            if let Some(id) = m.get("id").and_then(|v| v.as_str()) {
                expired.push(id.to_string());
            }
        } else {
            alive.push(m);
        }
    }
    if alive.len() > cap as usize {
        let excess = alive.len() - cap as usize;
        for m in alive.drain(..excess) {
            if let Some(id) = m.get("id").and_then(|v| v.as_str()) {
                expired.push(id.to_string());
            }
        }
    }
    *msgs = alive;
    expired
}

impl AppState {
    /// Generate `count` one-time recovery codes for `user_id`. The plaintext
    /// codes are returned exactly once; only their hashes are persisted.
    pub async fn generate_recovery_codes(&self, user_id: i64, count: usize) -> wabidb::error::Result<Vec<String>> {
        crate::recovery_codes::issue(Arc::clone(&self.recovery_codes), Arc::clone(&self.wdb), user_id, count, self.instance_operations.clone()).await
    }

    /// Consume a recovery code. Returns true only if the code is valid and
    /// bound to `user_id`. The code is single-use.
    pub async fn consume_recovery_code(&self, code: &str, user_id: i64) -> wabidb::error::Result<bool> {
        crate::recovery_codes::consume(Arc::clone(&self.recovery_codes), Arc::clone(&self.wdb), crate::recovery_codes::hash_code(code), user_id, self.instance_operations.clone()).await
    }

    /// Spend a code, restore its account as owner and revoke existing sessions
    /// in one ordered event. A failed write publishes none of those changes.
    pub async fn recover_owner_with_code(&self, code: &str, user_id: i64) -> wabidb::error::Result<bool> {
        crate::recovery_codes::recover(Arc::clone(&self.recovery_codes), Arc::clone(&self.revocations),
            Arc::clone(&self.owner_user_id), Arc::clone(&self.wdb), crate::recovery_codes::hash_code(code), user_id, self.instance_operations.clone()).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_reap_live_channel_ttl_expired() {
        let now = 1000_000;
        let mut msgs = vec![
            json!({"id": "live_1", "bornAt": now - 1000, "text": "fresh"}),
            json!({"id": "live_2", "bornAt": now - 600_001, "text": "old"}),
            json!({"id": "live_3", "bornAt": now - 700_000, "text": "ancient"}),
        ];
        let expired = reap_live_channel_buffer(&mut msgs, 600_000, 100, now);
        assert_eq!(expired, vec!["live_2", "live_3"]);
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0]["id"], "live_1");
    }

    #[test]
    fn test_reap_live_channel_cap_enforced() {
        let now = 1000_000;
        let mut msgs: Vec<serde_json::Value> = (0..5)
            .map(|i| json!({"id": format!("live_{}", i), "bornAt": now - 1000}))
            .collect();
        let expired = reap_live_channel_buffer(&mut msgs, 600_000, 2, now);
        assert_eq!(expired, vec!["live_0", "live_1", "live_2"]);
        assert_eq!(msgs.len(), 2);
    }

    #[test]
    fn test_reap_live_channel_empty() {
        let now = 1000_000;
        let mut msgs: Vec<serde_json::Value> = vec![];
        let expired = reap_live_channel_buffer(&mut msgs, 600_000, 100, now);
        assert!(expired.is_empty());
        assert!(msgs.is_empty());
    }

    #[test]
    fn test_reap_live_channel_no_born_at() {
        let now = 1000_000;
        let mut msgs = vec![json!({"id": "live_1", "text": "no bornat"})];
        let expired = reap_live_channel_buffer(&mut msgs, 1, 100, now);
        // bornAt defaults to 0, which means it's expired since now - 0 >= 1
        assert_eq!(expired, vec!["live_1"]);
        assert!(msgs.is_empty());
    }

    // ── Password-change session lifecycle ────────────────────────────────────
    //
    // Regression test for: "changing my password kicks me out and keeps me out."
    // handle_change_password now calls `revoke_user_other_sessions` instead of
    // `revoke_user`, so the bearer token that performed the change survives
    // while other pre-existing sessions for the same user are rejected. These
    // tests drive the real `RevocationStore::is_revoked` decision (the exact
    // code `AppState::is_token_revoked` runs on every authenticated request).

    #[test]
    fn password_change_keeps_current_session_revokes_other_session() {
        let mut store = RevocationStore::default();
        let user_id = 42;

        // Exactly the mutation `AppState::revoke_user_other_sessions` performs
        // when a user changes their own password.
        store.user_iat_revoked.insert(user_id, 1_000_000 + 1);
        store
            .user_jti_exemptions
            .insert(user_id, HashSet::from(["current-session-jti".to_string()]));

        // Both tokens were issued before the change watermark.
        let iat_before_change = 999_999;

        // The token used to change the password stays usable...
        assert!(!store.is_revoked("current-session-jti", user_id, iat_before_change));
        // ...while another pre-existing token for the same user is rejected.
        assert!(store.is_revoked("older-device-jti", user_id, iat_before_change));

        // A fresh token minted after the change (re-login) is NOT revoked.
        let iat_after_change = 1_000_001;
        assert!(!store.is_revoked("fresh-login-jti", user_id, iat_after_change));

        // Other users are unaffected by this user's password change.
        assert!(!store.is_revoked("random-jti", 7, iat_before_change));
    }

    #[test]
    fn second_password_change_rotates_the_exempted_session() {
        let mut store = RevocationStore::default();
        let user = 9;

        // First change: watermark 1_000, current session t1 exempted.
        store.user_iat_revoked.insert(user, 1_000);
        store
            .user_jti_exemptions
            .insert(user, HashSet::from(["t1".to_string()]));
        assert!(!store.is_revoked("t1", user, 999));

        // Second change replaces the exemption wholesale, so the exemption set
        // holds at most one jti per user (bounded growth).
        store.user_iat_revoked.insert(user, 2_000);
        store
            .user_jti_exemptions
            .insert(user, HashSet::from(["t2".to_string()]));

        // t1 lost its exemption and is now below the new watermark: revoked.
        assert!(store.is_revoked("t1", user, 999));
        // t2 (the new current session) is exempt and stays usable.
        assert!(!store.is_revoked("t2", user, 999));
        // Any third pre-existing session is revoked too.
        assert!(store.is_revoked("t3", user, 999));
    }

    #[test]
    fn full_user_revocation_still_wins_over_exemption() {
        let mut store = RevocationStore::default();
        store.user_iat_revoked.insert(42, 1_000);
        store
            .user_jti_exemptions
            .insert(42, HashSet::from(["cur".to_string()]));

        // Admin / owner / recovery flows still use the whole-user `users` set,
        // which must override any jti exemption (authentication is NOT weakened).
        store.users.insert(42);
        assert!(store.is_revoked("cur", 42, 999));
        assert!(store.is_revoked("fresh", 42, 1_001));
    }

    #[test]
    fn legacy_revocation_store_json_loads_without_new_fields() {
        // Pre-existing revocations.json files (epoch/jtis/users only) must keep
        // loading and behaving identically after the new fields are added.
        // Legacy jtis is a bare array; it deserializes via the compat shim in
        // load_revocations with u64::MAX expiry (never pruned automatically).
        let legacy = r#"{"epoch": 0, "jtis": ["revoked-jti"], "users": [7]}"#;
        let store = AppState::load_legacy_revocations_str(legacy);
        assert!(store.is_revoked("revoked-jti", 1, 5));
        assert!(store.is_revoked("anything", 7, 5));
        assert!(!store.is_revoked("ok-jti", 1, 5));
        assert!(store.user_iat_revoked.is_empty());
        assert!(store.user_jti_exemptions.is_empty());

        // New-style jtis map {jti: exp} round-trips and prunes correctly.
        let mut store = RevocationStore::default();
        store.jtis.insert("old".into(), 100);
        store.jtis.insert("live".into(), u64::MAX);
        store.prune_expired_jtis(1_000_000);
        assert!(!store.jtis.contains_key("old"));
        assert!(store.jtis.contains_key("live"));

        // New-style store round-trips through serialization without data loss.
        let mut store = RevocationStore::default();
        store.user_iat_revoked.insert(42, 1_000);
        store
            .user_jti_exemptions
            .insert(42, HashSet::from(["cur".to_string()]));
        let roundtrip: RevocationStore =
            serde_json::from_str(&serde_json::to_string(&store).unwrap()).unwrap();
        assert_eq!(roundtrip.user_iat_revoked, store.user_iat_revoked);
        assert_eq!(roundtrip.user_jti_exemptions, store.user_jti_exemptions);
    }
}
