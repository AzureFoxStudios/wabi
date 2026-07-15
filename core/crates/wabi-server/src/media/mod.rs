//! Media room registry for helper-node voice/video offloading.
//!
//! Phase 4: primary owns room lifecycle + permissions. Helper nodes with
//! `MediaRelay` capability can be assigned as the host for a room.
//! Clients ask primary "where do I connect?"; primary returns the helper
//! endpoint or falls back to itself.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, path::PathBuf, sync::Arc};
use tokio::sync::RwLock;
use uuid::Uuid;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MediaRoomStatus {
    Pending,
    Assigned,
    Active,
    Closed,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaRoom {
    pub room_id: String,
    pub channel_id: String,
    pub created_at: DateTime<Utc>,
    pub assigned_node_id: Option<String>,
    pub assigned_at: Option<DateTime<Utc>>,
    pub status: MediaRoomStatus,
    pub sfu_endpoint: Option<String>,
    pub max_participants: u32,
    pub current_participants: u32,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct MediaRoomRegistryData {
    rooms: HashMap<String, MediaRoom>,
}

#[derive(Clone, Debug)]
pub struct MediaRoomRegistry {
    data_path: PathBuf,
    inner: Arc<RwLock<MediaRoomRegistryData>>,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
#[allow(dead_code)]
pub enum MediaRoomError {
    #[error("room not found")]
    NotFound,
    #[error("room already exists")]
    AlreadyExists,
    #[error("room is not in a state that allows this action")]
    InvalidState,
    #[error("node is not suitable for media relay")]
    InvalidNode,
    #[error("io error: {0}")]
    Io(String),
}

#[allow(dead_code)]
impl MediaRoomRegistry {
    pub fn new_persistent(data_dir: impl Into<PathBuf>) -> Self {
        let data_dir: PathBuf = data_dir.into();
        let data_path = data_dir.join("media_rooms.json");
        let data = std::fs::read_to_string(&data_path)
            .ok()
            .and_then(|s| serde_json::from_str::<MediaRoomRegistryData>(&s).ok())
            .unwrap_or_default();
        Self {
            data_path,
            inner: Arc::new(RwLock::new(data)),
        }
    }

    /// Create a new media room for a channel. Returns existing if
    /// a room for this channel is already open.
    pub async fn create_room(
        &self,
        channel_id: String,
        max_participants: u32,
    ) -> Result<MediaRoom, MediaRoomError> {
        let mut guard = self.inner.write().await;
        if let Some(existing) = guard.rooms.values().find(|r| {
            r.channel_id == channel_id
                && matches!(
                    r.status,
                    MediaRoomStatus::Pending | MediaRoomStatus::Assigned | MediaRoomStatus::Active
                )
        }) {
            return Ok(existing.clone());
        }
        let room = MediaRoom {
            room_id: new_room_id(),
            channel_id,
            created_at: Utc::now(),
            assigned_node_id: None,
            assigned_at: None,
            status: MediaRoomStatus::Pending,
            sfu_endpoint: None,
            max_participants,
            current_participants: 0,
        };
        guard.rooms.insert(room.room_id.clone(), room.clone());
        self.persist_locked(&guard).await;
        Ok(room)
    }

    pub async fn assign_room(
        &self,
        room_id: &str,
        node_id: &str,
        sfu_endpoint: Option<String>,
    ) -> Result<MediaRoom, MediaRoomError> {
        let mut guard = self.inner.write().await;
        let room = guard
            .rooms
            .get_mut(room_id)
            .ok_or(MediaRoomError::NotFound)?;
        if matches!(room.status, MediaRoomStatus::Closed) {
            return Err(MediaRoomError::InvalidState);
        }
        room.assigned_node_id = Some(node_id.to_string());
        room.assigned_at = Some(Utc::now());
        room.sfu_endpoint = sfu_endpoint;
        room.status = MediaRoomStatus::Assigned;
        let cloned = room.clone();
        self.persist_locked(&guard).await;
        Ok(cloned)
    }

    pub async fn mark_active(
        &self,
        room_id: &str,
        node_id: &str,
        sfu_endpoint: String,
    ) -> Result<MediaRoom, MediaRoomError> {
        let mut guard = self.inner.write().await;
        let room = guard
            .rooms
            .get_mut(room_id)
            .ok_or(MediaRoomError::NotFound)?;
        if room.assigned_node_id.as_deref() != Some(node_id) {
            return Err(MediaRoomError::InvalidNode);
        }
        room.status = MediaRoomStatus::Active;
        room.sfu_endpoint = Some(sfu_endpoint);
        let cloned = room.clone();
        self.persist_locked(&guard).await;
        Ok(cloned)
    }

    pub async fn update_participants(
        &self,
        room_id: &str,
        count: u32,
    ) -> Result<MediaRoom, MediaRoomError> {
        let mut guard = self.inner.write().await;
        let room = guard
            .rooms
            .get_mut(room_id)
            .ok_or(MediaRoomError::NotFound)?;
        room.current_participants = count;
        let cloned = room.clone();
        self.persist_locked(&guard).await;
        Ok(cloned)
    }

    pub async fn close_room(&self, room_id: &str) -> Result<MediaRoom, MediaRoomError> {
        let mut guard = self.inner.write().await;
        let room = guard
            .rooms
            .get_mut(room_id)
            .ok_or(MediaRoomError::NotFound)?;
        room.status = MediaRoomStatus::Closed;
        room.assigned_node_id = None;
        room.sfu_endpoint = None;
        let cloned = room.clone();
        self.persist_locked(&guard).await;
        Ok(cloned)
    }

    pub async fn get_room(&self, room_id: &str) -> Option<MediaRoom> {
        let guard = self.inner.read().await;
        guard.rooms.get(room_id).cloned()
    }

    pub async fn find_by_channel(&self, channel_id: &str) -> Option<MediaRoom> {
        let guard = self.inner.read().await;
        guard
            .rooms
            .values()
            .find(|r| r.channel_id == channel_id && !matches!(r.status, MediaRoomStatus::Closed))
            .cloned()
    }

    pub async fn list_rooms(&self) -> Vec<MediaRoom> {
        let guard = self.inner.read().await;
        guard
            .rooms
            .values()
            .filter(|r| !matches!(r.status, MediaRoomStatus::Closed))
            .cloned()
            .collect()
    }

    pub async fn active_endpoint(&self, room_id: &str) -> Option<String> {
        let guard = self.inner.read().await;
        let room = guard.rooms.get(room_id)?;
        if room.status != MediaRoomStatus::Active {
            return None;
        }
        room.sfu_endpoint.clone()
    }

    async fn persist_locked(&self, data: &MediaRoomRegistryData) {
        if let Some(parent) = self.data_path.parent() {
            let _ = tokio::fs::create_dir_all(parent).await;
        }
        if let Ok(content) = serde_json::to_string_pretty(data) {
            let _ = tokio::fs::write(&self.data_path, content).await;
        }
    }
}

fn new_room_id() -> String {
    format!("room-{}", Uuid::new_v4())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn create_assign_active_close() {
        let tmp = std::env::temp_dir().join(format!("wabi-media-test-{}", Uuid::new_v4()));
        let reg = MediaRoomRegistry::new_persistent(&tmp);

        let room = reg.create_room("ch1".into(), 8).await.unwrap();
        assert_eq!(room.channel_id, "ch1");
        assert_eq!(room.status, MediaRoomStatus::Pending);

        let assigned = reg
            .assign_room(
                &room.room_id,
                "node-a",
                Some("wss://helper.local/roomA".into()),
            )
            .await
            .unwrap();
        assert_eq!(assigned.status, MediaRoomStatus::Assigned);

        let active = reg
            .mark_active(&room.room_id, "node-a", "wss://helper.local/roomA".into())
            .await
            .unwrap();
        assert_eq!(active.status, MediaRoomStatus::Active);

        let ep = reg.active_endpoint(&room.room_id).await;
        assert_eq!(ep, Some("wss://helper.local/roomA".to_string()));

        let closed = reg.close_room(&room.room_id).await.unwrap();
        assert_eq!(closed.status, MediaRoomStatus::Closed);
        assert!(reg.active_endpoint(&room.room_id).await.is_none());

        let _ = tokio::fs::remove_dir_all(&tmp).await;
    }
}
