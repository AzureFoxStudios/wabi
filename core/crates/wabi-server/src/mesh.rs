//! Retired legacy peer-heartbeat coordinator.
//!
//! `WABI_MESH_ENABLED` used to initialize an experimental coordinator that
//! posted to `/api/mesh/heartbeat`, but no receiver route exists in the current
//! server. Leaving that loop active creates noisy 404s and, worse, suggests a
//! state/failover feature exists when it does not.
//!
//! Current multi-node paths are deliberately separate:
//! - helper identity/health/capabilities: `nodes/`
//! - WabiDB state replication: `WABIDB_PEER_ENDPOINT` + `WABI_SYNC_TOKEN`
//! - regional HTTP gateway: `WABI_SERVER_ROLE=anchor`

use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::RwLock;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeshConfig {
    pub node_id: String,
    pub is_primary: bool,
    pub mesh_enabled: bool,
    pub mesh_peers: Vec<String>,
}

#[derive(Debug)]
pub struct MeshPresence {
    pub peer_heartbeats: std::collections::HashMap<String, i64>,
    pub is_primary: bool,
}

pub struct MeshService {
    pub config: MeshConfig,
    pub peer_ids: Vec<String>,
    pub presence: Arc<RwLock<MeshPresence>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeshStatus {
    pub peers: Vec<String>,
    pub is_primary: bool,
    /// Compatibility field retained for older admin clients. It must never be
    /// interpreted as WabiDB replication health.
    pub sync_status: String,
}

impl MeshService {
    /// The old `WABI_MESH_ENABLED` coordinator is intentionally retired.
    ///
    /// Returning an error lets existing startup code degrade to `None` while
    /// logging one actionable warning instead of starting a heartbeat loop to
    /// an endpoint that does not exist.
    pub async fn new(_config: MeshConfig, _peer_ids: Vec<String>) -> anyhow::Result<Self> {
        Err(anyhow::anyhow!(
            "WABI_MESH_ENABLED is retired: use helper nodes for worker/media health, WABIDB_PEER_ENDPOINT + WABI_SYNC_TOKEN for state replication, or WABI_SERVER_ROLE=anchor for a regional HTTP gateway"
        ))
    }

    pub async fn get_status(&self) -> MeshStatus {
        let presence = self.presence.read().await;
        MeshStatus {
            peers: self.peer_ids.clone(),
            is_primary: presence.is_primary,
            sync_status: "retired".to_string(),
        }
    }

    #[allow(dead_code)]
    pub async fn get_optimal_node(&self, _user_region: Option<&str>) -> String {
        self.config.node_id.clone()
    }

    #[allow(dead_code)]
    pub async fn is_peer_alive(&self, node_id: &str) -> bool {
        let presence = self.presence.read().await;
        let last_seen = presence.peer_heartbeats.get(node_id);
        match last_seen {
            Some(timestamp) => chrono::Utc::now().timestamp() - *timestamp < 15,
            None => false,
        }
    }

    #[allow(dead_code)]
    pub async fn record_heartbeat(&self, node_id: &str, timestamp: i64) {
        let mut presence = self.presence.write().await;
        presence.peer_heartbeats.insert(node_id.to_string(), timestamp);
    }

    #[allow(dead_code)]
    pub async fn get_alive_peers(&self) -> Vec<String> {
        let presence = self.presence.read().await;
        let now = chrono::Utc::now().timestamp();
        presence
            .peer_heartbeats
            .iter()
            .filter(|(_, timestamp)| now - **timestamp < 15)
            .map(|(node_id, _)| node_id.clone())
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn legacy_mesh_runtime_fails_closed_with_migration_guidance() {
        let error = MeshService::new(
            MeshConfig {
                node_id: "legacy-node".into(),
                is_primary: true,
                mesh_enabled: true,
                mesh_peers: vec!["https://peer.example".into()],
            },
            vec!["https://peer.example".into()],
        )
        .await
        .err()
        .expect("legacy coordinator must remain disabled");
        let message = error.to_string();
        assert!(message.contains("WABIDB_PEER_ENDPOINT"));
        assert!(message.contains("WABI_SERVER_ROLE=anchor"));
    }
}
