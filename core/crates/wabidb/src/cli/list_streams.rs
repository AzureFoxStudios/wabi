use std::path::Path;

use crate::error::Result;
use crate::stream_log::segment_reader::SegmentReader;

#[derive(Debug, Clone)]
pub struct StreamInfo {
    pub stream_id: String,
    pub stream_kind: u8,
    pub last_commit_seq: u64,
    pub segment_count: u32,
}

pub async fn list_streams(data_dir: &Path) -> Result<Vec<StreamInfo>> {
    let streams_dir = data_dir.join("streams");
    if !tokio::fs::try_exists(&streams_dir).await.unwrap_or(false) {
        return Ok(Vec::new());
    }

    let mut streams = Vec::new();
    let mut streams_reader = tokio::fs::read_dir(&streams_dir).await?;

    while let Some(entry) = streams_reader.next_entry().await? {
        let stream_path = entry.path();
        if !stream_path.is_dir() {
            continue;
        }

        let stream_id = stream_path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();

        let events_dir = stream_path.join("events");
        let mut segment_count = 0u32;
        let mut last_commit_seq = 0u64;

        if tokio::fs::try_exists(&events_dir).await.unwrap_or(false) {
            let mut events_reader = tokio::fs::read_dir(&events_dir).await?;
            while let Some(seg_entry) = events_reader.next_entry().await? {
                let seg_path = seg_entry.path();
                if seg_path.extension().map_or(false, |ext| ext == "wseg") {
                    segment_count += 1;
                    if let Ok(mut reader) = SegmentReader::open(&seg_path).await {
                        if let Ok(recs) = reader.read_records().await {
                            for r in &recs {
                                if r.header.commit_seq > last_commit_seq {
                                    last_commit_seq = r.header.commit_seq;
                                }
                            }
                        }
                    }
                }
            }
        }

        let stream_kind = if stream_id.starts_with("ch_") {
            1u8
        } else if stream_id.starts_with("dm_") {
            2u8
        } else {
            6u8
        };

        streams.push(StreamInfo {
            stream_id,
            stream_kind,
            last_commit_seq,
            segment_count,
        });
    }

    streams.sort_by(|a, b| a.stream_id.cmp(&b.stream_id));
    Ok(streams)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::format::record::{payload_crc32c, RecordHeader, RecordKind};
    use crate::stream_log::segment_writer::SegmentWriter;
    use tempfile::tempdir;

    #[tokio::test]
    async fn empty_dir_returns_empty() {
        let dir = tempdir().unwrap();
        let streams = list_streams(dir.path()).await.unwrap();
        assert!(streams.is_empty());
    }

    #[tokio::test]
    async fn multiple_streams_listed() {
        let dir = tempdir().unwrap();
        let data_dir = dir.path();

        for sid in &["ch_alpha", "dm_beta", "ch_gamma"] {
            let events_dir = data_dir.join("streams").join(sid).join("events");
            tokio::fs::create_dir_all(&events_dir).await.unwrap();
            let payload = b"data";
            let crc = payload_crc32c(payload);
            let mut writer = SegmentWriter::open(&events_dir, sid.to_string()).await.unwrap();
            let h = RecordHeader::new(RecordKind::Event, 1, [0u8; 16], payload.len() as u32, crc);
            writer.append(&h, payload).await.unwrap();
            writer.close().await.unwrap();
        }

        let streams = list_streams(data_dir).await.unwrap();
        assert_eq!(streams.len(), 3);
    }

    #[tokio::test]
    async fn ordering_is_by_stream_id() {
        let dir = tempdir().unwrap();
        let data_dir = dir.path();

        for sid in &["ch_z", "ch_a", "ch_m"] {
            let events_dir = data_dir.join("streams").join(sid).join("events");
            tokio::fs::create_dir_all(&events_dir).await.unwrap();
        }

        let streams = list_streams(data_dir).await.unwrap();
        let ids: Vec<&str> = streams.iter().map(|s| s.stream_id.as_str()).collect();
        assert_eq!(ids, vec!["ch_a", "ch_m", "ch_z"]);
    }
}
