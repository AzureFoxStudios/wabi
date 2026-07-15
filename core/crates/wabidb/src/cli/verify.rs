use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::{Result, WabiError};
use crate::stream_log::segment_reader::SegmentReader;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManifestSummary {
    pub format_version: u16,
    pub stream_count: usize,
    pub segment_count: usize,
    pub total_commits: u64,
}

#[derive(Debug, Clone)]
pub struct VerifyReport {
    pub ok: bool,
    pub errors: Vec<String>,
    pub manifest: Option<ManifestSummary>,
}

pub async fn verify(data_dir: &Path) -> Result<VerifyReport> {
    let mut errors = Vec::new();

    let manifest_path = data_dir.join("storage-manifest.json");
    let manifest_exists = tokio::fs::try_exists(&manifest_path).await.unwrap_or(false);
    if !manifest_exists {
        return Ok(VerifyReport {
            ok: false,
            errors: vec!["missing storage-manifest.json".into()],
            manifest: None,
        });
    }

    let manifest_raw = tokio::fs::read_to_string(&manifest_path).await.map_err(|e| {
        WabiError::Io(e)
    })?;
    let manifest: ManifestSummary = serde_json::from_str(&manifest_raw).map_err(|e| {
        WabiError::Corrupt {
            location: "storage-manifest.json".into(),
            detail: format!("invalid JSON: {e}"),
        }
    })?;

    let streams_dir = data_dir.join("streams");
    if !tokio::fs::try_exists(&streams_dir).await.unwrap_or(false) {
        return Ok(VerifyReport {
            ok: errors.is_empty(),
            errors,
            manifest: Some(manifest),
        });
    }

    let mut streams_reader = tokio::fs::read_dir(&streams_dir).await?;
    while let Some(entry) = streams_reader.next_entry().await? {
        let stream_path = entry.path();
        if !stream_path.is_dir() {
            continue;
        }
        let events_dir = stream_path.join("events");
        if !tokio::fs::try_exists(&events_dir).await.unwrap_or(false) {
            continue;
        }

        let mut events_reader = tokio::fs::read_dir(&events_dir).await?;
        while let Some(seg_entry) = events_reader.next_entry().await? {
            let seg_path = seg_entry.path();
            if seg_path.extension().map_or(false, |ext| ext == "wseg") {
                let mut reader = match SegmentReader::open(&seg_path).await {
                    Ok(r) => r,
                    Err(_) => {
                        errors.push(format!("cannot open segment: {}", seg_path.display()));
                        continue;
                    }
                };
                if let Err(e) = reader.read_records().await {
                    errors.push(format!("segment failed verification: {}: {e}", seg_path.display()));
                } else {
                    let len = tokio::fs::metadata(&seg_path).await.map(|m| m.len()).unwrap_or(0);
                    if len > 0 {
                        let head = tokio::fs::read(&seg_path).await.unwrap_or_default();
                        if !head.starts_with(b"WABI") {
                            errors.push(format!("segment has no valid magic: {}", seg_path.display()));
                        }
                    }
                }
            }
        }
    }

    Ok(VerifyReport {
        ok: errors.is_empty(),
        errors,
        manifest: Some(manifest),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::format::record::{payload_crc32c, RecordHeader, RecordKind};
    use crate::stream_log::segment_writer::SegmentWriter;
    use tempfile::tempdir;

    #[tokio::test]
    async fn clean_data_dir_returns_ok() {
        let dir = tempdir().unwrap();
        let data_dir = dir.path();

        let manifest = ManifestSummary {
            format_version: 1,
            stream_count: 1,
            segment_count: 1,
            total_commits: 1,
        };
        let manifest_json = serde_json::to_string_pretty(&manifest).unwrap();
        tokio::fs::write(data_dir.join("storage-manifest.json"), &manifest_json).await.unwrap();

        let stream_dir = data_dir.join("streams").join("ch_test").join("events");
        tokio::fs::create_dir_all(&stream_dir).await.unwrap();

        let payload = b"data";
        let crc = payload_crc32c(payload);
        let mut writer = SegmentWriter::open(&stream_dir, "ch_test".into()).await.unwrap();
        let h = RecordHeader::new(RecordKind::Event, 1, [0u8; 16], payload.len() as u32, crc);
        writer.append(&h, payload).await.unwrap();
        writer.close().await.unwrap();

        let report = verify(data_dir).await.unwrap();
        assert!(report.ok, "expected ok, got errors: {:?}", report.errors);
        assert!(report.errors.is_empty());
        assert!(report.manifest.is_some());
    }

    #[tokio::test]
    async fn missing_manifest_returns_error() {
        let dir = tempdir().unwrap();
        let report = verify(dir.path()).await.unwrap();
        assert!(!report.ok);
        assert!(report.errors.iter().any(|e| e.contains("storage-manifest.json")));
        assert!(report.manifest.is_none());
    }

    #[tokio::test]
    async fn corrupted_blob_returns_error() {
        let dir = tempdir().unwrap();
        let data_dir = dir.path();

        let manifest = ManifestSummary {
            format_version: 1,
            stream_count: 0,
            segment_count: 0,
            total_commits: 0,
        };
        let manifest_json = serde_json::to_string_pretty(&manifest).unwrap();
        tokio::fs::write(data_dir.join("storage-manifest.json"), &manifest_json).await.unwrap();

        let stream_dir = data_dir.join("streams").join("ch_test").join("events");
        tokio::fs::create_dir_all(&stream_dir).await.unwrap();

        let seg_path = stream_dir.join("00000001.wseg");
        tokio::fs::write(&seg_path, b"not a valid segment file").await.unwrap();

        let report = verify(data_dir).await.unwrap();
        assert!(!report.ok, "expected errors for corrupt data");
        assert!(!report.errors.is_empty());
    }
}
