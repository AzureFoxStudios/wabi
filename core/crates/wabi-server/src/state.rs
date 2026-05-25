//! Application state shared across handlers

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::{broadcast, RwLock};

use crate::api::upload::UploadState;
use crate::blacklist::BlacklistManager;
use crate::config::ServerConfig;
use crate::db::StdbClient;
use crate::nodes::NodeRegistry;

/// In-memory message cache shared between Socket.IO and HTTP handlers.
/// channel_id → Vec of message JSON objects (capped at 1000 per channel).
pub type SessionMessages = Arc<RwLock<HashMap<String, Vec<serde_json::Value>>>>;

/// Shared application state
pub struct AppState {
    pub config: ServerConfig,
    pub stdb: StdbClient,
    pub ws_tx: broadcast::Sender<Arc<crate::websocket::WsMessage>>,
    #[allow(dead_code)]
    pub channels: RwLock<ChannelManager>,
    pub session_messages: SessionMessages,
    /// The user ID of the server owner (first registrant).
    /// None until the first account is created.
    pub owner_user_id: RwLock<Option<i64>>,
    /// Upload session state (in-memory, not persisted)
    pub upload_state: UploadState,
    /// Core helper-node registry (authority-owned; not federation)
    pub node_registry: NodeRegistry,
    /// Broadcasts the SocketIo handle so HTTP handlers (like avatar upload) can emit events
    #[allow(dead_code)]
    pub sio_broadcast_tx: broadcast::Sender<socketioxide::SocketIo>,
    /// Blacklist manager for bans
    pub blacklist: RwLock<Option<Arc<BlacklistManager>>>,
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

impl AppState {
    pub fn new(config: ServerConfig) -> Self {
        let (ws_tx, _) = broadcast::channel(1000);
        let (sio_broadcast_tx, _) = broadcast::channel(1);
        let stdb = StdbClient::new(
            config.stdb_uri.clone(),
            config.stdb_database.clone(),
            std::env::var("WABI_STDB_TOKEN").ok(),
        );
        let owner_user_id = RwLock::new(Self::load_owner_from_disk(&config.data_dir));
        let node_registry = NodeRegistry::new_persistent(
            config.node_id.clone(),
            PathBuf::from(&config.data_dir).join("node_registry.json"),
        );
        Self {
            config,
            stdb,
            ws_tx,
            channels: RwLock::new(ChannelManager {
                channel_broadcasts: std::collections::HashMap::new(),
            }),
            session_messages: Arc::new(RwLock::new(HashMap::new())),
            owner_user_id,
            upload_state: UploadState::new(),
            node_registry,
            sio_broadcast_tx,
            blacklist: RwLock::new(None),
        }
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

    fn owner_file(data_dir: &str) -> PathBuf {
        PathBuf::from(data_dir).join("server_owner.json")
    }

    fn load_owner_from_disk(data_dir: &str) -> Option<i64> {
        let path = Self::owner_file(data_dir);
        let content = std::fs::read_to_string(path).ok()?;
        let v: serde_json::Value = serde_json::from_str(&content).ok()?;
        v.get("owner_user_id")?.as_i64()
    }

    /// Returns true if the server has no owner yet (first-run state).
    pub async fn needs_setup(&self) -> bool {
        self.owner_user_id.read().await.is_none()
    }

    /// Claim ownership. Writes to disk so it survives restarts.
    /// Fails silently if an owner already exists.
    pub async fn claim_ownership(&self, user_id: i64, username: &str) {
        let mut guard = self.owner_user_id.write().await;
        if guard.is_some() {
            return; // already claimed
        }
        *guard = Some(user_id);
        let path = Self::owner_file(&self.config.data_dir);
        let payload = serde_json::json!({
            "owner_user_id": user_id,
            "owner_username": username,
        });
        if let Ok(s) = serde_json::to_string_pretty(&payload) {
            let _ = std::fs::write(path, s);
        }
        tracing::info!("[setup] owner claimed by {} (id={})", username, user_id);
    }

    /// Get the highest role for a user from STDB RBAC (default workspace)
    pub async fn get_user_highest_role(&self, user_id: i64) -> String {
        if let Ok(result) = self.stdb.sql_query(
            &format!("SELECT role FROM state_rbac_assignment WHERE user_id = {} AND workspace_id = 'default-workspace' AND active = true LIMIT 1", user_id)
        ).await {
            if let Some(row) = result.decode_rows().into_iter().next() {
                if let Some(role_val) = row.get("role") {
                    if let Some(role_str) = role_val.as_str() {
                        return role_str.to_string();
                    }
                }
            }
        }
        if *self.owner_user_id.read().await == Some(user_id) {
            return "owner".to_string();
        }
        if user_id > 0 {
            return "member".to_string();
        }
        "guest".to_string()
    }

    /// Returns true if the user is the owner, in the admin list, or has 'admin' role in STDB
    pub async fn is_admin(&self, user_id: i64) -> bool {
        if self.config.admin_user_ids.contains(&user_id) {
            return true;
        }
        if *self.owner_user_id.read().await == Some(user_id) {
            return true;
        }
        // Check STDB for admin/owner role
        if let Ok(result) = self.stdb.sql_query(
            &format!("SELECT role FROM state_rbac_assignment WHERE user_id = {} AND workspace_id = 'default-workspace' AND role IN ('admin', 'owner') AND active = true LIMIT 1", user_id)
        ).await {
            return !result.decode_rows().is_empty();
        }
        false
    }

    /// Get mesh status (for health checks)
    #[allow(dead_code)]
    pub fn get_mesh_status(&self) -> anyhow::Result<MeshStatusInfo> {
        Ok(MeshStatusInfo {
            peers: self.config.mesh_peers.clone(),
            is_primary: self.config.is_primary,
            sync_status: if self.config.mesh_enabled {
                "synced"
            } else {
                "standalone"
            }
            .to_string(),
        })
    }
}

/// Mesh status information (for health endpoint)
#[allow(dead_code)]
pub struct MeshStatusInfo {
    pub peers: Vec<String>,
    pub is_primary: bool,
    pub sync_status: String,
}
