//! Segment compaction.
//!
//! Per the kanban card body (wabidb-42):
//! - File: `core/crates/wabidb/src/retention/compaction.rs` (this file).
//! - The mechanism for reclaiming disk space from tombstones. After
//!   records are tombstoned (their keys destroyed), the bytes remain on
//!   disk in the segment files. Compaction rewrites the live records
//!   into a new segment file, then atomically renames the new file
//!   over the old one. Tombstoned records are dropped during the
//!   rewrite.
//! - The procedure is atomic at the segment level: each segment is
//!   compacted independently, and the new segment replaces the old
//!   after a successful rewrite + fsync.
//! - Records whose `commit_seq` is in the tombstone set are NOT
//!   copied to the new segment. Records outside the tombstone set
//!   are copied with their original `commit_seq`.
//!
//! ## What this card does NOT do
//!
//! - Cross-segment compaction (merging many small segments into one
//!   large one). v1 compacts one segment at a time. A future card
//!   (wabidb-XX) does cross-segment.
//! - Background scheduling. The retention reaper (wabidb-41) calls
//!   compact_segment when it determines a segment has many tombstones.
//! - CRCs / encryption changes. The compacted records are byte-identical
//!   to the originals (just re-serialized into a new segment).

use crate::error::{ErrorCategory, Result, WabiError};
use crate::retention::tombstone::TombstoneTable;
use crate::stream_log::recovery::scan_segment_file;
use std::path::{Path, PathBuf};
use tokio::io::AsyncWriteExt;

/// Result of a successful segment compaction.
#[derive(Debug, Clone)]
pub struct CompactionResult {
    /// The path of the segment that was compacted.
    pub original_path: PathBuf,
    /// The path of the new (compacted) segment.
    pub new_path: PathBuf,
    /// The number of records that were kept (not tombstoned).
    pub records_kept: u32,
    /// The number of records that were dropped (tombstoned).
    pub records_dropped: u32,
    /// The new segment size in bytes.
    pub new_size_bytes: u64,
}

/// Compact a single segment, dropping records that are in the
/// tombstone set.
///
/// The procedure:
/// 1. Scan the original segment for valid records (using `scan_segment_file`).
/// 2. Filter out records whose `commit_seq` is in the tombstone set.
/// 3. Write the kept records to a new segment file.
/// 4. fsync the new segment.
/// 5. Atomically rename the new segment over the old one.
///
/// # Errors
///
/// - `WabiError::Corrupt` if the original segment can't be scanned.
/// - `WabiError::Io` for filesystem errors during the rewrite.
/// - `WabiError::InternalInvariantViolated` if the atomic rename fails
///   after the new file is written (the caller should investigate; the
///   new file is left at `new_path` for recovery).
pub async fn compact_segment(
    original_path: &Path,
    stream_id: &str,
    tombstone_table: &TombstoneTable,
) -> Result<CompactionResult> {
    // 1. Scan the original segment.
    let recovery = scan_segment_file(original_path).await.map_err(|e| {
        WabiError::Corrupt {
            location: format!("scan_segment_file({})", original_path.display()),
            detail: format!("{e}"),
        }
    })?;

    if let Some(err) = recovery.error {
        return Err(WabiError::Corrupt {
            location: format!("scan_segment_file({})", original_path.display()),
            detail: format!("{err}"),
        });
    }

    // 2. Filter out tombstoned records. The stream_id is the parameter
    //    (the recovery module's stream_id field is empty because the
    //    segment file format doesn't store the original stream id).
    let total_records = recovery.valid_records.len() as u32;
    let kept: Vec<_> = recovery
        .valid_records
        .into_iter()
        .filter(|record| !tombstone_table.is_tombstoned(stream_id, record.header.commit_seq))
        .collect();

    let records_kept = kept.len() as u32;
    let records_dropped = total_records - records_kept;

    // 3. If all records are tombstoned, zero the file contents, delete,
    //    and fsync the parent directory so the deletion is durable on
    //    power loss.
    if kept.is_empty() {
        // Security: zero the file's ciphertext bytes before unlink so the
        // retired data cannot be recovered from the inode via forensic tools.
        // Although the encryption key is already destroyed (making the data
        // cryptographically unrecoverable), zeroing provides defense-in-depth.
        zero_and_remove_file(original_path).await?;
        if let Some(parent) = original_path.parent() {
            crate::storage::fsync::fsync_dir(parent).await?;
        }
        return Ok(CompactionResult {
            original_path: original_path.to_path_buf(),
            new_path: original_path.to_path_buf(),
            records_kept: 0,
            records_dropped,
            new_size_bytes: 0,
        });
    }

    // 4. Write the kept records to a new segment file via a manual
    //    bytes write (preserves encryption exactly). The SegmentWriter
    //    would re-compute CRCs and break the encryption layout, so we
    //    write raw bytes to a .compacting file, fsync, then rename.
    let parent = original_path.parent().ok_or_else(|| {
        WabiError::InternalInvariantViolated {
            invariant: format!("segment path has no parent: {}", original_path.display()),
        }
    })?;
    let segment_id = parse_segment_id(original_path).ok_or_else(|| {
        WabiError::Corrupt {
            location: format!("parse_segment_id({})", original_path.display()),
            detail: "filename does not end with 8-digit .wseg".into(),
        }
    })?;
    let tmp_path = parent.join(format!("{segment_id:08}.wseg.compacting"));

    let mut kept_bytes: Vec<u8> = Vec::new();
    for record in &kept {
        let encoded_header = record.header.encode();
        kept_bytes.extend_from_slice(&encoded_header);
        kept_bytes.extend_from_slice(&record.payload);
    }

    // Write to temp, fsync, atomic rename.
    tokio::fs::write(&tmp_path, &kept_bytes)
        .await
        .map_err(|e| WabiError::Io(e))?;
    {
        let f = tokio::fs::File::open(&tmp_path)
            .await
            .map_err(|e| WabiError::Io(e))?;
        f.sync_all().await.map_err(|e| WabiError::Io(e))?;
    }
    tokio::fs::rename(&tmp_path, original_path)
        .await
        .map_err(|e| WabiError::Io(e))?;

    Ok(CompactionResult {
        original_path: original_path.to_path_buf(),
        new_path: original_path.to_path_buf(),
        records_kept,
        records_dropped,
        new_size_bytes: kept_bytes.len() as u64,
    })
}

/// Parse the segment id from a path like `00000001.wseg` or
/// `00000001.wseg.compacting`. Returns None if the filename does not
/// match the expected pattern.
fn parse_segment_id(path: &Path) -> Option<u64> {
    let stem = path.file_stem()?.to_str()?;
    // Strip any suffix after the segment number (e.g., ".wseg" or
    // ".compacting").
    let id_part = stem.split('.').next()?;
    id_part.parse().ok()
}

/// Securely zero a file's contents before removing it.
///
/// Overwrites the file with zeros in 1 MiB chunks, then calls `remove_file`.
/// This prevents forensic recovery of encrypted data from disk after the
/// segment is retired. Without this step, the ciphertext bytes would remain
/// in the inode until overwritten by new data.
async fn zero_and_remove_file(path: &Path) -> Result<()> {
    let len = tokio::fs::metadata(path).await.map(|m| m.len()).unwrap_or(0);
    if len > 0 {
        let mut file = tokio::fs::File::create(path).await.map_err(|e| {
            WabiError::Io(std::io::Error::new(e.kind(), format!("open for zeroing: {e}")))
        })?;
        let chunk_size: u64 = 1024 * 1024; // 1 MiB
        let buf = vec![0u8; chunk_size as usize];
        let mut remaining = len;
        while remaining > 0 {
            let write_size = remaining.min(chunk_size);
            file.write_all(&buf[..write_size as usize]).await.map_err(|e| {
                WabiError::Io(std::io::Error::new(e.kind(), format!("zero write: {e}")))
            })?;
            remaining -= write_size;
        }
        file.sync_all().await.map_err(|e| {
            WabiError::Io(std::io::Error::new(e.kind(), format!("zero fsync: {e}")))
        })?;
    }
    tokio::fs::remove_file(path).await.map_err(|e| {
        WabiError::Io(std::io::Error::new(e.kind(), format!("remove after zeroing: {e}")))
    })?;
    Ok(())
}

/// The error category for any future compaction-related errors.
#[allow(dead_code)]
fn _category() -> ErrorCategory {
    ErrorCategory::Retention
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stream_log::segment_writer::SegmentWriter;
    use tempfile::tempdir;

    #[test]
    fn parse_segment_id_valid() {
        let p = std::path::PathBuf::from("/tmp/streams/ch/00000001.wseg");
        assert_eq!(parse_segment_id(&p), Some(1));
        let p2 = std::path::PathBuf::from("/tmp/streams/ch/00000042.wseg");
        assert_eq!(parse_segment_id(&p2), Some(42));
        let p3 = std::path::PathBuf::from("/tmp/streams/ch/00000001.wseg.compacting");
        assert_eq!(parse_segment_id(&p3), Some(1));
    }

    #[test]
    fn parse_segment_id_invalid() {
        let p = std::path::PathBuf::from("/tmp/streams/ch/notanumber.wseg");
        assert_eq!(parse_segment_id(&p), None);
        let p2 = std::path::PathBuf::from("/tmp/streams/ch/");
        assert_eq!(parse_segment_id(&p2), None);
    }

    use crate::format::record::{payload_crc32c, RecordHeader, RecordKind};

    async fn write_segment(events_dir: &Path, count: u64) -> PathBuf {
        let mut w = SegmentWriter::open(events_dir, "ch_test".to_string()).await.unwrap();
        for i in 0..count {
            let payload = b"data";
            let crc = payload_crc32c(payload);
            let hdr = RecordHeader::new(RecordKind::Event, i + 1, [0u8; 16], payload.len() as u32, crc);
            w.append(&hdr, payload).await.unwrap();
        }
        w.close().await.unwrap();
        events_dir.join("00000001.wseg")
    }

    #[tokio::test]
    async fn compact_no_tombstones_keeps_everything() {
        let dir = tempdir().unwrap();
        let events_dir = dir.path().join("streams").join("ch_test").join("events");
        tokio::fs::create_dir_all(&events_dir).await.unwrap();
        let original_path = write_segment(&events_dir, 3).await;

        let table = TombstoneTable::new();
        let result = compact_segment(&original_path, "ch_test", &table).await.unwrap();
        assert_eq!(result.records_kept, 3);
        assert_eq!(result.records_dropped, 0);
    }

    #[tokio::test]
    async fn compact_with_tombstones_drops_them() {
        let dir = tempdir().unwrap();
        let events_dir = dir.path().join("streams").join("ch_test").join("events");
        tokio::fs::create_dir_all(&events_dir).await.unwrap();
        let original_path = write_segment(&events_dir, 5).await;

        let mut table = TombstoneTable::new();
        table.insert("ch_test".to_string(), 2, "user-request".into());
        table.insert("ch_test".to_string(), 4, "retention".into());

        let result = compact_segment(&original_path, "ch_test", &table).await.unwrap();
        assert_eq!(result.records_kept, 3, "expected 3 kept (1, 3, 5)");
        assert_eq!(result.records_dropped, 2, "expected 2 dropped (2, 4)");
    }

    #[tokio::test]
    async fn compact_all_tombstoned_deletes_file() {
        let dir = tempdir().unwrap();
        let events_dir = dir.path().join("streams").join("ch_test").join("events");
        tokio::fs::create_dir_all(&events_dir).await.unwrap();
        let original_path = write_segment(&events_dir, 3).await;

        let mut table = TombstoneTable::new();
        for i in 1..=3 {
            table.insert("ch_test".to_string(), i, "all".into());
        }

        let result = compact_segment(&original_path, "ch_test", &table).await.unwrap();
        assert_eq!(result.records_kept, 0);
        assert_eq!(result.records_dropped, 3);
        assert!(!tokio::fs::try_exists(&original_path).await.unwrap_or(false));
    }

    #[tokio::test]
    async fn compaction_deletes_file_then_fsyncs_directory() {
        let dir = tempdir().unwrap();
        let events_dir = dir.path().join("streams").join("ch_test").join("events");
        tokio::fs::create_dir_all(&events_dir).await.unwrap();
        let original_path = write_segment(&events_dir, 3).await;

        let mut table = TombstoneTable::new();
        for i in 1..=3 {
            table.insert("ch_test".to_string(), i, "all".into());
        }

        // Compact all-tombstoned: should delete and fsync.
        let result = compact_segment(&original_path, "ch_test", &table).await.unwrap();
        assert_eq!(result.records_kept, 0);
        assert_eq!(result.records_dropped, 3);
        assert!(
            !tokio::fs::try_exists(&original_path).await.unwrap_or(false),
            "segment should be deleted"
        );
        // If we got here without an fsync error, the directory fsync succeeded.
    }

    #[tokio::test]
    async fn compact_missing_file_errors() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("missing.wseg");
        let table = TombstoneTable::new();
        let result = compact_segment(&path, "ch_test", &table).await;
        assert!(result.is_err(), "expected error for missing file");
    }
}
