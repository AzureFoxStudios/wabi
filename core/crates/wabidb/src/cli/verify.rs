//! `wabidb-cli verify`: parse the storage manifest and verify every segment
//! against the commit index (every acknowledged record present, with the
//! payload hash the index recorded).
//!
//! Read-only. Meant for a stopped server or a copy of the data directory;
//! never takes, writes or unlinks `.lock`.

use std::path::Path;

use serde::Deserialize;

use crate::error::{Result, WabiError};
use crate::stream_log::segment_reader::SegmentReader;

/// `storage-manifest.json` as `WabiDbEngine::open` writes it
/// (engine/mod.rs). `highest_commit_seq` is updated best-effort at open, so
/// it can lag commits made since the last start.
#[derive(Debug, Clone, Deserialize)]
pub struct ManifestSummary {
    pub schema_version: u32,
    pub format_version: u16,
    pub engine_version: String,
    pub created_at_micros: i64,
    pub highest_commit_seq: u64,
}

/// The manifest versions this build writes and can read.
const SUPPORTED_SCHEMA_VERSION: u32 = 1;
const SUPPORTED_FORMAT_VERSION: u16 = 1;

#[derive(Debug, Clone)]
pub struct VerifyReport {
    pub ok: bool,
    pub errors: Vec<String>,
    pub manifest: Option<ManifestSummary>,
    /// `.wseg` files verified.
    pub segments_verified: usize,
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
            segments_verified: 0,
        });
    }

    let manifest_raw = tokio::fs::read_to_string(&manifest_path).await.map_err(WabiError::Io)?;
    let manifest: ManifestSummary = serde_json::from_str(&manifest_raw).map_err(|e| {
        WabiError::Corrupt {
            location: "storage-manifest.json".into(),
            detail: format!("invalid JSON: {e}"),
        }
    })?;
    if manifest.schema_version != SUPPORTED_SCHEMA_VERSION {
        errors.push(format!("unsupported manifest schema_version {}", manifest.schema_version));
    }
    if manifest.format_version != SUPPORTED_FORMAT_VERSION {
        errors.push(format!("unsupported manifest format_version {}", manifest.format_version));
    }

    let index_dir = data_dir.join("global").join("commit-index");
    let mut indexed = match crate::commit_index::batcher::read_all_entries(&index_dir) {
        Ok(entries) => Some(super::IndexedRecords::new(&entries)),
        Err(e) => {
            errors.push(format!("cannot read commit index {}: {e}", index_dir.display()));
            None
        }
    };

    let mut segments_verified = 0;
    for stream in super::stream_dirs(data_dir).await?.unwrap_or_default() {
        for seg_path in &stream.segments {
            segments_verified += 1;
            let mut reader = match SegmentReader::open(seg_path).await {
                Ok(r) => r,
                Err(_) => {
                    errors.push(format!("cannot open segment: {}", seg_path.display()));
                    continue;
                }
            };
            let records = reader.read_records().await;
            if let (Ok(records), Some(indexed)) = (&records, indexed.as_mut()) {
                for record in records {
                    indexed.observe(&record.header, &record.payload);
                }
            }
            if let Err(e) = records {
                errors.push(format!("segment failed verification: {}: {e}", seg_path.display()));
            } else {
                let len = tokio::fs::metadata(seg_path).await.map(|m| m.len()).unwrap_or(0);
                if len > 0 {
                    let head = tokio::fs::read(seg_path).await.unwrap_or_default();
                    if !head.starts_with(b"WABI") {
                        errors.push(format!("segment has no valid magic: {}", seg_path.display()));
                    }
                }
            }
        }
    }

    if let Some(indexed) = indexed {
        errors.extend(indexed.finish().errors());
    }

    Ok(VerifyReport {
        ok: errors.is_empty(),
        errors,
        manifest: Some(manifest),
        segments_verified,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::test_support::{real_engine_tree, ROSTER_ENCODED};

    /// Fails on main: the old ManifestSummary did not match what the engine
    /// writes, so verify returned "invalid JSON" on every real tree.
    #[tokio::test]
    async fn real_engine_tree_verifies() {
        let dir = tempfile::tempdir().unwrap();
        real_engine_tree(dir.path()).await;

        let report = verify(dir.path()).await.unwrap();
        assert!(report.ok, "{report:#?}");
        assert_eq!(report.segments_verified, 2);
        let manifest = report.manifest.unwrap();
        assert_eq!(manifest.schema_version, 1);
        assert_eq!(manifest.format_version, 1);
    }

    #[tokio::test]
    async fn missing_manifest_returns_error() {
        let dir = tempfile::tempdir().unwrap();
        let report = verify(dir.path()).await.unwrap();
        assert!(!report.ok);
        assert!(report.errors.iter().any(|e| e.contains("storage-manifest.json")));
        assert!(report.manifest.is_none());
    }

    #[tokio::test]
    async fn corrupted_segment_in_encoded_stream_dir_returns_error() {
        let dir = tempfile::tempdir().unwrap();
        real_engine_tree(dir.path()).await;
        let segment = dir
            .path()
            .join("streams")
            .join("other")
            .join(ROSTER_ENCODED)
            .join("events")
            .join("00000001.wseg");
        std::fs::write(&segment, b"not a valid segment file").unwrap();

        let report = verify(dir.path()).await.unwrap();
        assert!(!report.ok, "expected errors for corrupt data");
        assert!(
            report.errors.iter().any(|e| e.contains(ROSTER_ENCODED)),
            "{report:#?}"
        );
    }
}
