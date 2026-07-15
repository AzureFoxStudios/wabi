use std::path::Path;

use crate::error::{Result, WabiError};
use crate::format::record::RecordHeader;
use crate::storage::fsync::fsync_dir;

#[derive(Clone)]
pub struct RecoveryRecord {
    pub stream_id: String,
    pub header: RecordHeader,
    pub payload: Vec<u8>,
}

pub struct RecoveryResult {
    pub valid_records: Vec<RecoveryRecord>,
    pub error: Option<String>,
}

/// Truncate a file at a given byte offset.
///
/// After truncation the file is fsync'd and the parent directory is
/// fsync'd so the size change is durable on disk.
pub async fn truncate_at_offset(path: &Path, offset: u64) -> Result<()> {
    let f = tokio::fs::OpenOptions::new()
        .write(true)
        .open(path)
        .await
        .map_err(WabiError::Io)?;
    f.set_len(offset).await.map_err(WabiError::Io)?;
    f.sync_all().await.map_err(WabiError::Io)?;
    drop(f);
    if let Some(parent) = path.parent() {
        fsync_dir(parent).await?;
    }
    Ok(())
}

/// Scan a segment file for valid records and truncate at the first
/// corrupt or truncated position.
///
/// Per the kanban card body (wabidb-08): *"Truncate at first invalid
/// record. Update file size on disk."* The [`SegmentReader`] stops at
/// the first invalid header or truncated tail; this function records the
/// stop offset and truncates the file if any trailing data remains.
pub async fn scan_segment_file(path: &Path) -> Result<RecoveryResult> {
    use crate::stream_log::segment_reader::SegmentReader;
    let file_len = tokio::fs::metadata(path)
        .await
        .map(|m| m.len())
        .unwrap_or(0);
    let mut reader = SegmentReader::open(path).await?;
    let records = reader.read_records().await?;
    let cursor = reader.cursor();

    // Truncate if we didn't reach the end of the file.
    if cursor < file_len {
        truncate_at_offset(path, cursor).await?;
    }

    let valid_records: Vec<RecoveryRecord> = records
        .into_iter()
        .map(|r| RecoveryRecord {
            stream_id: String::new(),
            header: r.header,
            payload: r.payload,
        })
        .collect();
    Ok(RecoveryResult {
        valid_records,
        error: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::format::record::{payload_crc32c, RecordKind};
    use crate::stream_log::segment_writer::SegmentWriter;
    use tempfile::tempdir;

    fn test_header(commit_seq: u64, payload: &[u8]) -> RecordHeader {
        let mut stream_hash = [0u8; 16];
        stream_hash[0] = 0xAB;
        let crc = payload_crc32c(payload);
        RecordHeader::new(RecordKind::Event, commit_seq, stream_hash, payload.len() as u32, crc)
    }

    #[tokio::test]
    async fn recovery_truncates_at_corrupt_record() {
        let dir = tempdir().unwrap();
        let events_dir = dir.path().join("events");
        tokio::fs::create_dir_all(&events_dir).await.unwrap();

        // Write 3 valid records, then append trailing garbage.
        let seg_path = events_dir.join("00000001.wseg");
        {
            let mut writer = SegmentWriter::open(&events_dir, "ch_test".into())
                .await
                .unwrap();
            for i in 1..=3u64 {
                let payload = format!("rec{i}").into_bytes();
                let h = test_header(i, &payload);
                writer.append(&h, &payload).await.unwrap();
            }
            writer.flush().await.unwrap();
            writer.close().await.unwrap();
        }

        // Append garbage after the 3rd record to simulate a corrupt 4th record.
        {
            let mut f = tokio::fs::OpenOptions::new()
                .append(true)
                .open(&seg_path)
                .await
                .unwrap();
            use tokio::io::AsyncWriteExt;
            f.write_all(b"CORRUPTED GARBAGE DATA THAT IS NOT A VALID RECORD")
                .await
                .unwrap();
            f.sync_all().await.unwrap();
        }

        let original_len = tokio::fs::metadata(&seg_path).await.unwrap().len();

        // Run recovery: should truncate the garbage.
        let result = scan_segment_file(&seg_path).await.unwrap();
        assert_eq!(result.valid_records.len(), 3);

        // Verify the file was truncated.
        let new_len = tokio::fs::metadata(&seg_path).await.unwrap().len();
        assert!(new_len < original_len, "file should be smaller after truncation");
    }

    #[tokio::test]
    async fn recovery_does_not_truncate_clean_file() {
        let dir = tempdir().unwrap();
        let events_dir = dir.path().join("events");
        tokio::fs::create_dir_all(&events_dir).await.unwrap();

        let seg_path = events_dir.join("00000001.wseg");
        {
            let mut writer = SegmentWriter::open(&events_dir, "ch_test".into())
                .await
                .unwrap();
            for i in 1..=3u64 {
                let payload = format!("rec{i}").into_bytes();
                let h = test_header(i, &payload);
                writer.append(&h, &payload).await.unwrap();
            }
            writer.close().await.unwrap();
        }

        let original_len = tokio::fs::metadata(&seg_path).await.unwrap().len();

        let result = scan_segment_file(&seg_path).await.unwrap();
        assert_eq!(result.valid_records.len(), 3);

        let new_len = tokio::fs::metadata(&seg_path).await.unwrap().len();
        assert_eq!(new_len, original_len, "clean file should not be truncated");
    }

    #[tokio::test]
    async fn recovery_truncates_empty_tail() {
        let dir = tempdir().unwrap();
        let events_dir = dir.path().join("events");
        tokio::fs::create_dir_all(&events_dir).await.unwrap();

        let seg_path = events_dir.join("00000001.wseg");
        {
            let mut writer = SegmentWriter::open(&events_dir, "ch_test".into())
                .await
                .unwrap();
            for i in 1..=3u64 {
                let payload = format!("rec{i}").into_bytes();
                let h = test_header(i, &payload);
                writer.append(&h, &payload).await.unwrap();
            }
            writer.flush().await.unwrap();
            writer.close().await.unwrap();
        }

        // Append zeros (simulates a partial write that didn't complete).
        {
            let mut f = tokio::fs::OpenOptions::new()
                .append(true)
                .open(&seg_path)
                .await
                .unwrap();
            use tokio::io::AsyncWriteExt;
            f.write_all(&[0u8; 128]).await.unwrap();
            f.sync_all().await.unwrap();
        }

        let result = scan_segment_file(&seg_path).await.unwrap();
        assert_eq!(result.valid_records.len(), 3);

        // The file should be truncated back to the valid data length.
        let final_len = tokio::fs::metadata(&seg_path).await.unwrap().len();
        let expected_len = {
            let mut reader = crate::stream_log::segment_reader::SegmentReader::open(&seg_path)
                .await
                .unwrap();
            let _ = reader.read_records().await.unwrap();
            reader.cursor()
        };
        assert_eq!(final_len, expected_len);
    }
}
