//! Helper-node registry core.
//!
//! Phase 1 owns helper identity, pairing, heartbeat, reachability, and revocation
//! inside `wabi-server` core. This is deliberately not federation and not the old
//! `wabi-mesh` addon.

use chrono::{DateTime, Duration as ChronoDuration, Utc};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    io::Write,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
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
    BlobCache,
    Backup,
    Standby,
    Anchor,
    GpuWorker,
}

impl std::fmt::Display for NodeCapability {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let s = match self {
            NodeCapability::CpuWorker => "cpu_worker",
            NodeCapability::ThumbnailWorker => "thumbnail_worker",
            NodeCapability::TranscodeWorker => "transcode_worker",
            NodeCapability::SearchIndexer => "search_indexer",
            NodeCapability::FileCache => "file_cache",
            NodeCapability::MediaRelay => "media_relay",
            NodeCapability::BlobCache => "blob_cache",
            NodeCapability::Backup => "backup",
            NodeCapability::Standby => "standby",
            NodeCapability::Anchor => "anchor",
            NodeCapability::GpuWorker => "gpu_worker",
        };
        write!(f, "{}", s)
    }
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

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StandbySnapshotMetadata {
    pub last_snapshot_id: Option<String>,
    pub last_snapshot_at: Option<DateTime<Utc>>,
    pub last_snapshot_status: Option<String>,
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
    /// LAN-reachable address reported by the helper, e.g. "http://192.168.1.42:9999".
    /// Used by the authority to route same-LAN clients directly to this helper.
    #[serde(default)]
    pub lan_reachable_at: Option<String>,
    /// Snapshot status for high-trust standby/backup nodes.
    #[serde(default)]
    pub standby: StandbySnapshotMetadata,
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
    /// If the helper is reachable on the local LAN, it should report its LAN address here
    /// (e.g. "http://192.168.1.42:9999"). The authority can then issue signed route tokens
    /// pointing LAN clients to this helper directly.
    #[serde(default)]
    pub lan_reachable_at: Option<String>,
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

    pub fn new_persistent(
        authority_node_id: String,
        storage_path: PathBuf,
    ) -> Result<Self, NodeRegistryError> {
        let data = match std::fs::symlink_metadata(&storage_path) {
            Ok(metadata) => {
                if !metadata.is_file() || metadata.file_type().is_symlink() {
                    return Err(NodeRegistryError::Persistence(format!(
                        "node registry is not a regular file: {}",
                        storage_path.display()
                    )));
                }
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    if metadata.permissions().mode() & 0o077 != 0 {
                        std::fs::set_permissions(
                            &storage_path,
                            std::fs::Permissions::from_mode(0o600),
                        )
                        .map_err(|error| {
                            NodeRegistryError::Persistence(format!(
                                "cannot make node registry private: {error}"
                            ))
                        })?;
                    }
                }
                let content = std::fs::read_to_string(&storage_path)
                    .map_err(|error| NodeRegistryError::Persistence(error.to_string()))?;
                serde_json::from_str::<NodeRegistryData>(&content).map_err(|error| {
                    NodeRegistryError::Persistence(format!(
                        "invalid node registry {}: {error}",
                        storage_path.display()
                    ))
                })?
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                NodeRegistryData::default()
            }
            Err(error) => return Err(NodeRegistryError::Persistence(error.to_string())),
        };
        Ok(Self {
            authority_node_id,
            storage_path: Some(storage_path),
            inner: Arc::new(RwLock::new(data)),
        })
    }

    pub fn authority_node_id(&self) -> Option<&str> {
        Some(self.authority_node_id.as_str())
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
        let mut next = data.clone();
        next.pairing_tokens.push(token.clone());
        self.persist_locked(&next).await?;
        *data = next;
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
        let mut next = data.clone();
        let token = next
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
            lan_reachable_at: None,
            standby: StandbySnapshotMetadata::default(),
        };
        next.node_secrets
            .insert(node.node_id.clone(), node_secret.clone());
        next.nodes.push(node.clone());
        self.persist_locked(&next).await?;
        *data = next;

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
        let mut next = data.clone();
        let expected_secret = next
            .node_secrets
            .get(node_id)
            .ok_or(NodeRegistryError::InvalidNodeSecret)?;
        if expected_secret != node_secret {
            return Err(NodeRegistryError::InvalidNodeSecret);
        }

        let node = next
            .nodes
            .iter_mut()
            .find(|node| node.node_id == node_id)
            .ok_or(NodeRegistryError::NodeNotFound)?;

        if node.status == NodeStatus::Revoked {
            return Err(NodeRegistryError::NodeRevoked);
        }
        if req.capabilities.as_ref().is_some_and(|requested| {
            requested
                .iter()
                .any(|capability| !node.capabilities.contains(capability))
        }) {
            return Err(NodeRegistryError::InvalidInput(
                "heartbeat cannot grant an unpaired node capability".into(),
            ));
        }

        node.status = NodeStatus::Online;
        node.last_heartbeat_at = Some(Utc::now());
        node.load = req.load;
        node.reachability = req.reachability;
        node.endpoint = req.endpoint;
        node.lan_reachable_at = req.lan_reachable_at;
        // Pairing fixes the granted capability set. A helper's own heartbeat
        // may report a subset, but it cannot upgrade its trust or replace the
        // operator-approved grants stored here.
        let updated = node.clone();
        self.persist_locked(&next).await?;
        *data = next;
        Ok(updated)
    }

    pub async fn authenticate_node(
        &self,
        node_id: &str,
        node_secret: &str,
    ) -> Result<HelperNode, NodeRegistryError> {
        let data = self.inner.read().await;
        let expected_secret = data
            .node_secrets
            .get(node_id)
            .ok_or(NodeRegistryError::InvalidNodeSecret)?;
        if expected_secret != node_secret {
            return Err(NodeRegistryError::InvalidNodeSecret);
        }
        let node = data
            .nodes
            .iter()
            .find(|node| node.node_id == node_id)
            .ok_or(NodeRegistryError::NodeNotFound)?;
        if node.status == NodeStatus::Revoked {
            return Err(NodeRegistryError::NodeRevoked);
        }
        Ok(node.clone())
    }

    pub async fn record_standby_snapshot(
        &self,
        node_id: &str,
        snapshot_id: &str,
        status: impl Into<String>,
    ) -> Result<HelperNode, NodeRegistryError> {
        let mut data = self.inner.write().await;
        let mut next = data.clone();
        let node = next
            .nodes
            .iter_mut()
            .find(|node| node.node_id == node_id)
            .ok_or(NodeRegistryError::NodeNotFound)?;
        if node.status == NodeStatus::Revoked {
            return Err(NodeRegistryError::NodeRevoked);
        }
        if !node.capabilities.contains(&NodeCapability::Standby)
            && !node.capabilities.contains(&NodeCapability::Backup)
        {
            return Err(NodeRegistryError::InvalidInput(
                "node does not have standby or backup capability".into(),
            ));
        }
        node.standby.last_snapshot_id = Some(snapshot_id.to_string());
        node.standby.last_snapshot_at = Some(Utc::now());
        node.standby.last_snapshot_status = Some(status.into());
        let updated = node.clone();
        self.persist_locked(&next).await?;
        *data = next;
        Ok(updated)
    }

    pub async fn revoke_node(&self, node_id: &str) -> Result<HelperNode, NodeRegistryError> {
        let mut data = self.inner.write().await;
        let mut next = data.clone();
        let node = next
            .nodes
            .iter_mut()
            .find(|node| node.node_id == node_id)
            .ok_or(NodeRegistryError::NodeNotFound)?;
        node.status = NodeStatus::Revoked;
        node.revoked_at = Some(Utc::now());
        let updated = node.clone();
        self.persist_locked(&next).await?;
        *data = next;
        Ok(updated)
    }

    /// Mark nodes offline if their last heartbeat is older than the threshold.
    pub async fn mark_stale_nodes_offline(
        &self,
        threshold: Duration,
    ) -> Result<Vec<HelperNode>, NodeRegistryError> {
        let mut changed = Vec::new();
        let mut data = self.inner.write().await;
        let mut next = data.clone();
        let now = Utc::now();
        let threshold = match ChronoDuration::from_std(threshold) {
            Ok(d) => d,
            Err(_) => return Ok(changed),
        };
        for node in next.nodes.iter_mut() {
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
            self.persist_locked(&next).await?;
            *data = next;
        }
        Ok(changed)
    }

    pub async fn find_online_node_with_capability(
        &self,
        capability: NodeCapability,
    ) -> Option<HelperNode> {
        let data = self.inner.read().await;
        for node in &data.nodes {
            if node.status != NodeStatus::Online {
                continue;
            }
            if node.capabilities.contains(&capability) {
                return Some(node.clone());
            }
        }
        None
    }

    async fn persist_locked(&self, data: &NodeRegistryData) -> Result<(), NodeRegistryError> {
        let Some(path) = &self.storage_path else {
            return Ok(());
        };
        let path = path.clone();
        let content = serde_json::to_vec_pretty(data)
            .map_err(|e| NodeRegistryError::Persistence(e.to_string()))?;
        tokio::task::spawn_blocking(move || persist_private_registry(&path, &content))
            .await
            .map_err(|error| NodeRegistryError::Persistence(error.to_string()))?
    }
}

fn persist_private_registry(path: &Path, content: &[u8]) -> Result<(), NodeRegistryError> {
    use std::fs::{self, OpenOptions};
    #[cfg(unix)]
    use std::os::unix::fs::OpenOptionsExt;

    let parent = path
        .parent()
        .ok_or_else(|| NodeRegistryError::Persistence("node registry path has no parent".into()))?;
    fs::create_dir_all(parent)
        .map_err(|error| NodeRegistryError::Persistence(error.to_string()))?;
    match fs::symlink_metadata(path) {
        Ok(metadata) if !metadata.is_file() || metadata.file_type().is_symlink() => {
            return Err(NodeRegistryError::Persistence(format!(
                "node registry is not a regular file: {}",
                path.display()
            )));
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(NodeRegistryError::Persistence(error.to_string())),
    }

    let temporary = parent.join(format!(".node-registry-{}.tmp", Uuid::new_v4()));
    let result = (|| -> std::io::Result<()> {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut file = options.open(&temporary)?;
        file.write_all(content)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, path)?;
        #[cfg(unix)]
        fs::File::open(parent)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result.map_err(|error| {
        NodeRegistryError::Persistence(format!(
            "could not save node registry {}: {error}",
            path.display()
        ))
    })
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

    #[test]
    fn damaged_persistent_registry_refuses_startup() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("node_registry.json");
        std::fs::write(&path, b"{incomplete").unwrap();
        assert!(matches!(
            NodeRegistry::new_persistent("authority-test".into(), path),
            Err(NodeRegistryError::Persistence(_))
        ));
    }

    #[cfg(unix)]
    #[test]
    fn existing_registry_is_private_and_symlink_is_rejected() {
        use std::os::unix::fs::{symlink, PermissionsExt};

        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("node_registry.json");
        std::fs::write(
            &path,
            serde_json::to_vec(&NodeRegistryData::default()).unwrap(),
        )
        .unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        NodeRegistry::new_persistent("authority-test".into(), path.clone()).unwrap();
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o077,
            0
        );

        let link = temp.path().join("linked-registry.json");
        symlink(&path, &link).unwrap();
        assert!(matches!(
            NodeRegistry::new_persistent("authority-test".into(), link),
            Err(NodeRegistryError::Persistence(_))
        ));
    }

    #[tokio::test]
    async fn node_credentials_are_private_and_survive_restart() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("node_registry.json");
        let registry = NodeRegistry::new_persistent("authority-test".into(), path.clone()).unwrap();
        let token = registry
            .create_pairing_token(
                "standby".into(),
                vec![NodeCapability::Standby],
                Duration::from_secs(60),
            )
            .await
            .unwrap();
        let joined = registry
            .join_with_token(JoinNodeRequest {
                token: token.token,
                display_name: "standby-1".into(),
                public_key: "standby-public-key".into(),
                reachability: NodeReachability::OutboundOnly,
                endpoint: None,
            })
            .await
            .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o077,
                0
            );
        }
        let reopened = NodeRegistry::new_persistent("authority-test".into(), path).unwrap();
        assert_eq!(
            reopened
                .authenticate_node(&joined.node.node_id, &joined.node_secret)
                .await
                .unwrap()
                .node_id,
            joined.node.node_id
        );
    }

    #[tokio::test]
    async fn failed_registry_save_does_not_change_live_node_trust() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("node_registry.json");
        let mut registry = NodeRegistry::new_persistent("authority-test".into(), path).unwrap();
        let token = registry
            .create_pairing_token(
                "worker".into(),
                vec![NodeCapability::CpuWorker],
                Duration::from_secs(60),
            )
            .await
            .unwrap();
        let joined = registry
            .join_with_token(JoinNodeRequest {
                token: token.token,
                display_name: "worker-1".into(),
                public_key: "worker-public-key".into(),
                reachability: NodeReachability::OutboundOnly,
                endpoint: None,
            })
            .await
            .unwrap();
        let non_directory = temp.path().join("not-a-directory");
        std::fs::write(&non_directory, b"occupied").unwrap();
        registry.storage_path = Some(non_directory.join("node_registry.json"));
        assert!(matches!(
            registry.revoke_node(&joined.node.node_id).await,
            Err(NodeRegistryError::Persistence(_))
        ));
        assert!(registry
            .authenticate_node(&joined.node.node_id, &joined.node_secret)
            .await
            .is_ok());
        assert!(matches!(
            registry
                .create_pairing_token(
                    "second".into(),
                    vec![NodeCapability::CpuWorker],
                    Duration::from_secs(60)
                )
                .await,
            Err(NodeRegistryError::Persistence(_))
        ));
        assert_eq!(registry.list_pairing_tokens().await.len(), 1);
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
                    capabilities: Some(vec![NodeCapability::CpuWorker]),
                    ..Default::default()
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
        assert_eq!(node.capabilities, vec![NodeCapability::CpuWorker]);
    }

    #[tokio::test]
    async fn heartbeat_cannot_grant_itself_standby_trust() {
        let registry = test_registry();
        let token = registry
            .create_pairing_token(
                "worker".into(),
                vec![NodeCapability::CpuWorker],
                Duration::from_secs(60),
            )
            .await
            .unwrap();
        let joined = registry
            .join_with_token(JoinNodeRequest {
                token: token.token,
                display_name: "worker-1".into(),
                public_key: "worker-public-key".into(),
                reachability: NodeReachability::OutboundOnly,
                endpoint: None,
            })
            .await
            .unwrap();
        let result = registry
            .record_heartbeat(
                &joined.node.node_id,
                &joined.node_secret,
                NodeHeartbeatRequest {
                    capabilities: Some(vec![NodeCapability::CpuWorker, NodeCapability::Standby]),
                    ..Default::default()
                },
            )
            .await;
        assert!(matches!(result, Err(NodeRegistryError::InvalidInput(_))));
        let stored = registry.list_nodes().await;
        assert_eq!(stored[0].status, NodeStatus::Pending);
        assert_eq!(stored[0].capabilities, vec![NodeCapability::CpuWorker]);
        assert!(registry
            .record_standby_snapshot(&joined.node.node_id, "untrusted-snapshot", "received")
            .await
            .is_err());
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

    #[tokio::test]
    async fn standby_snapshot_metadata_requires_standby_or_backup_capability() {
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

        let result = registry
            .record_standby_snapshot(&joined.node.node_id, "snap-test", "received")
            .await;

        assert!(matches!(result, Err(NodeRegistryError::InvalidInput(_))));
    }

    #[tokio::test]
    async fn revoked_standby_node_cannot_record_snapshot() {
        let registry = test_registry();
        let token = registry
            .create_pairing_token(
                "standby".to_string(),
                vec![NodeCapability::Standby],
                Duration::from_secs(60),
            )
            .await
            .expect("token created");
        let joined = registry
            .join_with_token(JoinNodeRequest {
                token: token.token,
                display_name: "standby-1".to_string(),
                public_key: "age1standbykey".to_string(),
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
            .record_standby_snapshot(&joined.node.node_id, "snap-test", "received")
            .await;

        assert!(matches!(result, Err(NodeRegistryError::NodeRevoked)));
    }
}
