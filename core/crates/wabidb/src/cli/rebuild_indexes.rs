use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::error::Result;
use crate::stream_log::segment_reader::SegmentReader;

#[derive(Debug, Clone)]
pub struct RebuildReport {
    pub streams_processed: u64,
    pub entries_replayed: u64,
    pub duration_micros: i64,
}

pub async fn rebuild_indexes(data_dir: &Path) -> Result<RebuildReport> {
    let start = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_micros() as i64)
        .unwrap_or(0);

    let streams_dir = data_dir.join("streams");
    if !tokio::fs::try_exists(&streams_dir).await.unwrap_or(false) {
        let duration = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_micros() as i64)
            .unwrap_or(0) - start;
        return Ok(RebuildReport {
            streams_processed: 0,
            entries_replayed: 0,
            duration_micros: duration,
        });
    }

    let mut streams_processed = 0u64;
    let mut entries_replayed = 0u64;

    let mut streams_reader = tokio::fs::read_dir(&streams_dir).await?;
    while let Some(entry) = streams_reader.next_entry().await? {
        let stream_path = entry.path();
        if !stream_path.is_dir() {
            continue;
        }
        streams_processed += 1;

        let events_dir = stream_path.join("events");
        if !tokio::fs::try_exists(&events_dir).await.unwrap_or(false) {
            continue;
        }

        let mut events_reader = tokio::fs::read_dir(&events_dir).await?;
        let mut segment_paths = Vec::new();
        while let Some(seg_entry) = events_reader.next_entry().await? {
            let seg_path = seg_entry.path();
            if seg_path.extension().map_or(false, |ext| ext == "wseg") {
                segment_paths.push(seg_path);
            }
        }
        segment_paths.sort();

        for seg_path in &segment_paths {
            let mut reader = match SegmentReader::open(seg_path).await {
                Ok(r) => r,
                Err(_) => continue,
            };
            if let Ok(recs) = reader.read_records().await {
                entries_replayed += recs.len() as u64;
            }
        }
    }

    let end = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_micros() as i64)
        .unwrap_or(0);

    Ok(RebuildReport {
        streams_processed,
        entries_replayed,
        duration_micros: end - start,
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
        let report = rebuild_indexes(dir.path()).await.unwrap();
        assert_eq!(report.streams_processed, 0);
        assert_eq!(report.entries_replayed, 0);
        assert!(report.duration_micros >= 0);
    }

    #[tokio::test]
    async fn single_stream_replays_entries() {
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

        let report = rebuild_indexes(data_dir).await.unwrap();
        assert_eq!(report.streams_processed, 1);
        assert_eq!(report.entries_replayed, 5);
    }

    #[tokio::test]
    async fn multiple_streams() {
        let dir = tempdir().unwrap();
        let data_dir = dir.path();

        for sid in &["ch_a", "ch_b", "ch_c"] {
            let events_dir = data_dir.join("streams").join(sid).join("events");
            tokio::fs::create_dir_all(&events_dir).await.unwrap();
            let payload = b"data";
            let crc = payload_crc32c(payload);
            let mut writer = SegmentWriter::open(&events_dir, sid.to_string()).await.unwrap();
            let h = RecordHeader::new(RecordKind::Event, 1, [0u8; 16], payload.len() as u32, crc);
            writer.append(&h, payload).await.unwrap();
            writer.close().await.unwrap();
        }

        let report = rebuild_indexes(data_dir).await.unwrap();
        assert_eq!(report.streams_processed, 3);
        assert_eq!(report.entries_replayed, 3);
    }
}
