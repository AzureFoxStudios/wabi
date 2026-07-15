use std::path::Path;

use crate::error::Result;
use crate::sequencer::types::DurableEvent;
use crate::stream_log::segment_reader::SegmentReader;

pub async fn tail(
    data_dir: &Path,
    stream_id: &str,
    n: usize,
) -> Result<Vec<DurableEvent>> {
    let events_dir = data_dir.join("streams").join(stream_id).join("events");
    if !tokio::fs::try_exists(&events_dir).await.unwrap_or(false) {
        return Ok(Vec::new());
    }

    let mut dir_entries = tokio::fs::read_dir(&events_dir).await?;
    let mut segment_paths = Vec::new();
    while let Some(entry) = dir_entries.next_entry().await? {
        let path = entry.path();
        if path.extension().map_or(false, |ext| ext == "wseg") {
            segment_paths.push(path);
        }
    }
    segment_paths.sort();

    let mut all_events: Vec<DurableEvent> = Vec::new();

    for seg_path in &segment_paths {
        let mut reader = match SegmentReader::open(seg_path).await {
            Ok(r) => r,
            Err(_) => continue,
        };
        if let Ok(recs) = reader.read_records().await {
            for r in &recs {
                all_events.push(DurableEvent {
                    commit_seq: r.header.commit_seq,
                    stream_id: stream_id.to_string(),
                    event_type: "unknown".into(),
                    ciphertext: r.payload.clone(),
                    record_bytes: Vec::new(),
                });
            }
        }
    }

    all_events.sort_by_key(|e| e.commit_seq);

    if n >= all_events.len() {
        return Ok(all_events);
    }

    Ok(all_events[all_events.len() - n..].to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::format::record::{payload_crc32c, RecordHeader, RecordKind};
    use crate::stream_log::segment_writer::SegmentWriter;
    use tempfile::tempdir;

    fn make_payload_crc(payload: &[u8]) -> u32 {
        payload_crc32c(payload)
    }

    #[tokio::test]
    async fn empty_stream_returns_empty() {
        let dir = tempdir().unwrap();
        let data_dir = dir.path();
        let events_dir = data_dir.join("streams").join("ch_test").join("events");
        tokio::fs::create_dir_all(&events_dir).await.unwrap();

        let result = tail(data_dir, "ch_test", 10).await.unwrap();
        assert!(result.is_empty());
    }

    #[tokio::test]
    async fn n_equals_one_returns_last_event() {
        let dir = tempdir().unwrap();
        let data_dir = dir.path();
        let events_dir = data_dir.join("streams").join("ch_test").join("events");
        tokio::fs::create_dir_all(&events_dir).await.unwrap();

        let mut writer = SegmentWriter::open(&events_dir, "ch_test".into()).await.unwrap();
        let payload = b"data";
        let crc = make_payload_crc(payload);
        for i in 0u64..5 {
            let h = RecordHeader::new(RecordKind::Event, i, [0u8; 16], payload.len() as u32, crc);
            writer.append(&h, payload).await.unwrap();
        }
        writer.close().await.unwrap();

        let result = tail(data_dir, "ch_test", 1).await.unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].commit_seq, 4);
    }

    #[tokio::test]
    async fn n_equals_ten_with_five_events_returns_all() {
        let dir = tempdir().unwrap();
        let data_dir = dir.path();
        let events_dir = data_dir.join("streams").join("ch_test").join("events");
        tokio::fs::create_dir_all(&events_dir).await.unwrap();

        let mut writer = SegmentWriter::open(&events_dir, "ch_test".into()).await.unwrap();
        let payload = b"data";
        let crc = make_payload_crc(payload);
        for i in 0u64..5 {
            let h = RecordHeader::new(RecordKind::Event, i, [0u8; 16], payload.len() as u32, crc);
            writer.append(&h, payload).await.unwrap();
        }
        writer.close().await.unwrap();

        let result = tail(data_dir, "ch_test", 10).await.unwrap();
        assert_eq!(result.len(), 5);
    }
}
