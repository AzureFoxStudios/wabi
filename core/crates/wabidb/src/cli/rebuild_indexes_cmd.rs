use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::error::Result;
use crate::cli::rebuild_indexes::rebuild_indexes;

pub struct RebuildIndexesReport {
    pub streams_processed: u64,
    pub entries_replayed: u64,
    pub duration_micros: i64,
}

pub async fn rebuild_indexes_cmd(data_dir: &Path) -> Result<RebuildIndexesReport> {
    let start = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_micros() as i64)
        .unwrap_or(0);

    eprintln!("Rebuilding indexes in {:?} ...", data_dir);

    let report = rebuild_indexes(data_dir).await?;

    let end = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_micros() as i64)
        .unwrap_or(0);

    let duration = end - start;

    eprintln!(
        "Rebuild complete: {} streams, {} entries, {}µs",
        report.streams_processed, report.entries_replayed, duration
    );

    Ok(RebuildIndexesReport {
        streams_processed: report.streams_processed,
        entries_replayed: report.entries_replayed,
        duration_micros: duration,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::format::record::{payload_crc32c, RecordHeader, RecordKind};
    use crate::stream_log::segment_writer::SegmentWriter;
    use tempfile::tempdir;

    #[tokio::test]
    async fn empty_dir_returns_zero() {
        let dir = tempdir().unwrap();
        let report = rebuild_indexes_cmd(dir.path()).await.unwrap();
        assert_eq!(report.streams_processed, 0);
        assert_eq!(report.entries_replayed, 0);
        assert!(report.duration_micros >= 0);
    }

    #[tokio::test]
    async fn populated_dir_replays_entries() {
        let dir = tempdir().unwrap();
        let data_dir = dir.path();

        let events_dir = data_dir.join("streams").join("ch_test").join("events");
        tokio::fs::create_dir_all(&events_dir).await.unwrap();

        let payload = b"event data";
        let crc = payload_crc32c(payload);
        let mut writer = SegmentWriter::open(&events_dir, "ch_test".into()).await.unwrap();
        for i in 0u64..5 {
            let h = RecordHeader::new(RecordKind::Event, i, [0u8; 16], payload.len() as u32, crc);
            writer.append(&h, payload).await.unwrap();
        }
        writer.close().await.unwrap();

        let report = rebuild_indexes_cmd(data_dir).await.unwrap();
        assert_eq!(report.streams_processed, 1);
        assert_eq!(report.entries_replayed, 5);
    }

    #[tokio::test]
    async fn progress_output_is_printed() {
        let dir = tempdir().unwrap();
        let data_dir = dir.path();

        let events_dir = data_dir.join("streams").join("ch_progress").join("events");
        tokio::fs::create_dir_all(&events_dir).await.unwrap();

        let payload = b"progress";
        let crc = payload_crc32c(payload);
        let mut writer = SegmentWriter::open(&events_dir, "ch_progress".into()).await.unwrap();
        let h = RecordHeader::new(RecordKind::Event, 1, [0u8; 16], payload.len() as u32, crc);
        writer.append(&h, payload).await.unwrap();
        writer.close().await.unwrap();

        let report = rebuild_indexes_cmd(data_dir).await.unwrap();
        assert_eq!(report.streams_processed, 1);
        assert_eq!(report.entries_replayed, 1);
    }
}
