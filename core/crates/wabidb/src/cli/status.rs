use std::path::Path;


use crate::error::Result;
use crate::stream_log::segment_reader::SegmentReader;

#[derive(Debug, Clone)]
pub struct StatusReport {
    pub data_dir_size_bytes: u64,
    pub stream_count: u64,
    pub segment_count: u64,
    pub commit_count: u64,
    pub last_commit_seq_micros: Option<i64>,
    pub oldest_event_micros: Option<i64>,
}

pub async fn status(data_dir: &Path) -> Result<StatusReport> {
    let mut data_dir_size = 0u64;
    let mut stream_count = 0u64;
    let mut segment_count = 0u64;
    let mut commit_count = 0u64;
    let mut last_commit_seq_micros: Option<i64> = None;
    let mut oldest_event_micros: Option<i64> = None;

    let streams_dir = data_dir.join("streams");
    if !tokio::fs::try_exists(&streams_dir).await.unwrap_or(false) {
        return Ok(StatusReport {
            data_dir_size_bytes: 0,
            stream_count: 0,
            segment_count: 0,
            commit_count: 0,
            last_commit_seq_micros: None,
            oldest_event_micros: None,
        });
    }

    let mut streams_reader = tokio::fs::read_dir(&streams_dir).await?;
    while let Some(entry) = streams_reader.next_entry().await? {
        let stream_path = entry.path();
        if !stream_path.is_dir() {
            continue;
        }
        stream_count += 1;

        if let Ok(meta) = tokio::fs::metadata(&stream_path).await {
            data_dir_size = data_dir_size.saturating_add(meta.len());
        }

        let events_dir = stream_path.join("events");
        if !tokio::fs::try_exists(&events_dir).await.unwrap_or(false) {
            continue;
        }

        let mut events_reader = tokio::fs::read_dir(&events_dir).await?;
        while let Some(seg_entry) = events_reader.next_entry().await? {
            let seg_path = seg_entry.path();
            if seg_path.extension().map_or(false, |ext| ext == "wseg") {
                segment_count += 1;

                if let Ok(meta) = tokio::fs::metadata(&seg_path).await {
                    data_dir_size = data_dir_size.saturating_add(meta.len());
                }

                if let Ok(mut reader) = SegmentReader::open(&seg_path).await {
                    if let Ok(recs) = reader.read_records().await {
                        for r in &recs {
                            commit_count += 1;
                            last_commit_seq_micros = Some(r.header.commit_seq as i64);
                            if oldest_event_micros.is_none() {
                                oldest_event_micros = Some(r.header.commit_seq as i64);
                            }
                        }
                    }
                }
            }
        }
    }

    Ok(StatusReport {
        data_dir_size_bytes: data_dir_size,
        stream_count,
        segment_count,
        commit_count,
        last_commit_seq_micros,
        oldest_event_micros,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::format::record::{payload_crc32c, RecordHeader, RecordKind};
    use crate::stream_log::segment_writer::SegmentWriter;
    use tempfile::tempdir;

    #[tokio::test]
    async fn empty_dir_returns_zeros() {
        let dir = tempdir().unwrap();
        let report = status(dir.path()).await.unwrap();
        assert_eq!(report.stream_count, 0);
        assert_eq!(report.segment_count, 0);
        assert_eq!(report.commit_count, 0);
        assert!(report.last_commit_seq_micros.is_none());
    }

    #[tokio::test]
    async fn populated_dir_returns_counts() {
        let dir = tempdir().unwrap();
        let data_dir = dir.path();

        for sid in &["ch_a", "ch_b"] {
            let events_dir = data_dir.join("streams").join(sid).join("events");
            tokio::fs::create_dir_all(&events_dir).await.unwrap();
            let payload = b"data";
            let crc = payload_crc32c(payload);
            let mut writer = SegmentWriter::open(&events_dir, sid.to_string()).await.unwrap();
            for i in 0u64..3 {
                let h = RecordHeader::new(RecordKind::Event, i, [0u8; 16], payload.len() as u32, crc);
                writer.append(&h, payload).await.unwrap();
            }
            writer.close().await.unwrap();
        }

        let report = status(data_dir).await.unwrap();
        assert_eq!(report.stream_count, 2);
        assert_eq!(report.segment_count, 2);
        assert_eq!(report.commit_count, 6);
        assert!(report.data_dir_size_bytes > 0);
        assert!(report.last_commit_seq_micros.is_some());
        assert!(report.oldest_event_micros.is_some());
    }
}
