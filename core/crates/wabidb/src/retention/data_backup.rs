use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::{Result, WabiError};
use crate::storage::fsync::fsync_dir;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DataBackupEntry {
    pub relative_path: String,
    pub size: u64,
    pub blake3_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DataBackupResult {
    pub entries: Vec<DataBackupEntry>,
    pub backup_dir: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupManifest {
    pub format_version: u16,
    pub created_at_micros: i64,
    pub entries: Vec<DataBackupEntry>,
}

pub async fn backup_data(data_dir: &Path, backup_dir: &Path) -> Result<DataBackupResult> {
    tokio::fs::create_dir_all(backup_dir).await?;

    let mut entries = Vec::new();

    let streams_dir = data_dir.join("streams");
    if tokio::fs::try_exists(&streams_dir).await.unwrap_or(false) {
        let mut streams_reader = tokio::fs::read_dir(&streams_dir).await?;
        while let Some(stream_entry) = streams_reader.next_entry().await? {
            let stream_path = stream_entry.path();
            if !stream_path.is_dir() {
                continue;
            }
            let stream_name = stream_path.file_name().unwrap().to_string_lossy().to_string();

            let events_dir = stream_path.join("events");
            if tokio::fs::try_exists(&events_dir).await.unwrap_or(false) {
                let backup_stream_dir = backup_dir.join("streams").join(&stream_name).join("events");
                tokio::fs::create_dir_all(&backup_stream_dir).await?;

                let mut events_reader = tokio::fs::read_dir(&events_dir).await?;
                while let Some(seg_entry) = events_reader.next_entry().await? {
                    let seg_path = seg_entry.path();
                    if seg_path.extension().map_or(false, |ext| ext == "wseg") {
                        let seg_name = seg_path.file_name().unwrap().to_string_lossy().to_string();
                        let backup_seg_path = backup_stream_dir.join(&seg_name);

                        tokio::fs::copy(&seg_path, &backup_seg_path).await?;

                        let meta = tokio::fs::metadata(&backup_seg_path).await?;
                        let data = tokio::fs::read(&backup_seg_path).await?;
                        let hash = blake3::hash(&data);

                        entries.push(DataBackupEntry {
                            relative_path: format!("streams/{stream_name}/events/{seg_name}"),
                            size: meta.len(),
                            blake3_hash: hash.to_hex().to_string(),
                        });
                    }
                }
            }
        }
    }

    // Copy manifest
    let manifest_path = data_dir.join("storage-manifest.json");
    if tokio::fs::try_exists(&manifest_path).await.unwrap_or(false) {
        let backup_manifest_path = backup_dir.join("storage-manifest.json");
        tokio::fs::copy(&manifest_path, &backup_manifest_path).await?;

        let meta = tokio::fs::metadata(&backup_manifest_path).await?;
        let data = tokio::fs::read(&backup_manifest_path).await?;
        let hash = blake3::hash(&data);

        entries.push(DataBackupEntry {
            relative_path: "storage-manifest.json".into(),
            size: meta.len(),
            blake3_hash: hash.to_hex().to_string(),
        });
    }

    // Write backup manifest JSON
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_micros() as i64)
        .unwrap_or(0);

    let bm = BackupManifest {
        format_version: 1,
        created_at_micros: now,
        entries: entries.clone(),
    };

    let bm_json = serde_json::to_string_pretty(&bm).map_err(|e| WabiError::Corrupt {
        location: "backup manifest".into(),
        detail: format!("serialization failed: {e}"),
    })?;

    let bm_path = backup_dir.join("backup-manifest.json");
    tokio::fs::write(&bm_path, &bm_json).await?;
    fsync_dir(backup_dir).await?;

    Ok(DataBackupResult {
        entries,
        backup_dir: backup_dir.to_string_lossy().to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::format::record::{payload_crc32c, RecordHeader, RecordKind};
    use crate::stream_log::segment_writer::SegmentWriter;
    use tempfile::tempdir;

    #[tokio::test]
    async fn backup_empty() {
        let data_dir = tempdir().unwrap();
        let backup_dir = tempdir().unwrap();
        let result = backup_data(data_dir.path(), backup_dir.path()).await.unwrap();
        assert!(result.entries.is_empty());
    }

    #[tokio::test]
    async fn backup_populated() {
        let data_dir = tempdir().unwrap();
        let backup_dir = tempdir().unwrap();

        tokio::fs::write(data_dir.path().join("storage-manifest.json"), b"{\"version\":1}")
            .await
            .unwrap();

        let events_dir = data_dir.path().join("streams").join("ch_test").join("events");
        tokio::fs::create_dir_all(&events_dir).await.unwrap();
        let payload = b"data";
        let crc = payload_crc32c(payload);
        let mut writer = SegmentWriter::open(&events_dir, "ch_test".into()).await.unwrap();
        let h = RecordHeader::new(RecordKind::Event, 1, [0u8; 16], payload.len() as u32, crc);
        writer.append(&h, payload).await.unwrap();
        writer.close().await.unwrap();

        let result = backup_data(data_dir.path(), backup_dir.path()).await.unwrap();
        assert!(!result.entries.is_empty());

        let seg_backup = backup_dir.path().join("streams").join("ch_test").join("events").join("00000001.wseg");
        assert!(seg_backup.exists());

        let manifest_backup = backup_dir.path().join("storage-manifest.json");
        assert!(manifest_backup.exists());

        let bm_path = backup_dir.path().join("backup-manifest.json");
        assert!(bm_path.exists());
    }

    #[tokio::test]
    async fn backup_idempotent() {
        let data_dir = tempdir().unwrap();
        let backup_dir = tempdir().unwrap();

        tokio::fs::write(data_dir.path().join("storage-manifest.json"), b"{\"version\":1}")
            .await
            .unwrap();

        let result1 = backup_data(data_dir.path(), backup_dir.path()).await.unwrap();
        let result2 = backup_data(data_dir.path(), backup_dir.path()).await.unwrap();

        assert_eq!(result1.entries.len(), result2.entries.len());
    }
}
