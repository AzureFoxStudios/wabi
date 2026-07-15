//! Mesh coordination service for multi-node integration
//!
//! Provides node discovery, heartbeat management, and coordination
//! for distributed Wabi deployments.

use serde::{Deserialize, Serialize};
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
    pub sync_status: String,
}

impl MeshService {
    pub async fn new(config: MeshConfig, peer_ids: Vec<String>) -> anyhow::Result<Self> {
        let presence = MeshPresence {
            peer_heartbeats: std::collections::HashMap::new(),
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
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(3))
            .build()?;

        let payload = serde_json::json!({
            "node_id": config.node_id,
            "is_primary": config.is_primary,
            "timestamp": chrono::Utc::now().timestamp(),
        });

        for peer in &config.mesh_peers {
            let url = format!("{}/api/mesh/heartbeat", peer.trim_end_matches('/'));
            match client.post(&url).json(&payload).send().await {
                Ok(resp) => {
                    if resp.status().is_success() {
                        debug!("Heartbeat sent to peer {}", peer);
                    } else {
                        warn!("Heartbeat to {} returned status {}", peer, resp.status());
                    }
                }
                Err(e) => {
                    warn!("Heartbeat to {} failed: {}", peer, e);
                }
            }
        }

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

    #[allow(dead_code)]
    pub async fn get_optimal_node(&self, _user_region: Option<&str>) -> String {
        self.config.node_id.clone()
    }

    #[allow(dead_code)]
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

    pub async fn record_heartbeat(&self, node_id: &str, timestamp: i64) {
        let mut presence = self.presence.write().await;
        presence.peer_heartbeats.insert(node_id.to_string(), timestamp);
        debug!("Recorded heartbeat from peer {}", node_id);
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
