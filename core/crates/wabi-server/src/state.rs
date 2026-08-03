//! Application state shared across handlers

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::sync::atomic::AtomicU64;
use std::path::PathBuf;
use tokio::sync::{broadcast, Mutex, RwLock};
use serde::{Serialize, Deserialize};
use sha2::{Sha256, Digest};

use crate::adapter::WdbAdapter;
use wabidb::engine::wabi_store::WabiStore;
use crate::api::upload::UploadState;
use crate::blacklist::BlacklistManager;
use crate::blobs::BlobRegistry;
use crate::bot_registry::BotRegistry;
use crate::config::ServerConfig;
use crate::jobs::JobQueue;
use crate::nodes::NodeRegistry;
use crate::replication_transport::ReqwestTransport;
use crate::upload_registry::UploadRegistry;

/// In-memory message cache shared between Socket.IO and HTTP handlers.
/// channel_id → Vec of message JSON objects (capped at 1000 per channel).
pub type SessionMessages = Arc<RwLock<HashMap<String, Vec<serde_json::Value>>>>;

/// Shared application state
pub struct AppState {
    pub config: ServerConfig,
    /// WabiDB engine handle. The source of truth for all persistence.
    /// Concrete `WdbAdapter` (not the trait object) — `WabiStore` is not
    /// yet dyn-compatible (its async fns need a Send bound for `dyn Trait`).
    /// Can switch to `Arc<dyn WabiStore>` once the trait gets the fix.
    pub wdb: Arc<WdbAdapter>,
    pub ws_tx: broadcast::Sender<Arc<crate::websocket::WsMessage>>,
    #[allow(dead_code)]
    pub channels: RwLock<ChannelManager>,
    pub session_messages: SessionMessages,
    /// channel_id -> auto-delete duration in milliseconds (None/0 = off).
    /// In-memory for full preset support (5s..90d); also mirrored to WDB days when >= 1d.
    pub channel_auto_delete_ms: Arc<RwLock<HashMap<String, u64>>>,
    /// channel_id -> frontend label (e.g. "5s", "24h") for channel-updated payloads
    pub channel_auto_delete_label: Arc<RwLock<HashMap<String, String>>>,
    /// Per-channel live room TTL in milliseconds. Default: 10 minutes.
    pub live_channel_ttl_ms: Arc<RwLock<HashMap<String, u64>>>,
    /// Per-channel live room message count cap. Default: 1000.
    pub live_channel_cap: Arc<RwLock<HashMap<String, u64>>>,
    /// The user ID of the server owner (first registrant).
    /// None until the first account is created.
    pub owner_user_id: RwLock<Option<i64>>,
    /// Token revocation state. A stolen/compromised JWT can be killed
    /// without rotating the signing secret: individual `jti`s, entire
    /// users, or all tokens issued before an `epoch` can be revoked.
    pub revocation_file: PathBuf,
    pub revocations: RwLock<RevocationStore>,
    /// One-time recovery codes that let the owner regain access when locked
    /// out (e.g. password changed by an attacker). Maps code-hash -> owner id.
    pub recovery_file: PathBuf,
    pub recovery_codes: RwLock<HashMap<String, i64>>,
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
    /// Broadcasts the SocketIo handle so HTTP handlers (like avatar upload) can emit events
    #[allow(dead_code)]
    pub sio_broadcast_tx: broadcast::Sender<socketioxide::SocketIo>,
    /// Blacklist manager for bans
    pub blacklist: RwLock<Option<Arc<BlacklistManager>>>,
    /// Mesh service for multi-node coordination
    pub mesh_service: RwLock<Option<Arc<crate::mesh::MeshService>>>,
    /// Lore addon service for version-controlled binary storage
    #[cfg(feature = "wabi-lore")]
    pub lore_service: RwLock<Option<Arc<crate::lore::LoreService>>>,
    /// Serialises load+rewrite of the JSONL intents file so a concurrent
    /// `create_intent` (append) is not lost between load and rewrite in
    /// `confirm_intent` / `reject_intent`.
    pub intents_mutex: tokio::sync::Mutex<()>,
    /// Monotonic per-process counter for call signal ids.
    /// Not durable across restarts; clients replay since-signal_id after reconnect.
    pub call_signal_counter: Arc<AtomicU64>,
    /// Per-connection call-session subscription sets. conn_id -> set of session_ids.
    pub call_session_subscriptions: Arc<Mutex<HashMap<u64, HashSet<String>>>>,
    /// Channel that internal call-session handlers push (session_id, WsMessage) to.
    /// WebSocket connections subscribe and filter by their own session set.
    pub call_session_push: broadcast::Sender<(String, Arc<crate::websocket::WsMessage>)>,
    /// Monotonic connection id counter for WebSocket connections.
    pub ws_conn_id_counter: Arc<Mutex<u64>>,
    /// Steam addon server-side cache (60s TTL per steam id). Opt-in; only
    /// populated when STEAM_API_KEY is configured. See api/steam.rs.
    pub steam_cache: Arc<Mutex<crate::api::steam::SteamCache>>,
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
    /// Individual revoked token IDs (`jti`).
    pub jtis: HashSet<String>,
    /// Entire revoked user IDs (all their tokens rejected).
    pub users: HashSet<i64>,
}

impl AppState {
    /// Build the application state. Opens the WabiDB engine at
    /// `<data_dir>/wabidb/`. WDB is fully decommissioned — no WDB
    /// initialization, no compat shim.
    pub async fn new(config: ServerConfig) -> anyhow::Result<Self> {
        let (ws_tx, _) = broadcast::channel(1000);
        let (sio_broadcast_tx, _) = broadcast::channel(1);
        let owner_user_id = RwLock::new(None);
        let node_registry = NodeRegistry::new_persistent(
            config.node_id.clone(),
            PathBuf::from(&config.data_dir).join("node_registry.json"),
        );
        let job_queue =
            JobQueue::new_persistent(PathBuf::from(&config.data_dir).join("job_queue.json"));
        let blob_registry = BlobRegistry::new_persistent(PathBuf::from(&config.data_dir));
        let bot_registry = BotRegistry::new_persistent(PathBuf::from(&config.data_dir));
        let upload_registry = UploadRegistry::new_persistent(PathBuf::from(&config.data_dir));
        let media_registry =
            crate::media::MediaRoomRegistry::new_persistent(PathBuf::from(&config.data_dir));

        // Open the WabiDB engine. This is the new source of truth.
        let wdb_data_dir = PathBuf::from(&config.data_dir).join("wabidb");
        std::fs::create_dir_all(&wdb_data_dir).ok();

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
            let transport = Arc::new(ReqwestTransport::new(wdb_data_dir.clone()));
            let rep_config = wabidb::replication::config::ReplicationConfig::new(
                &endpoint,
                sync_interval_micros,
                5_000_000, // 5 second max lag
            );
            let mut wdb_config = wabidb::engine::WabiDbConfig::from_env_var(wdb_data_dir);
            wdb_config.sync_transport = Some(transport);
            wdb_config.replication_config = Some(rep_config);
            tracing::info!(
                "WabiDB replication enabled → peer {} (interval {}µs)",
                endpoint,
                sync_interval_micros
            );
            Arc::new(WdbAdapter::open_with_config(wdb_config).await?)
        } else {
            Arc::new(WdbAdapter::open(&wdb_data_dir).await?)
        };

        // Load the authoritative owner from the WDB store (migrating the
        // legacy JSON file if needed). Must happen after the engine opens.
        let owner_val = Self::load_owner(wdb.as_ref(), &config.data_dir).await;
        *owner_user_id.write().await = owner_val;

        // Load persisted token-revocation state.
        let revocation_file = Self::revocation_file_path(&config.data_dir);
        let revocations = RwLock::new(Self::load_revocations(&config.data_dir).await);

        // Load persisted recovery codes.
        let recovery_file = Self::recovery_file_path(&config.data_dir);
        let recovery_codes = RwLock::new(Self::load_recovery_codes(&config.data_dir).await);

        Ok(Self {
            config,
            wdb,
            ws_tx,
            channels: RwLock::new(ChannelManager {
                channel_broadcasts: std::collections::HashMap::new(),
            }),
            session_messages: Arc::new(RwLock::new(HashMap::new())),
            channel_auto_delete_ms: Arc::new(RwLock::new(HashMap::new())),
            channel_auto_delete_label: Arc::new(RwLock::new(HashMap::new())),
            live_channel_ttl_ms: Arc::new(RwLock::new(HashMap::new())),
            live_channel_cap: Arc::new(RwLock::new(HashMap::new())),
            owner_user_id,
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
            sio_broadcast_tx,
            blacklist: RwLock::new(None),
            mesh_service: RwLock::new(None),
            #[cfg(feature = "wabi-lore")]
            lore_service: RwLock::new(None),
            intents_mutex: tokio::sync::Mutex::new(()),
            call_signal_counter: Arc::new(AtomicU64::new(0)),
            call_session_subscriptions: Arc::new(Mutex::new(HashMap::new())),
            ws_conn_id_counter: Arc::new(Mutex::new(0)),
            call_session_push: {
                let (tx, _) = broadcast::channel(1024);
                tx
            },
            steam_cache: Arc::new(Mutex::new(Default::default())),
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

    /// Set the mesh service (called during startup)
    pub async fn set_mesh_service(&self, mesh: Arc<crate::mesh::MeshService>) {
        let mut guard = self.mesh_service.write().await;
        *guard = Some(mesh);
    }

    /// Get the mesh service (if initialized)
    pub async fn get_mesh_status(&self) -> anyhow::Result<crate::mesh::MeshStatus> {
        let guard = self.mesh_service.read().await;
        match guard.as_ref() {
            Some(mesh) => Ok(mesh.get_status().await),
            None => Err(anyhow::anyhow!("Mesh service not initialized")),
        }
    }

    /// Record a heartbeat from a peer node
    pub async fn record_heartbeat(&self, node_id: &str, timestamp: i64) {
        let guard = self.mesh_service.read().await;
        if let Some(mesh) = guard.as_ref() {
            mesh.record_heartbeat(node_id, timestamp).await;
        }
    }

    /// Set the Lore service (called during startup)
    #[cfg(feature = "wabi-lore")]
    pub async fn set_lore_service(&self, lore: Arc<crate::lore::LoreService>) {
        let mut guard = self.lore_service.write().await;
        *guard = Some(lore);
    }

    /// Get mesh configuration
    pub async fn get_mesh_config(&self) -> anyhow::Result<crate::mesh::MeshConfig> {
        let guard = self.mesh_service.read().await;
        match guard.as_ref() {
            Some(mesh) => Ok(mesh.config.clone()),
            None => Err(anyhow::anyhow!("Mesh service not initialized")),
        }
    }

    fn owner_file(data_dir: &str) -> PathBuf {
        PathBuf::from(data_dir).join("server_owner.json")
    }

    /// Legacy migration source. The authoritative owner is now persisted in
    /// the WDB store (see `load_owner` / `claim_ownership`); this only reads
    /// the old JSON file once, to migrate existing deployments.
    fn load_owner_from_disk(data_dir: &str) -> Option<i64> {
        let path = Self::owner_file(data_dir);
        let content = std::fs::read_to_string(path).ok()?;
        let v: serde_json::Value = serde_json::from_str(&content).ok()?;
        v.get("owner_user_id")?.as_i64()
    }

    /// Load the owner from the authoritative WDB store. Falls back to the
    /// legacy JSON file for one-time migration, adopting it into the store.
    async fn load_owner(wdb: &WdbAdapter, data_dir: &str) -> Option<i64> {
        match wdb.get_owner_user_id().await {
            Ok(Some(id)) => return Some(id as i64),
            Ok(None) => {}
            Err(e) => tracing::warn!("[setup] failed to read owner from store: {e}"),
        }
        if let Some(id) = Self::load_owner_from_disk(data_dir) {
            tracing::warn!(
                "[setup] migrating legacy server_owner.json -> WDB store (owner_user_id={})",
                id
            );
            if let Err(e) = wdb.claim_owner(id as u64).await {
                tracing::error!("[setup] failed to migrate owner into store: {e}");
            }
            return Some(id);
        }
        None
    }

    /// Returns true if the server has no owner yet (first-run state).
    pub async fn needs_setup(&self) -> bool {
        self.owner_user_id.read().await.is_none()
    }

    /// Claim ownership. Returns true if this user claimed it (i.e., was
    /// the first registrant). Persists to the WDB store so it is the
    /// authoritative source of truth and survives restarts.
    /// Fails silently if an owner already exists.
    pub async fn claim_ownership(&self, user_id: i64, _username: &str) -> bool {
        let mut guard = self.owner_user_id.write().await;
        if guard.is_some() {
            return false; // already claimed
        }
        if let Err(e) = self.wdb.claim_owner(user_id as u64).await {
            tracing::error!("[setup] failed to persist owner claim: {e}");
            return false;
        }
        *guard = Some(user_id);
        tracing::info!("[setup] owner claimed by user_id={}", user_id);
        true
    }

    /// Get the highest role for a user from WDB RBAC (default workspace)
    /// TODO: wabidb RBAC projection
    pub async fn get_user_highest_role(&self, _user_id: i64) -> String {
        "Member".to_string()
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

    async fn load_revocations(data_dir: &str) -> RevocationStore {
        let path = Self::revocation_file_path(data_dir);
        if let Ok(s) = std::fs::read_to_string(&path) {
            if let Ok(v) = serde_json::from_str::<RevocationStore>(&s) {
                return v;
            }
        }
        RevocationStore::default()
    }

    async fn save_revocations(&self) {
        let guard = self.revocations.read().await;
        if let Ok(s) = serde_json::to_string_pretty(&*guard) {
            let _ = std::fs::write(&self.revocation_file, s);
        }
    }

    /// Revoke a single token by its `jti`. No-op for tokens that lack one.
    pub async fn revoke_token(&self, jti: String) {
        if jti.is_empty() {
            return;
        }
        {
            self.revocations.write().await.jtis.insert(jti);
        }
        self.save_revocations().await;
    }

    /// Revoke every current token for a user (force-logout).
    pub async fn revoke_user(&self, user_id: i64) {
        {
            self.revocations.write().await.users.insert(user_id);
        }
        self.save_revocations().await;
    }

    /// Revoke ALL outstanding tokens by advancing the revocation epoch.
    pub async fn revoke_all_tokens(&self) {
        {
            self.revocations.write().await.epoch =
                chrono::Utc::now().timestamp().max(1) as u64 + 1;
        }
        self.save_revocations().await;
    }

    /// Returns true if the given token claims have been revoked.
    pub async fn is_token_revoked(&self, jti: &str, sub: i64, iat: i64) -> bool {
        let guard = self.revocations.read().await;
        if guard.epoch != 0 && (iat as u64) < guard.epoch {
            return true;
        }
        if guard.users.contains(&sub) {
            return true;
        }
        if !jti.is_empty() && guard.jtis.contains(jti) {
            return true;
        }
        false
    }

    // ─── Recovery codes ──────────────────────────────────────────────────────

    fn recovery_file_path(data_dir: &str) -> PathBuf {
        PathBuf::from(data_dir).join("recovery_codes.json")
    }

    async fn load_recovery_codes(data_dir: &str) -> HashMap<String, i64> {
        let path = Self::recovery_file_path(data_dir);
        if let Ok(s) = std::fs::read_to_string(&path) {
            if let Ok(v) = serde_json::from_str::<HashMap<String, i64>>(&s) {
                return v;
            }
        }
        HashMap::new()
    }

    async fn save_recovery_codes(&self) {
        let guard = self.recovery_codes.read().await;
        if let Ok(s) = serde_json::to_string_pretty(&*guard) {
            let _ = std::fs::write(&self.recovery_file, s);
        }
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
    fn hash_code(code: &str) -> String {
        let mut hasher = Sha256::new();
        hasher.update(code.as_bytes());
        format!("{:x}", hasher.finalize())
    }

    /// Generate `count` one-time recovery codes for `user_id`. The plaintext
    /// codes are returned exactly once; only their hashes are persisted.
    pub async fn generate_recovery_codes(&self, user_id: i64, count: usize) -> Vec<String> {
        let mut plaintext = Vec::new();
        {
            let mut guard = self.recovery_codes.write().await;
            for _ in 0..count {
                let code = uuid::Uuid::new_v4().simple().to_string();
                plaintext.push(code.clone());
                guard.insert(Self::hash_code(&code), user_id);
            }
        }
        self.save_recovery_codes().await;
        plaintext
    }

    /// Consume a recovery code. Returns true only if the code is valid and
    /// bound to `user_id`. The code is single-use.
    pub async fn consume_recovery_code(&self, code: &str, user_id: i64) -> bool {
        let key = Self::hash_code(code);
        let mut guard = self.recovery_codes.write().await;
        match guard.get(&key) {
            Some(&bound) if bound == user_id => {
                guard.remove(&key);
                drop(guard);
                self.save_recovery_codes().await;
                true
            }
            _ => false,
        }
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
        let mut msgs = vec![
            json!({"id": "live_1", "text": "no bornat"}),
        ];
        let expired = reap_live_channel_buffer(&mut msgs, 1, 100, now);
        // bornAt defaults to 0, which means it's expired since now - 0 >= 1
        assert_eq!(expired, vec!["live_1"]);
        assert!(msgs.is_empty());
    }
}
