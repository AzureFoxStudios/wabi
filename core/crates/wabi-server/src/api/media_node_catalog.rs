//! Media-node advertisements and selection metadata.
//!
//! This registry is Authority-local. A Media Node may advertise the same physical
//! SFU to many independent Authorities, but each Authority stores only the
//! advertisement received through its own authenticated node relationship.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, OnceLock},
};
use tokio::sync::RwLock;

use crate::nodes::{HelperNode, NodeCapability, NodeReachability, NodeStatus};

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MediaNodeSharing {
    #[default]
    Private,
    Shared,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MediaNodeAdvertisement {
    /// Backend identifier such as `livekit` or `mediasoup`.
    pub provider: String,
    /// Operator-supplied region hint. Selection may prefer it, but measured
    /// client latency remains a stronger future signal.
    #[serde(default)]
    pub region: Option<String>,
    /// Whether this physical node is intentionally available to more than one
    /// Authority. This is descriptive; a separate pairing is still required for
    /// every Authority.
    #[serde(default)]
    pub sharing: MediaNodeSharing,
    /// Public SFU/WebRTC signaling endpoint exposed by this media node.
    #[serde(default)]
    pub sfu_endpoint: Option<String>,
    /// Allows a node to drain without being removed/revoked.
    #[serde(default = "default_true")]
    pub accepting_new_rooms: bool,
    #[serde(default)]
    pub max_rooms: Option<u32>,
    #[serde(default)]
    pub max_participants: Option<u32>,
    #[serde(default)]
    pub max_participants_per_room: Option<u32>,
    /// Runtime values are optional until the media backend can report them
    /// accurately. Missing values must not be invented by the Authority.
    #[serde(default)]
    pub active_rooms: Option<u32>,
    #[serde(default)]
    pub active_participants: Option<u32>,
}

fn default_true() -> bool {
    true
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MediaNodeAdvertisementRecord {
    pub node_id: String,
    pub advertisement: MediaNodeAdvertisement,
    pub updated_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MediaNodeSelection {
    pub node_id: String,
    pub endpoint: String,
    pub provider: String,
    pub region: Option<String>,
    pub sharing: MediaNodeSharing,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CatalogData {
    #[serde(default)]
    advertisements: HashMap<String, MediaNodeAdvertisementRecord>,
}

#[derive(Clone, Debug)]
pub struct MediaNodeCatalog {
    path: PathBuf,
    inner: Arc<RwLock<CatalogData>>,
}

static GLOBAL_CATALOG: OnceLock<MediaNodeCatalog> = OnceLock::new();

pub fn global(data_dir: &str) -> &'static MediaNodeCatalog {
    GLOBAL_CATALOG.get_or_init(|| {
        MediaNodeCatalog::new_persistent(PathBuf::from(data_dir).join("media_nodes.json"))
    })
}

impl MediaNodeCatalog {
    pub fn new_persistent(path: impl Into<PathBuf>) -> Self {
        let path = path.into();
        let data = std::fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str::<CatalogData>(&raw).ok())
            .unwrap_or_default();
        Self {
            path,
            inner: Arc::new(RwLock::new(data)),
        }
    }

    pub async fn upsert(
        &self,
        node_id: &str,
        advertisement: MediaNodeAdvertisement,
    ) -> Result<MediaNodeAdvertisementRecord, String> {
        let advertisement = validate_advertisement(advertisement)?;
        let record = MediaNodeAdvertisementRecord {
            node_id: node_id.to_string(),
            advertisement,
            updated_at: Utc::now(),
        };
        let mut data = self.inner.write().await;
        data.advertisements
            .insert(node_id.to_string(), record.clone());
        self.persist_locked(&data).await?;
        Ok(record)
    }

    pub async fn remove(&self, node_id: &str) -> Result<bool, String> {
        let mut data = self.inner.write().await;
        let removed = data.advertisements.remove(node_id).is_some();
        if removed {
            self.persist_locked(&data).await?;
        }
        Ok(removed)
    }

    pub async fn get(&self, node_id: &str) -> Option<MediaNodeAdvertisementRecord> {
        self.inner
            .read()
            .await
            .advertisements
            .get(node_id)
            .cloned()
    }

    pub async fn list(&self) -> Vec<MediaNodeAdvertisementRecord> {
        let data = self.inner.read().await;
        let mut records = data.advertisements.values().cloned().collect::<Vec<_>>();
        records.sort_by(|a, b| a.node_id.cmp(&b.node_id));
        records
    }

    /// Choose an advertised media node without treating region labels as more
    /// trustworthy than capacity/reachability. Unknown runtime occupancy is
    /// allowed; explicit evidence that a node is full is a hard rejection.
    pub async fn select(
        &self,
        nodes: &[HelperNode],
        requested_participants: u32,
        preferred_region: Option<&str>,
    ) -> Option<MediaNodeSelection> {
        let data = self.inner.read().await;
        let mut candidates: Vec<(i64, String, MediaNodeSelection)> = Vec::new();

        for node in nodes {
            if node.status != NodeStatus::Online
                || !node.capabilities.contains(&NodeCapability::MediaRelay)
            {
                continue;
            }
            let Some(record) = data.advertisements.get(&node.node_id) else {
                continue;
            };
            let ad = &record.advertisement;
            if !ad.accepting_new_rooms || !has_capacity(ad, requested_participants) {
                continue;
            }
            let endpoint = ad
                .sfu_endpoint
                .as_ref()
                .or(node.endpoint.as_ref())
                .filter(|value| !value.trim().is_empty())?
                .clone();

            let mut score = reachability_score(&node.reachability);
            if preferred_region
                .zip(ad.region.as_deref())
                .is_some_and(|(wanted, actual)| wanted.eq_ignore_ascii_case(actual))
            {
                score += 1_000;
            }
            if ad.sharing == MediaNodeSharing::Shared {
                score += 10;
            }
            if let (Some(active), Some(max)) = (ad.active_participants, ad.max_participants) {
                let remaining = max.saturating_sub(active) as i64;
                score += remaining.min(500);
            }
            if let Some(cpu) = node.load.cpu_percent {
                score -= cpu.round() as i64;
            }

            candidates.push((
                score,
                node.node_id.clone(),
                MediaNodeSelection {
                    node_id: node.node_id.clone(),
                    endpoint,
                    provider: ad.provider.clone(),
                    region: ad.region.clone(),
                    sharing: ad.sharing.clone(),
                },
            ));
        }

        candidates.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
        candidates.into_iter().next().map(|(_, _, selected)| selected)
    }

    async fn persist_locked(&self, data: &CatalogData) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("create media-node catalog directory: {e}"))?;
        }
        let bytes = serde_json::to_vec_pretty(data)
            .map_err(|e| format!("serialize media-node catalog: {e}"))?;
        tokio::fs::write(&self.path, bytes)
            .await
            .map_err(|e| format!("persist media-node catalog: {e}"))
    }
}

fn validate_advertisement(
    mut ad: MediaNodeAdvertisement,
) -> Result<MediaNodeAdvertisement, String> {
    ad.provider = sanitize_token(&ad.provider, 32);
    if ad.provider.is_empty() {
        return Err("media provider is required".into());
    }
    ad.region = ad
        .region
        .take()
        .map(|value| sanitize_token(&value, 64))
        .filter(|value| !value.is_empty());
    ad.sfu_endpoint = ad
        .sfu_endpoint
        .take()
        .map(|value| value.trim().trim_end_matches('/').to_string())
        .filter(|value| !value.is_empty());

    if let Some(endpoint) = &ad.sfu_endpoint {
        if !(endpoint.starts_with("https://")
            || endpoint.starts_with("wss://")
            || endpoint.starts_with("http://")
            || endpoint.starts_with("ws://"))
        {
            return Err("sfuEndpoint must use http(s) or ws(s)".into());
        }
    }
    for (label, value) in [
        ("maxRooms", ad.max_rooms),
        ("maxParticipants", ad.max_participants),
        ("maxParticipantsPerRoom", ad.max_participants_per_room),
    ] {
        if value == Some(0) {
            return Err(format!("{label} must be greater than zero when set"));
        }
    }
    Ok(ad)
}

fn sanitize_token(value: &str, max_len: usize) -> String {
    value
        .trim()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        .take(max_len)
        .collect::<String>()
        .to_ascii_lowercase()
}

fn has_capacity(ad: &MediaNodeAdvertisement, requested_participants: u32) -> bool {
    if ad
        .max_participants_per_room
        .is_some_and(|limit| requested_participants > limit)
    {
        return false;
    }
    if let (Some(active), Some(limit)) = (ad.active_rooms, ad.max_rooms) {
        if active >= limit {
            return false;
        }
    }
    if let (Some(active), Some(limit)) = (ad.active_participants, ad.max_participants) {
        if active.saturating_add(requested_participants) > limit {
            return false;
        }
    }
    true
}

fn reachability_score(reachability: &NodeReachability) -> i64 {
    match reachability {
        NodeReachability::PublicReachable => 300,
        NodeReachability::RelayReachable => 250,
        NodeReachability::LanReachable => 100,
        NodeReachability::OutboundOnly => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::nodes::{NodeLoad, StandbySnapshotMetadata};
    use uuid::Uuid;

    fn node(id: &str, reachability: NodeReachability, cpu: f32) -> HelperNode {
        HelperNode {
            node_id: id.into(),
            display_name: id.into(),
            public_key: format!("pk-{id}"),
            capabilities: vec![NodeCapability::MediaRelay],
            reachability,
            endpoint: None,
            status: NodeStatus::Online,
            load: NodeLoad {
                cpu_percent: Some(cpu),
                ..Default::default()
            },
            paired_at: Utc::now(),
            last_heartbeat_at: Some(Utc::now()),
            revoked_at: None,
            lan_reachable_at: None,
            standby: StandbySnapshotMetadata::default(),
        }
    }

    fn ad(region: &str, endpoint: &str) -> MediaNodeAdvertisement {
        MediaNodeAdvertisement {
            provider: "livekit".into(),
            region: Some(region.into()),
            sharing: MediaNodeSharing::Shared,
            sfu_endpoint: Some(endpoint.into()),
            accepting_new_rooms: true,
            max_rooms: Some(100),
            max_participants: Some(1_000),
            max_participants_per_room: Some(100),
            active_rooms: Some(2),
            active_participants: Some(20),
        }
    }

    #[tokio::test]
    async fn advertisement_persists_and_sanitizes_tokens() {
        let path = std::env::temp_dir().join(format!("wabi-media-nodes-{}.json", Uuid::new_v4()));
        let catalog = MediaNodeCatalog::new_persistent(&path);
        let mut value = ad("US West / SF", "wss://calls.example.test/");
        value.provider = "LiveKit !!".into();
        let stored = catalog.upsert("node-a", value).await.unwrap();
        assert_eq!(stored.advertisement.provider, "livekit");
        assert_eq!(stored.advertisement.region.as_deref(), Some("uswestsf"));
        assert_eq!(stored.advertisement.sfu_endpoint.as_deref(), Some("wss://calls.example.test"));

        let reopened = MediaNodeCatalog::new_persistent(&path);
        assert!(reopened.get("node-a").await.is_some());
        let _ = tokio::fs::remove_file(path).await;
    }

    #[tokio::test]
    async fn selection_prefers_matching_region_when_capacity_allows() {
        let path = std::env::temp_dir().join(format!("wabi-media-select-{}.json", Uuid::new_v4()));
        let catalog = MediaNodeCatalog::new_persistent(&path);
        catalog.upsert("sf", ad("us-west", "wss://sf.example.test")).await.unwrap();
        catalog.upsert("sg", ad("singapore", "wss://sg.example.test")).await.unwrap();
        let nodes = vec![
            node("sf", NodeReachability::PublicReachable, 5.0),
            node("sg", NodeReachability::PublicReachable, 50.0),
        ];
        let selected = catalog.select(&nodes, 50, Some("singapore")).await.unwrap();
        assert_eq!(selected.node_id, "sg");
        let _ = tokio::fs::remove_file(path).await;
    }

    #[tokio::test]
    async fn full_nodes_are_rejected_before_scoring() {
        let path = std::env::temp_dir().join(format!("wabi-media-full-{}.json", Uuid::new_v4()));
        let catalog = MediaNodeCatalog::new_persistent(&path);
        let mut full = ad("singapore", "wss://full.example.test");
        full.max_participants = Some(50);
        full.active_participants = Some(45);
        catalog.upsert("full", full).await.unwrap();
        catalog.upsert("roomy", ad("us-west", "wss://roomy.example.test")).await.unwrap();
        let nodes = vec![
            node("full", NodeReachability::PublicReachable, 1.0),
            node("roomy", NodeReachability::PublicReachable, 90.0),
        ];
        let selected = catalog.select(&nodes, 10, Some("singapore")).await.unwrap();
        assert_eq!(selected.node_id, "roomy");
        let _ = tokio::fs::remove_file(path).await;
    }
}
