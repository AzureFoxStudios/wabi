//! `wabidb-cli list-streams`: one line per stream directory.
//!
//! Read-only. Meant for a stopped server or a copy of the data directory;
//! never takes, writes or unlinks `.lock`.

use std::path::Path;

use crate::error::Result;
use crate::stream_log::segment_reader::SegmentReader;

#[derive(Debug, Clone)]
pub struct StreamInfo {
    /// The id the records name (raw directory name or its decoding), as
    /// replay resolves it. A directory with no records shows its raw name.
    pub stream_id: String,
    /// Kind of the directory it sits in (`streams/<kind>`); `None` for a
    /// directory name the engine does not write.
    pub stream_kind: Option<u8>,
    pub kind_dir: String,
    /// The directory name on disk, encoded or raw.
    pub dir_name: String,
    pub segment_count: u32,
    pub record_count: u64,
    pub last_commit_seq: u64,
}

/// Streams sorted by kind directory, then stream id.
pub async fn list_streams(data_dir: &Path) -> Result<Vec<StreamInfo>> {
    let mut streams = Vec::new();
    for stream in super::stream_dirs(data_dir).await?.unwrap_or_default() {
        let mut hashes = Vec::new();
        let mut last_commit_seq = 0u64;
        for seg_path in &stream.segments {
            if let Ok(mut reader) = SegmentReader::open(seg_path).await {
                if let Ok(recs) = reader.read_records().await {
                    for r in &recs {
                        hashes.push(r.header.stream_id_hash);
                        last_commit_seq = last_commit_seq.max(r.header.commit_seq);
                    }
                }
            }
        }
        streams.push(StreamInfo {
            stream_id: super::resolve_stream_id(&stream.dir_name, &hashes).stream_id,
            stream_kind: stream.stream_kind,
            kind_dir: stream.kind_dir,
            dir_name: stream.dir_name,
            segment_count: stream.segments.len() as u32,
            record_count: hashes.len() as u64,
            last_commit_seq,
        });
    }
    streams.sort_by(|a, b| (&a.kind_dir, &a.stream_id).cmp(&(&b.kind_dir, &b.stream_id)));
    Ok(streams)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::test_support::{
        empty_engine_tree, real_engine_tree, CHANNEL, ROSTER, ROSTER_ENCODED,
    };

    #[tokio::test]
    async fn empty_engine_tree_lists_nothing() {
        let dir = tempfile::tempdir().unwrap();
        empty_engine_tree(dir.path()).await;
        assert!(list_streams(dir.path()).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn real_engine_tree_lists_decoded_ids_and_kinds() {
        let dir = tempfile::tempdir().unwrap();
        real_engine_tree(dir.path()).await;

        let streams = list_streams(dir.path()).await.unwrap();
        let rows: Vec<_> = streams
            .iter()
            .map(|s| {
                (
                    s.stream_id.as_str(),
                    s.stream_kind,
                    s.kind_dir.as_str(),
                    s.dir_name.as_str(),
                    s.segment_count,
                    s.record_count,
                    s.last_commit_seq,
                )
            })
            .collect();
        assert_eq!(
            rows,
            vec![
                (CHANNEL.0, Some(CHANNEL.1), "channel", CHANNEL.0, 1, 3, 4),
                (ROSTER.0, Some(ROSTER.1), "other", ROSTER_ENCODED, 1, 2, 4),
            ]
        );
    }

    /// A tree written before PR 293 holds the raw id, colon included, as
    /// the directory name. Linux allows `:` in names, so the fixture is the
    /// real engine's tree with the encoded directory renamed to the raw
    /// name: segment and index bytes do not depend on the directory name.
    #[cfg(unix)]
    #[tokio::test]
    async fn legacy_raw_named_directory_lists_its_raw_id() {
        let dir = tempfile::tempdir().unwrap();
        real_engine_tree(dir.path()).await;
        let other = dir.path().join("streams").join("other");
        std::fs::rename(other.join(ROSTER_ENCODED), other.join(ROSTER.0)).unwrap();

        let streams = list_streams(dir.path()).await.unwrap();
        let roster = streams.iter().find(|s| s.kind_dir == "other").unwrap();
        assert_eq!(roster.stream_id, ROSTER.0);
        assert_eq!(roster.dir_name, ROSTER.0);
        assert_eq!(roster.record_count, 2);

        let report = crate::cli::check::check(dir.path()).await.unwrap();
        assert!(report.ok, "{report:#?}");
        assert_eq!(report.stats.total_segments, 2);
        assert_eq!(report.stats.total_records, 5);
    }
}
