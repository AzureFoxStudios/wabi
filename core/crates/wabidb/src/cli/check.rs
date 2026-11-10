//! `wabidb-cli check`: scan every stream segment and the commit index.
//!
//! Read-only. Meant for a stopped server or a copy of the data directory;
//! never takes, writes or unlinks `.lock`.

use std::path::Path;

use crate::error::Result;
use crate::stream_log::segment_reader::SegmentReader;

#[derive(Debug, Clone)]
pub struct CheckStats {
    /// `streams/<kind>/<stream_dir>` directories found.
    pub total_streams: usize,
    /// `.wseg` files scanned.
    pub total_segments: usize,
    /// Valid records read from those segments.
    pub total_records: usize,
    pub corrupt_records: usize,
    /// Entries in `global/commit-index`.
    pub indexed_commits: usize,
}

#[derive(Debug, Clone)]
pub struct CheckReport {
    pub ok: bool,
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
    pub stats: CheckStats,
}

/// Check the engine directory `data_dir`. `ok` is false if the manifest is
/// missing, a segment or the commit index cannot be read, a record sits in
/// a directory whose name does not match its stream, or the commit index
/// has entries but no segment was found.
pub async fn check(data_dir: &Path) -> Result<CheckReport> {
    let mut errors = Vec::new();
    let mut warnings = Vec::new();
    let mut stats = CheckStats {
        total_streams: 0,
        total_segments: 0,
        total_records: 0,
        corrupt_records: 0,
        indexed_commits: 0,
    };

    let manifest_path = data_dir.join("storage-manifest.json");
    if !tokio::fs::try_exists(&manifest_path).await.unwrap_or(false) {
        return Ok(CheckReport {
            ok: false,
            errors: vec!["missing storage-manifest.json".into()],
            warnings,
            stats,
        });
    }

    let index_dir = data_dir.join("global").join("commit-index");
    match crate::commit_index::batcher::read_all_entries(&index_dir) {
        Ok(entries) => stats.indexed_commits = entries.len(),
        Err(e) => errors.push(format!("cannot read commit index {}: {e}", index_dir.display())),
    }

    for stream in super::stream_dirs(data_dir).await?.unwrap_or_default() {
        stats.total_streams += 1;
        let label = format!("{}/{}", stream.kind_dir, stream.dir_name);
        if stream.stream_kind.is_none() {
            warnings.push(format!("stream {label} is under an unknown kind directory"));
        }
        if !stream.has_events_dir {
            warnings.push(format!("stream {label} has no events directory"));
            continue;
        }
        if stream.segments.is_empty() {
            warnings.push(format!("stream {label} has no segments"));
        }

        let mut hashes = Vec::new();
        for seg_path in &stream.segments {
            stats.total_segments += 1;
            let mut reader = match SegmentReader::open(seg_path).await {
                Ok(r) => r,
                Err(_) => {
                    errors.push(format!("cannot open segment: {}", seg_path.display()));
                    continue;
                }
            };
            match reader.read_records().await {
                Ok(recs) => {
                    stats.total_records += recs.len();
                    hashes.extend(recs.iter().map(|r| r.header.stream_id_hash));
                }
                Err(_) => {
                    stats.corrupt_records += 1;
                    errors.push(format!("corrupt segment: {}", seg_path.display()));
                }
            }
        }

        let resolved = super::resolve_stream_id(&stream.dir_name, &hashes);
        if resolved.unmatched_records > 0 {
            errors.push(format!(
                "stream {label}: {} records belong to a stream other than {:?}",
                resolved.unmatched_records, resolved.stream_id
            ));
        }
    }

    if stats.total_segments == 0 && stats.indexed_commits > 0 {
        errors.push(format!(
            "commit index has {} entries but no segment was found under \
             streams/<kind>/<stream_dir>/events (is DATA_DIR the engine directory?)",
            stats.indexed_commits
        ));
    }

    Ok(CheckReport {
        ok: errors.is_empty(),
        errors,
        warnings,
        stats,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::test_support::{empty_engine_tree, real_engine_tree, remove_segments};

    #[tokio::test]
    async fn missing_manifest_returns_error() {
        let dir = tempfile::tempdir().unwrap();
        let report = check(dir.path()).await.unwrap();
        assert!(!report.ok);
        assert!(report.errors.iter().any(|e| e.contains("storage-manifest.json")));
    }

    /// Fails on main: the old walk treated `streams/channel` and
    /// `streams/other` as streams, found zero segments and returned ok.
    #[tokio::test]
    async fn check_scans_the_segments_a_real_engine_wrote() {
        let dir = tempfile::tempdir().unwrap();
        real_engine_tree(dir.path()).await;

        let report = check(dir.path()).await.unwrap();
        println!("{report:#?}");
        assert!(report.ok, "{report:#?}");
        assert!(report.warnings.is_empty(), "{report:#?}");
        assert_eq!(report.stats.total_streams, 2);
        assert_eq!(report.stats.total_segments, 2);
        assert_eq!(report.stats.total_records, 5);
        assert_eq!(report.stats.indexed_commits, 4);
    }

    #[tokio::test]
    async fn zero_segments_with_indexed_commits_is_not_ok() {
        let dir = tempfile::tempdir().unwrap();
        real_engine_tree(dir.path()).await;
        remove_segments(dir.path());

        let report = check(dir.path()).await.unwrap();
        assert!(!report.ok, "{report:#?}");
        assert_eq!(report.stats.total_segments, 0);
        assert_eq!(report.stats.indexed_commits, 4);
        assert!(report.errors.iter().any(|e| e.contains("no segment was found")), "{report:#?}");
    }

    #[tokio::test]
    async fn missing_streams_dir_with_indexed_commits_is_not_ok() {
        let dir = tempfile::tempdir().unwrap();
        real_engine_tree(dir.path()).await;
        std::fs::remove_dir_all(dir.path().join("streams")).unwrap();

        let report = check(dir.path()).await.unwrap();
        assert!(!report.ok, "{report:#?}");
        assert_eq!(report.stats.total_segments, 0);
    }

    #[tokio::test]
    async fn empty_engine_tree_is_ok() {
        let dir = tempfile::tempdir().unwrap();
        empty_engine_tree(dir.path()).await;

        let report = check(dir.path()).await.unwrap();
        assert!(report.ok, "{report:#?}");
        assert_eq!(report.stats.total_segments, 0);
        assert_eq!(report.stats.indexed_commits, 0);
    }

    /// A segment moved into another stream's directory holds records whose
    /// header hash names neither spelling of that directory.
    #[tokio::test]
    async fn record_in_the_wrong_stream_directory_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        real_engine_tree(dir.path()).await;
        let streams = dir.path().join("streams");
        let channel_events = streams.join("channel").join("ch_alpha").join("events");
        let roster_segment = streams
            .join("other")
            .join(crate::cli::test_support::ROSTER_ENCODED)
            .join("events")
            .join("00000001.wseg");
        std::fs::rename(roster_segment, channel_events.join("00000002.wseg")).unwrap();

        let report = check(dir.path()).await.unwrap();
        assert!(!report.ok, "{report:#?}");
        assert!(
            report.errors.iter().any(|e| e.contains("2 records belong to a stream other than \"ch_alpha\"")),
            "{report:#?}"
        );
    }
}
