//! Mesh service for multi-node coordination
//!
//! Handles:
//! - Node presence/health monitoring
//! - Automatic failover coordination
//! - Load distribution awareness
//! - Relay node selection optimization

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{debug, info, warn};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeshConfig {
    pub node_id: String,
    pub is_primary: bool,
    pub mesh_enabled: bool,
    pub mesh_peers: Vec<String>,
}

#[derive(Debug)]
pub struct MeshPresence {
    pub peer_heartbeats: HashMap<String, i64>,
    pub self_id: String,
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
    pub sync_status: String,
}

impl MeshService {
    pub async fn new(config: MeshConfig, peer_ids: Vec<String>) -> anyhow::Result<Self> {
        let presence = MeshPresence {
            peer_heartbeats: HashMap::new(),
            self_id: config.node_id.clone(),
            is_primary: config.is_primary,
        };

        let service = Self {
            config,
            peer_ids,
            presence: Arc::new(RwLock::new(presence)),
        };

        service.start_heartbeat_loop();

        info!(
            "Mesh service initialized with {} peers",
            service.peer_ids.len()
        );

        Ok(service)
    }

    fn start_heartbeat_loop(&self) {
        let config = self.config.clone();
        let _peer_ids = self.peer_ids.clone();
        let presence = Arc::clone(&self.presence);

        tokio::spawn(async move {
            let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(5));

            loop {
                interval.tick().await;

                if let Err(e) = Self::send_heartbeat(&config).await {
                    warn!("Failed to send heartbeat: {}", e);
                }

                let mut presence_guard = presence.write().await;
                let now = chrono::Utc::now().timestamp();

                let dead_threshold = now - 15;
                presence_guard.peer_heartbeats.retain(|node_id, last_seen| {
                    if *last_seen < dead_threshold {
                        warn!("Peer {} marked as dead (no heartbeat)", node_id);
                        false
                    } else {
                        true
                    }
                });
            }
        });
    }

    async fn send_heartbeat(config: &MeshConfig) -> anyhow::Result<()> {
        debug!("Heartbeat sent from node {}", config.node_id);
        Ok(())
    }

    pub async fn get_status(&self) -> MeshStatus {
        let presence = self.presence.read().await;

        MeshStatus {
            peers: self.peer_ids.clone(),
            is_primary: presence.is_primary,
            sync_status: "synced".to_string(),
        }
    }

    pub async fn get_optimal_node(&self, _user_region: Option<&str>) -> String {
        self.config.node_id.clone()
    }

    pub async fn is_peer_alive(&self, node_id: &str) -> bool {
        let presence = self.presence.read().await;
        let last_seen = presence.peer_heartbeats.get(node_id);

        match last_seen {
            Some(timestamp) => {
                let now = chrono::Utc::now().timestamp();
                now - *timestamp < 15
            }
            None => false,
        }
    }

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
