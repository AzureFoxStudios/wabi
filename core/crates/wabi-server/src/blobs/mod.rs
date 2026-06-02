//! Content-addressed blob registry for Wabi files.
//!
//! Phase 3: blobs are stored by SHA-256 hash. The primary owns the registry metadata.
//! Helper nodes with `BlobCache` capability can claim blob cache/store jobs and
//! mirror blobs locally. Clients ask the primary for a download route; the primary
//! returns signed helper URLs or falls back to itself.
//!
//! Storage layout on disk:
//!   `<data_dir>/blobs/<hash_prefix_2>/<full_hash>`
//!
//! Metadata is persisted as JSON alongside the blob (`.meta` suffix).

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, path::PathBuf, sync::Arc, time::Duration};
use tokio::io::AsyncWriteExt;
use tokio::sync::RwLock;
use uuid::Uuid;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct BlobMeta {
    pub hash: String,
    pub original_name: String,
    pub mime_type: String,
    pub size: u64,
    pub uploaded_at: DateTime<Utc>,
    pub uploaded_by: Option<String>,
    pub channel_id: Option<String>,
    pub message_id: Option<String>,
    /// Which nodes are known to hold this blob (node_id list).
    pub storage_locations: Vec<String>,
    /// Whether this blob has been deleted (soft-delete).
    pub deleted: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct BlobRegistryData {
    blobs: HashMap<String, BlobMeta>,
}

#[derive(Clone, Debug)]
pub struct BlobRegistry {
    base_dir: PathBuf,
    data_path: PathBuf,
    inner: Arc<RwLock<BlobRegistryData>>,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum BlobRegistryError {
    #[error("blob not found")]
    NotFound,
    #[error("io error: {0}")]
    Io(String),
    #[error("hash mismatch")]
    HashMismatch,
    #[error("already exists")]
    AlreadyExists,
}

impl BlobRegistry {
    pub fn new_persistent(data_dir: impl Into<PathBuf>) -> Self {
        let base_dir: PathBuf = data_dir.into();
        let data_path = base_dir.join("blob_registry.json");
        let data = std::fs::read_to_string(&data_path)
            .ok()
            .and_then(|s| serde_json::from_str::<BlobRegistryData>(&s).ok())
            .unwrap_or_default();
        Self {
            base_dir,
            data_path,
            inner: Arc::new(RwLock::new(data)),
        }
    }

    /// Store bytes and return the computed SHA-256 hex hash.
    /// If `expected_hash` is provided, verifies the computed hash matches.
    /// Returns existing meta if already stored and not deleted.
    pub async fn store_blob(
        &self,
        data: &[u8],
        original_name: String,
        mime_type: String,
        uploaded_by: Option<String>,
        channel_id: Option<String>,
        message_id: Option<String>,
        expected_hash: Option<&str>,
    ) -> Result<BlobMeta, BlobRegistryError> {
        let computed_hash = hex::encode(Sha256::digest(data));
        if let Some(expected) = expected_hash {
            if expected != computed_hash {
                return Err(BlobRegistryError::HashMismatch);
            }
        }

        // Check if already registered and not deleted
        {
            let guard = self.inner.read().await;
            if let Some(existing) = guard.blobs.get(&computed_hash) {
                if !existing.deleted {
                    return Ok(existing.clone());
                }
            }
        }

        // Ensure blob directory exists
        let prefix = &computed_hash[..2.min(computed_hash.len())];
        let blob_dir = self.base_dir.join("blobs").join(prefix);
        tokio::fs::create_dir_all(&blob_dir)
            .await
            .map_err(|e| BlobRegistryError::Io(e.to_string()))?;

        let blob_path = blob_dir.join(&computed_hash);

        // Write file atomically via temp rename
        let tmp_path = blob_dir.join(format!(".tmp-{}", Uuid::new_v4()));
        {
            let mut file = tokio::fs::File::create(&tmp_path)
                .await
                .map_err(|e| BlobRegistryError::Io(e.to_string()))?;
            file.write_all(data)
                .await
                .map_err(|e| BlobRegistryError::Io(e.to_string()))?;
            file.flush()
                .await
                .map_err(|e| BlobRegistryError::Io(e.to_string()))?;
            drop(file);
        }
        tokio::fs::rename(&tmp_path, &blob_path)
            .await
            .map_err(|e| BlobRegistryError::Io(e.to_string()))?;

        let meta = BlobMeta {
            hash: computed_hash.clone(),
            original_name,
            mime_type,
            size: data.len() as u64,
            uploaded_at: Utc::now(),
            uploaded_by,
            channel_id,
            message_id,
            storage_locations: vec!["primary".to_string()],
            deleted: false,
        };

        let mut guard = self.inner.write().await;
        guard.blobs.insert(computed_hash, meta.clone());
        self.persist_locked(&guard).await;
        Ok(meta)
    }

    /// Get blob metadata by hash.
    pub async fn get_meta(&self, hash: &str) -> Option<BlobMeta> {
        let guard = self.inner.read().await;
        guard.blobs.get(hash).cloned().filter(|m| !m.deleted)
    }

    /// Absolute path to the blob file on disk, if it exists.
    pub fn blob_path(&self, hash: &str) -> PathBuf {
        let prefix = &hash[..2.min(hash.len())];
        self.base_dir.join("blobs").join(prefix).join(hash)
    }

    /// Verify that the blob file exists on disk and matches registered meta.
    pub async fn verify_localblob(&self, hash: &str) -> bool {
        let meta = match self.get_meta(hash).await {
            Some(m) => m,
            None => return false,
        };
        let path = self.blob_path(hash);
        match tokio::fs::metadata(&path).await {
            Ok(md) => md.len() == meta.size,
            Err(_) => false,
        }
    }

    /// List all non-deleted blobs.
    pub async fn list_blobs(&self) -> Vec<BlobMeta> {
        let guard = self.inner.read().await;
        guard
            .blobs
            .values()
            .filter(|m| !m.deleted)
            .cloned()
            .collect()
    }

    /// Soft-delete a blob.
    pub async fn delete_blob(&self, hash: &str) -> Result<BlobMeta, BlobRegistryError> {
        let mut guard = self.inner.write().await;
        let meta = guard
            .blobs
            .get_mut(hash)
            .ok_or(BlobRegistryError::NotFound)?;
        meta.deleted = true;
        let cloned = meta.clone();
        self.persist_locked(&guard).await;
        Ok(cloned)
    }

    /// Register that a helper node now holds a copy of this blob.
    pub async fn add_storage_location(
        &self,
        hash: &str,
        node_id: &str,
    ) -> Result<(), BlobRegistryError> {
        let mut guard = self.inner.write().await;
        let meta = guard
            .blobs
            .get_mut(hash)
            .ok_or(BlobRegistryError::NotFound)?;
        if !meta.storage_locations.contains(&node_id.to_string()) {
            meta.storage_locations.push(node_id.to_string());
        }
        self.persist_locked(&guard).await;
        Ok(())
    }

    /// Remove a node from the storage locations (e.g. when revoked/offline).
    pub async fn remove_storage_location(&self, hash: &str, node_id: &str) {
        let mut guard = self.inner.write().await;
        if let Some(meta) = guard.blobs.get_mut(hash) {
            meta.storage_locations.retain(|l| l != node_id);
            self.persist_locked(&guard).await;
        }
    }

    /// Compute a SHA-256 hash from bytes.
    pub fn hash_bytes(data: &[u8]) -> String {
        hex::encode(Sha256::digest(data))
    }

    async fn persist_locked(&self, data: &BlobRegistryData) {
        if let Some(parent) = self.data_path.parent() {
            let _ = tokio::fs::create_dir_all(parent).await;
        }
        if let Ok(content) = serde_json::to_string_pretty(data) {
            let _ = tokio::fs::write(&self.data_path, content).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn roundtrip_store_and_get() {
        let tmp = std::env::temp_dir().join(format!("wabi-blob-test-{}", Uuid::new_v4()));
        let reg = BlobRegistry::new_persistent(&tmp);

        let data = b"hello wabi blob";
        let meta = reg
            .store_blob(
                data.as_slice(),
                "hello.txt".into(),
                "text/plain".into(),
                Some("u1".into()),
                Some("ch1".into()),
                Some("m1".into()),
                None,
            )
            .await
            .unwrap();

        assert_eq!(meta.size, 15);
        assert_eq!(meta.mime_type, "text/plain");
        assert_eq!(meta.original_name, "hello.txt");
        assert!(meta.storage_locations.contains(&"primary".to_string()));
        assert!(!meta.deleted);

        // Re-storing same bytes returns existing meta (dedupe)
        let meta2 = reg
            .store_blob(
                data.as_slice(),
                "other.txt".into(),
                "text/plain".into(),
                None,
                None,
                None,
                None,
            )
            .await
            .unwrap();
        assert_eq!(meta2.hash, meta.hash);

        let fetched = reg.get_meta(&meta.hash).await.unwrap();
        assert_eq!(fetched.size, 15);

        // Verify on disk
        let path = reg.blob_path(&meta.hash);
        assert!(tokio::fs::metadata(&path).await.is_ok());

        // Verify local integrity
        assert!(reg.verify_localblob(&meta.hash).await);

        // Add helper storage location
        reg.add_storage_location(&meta.hash, "helper-1")
            .await
            .unwrap();
        let fetched2 = reg.get_meta(&meta.hash).await.unwrap();
        assert!(fetched2.storage_locations.contains(&"helper-1".to_string()));

        // Soft delete
        let deleted = reg.delete_blob(&meta.hash).await.unwrap();
        assert!(deleted.deleted);
        assert!(reg.get_meta(&meta.hash).await.is_none());

        // Cleanup
        let _ = tokio::fs::remove_dir_all(&tmp).await;
    }

    #[tokio::test]
    async fn hash_mismatch_rejected() {
        let tmp = std::env::temp_dir().join(format!("wabi-blob-test-{}", Uuid::new_v4()));
        let reg = BlobRegistry::new_persistent(&tmp);
        let data = b"mismatch test";
        let bad_hash = "0000000000000000000000000000000000000000000000000000000000000000";
        let result = reg
            .store_blob(
                data.as_slice(),
                "f.txt".into(),
                "text/plain".into(),
                None,
                None,
                None,
                Some(bad_hash),
            )
            .await;
        assert_eq!(result, Err(BlobRegistryError::HashMismatch));
        let _ = tokio::fs::remove_dir_all(&tmp).await;
    }
}
