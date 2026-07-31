//! Upload ownership registry for files served under the generic `/uploads/` URL space.
//!
//! Option 1 (see FILE_SECURITY_AUDIT_DECISION_2026-07-31.md): this registry is
//! **ops metadata, not an authz brain**. It records which channel / user each
//! uploaded file belongs to so operators can audit disk usage and (later) build
//! a read gate. It is deliberately *not* consulted on the serve path —
//! `serve_upload` stays a capability URL.
//!
//! Storage layout on disk:
//!   `<data_dir>/upload_registry.json`

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, path::PathBuf, sync::Arc};
use tokio::sync::RwLock;

/// Classification of an uploaded file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UploadKind {
    Attachment,
    Avatar,
    Profile,
    Branding,
    Whiteboard,
    Other,
}

impl UploadKind {
    #[allow(dead_code)]
    pub fn as_str(&self) -> &'static str {
        match self {
            UploadKind::Attachment => "attachment",
            UploadKind::Avatar => "avatar",
            UploadKind::Profile => "profile",
            UploadKind::Branding => "branding",
            UploadKind::Whiteboard => "whiteboard",
            UploadKind::Other => "other",
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadMeta {
    /// Final filename as served at `/uploads/{filename}` (e.g. `{uuid}.jpg`).
    pub filename: String,
    /// Original client-provided filename.
    pub original_name: String,
    pub channel_id: Option<String>,
    pub uploader_id: Option<i64>,
    pub kind: UploadKind,
    pub size: u64,
    pub created_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct UploadRegistryData {
    files: HashMap<String, UploadMeta>,
}

/// Tolerant, JSON-persisted registry of uploaded-file ownership.
///
/// `get`/`list`/`by_channel`/`total_bytes_for_channel` are read-side operators
/// for future admin tooling; `record` is the only write-path consumer today.
#[derive(Clone, Debug)]
pub struct UploadRegistry {
    data_path: PathBuf,
    inner: Arc<RwLock<UploadRegistryData>>,
}

impl UploadRegistry {
    pub fn new_persistent(data_dir: impl Into<PathBuf>) -> Self {
        let data_path: PathBuf = data_dir.into().join("upload_registry.json");
        let data = std::fs::read_to_string(&data_path)
            .ok()
            .and_then(|s| serde_json::from_str::<UploadRegistryData>(&s).ok())
            .unwrap_or_default();
        Self {
            data_path,
            inner: Arc::new(RwLock::new(data)),
        }
    }

    /// Record ownership of an uploaded file.
    ///
    /// Failure policy: never fail an upload because the accounting file
    /// hiccuped — log and continue.
    pub async fn record(
        &self,
        filename: &str,
        original_name: &str,
        channel_id: Option<String>,
        uploader_id: Option<i64>,
        kind: UploadKind,
        size: u64,
    ) {
        let meta = UploadMeta {
            filename: filename.to_string(),
            original_name: original_name.to_string(),
            channel_id,
            uploader_id,
            kind,
            size,
            created_at: Utc::now(),
        };
        let mut guard = self.inner.write().await;
        guard.files.insert(filename.to_string(), meta);
        self.persist_locked(&guard).await;
    }

    /// Look up ownership metadata for a filename.
    #[allow(dead_code)]
    pub async fn get(&self, filename: &str) -> Option<UploadMeta> {
        let guard = self.inner.read().await;
        guard.files.get(filename).cloned()
    }

    /// List all recorded files.
    #[allow(dead_code)]
    pub async fn list(&self) -> Vec<UploadMeta> {
        let guard = self.inner.read().await;
        let mut all: Vec<UploadMeta> = guard.files.values().cloned().collect();
        all.sort_by(|a, b| a.created_at.cmp(&b.created_at));
        all
    }

    /// List all recorded files belonging to a channel.
    #[allow(dead_code)]
    pub async fn by_channel(&self, channel_id: &str) -> Vec<UploadMeta> {
        let guard = self.inner.read().await;
        guard
            .files
            .values()
            .filter(|m| m.channel_id.as_deref() == Some(channel_id))
            .cloned()
            .collect()
    }

    /// Total bytes recorded on disk for a channel.
    #[allow(dead_code)]
    pub async fn total_bytes_for_channel(&self, channel_id: &str) -> u64 {
        self.by_channel(channel_id).await.iter().map(|m| m.size).sum()
    }

    async fn persist_locked(&self, data: &UploadRegistryData) {
        if let Some(parent) = self.data_path.parent() {
            let _ = tokio::fs::create_dir_all(parent).await;
        }
        if let Ok(content) = serde_json::to_string_pretty(data) {
            if let Err(e) = tokio::fs::write(&self.data_path, content).await {
                tracing::warn!(
                    "[upload_registry] failed to persist {}: {}",
                    self.data_path.display(),
                    e
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    #[tokio::test]
    async fn roundtrip_record_reload_list() {
        let tmp = std::env::temp_dir().join(format!("wabi-upload-reg-test-{}", Uuid::new_v4()));
        let reg = UploadRegistry::new_persistent(&tmp);

        reg.record(
            "abc-123.jpg",
            "photo.jpg",
            Some("ch_1".into()),
            Some(42),
            UploadKind::Attachment,
            4096,
        )
        .await;
        reg.record(
            "wb-1.png",
            "drawing.png",
            Some("ch_2".into()),
            Some(7),
            UploadKind::Whiteboard,
            1024,
        )
        .await;
        reg.record(
            "profile-1.jpg",
            "avatar.jpg",
            None,
            Some(42),
            UploadKind::Profile,
            512,
        )
        .await;

        // In-memory lookups
        let meta = reg.get("abc-123.jpg").await.unwrap();
        assert_eq!(meta.kind, UploadKind::Attachment);
        assert_eq!(meta.channel_id.as_deref(), Some("ch_1"));
        assert_eq!(meta.uploader_id, Some(42));
        assert_eq!(meta.size, 4096);
        assert_eq!(meta.original_name, "photo.jpg");

        let ch1 = reg.by_channel("ch_1").await;
        assert_eq!(ch1.len(), 1);
        assert_eq!(reg.total_bytes_for_channel("ch_1").await, 4096);
        assert_eq!(reg.total_bytes_for_channel("ch_2").await, 1024);

        // Reload from disk — metadata survives a restart
        let reg2 = UploadRegistry::new_persistent(&tmp);
        assert_eq!(reg2.list().await.len(), 3);
        assert_eq!(
            reg2.get("wb-1.png").await.unwrap().kind,
            UploadKind::Whiteboard
        );
        assert_eq!(
            reg2.get("profile-1.jpg").await.unwrap().uploader_id,
            Some(42)
        );

        // Failure policy: a corrupt registry file must not crash startup
        std::fs::write(tmp.join("upload_registry.json"), "{ not json").unwrap();
        let reg3 = UploadRegistry::new_persistent(&tmp);
        assert!(reg3.list().await.is_empty());

        let _ = tokio::fs::remove_dir_all(&tmp).await;
    }
}
