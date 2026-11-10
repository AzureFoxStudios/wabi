//! Read-only operator commands behind the `wabidb-cli` binary: `check`,
//! `verify`, `status` and `list-streams`.
//!
//! Every command reads an engine directory (`data/wabi-server/wabidb`) of a
//! stopped server, or a copy of one. None opens the engine, and none takes,
//! writes or unlinks the advisory `.lock` file (AGENTS.md golden rule 9).
//!
//! The on-disk layout is `streams/<kind>/<stream_dir>/events/*.wseg`
//! (docs/ai/wabidb-storage.md). Kind and stream directory names come only
//! from the engine's helpers in `sequencer`; a directory's stream id is
//! resolved per record header hash, as `engine/replay.rs` does.

pub mod check;
pub mod list_streams;
pub mod status;
pub mod verify;

use std::path::{Path, PathBuf};

use crate::error::Result;

/// One `streams/<kind>/<stream_dir>` directory found on disk.
#[derive(Debug, Clone)]
pub(crate) struct StreamDir {
    /// Name of the kind directory, e.g. `channel`.
    pub kind_dir: String,
    /// The stream kind the engine writes into `kind_dir`, or `None` for a
    /// directory name `sequencer::stream_kind_dir_name` never produces.
    pub stream_kind: Option<u8>,
    /// Name of the stream directory: encoded, or raw on older trees.
    pub dir_name: String,
    pub has_events_dir: bool,
    /// `events/*.wseg`, in ascending segment number (the writer's order).
    pub segments: Vec<PathBuf>,
}

/// The stream kind whose directory the engine names `kind_dir`. Kind 6 and
/// unknown kinds share `other`; this returns 6 for it.
pub(crate) fn stream_kind_of_dir(kind_dir: &str) -> Option<u8> {
    (1..=6).find(|kind| crate::sequencer::stream_kind_dir_name(*kind) == kind_dir)
}

/// Every stream directory under `data_dir/streams`, sorted by kind
/// directory then stream directory name. `None` if `streams/` is absent.
/// Like replay, every directory under `streams/` is walked as a kind
/// directory, known or not.
pub(crate) async fn stream_dirs(data_dir: &Path) -> Result<Option<Vec<StreamDir>>> {
    let streams_dir = data_dir.join("streams");
    if !tokio::fs::try_exists(&streams_dir).await? {
        return Ok(None);
    }
    let mut dirs = Vec::new();
    let mut kinds = tokio::fs::read_dir(&streams_dir).await?;
    while let Some(kind_entry) = kinds.next_entry().await? {
        let kind_path = kind_entry.path();
        if !kind_path.is_dir() {
            continue;
        }
        let kind_dir = kind_entry.file_name().to_string_lossy().into_owned();
        let mut streams = tokio::fs::read_dir(&kind_path).await?;
        while let Some(stream_entry) = streams.next_entry().await? {
            let path = stream_entry.path();
            if !path.is_dir() {
                continue;
            }
            let events_dir = path.join("events");
            let has_events_dir = tokio::fs::try_exists(&events_dir).await?;
            let mut segments: Vec<(Option<u64>, PathBuf)> = Vec::new();
            if has_events_dir {
                let mut entries = tokio::fs::read_dir(&events_dir).await?;
                while let Some(entry) = entries.next_entry().await? {
                    let segment = entry.path();
                    if segment.extension() == Some(std::ffi::OsStr::new("wseg")) {
                        let number = segment
                            .file_stem()
                            .and_then(|stem| stem.to_str())
                            .and_then(|stem| stem.parse::<u64>().ok());
                        segments.push((number, segment));
                    }
                }
            }
            segments.sort();
            dirs.push(StreamDir {
                stream_kind: stream_kind_of_dir(&kind_dir),
                kind_dir: kind_dir.clone(),
                dir_name: stream_entry.file_name().to_string_lossy().into_owned(),
                has_events_dir,
                segments: segments.into_iter().map(|(_, path)| path).collect(),
            });
        }
    }
    dirs.sort_by(|a, b| (&a.kind_dir, &a.dir_name).cmp(&(&b.kind_dir, &b.dir_name)));
    Ok(Some(dirs))
}

/// The stream id a directory holds, resolved as replay does.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ResolvedStreamId {
    pub stream_id: String,
    /// Records whose header hash matches neither spelling of the directory
    /// name: replay would decrypt them under the wrong stream's key.
    pub unmatched_records: usize,
}

/// Resolve the stream id of a directory named `dir_name` from the stream id
/// hashes in its record headers. The candidates are
/// `sequencer::stream_id_candidates` (raw name first, then its decoding);
/// the id is the candidate the records name, else the raw name.
pub(crate) fn resolve_stream_id<'a>(
    dir_name: &str,
    record_hashes: impl IntoIterator<Item = &'a [u8; 16]>,
) -> ResolvedStreamId {
    let candidates: Vec<(String, [u8; 16])> = crate::sequencer::stream_id_candidates(dir_name)
        .into_iter()
        .map(|id| {
            let hash = crate::stream_identity::stream_id_hash(&id);
            (id, hash)
        })
        .collect();
    let mut named: Option<usize> = None;
    let mut unmatched_records = 0;
    for hash in record_hashes {
        match candidates.iter().position(|(_, candidate)| candidate == hash) {
            Some(index) => {
                named.get_or_insert(index);
            }
            None => unmatched_records += 1,
        }
    }
    ResolvedStreamId {
        stream_id: candidates[named.unwrap_or(0)].0.clone(),
        unmatched_records,
    }
}

/// Real-engine data directories for the CLI tests. Every CLI test runs the
/// command against a tree written by `WabiDbEngine`, never a hand-built one.
#[cfg(test)]
pub(crate) mod test_support {
    use std::path::Path;

    use crate::crypto::bootstrap::BootstrapSource;
    use crate::engine::{WabiDbConfig, WabiDbEngine};
    use crate::format::record::RecordKind;
    use crate::sequencer::types::{CommandCommit, EventToWrite};

    pub(crate) const BOOTSTRAP: [u8; 32] = [0x2Bu8; 32];
    /// `stream_kind_dir_name(1)` → `channel`.
    pub(crate) const CHANNEL: (&str, u8) = ("ch_alpha", 1);
    /// `stream_kind_dir_name(6)` → `other`. The colon forces an encoded
    /// directory name, `community-roster%3Av1`.
    pub(crate) const ROSTER: (&str, u8) = ("community-roster:v1", 6);
    pub(crate) const ROSTER_ENCODED: &str = "community-roster%3Av1";

    pub(crate) fn config(path: &Path) -> WabiDbConfig {
        let mut config = WabiDbConfig::new(path.to_path_buf(), BootstrapSource::Provided(BOOTSTRAP));
        config.allow_init = true;
        config
    }

    pub(crate) async fn commit(engine: &WabiDbEngine, events: &[(&str, u8)], payload: &[u8]) {
        for (stream, _) in events {
            engine.get_or_create_stream_key(stream).await.unwrap();
        }
        let (response_tx, _response_rx) = tokio::sync::oneshot::channel();
        engine
            .run_command(CommandCommit {
                room_owner_precondition: None,
                caller_user_id: 1,
                caller_device_id: "cli-test-device".into(),
                command_name: "cli_test_cmd".into(),
                idempotency_key: None,
                events: events
                    .iter()
                    .map(|(stream, kind)| EventToWrite {
                        stream_id: (*stream).to_string(),
                        event_type: "cli_test_event".into(),
                        stream_kind: *kind,
                        record_kind: RecordKind::Event,
                        plaintext: payload.to_vec(),
                    })
                    .collect(),
                essential: true,
                response_tx,
            })
            .await
            .unwrap();
    }

    /// Open a real engine at `path`, write four commands across two stream
    /// kinds (five records: the last command writes both streams), and
    /// close it. Returns once the engine has released its advisory lock.
    ///
    /// Commits 1..=4. Records: channel 3 (seqs 1, 3, 4), roster 2 (seqs 2, 4).
    pub(crate) async fn real_engine_tree(path: &Path) {
        let engine = crate::tests::reopen_after_drop(config(path), None).await.unwrap();
        commit(&engine, &[CHANNEL], b"one").await;
        commit(&engine, &[ROSTER], b"two").await;
        commit(&engine, &[CHANNEL], b"three").await;
        commit(&engine, &[CHANNEL, ROSTER], b"four").await;
        drop(engine);
        drop(crate::tests::wait_for_stopped_engine(path).await);
    }

    /// Open a real engine at `path` and close it without writing.
    pub(crate) async fn empty_engine_tree(path: &Path) {
        drop(crate::tests::reopen_after_drop(config(path), None).await.unwrap());
        drop(crate::tests::wait_for_stopped_engine(path).await);
    }

    /// Delete every `.wseg` file, keeping the stream directories.
    pub(crate) fn remove_segments(path: &Path) {
        for kind in std::fs::read_dir(path.join("streams")).unwrap() {
            for stream in std::fs::read_dir(kind.unwrap().path()).unwrap() {
                for segment in std::fs::read_dir(stream.unwrap().path().join("events")).unwrap() {
                    std::fs::remove_file(segment.unwrap().path()).unwrap();
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::path::{Path, PathBuf};

    use super::test_support::real_engine_tree;

    /// (path, size, modified, inode) of every entry under `root`.
    fn inventory(root: &Path) -> BTreeMap<PathBuf, (u64, std::time::SystemTime, u64)> {
        fn walk(dir: &Path, out: &mut BTreeMap<PathBuf, (u64, std::time::SystemTime, u64)>) {
            for entry in std::fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                let meta = std::fs::symlink_metadata(&path).unwrap();
                #[cfg(unix)]
                let inode = std::os::unix::fs::MetadataExt::ino(&meta);
                #[cfg(not(unix))]
                let inode = 0;
                out.insert(path.clone(), (meta.len(), meta.modified().unwrap(), inode));
                if meta.is_dir() {
                    walk(&path, out);
                }
            }
        }
        let mut out = BTreeMap::new();
        walk(root, &mut out);
        out
    }

    /// Every command runs while another handle holds the advisory lock (so
    /// none needs it) and leaves the tree, `.lock` inode and bytes included,
    /// exactly as it was.
    #[tokio::test]
    async fn commands_are_read_only_and_never_touch_the_lock() {
        let dir = tempfile::tempdir().unwrap();
        real_engine_tree(dir.path()).await;
        let held_lock = crate::tests::wait_for_stopped_engine(dir.path()).await;
        let lock_bytes = std::fs::read(dir.path().join(".lock")).unwrap();
        let before = inventory(dir.path());
        assert!(before.contains_key(&dir.path().join(".lock")));

        assert!(super::check::check(dir.path()).await.unwrap().ok);
        assert!(super::verify::verify(dir.path()).await.unwrap().ok);
        assert_eq!(super::status::status(dir.path()).await.unwrap().segment_count, 2);
        assert_eq!(super::list_streams::list_streams(dir.path()).await.unwrap().len(), 2);

        assert_eq!(inventory(dir.path()), before);
        assert_eq!(std::fs::read(dir.path().join(".lock")).unwrap(), lock_bytes);
        drop(held_lock);
    }

    #[test]
    fn resolve_stream_id_follows_the_record_header_hash() {
        let hash = crate::stream_identity::stream_id_hash;
        // Encoded directory: the records name the decoded id.
        let roster = hash("community-roster:v1");
        let resolved = super::resolve_stream_id("community-roster%3Av1", [&roster]);
        assert_eq!(resolved.stream_id, "community-roster:v1");
        assert_eq!(resolved.unmatched_records, 0);
        // A raw id that is spelled like an encoding keeps its raw name.
        let raw = hash("a%3Ab");
        assert_eq!(super::resolve_stream_id("a%3Ab", [&raw]).stream_id, "a%3Ab");
        // No records: the raw name, as replay falls back to.
        let none: [&[u8; 16]; 0] = [];
        assert_eq!(super::resolve_stream_id("a%3Ab", none).stream_id, "a%3Ab");
        // A record of another stream is counted, not adopted.
        let other = hash("ch_other");
        let resolved = super::resolve_stream_id("ch_alpha", [&other]);
        assert_eq!(resolved.stream_id, "ch_alpha");
        assert_eq!(resolved.unmatched_records, 1);
    }
}
