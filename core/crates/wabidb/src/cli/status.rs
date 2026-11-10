//! `wabidb-cli status`: counts and sizes from the segments and commit index.
//!
//! Read-only. Meant for a stopped server or a copy of the data directory;
//! never takes, writes or unlinks `.lock`.

use std::path::Path;

use crate::error::Result;
use crate::stream_log::segment_reader::SegmentReader;

#[derive(Debug, Clone)]
pub struct StatusReport {
    /// `streams/<kind>/<stream_dir>` directories.
    pub stream_count: u64,
    pub segment_count: u64,
    /// Total size of the `.wseg` files.
    pub segment_bytes: u64,
    /// Valid records in the segments, orphans included.
    pub record_count: u64,
    /// Highest `commit_seq` in any record header.
    pub highest_record_seq: Option<u64>,
    /// Entries in `global/commit-index`.
    pub indexed_commits: u64,
    pub highest_commit_seq: Option<u64>,
    /// Commit timestamps (micros since the Unix epoch) from the index.
    pub oldest_commit_micros: Option<i64>,
    pub newest_commit_micros: Option<i64>,
}

pub async fn status(data_dir: &Path) -> Result<StatusReport> {
    let mut report = StatusReport {
        stream_count: 0,
        segment_count: 0,
        segment_bytes: 0,
        record_count: 0,
        highest_record_seq: None,
        indexed_commits: 0,
        highest_commit_seq: None,
        oldest_commit_micros: None,
        newest_commit_micros: None,
    };

    let index_dir = data_dir.join("global").join("commit-index");
    let entries = crate::commit_index::batcher::read_all_entries(&index_dir)?;
    report.indexed_commits = entries.len() as u64;
    report.highest_commit_seq = entries.iter().map(|e| e.commit_seq).max();
    report.oldest_commit_micros = entries.iter().map(|e| e.timestamp_micros).min();
    report.newest_commit_micros = entries.iter().map(|e| e.timestamp_micros).max();

    for stream in super::stream_dirs(data_dir).await?.unwrap_or_default() {
        report.stream_count += 1;
        for seg_path in &stream.segments {
            report.segment_count += 1;
            if let Ok(meta) = tokio::fs::metadata(seg_path).await {
                report.segment_bytes = report.segment_bytes.saturating_add(meta.len());
            }
            if let Ok(mut reader) = SegmentReader::open(seg_path).await {
                if let Ok(recs) = reader.read_records().await {
                    for r in &recs {
                        report.record_count += 1;
                        report.highest_record_seq =
                            report.highest_record_seq.max(Some(r.header.commit_seq));
                    }
                }
            }
        }
    }

    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::test_support::{empty_engine_tree, real_engine_tree};

    #[tokio::test]
    async fn empty_engine_tree_returns_zeros() {
        let dir = tempfile::tempdir().unwrap();
        empty_engine_tree(dir.path()).await;
        let report = status(dir.path()).await.unwrap();
        assert_eq!(report.segment_count, 0);
        assert_eq!(report.record_count, 0);
        assert_eq!(report.indexed_commits, 0);
        assert!(report.highest_commit_seq.is_none());
        assert!(report.oldest_commit_micros.is_none());
    }

    #[tokio::test]
    async fn real_engine_tree_returns_counts() {
        let dir = tempfile::tempdir().unwrap();
        real_engine_tree(dir.path()).await;

        let report = status(dir.path()).await.unwrap();
        assert_eq!(report.stream_count, 2, "{report:#?}");
        assert_eq!(report.segment_count, 2);
        assert_eq!(report.record_count, 5);
        assert_eq!(report.highest_record_seq, Some(4));
        assert_eq!(report.indexed_commits, 4);
        assert_eq!(report.highest_commit_seq, Some(4));
        assert!(report.segment_bytes > 0);
        let (oldest, newest) =
            (report.oldest_commit_micros.unwrap(), report.newest_commit_micros.unwrap());
        assert!(oldest > 0 && oldest <= newest, "{report:#?}");
    }
}
