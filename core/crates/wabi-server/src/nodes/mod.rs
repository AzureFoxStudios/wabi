//! Helper-node registry core.
//!
//! Phase 1 owns helper identity, pairing, heartbeat, reachability, and revocation
//! inside `wabi-server` core. This is deliberately not federation and not the old
//! `wabi-mesh` addon.

use chrono::{DateTime, Duration as ChronoDuration, Utc};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, path::PathBuf, sync::Arc, time::Duration};
use thiserror::Error;
use tokio::sync::RwLock;
use uuid::Uuid;

#[derive(Clone, Debug)]
pub struct NodeRegistry {
    authority_node_id: String,
    storage_path: Option<PathBuf>,
    inner: Arc<RwLock<NodeRegistryData>>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct NodeRegistryData {
    nodes: Vec<HelperNode>,
    pairing_tokens: Vec<NodePairingToken>,
    node_secrets: HashMap<String, String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NodeCapability {
    CpuWorker,
    ThumbnailWorker,
    TranscodeWorker,
    SearchIndexer,
    FileCache,
    MediaRelay,
    Backup,
    GpuWorker,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NodeReachability {
    OutboundOnly,
    LanReachable,
    PublicReachable,
    RelayReachable,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NodeStatus {
    Pending,
    Online,
    Offline,
    Revoked,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NodeLoad {
    pub cpu_percent: Option<f32>,
    pub memory_used_mb: Option<u64>,
    pub memory_total_mb: Option<u64>,
    pub upload_mbps: Option<f32>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HelperNode {
    pub node_id: String,
    pub display_name: String,
    pub public_key: String,
    pub capabilities: Vec<NodeCapability>,
    pub reachability: NodeReachability,
    pub endpoint: Option<String>,
    pub status: NodeStatus,
    pub load: NodeLoad,
    pub paired_at: DateTime<Utc>,
    pub last_heartbeat_at: Option<DateTime<Utc>>,
    pub revoked_at: Option<DateTime<Utc>>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NodePairingToken {
    pub token_id: String,
    pub token: String,
    pub label: String,
    pub capabilities: Vec<NodeCapability>,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub used_at: Option<DateTime<Utc>>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinNodeRequest {
    pub token: String,
    pub display_name: String,
    pub public_key: String,
    pub reachability: NodeReachability,
    pub endpoint: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinNodeResponse {
    pub node: HelperNode,
    pub node_secret: String,
    pub authority_node_id: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeHeartbeatRequest {
    #[serde(default)]
    pub load: NodeLoad,
    #[serde(default = "default_reachability")]
    pub reachability: NodeReachability,
    #[serde(default)]
    pub endpoint: Option<String>,
    #[serde(default)]
    pub capabilities: Option<Vec<NodeCapability>>,
}

fn default_reachability() -> NodeReachability {
    NodeReachability::OutboundOnly
}

impl Default for NodeReachability {
    fn default() -> Self {
        Self::OutboundOnly
    }
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum NodeRegistryError {
    #[error("pairing token not found")]
    PairingTokenNotFound,
    #[error("pairing token expired")]
    PairingTokenExpired,
    #[error("pairing token already used")]
    PairingTokenAlreadyUsed,
    #[error("node not found")]
    NodeNotFound,
    #[error("node secret did not match")]
    InvalidNodeSecret,
    #[error("node has been revoked")]
    NodeRevoked,
    #[error("invalid node input: {0}")]
    InvalidInput(String),
    #[error("persistence failed: {0}")]
    Persistence(String),
}

impl NodeRegistry {
    #[cfg(test)]
    pub fn new_in_memory(authority_node_id: String) -> Self {
        Self {
            authority_node_id,
            storage_path: None,
            inner: Arc::new(RwLock::new(NodeRegistryData::default())),
        }
    }

    pub fn new_persistent(authority_node_id: String, storage_path: PathBuf) -> Self {
        let data = std::fs::read_to_string(&storage_path)
            .ok()
            .and_then(|content| serde_json::from_str::<NodeRegistryData>(&content).ok())
            .unwrap_or_default();
        Self {
            authority_node_id,
            storage_path: Some(storage_path),
            inner: Arc::new(RwLock::new(data)),
        }
    }

    pub async fn list_nodes(&self) -> Vec<HelperNode> {
        self.inner.read().await.nodes.clone()
    }

    pub async fn list_pairing_tokens(&self) -> Vec<NodePairingToken> {
        self.inner.read().await.pairing_tokens.clone()
    }

    pub async fn create_pairing_token(
        &self,
        label: String,
        capabilities: Vec<NodeCapability>,
        ttl: Duration,
    ) -> Result<NodePairingToken, NodeRegistryError> {
        let label = label.trim().to_string();
        if label.is_empty() {
            return Err(NodeRegistryError::InvalidInput(
                "label cannot be empty".into(),
            ));
        }
        if capabilities.is_empty() {
            return Err(NodeRegistryError::InvalidInput(
                "at least one capability is required".into(),
            ));
        }
        let now = Utc::now();
        let ttl = ChronoDuration::from_std(ttl)
            .map_err(|e| NodeRegistryError::InvalidInput(e.to_string()))?;
        let token = NodePairingToken {
            token_id: new_id("pair"),
            token: new_secret("wabi_pair"),
            label,
            capabilities,
            created_at: now,
            expires_at: now + ttl,
            used_at: None,
        };

        let mut data = self.inner.write().await;
        data.pairing_tokens.push(token.clone());
        self.persist_locked(&data).await?;
        Ok(token)
    }

    pub async fn join_with_token(
        &self,
        req: JoinNodeRequest,
    ) -> Result<JoinNodeResponse, NodeRegistryError> {
        let display_name = req.display_name.trim().to_string();
        if display_name.is_empty() {
            return Err(NodeRegistryError::InvalidInput(
                "display_name cannot be empty".into(),
            ));
        }
        if req.public_key.trim().is_empty() {
            return Err(NodeRegistryError::InvalidInput(
                "public_key cannot be empty".into(),
            ));
        }

        let now = Utc::now();
        let mut data = self.inner.write().await;
        let token = data
            .pairing_tokens
            .iter_mut()
            .find(|token| token.token == req.token)
            .ok_or(NodeRegistryError::PairingTokenNotFound)?;

        if token.used_at.is_some() {
            return Err(NodeRegistryError::PairingTokenAlreadyUsed);
        }
        if token.expires_at <= now {
            return Err(NodeRegistryError::PairingTokenExpired);
        }

        token.used_at = Some(now);
        let node_secret = new_secret("wabi_node");
        let node = HelperNode {
            node_id: new_id("node"),
            display_name,
            public_key: req.public_key,
            capabilities: token.capabilities.clone(),
            reachability: req.reachability,
            endpoint: req.endpoint,
            status: NodeStatus::Pending,
            load: NodeLoad::default(),
            paired_at: now,
            last_heartbeat_at: None,
            revoked_at: None,
        };
        data.node_secrets
            .insert(node.node_id.clone(), node_secret.clone());
        data.nodes.push(node.clone());
        self.persist_locked(&data).await?;

        Ok(JoinNodeResponse {
            node,
            node_secret,
            authority_node_id: self.authority_node_id.clone(),
        })
    }

    pub async fn record_heartbeat(
        &self,
        node_id: &str,
        node_secret: &str,
        req: NodeHeartbeatRequest,
    ) -> Result<HelperNode, NodeRegistryError> {
        let mut data = self.inner.write().await;
        let expected_secret = data
            .node_secrets
            .get(node_id)
            .ok_or(NodeRegistryError::InvalidNodeSecret)?;
        if expected_secret != node_secret {
            return Err(NodeRegistryError::InvalidNodeSecret);
        }

        let node = data
            .nodes
            .iter_mut()
            .find(|node| node.node_id == node_id)
            .ok_or(NodeRegistryError::NodeNotFound)?;

        if node.status == NodeStatus::Revoked {
            return Err(NodeRegistryError::NodeRevoked);
        }

        node.status = NodeStatus::Online;
        node.last_heartbeat_at = Some(Utc::now());
        node.load = req.load;
        node.reachability = req.reachability;
        node.endpoint = req.endpoint;
        if let Some(capabilities) = req.capabilities {
            if !capabilities.is_empty() {
                node.capabilities = capabilities;
            }
        }
        let updated = node.clone();
        self.persist_locked(&data).await?;
        Ok(updated)
    }

    pub async fn revoke_node(&self, node_id: &str) -> Result<HelperNode, NodeRegistryError> {
        let mut data = self.inner.write().await;
        let node = data
            .nodes
            .iter_mut()
            .find(|node| node.node_id == node_id)
            .ok_or(NodeRegistryError::NodeNotFound)?;
        node.status = NodeStatus::Revoked;
        node.revoked_at = Some(Utc::now());
        let updated = node.clone();
        self.persist_locked(&data).await?;
        Ok(updated)
    }

    /// Mark nodes offline if their last heartbeat is older than the threshold.
    pub async fn mark_stale_nodes_offline(&self, threshold: Duration) -> Vec<HelperNode> {
        let mut changed = Vec::new();
        let mut data = self.inner.write().await;
        let now = Utc::now();
        let threshold = match ChronoDuration::from_std(threshold) {
            Ok(d) => d,
            Err(_) => return changed,
        };
        for node in data.nodes.iter_mut() {
            if node.status != NodeStatus::Online {
                continue;
            }
            let Some(last) = node.last_heartbeat_at else {
                continue;
            };
            if now - last > threshold {
                node.status = NodeStatus::Offline;
                changed.push(node.clone());
            }
        }
        if !changed.is_empty() {
            let _ = self.persist_locked(&data).await;
        }
        changed
    }

    async fn persist_locked(&self, data: &NodeRegistryData) -> Result<(), NodeRegistryError> {
        let Some(path) = &self.storage_path else {
            return Ok(());
        };
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| NodeRegistryError::Persistence(e.to_string()))?;
        }
        let content = serde_json::to_string_pretty(data)
            .map_err(|e| NodeRegistryError::Persistence(e.to_string()))?;
        tokio::fs::write(path, content)
            .await
            .map_err(|e| NodeRegistryError::Persistence(e.to_string()))
    }
}

fn new_id(prefix: &str) -> String {
    format!("{}-{}", prefix, Uuid::new_v4())
}

fn new_secret(prefix: &str) -> String {
    format!(
        "{}_{}{}",
        prefix,
        Uuid::new_v4().simple(),
        Uuid::new_v4().simple()
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn test_registry() -> NodeRegistry {
        NodeRegistry::new_in_memory("authority-test".to_string())
    }

    #[tokio::test]
    async fn pairing_token_is_single_use_and_creates_node_credentials() {
        let registry = test_registry();
        let token = registry
            .create_pairing_token(
                "media-helper".to_string(),
                vec![NodeCapability::MediaRelay, NodeCapability::ThumbnailWorker],
                Duration::from_secs(60),
            )
            .await
            .expect("token created");

        let joined = registry
            .join_with_token(JoinNodeRequest {
                token: token.token.clone(),
                display_name: "Ronin-Gaming-PC".to_string(),
                public_key: "helper-public-key".to_string(),
                reachability: NodeReachability::OutboundOnly,
                endpoint: None,
            })
            .await
            .expect("token can be redeemed once");

        assert_eq!(joined.node.display_name, "Ronin-Gaming-PC");
        assert_eq!(joined.node.capabilities, token.capabilities);
        assert!(!joined.node_secret.is_empty());

        let second_join = registry
            .join_with_token(JoinNodeRequest {
                token: token.token,
                display_name: "second-helper".to_string(),
                public_key: "second-public-key".to_string(),
                reachability: NodeReachability::OutboundOnly,
                endpoint: None,
            })
            .await;

        assert!(matches!(
            second_join,
            Err(NodeRegistryError::PairingTokenAlreadyUsed)
        ));
    }

    #[tokio::test]
    async fn heartbeat_updates_load_and_reachability_when_secret_matches() {
        let registry = test_registry();
        let token = registry
            .create_pairing_token(
                "worker".to_string(),
                vec![NodeCapability::CpuWorker],
                Duration::from_secs(60),
            )
            .await
            .expect("token created");
        let joined = registry
            .join_with_token(JoinNodeRequest {
                token: token.token,
                display_name: "worker-1".to_string(),
                public_key: "worker-key".to_string(),
                reachability: NodeReachability::OutboundOnly,
                endpoint: None,
            })
            .await
            .expect("joined");

        registry
            .record_heartbeat(
                &joined.node.node_id,
                &joined.node_secret,
                NodeHeartbeatRequest {
                    load: NodeLoad {
                        cpu_percent: Some(21.5),
                        memory_used_mb: Some(2048),
                        memory_total_mb: Some(8192),
                        upload_mbps: Some(55.0),
                    },
                    reachability: NodeReachability::LanReachable,
                    endpoint: Some("https://worker.lan:9443".to_string()),
                    capabilities: Some(vec![NodeCapability::CpuWorker, NodeCapability::FileCache]),
                },
            )
            .await
            .expect("heartbeat accepted");

        let nodes = registry.list_nodes().await;
        let node = nodes
            .iter()
            .find(|n| n.node_id == joined.node.node_id)
            .unwrap();
        assert_eq!(node.status, NodeStatus::Online);
        assert_eq!(node.reachability, NodeReachability::LanReachable);
        assert_eq!(node.endpoint.as_deref(), Some("https://worker.lan:9443"));
        assert_eq!(node.load.cpu_percent, Some(21.5));
        assert_eq!(
            node.capabilities,
            vec![NodeCapability::CpuWorker, NodeCapability::FileCache]
        );
    }

    #[tokio::test]
    async fn revoked_nodes_reject_heartbeats() {
        let registry = test_registry();
        let token = registry
            .create_pairing_token(
                "worker".to_string(),
                vec![NodeCapability::CpuWorker],
                Duration::from_secs(60),
            )
            .await
            .expect("token created");
        let joined = registry
            .join_with_token(JoinNodeRequest {
                token: token.token,
                display_name: "worker-1".to_string(),
                public_key: "worker-key".to_string(),
                reachability: NodeReachability::OutboundOnly,
                endpoint: None,
            })
            .await
            .expect("joined");

        registry
            .revoke_node(&joined.node.node_id)
            .await
            .expect("revoked");

        let result = registry
            .record_heartbeat(
                &joined.node.node_id,
                &joined.node_secret,
                NodeHeartbeatRequest::default(),
            )
            .await;

        assert!(matches!(result, Err(NodeRegistryError::NodeRevoked)));
    }
}
