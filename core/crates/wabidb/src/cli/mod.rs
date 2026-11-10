//! Operator commands behind the `wabidb-cli` binary.
//!
//! `check`, `verify`, `status` and `list-streams` only read. Each reads an
//! engine directory (`data/wabi-server/wabidb`) of a stopped server, or a
//! copy of one. None opens the engine, and none takes, writes or unlinks
//! the advisory `.lock` file (AGENTS.md golden rule 9).
//!
//! `quarantine` is the one command that writes: it takes the advisory lock
//! while it runs, so it cannot run against a live engine, and adds a commit
//! to `global/quarantine.json`. It never creates or unlinks `.lock`.
//!
//! The on-disk layout is `streams/<kind>/<stream_dir>/events/*.wseg`
//! (docs/ai/wabidb-storage.md). Kind and stream directory names come only
//! from the engine's helpers in `sequencer`; a directory's stream id is
//! resolved per record header hash, as `engine/replay.rs` does.
//!
//! `check` and `verify` also match every record against the commit index
//! ([`IndexedRecords`]): an acknowledged record that is missing, or whose
//! stored payload no longer has the hash the index recorded, is an error.
//! A commit in `global/quarantine.json` is reported as quarantined instead:
//! startup skips it whole, so its records are not required.

pub mod check;
pub mod list_streams;
pub mod quarantine;
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

/// What the commit index says the segments must hold, matched against what
/// they do hold. No key is needed: each index entry carries the BLAKE3 hash
/// of every record's stored (encrypted) payload, the same hash
/// `validate_replicated_events` checks.
///
/// This is the only way these commands can see a damaged payload. The
/// sequencer writes records with `payload_crc32c = 0` (the AES-GCM tag is
/// their integrity check), so `SegmentReader` returns a record whose payload
/// was altered on disk as valid. Replay then fails to decrypt it and refuses
/// to start with "not all indexed events could be recovered".
pub(crate) struct IndexedRecords {
    indexed_commits: std::collections::HashSet<u64>,
    /// Indexed commits the operator quarantined.
    quarantined: std::collections::BTreeSet<u64>,
    /// Everything `global/quarantine.json` lists, indexed or not.
    listed: std::collections::BTreeSet<u64>,
    /// Highest commit_seq in the index or in any record, orphans included.
    highest_seq: u64,
    /// Payload hashes still unmatched, per (commit_seq, stream id hash).
    expected: std::collections::HashMap<(u64, [u8; 16]), Vec<[u8; 32]>>,
    /// Records of an indexed commit whose payload matched no expected hash.
    unmatched: std::collections::HashMap<(u64, [u8; 16]), usize>,
    malformed_entries: Vec<u64>,
    orphan_records: usize,
}

/// Result of [`IndexedRecords::finish`]. Commit lists are ascending and
/// hold at most [`IndexedRecordsReport::LISTED_COMMITS`] entries.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct IndexedRecordsReport {
    /// Indexed records with no record in any segment.
    pub missing_records: usize,
    pub missing_commits: Vec<u64>,
    /// Indexed records whose stored payload does not match the index hash.
    pub corrupt_records: usize,
    pub corrupt_commits: Vec<u64>,
    /// Records that carry an indexed commit_seq the commit does not
    /// reference. Replay counts them and refuses the commit.
    pub unreferenced_records: usize,
    pub unreferenced_commits: Vec<u64>,
    /// Index entries whose reference and hash counts differ.
    pub malformed_entries: Vec<u64>,
    /// Records whose commit_seq is not in the index: leftovers of a command
    /// that never committed. Replay skips them; they are not an error.
    pub orphan_records: usize,
    /// Indexed commits listed in `global/quarantine.json`, ascending.
    /// Startup skips them, so damage to their records is not counted above.
    pub quarantined_commits: Vec<u64>,
    /// Commits `global/quarantine.json` lists above `highest_commit_seq`.
    /// The engine refuses to start on these: the next write would receive
    /// that seq and be skipped.
    pub future_quarantined: Vec<u64>,
    /// Highest commit_seq in the index or in any record, orphans included.
    /// The engine also counts its snapshot watermark, which these commands
    /// do not read; that is never above the index on a tree it wrote.
    pub highest_commit_seq: u64,
}

impl IndexedRecordsReport {
    pub(crate) const LISTED_COMMITS: usize = 10;

    /// One line per kind of damage, empty when the segments hold exactly
    /// what the commit index acknowledges.
    pub(crate) fn errors(&self) -> Vec<String> {
        let mut errors = Vec::new();
        if !self.malformed_entries.is_empty() {
            errors.push(format!(
                "commit index entries with differing reference and hash counts, commits {:?}",
                self.malformed_entries
            ));
        }
        if self.missing_records > 0 {
            errors.push(format!(
                "{} indexed records are missing from the segments, first commits {:?}",
                self.missing_records, self.missing_commits
            ));
        }
        if self.corrupt_records > 0 {
            errors.push(format!(
                "{} indexed records do not match the payload hash in the commit index, first commits {:?}",
                self.corrupt_records, self.corrupt_commits
            ));
        }
        if self.unreferenced_records > 0 {
            errors.push(format!(
                "{} records carry an indexed commit_seq that commit does not reference, first commits {:?}",
                self.unreferenced_records, self.unreferenced_commits
            ));
        }
        if !self.future_quarantined.is_empty() {
            errors.push(format!(
                "global/quarantine.json lists commits {:?} above every commit on disk ({});                  the engine refuses to start until they are removed from the list",
                self.future_quarantined, self.highest_commit_seq
            ));
        }
        errors
    }
}

impl IndexedRecords {
    /// `quarantine` is the content of `global/quarantine.json`.
    pub(crate) fn new(
        entries: &[crate::commit_index::record::CommitIndexEntry],
        quarantine: &std::collections::BTreeSet<u64>,
    ) -> Self {
        let mut this = Self {
            indexed_commits: Default::default(),
            quarantined: Default::default(),
            listed: quarantine.clone(),
            highest_seq: 0,
            expected: Default::default(),
            unmatched: Default::default(),
            malformed_entries: Vec::new(),
            orphan_records: 0,
        };
        for entry in entries {
            this.indexed_commits.insert(entry.commit_seq);
            this.highest_seq = this.highest_seq.max(entry.commit_seq);
            if quarantine.contains(&entry.commit_seq) {
                this.quarantined.insert(entry.commit_seq);
                continue;
            }
            if entry.event_refs.len() != entry.payload_hashes.len() {
                this.malformed_entries.push(entry.commit_seq);
            }
            for (reference, hash) in entry.event_refs.iter().zip(&entry.payload_hashes) {
                this.expected
                    .entry((entry.commit_seq, reference.stream_id_hash))
                    .or_default()
                    .push(*hash);
            }
        }
        this
    }

    /// Account for one record read from a segment.
    pub(crate) fn observe(&mut self, header: &crate::format::record::RecordHeader, payload: &[u8]) {
        // Orphans count too: the sequencer continues above them.
        self.highest_seq = self.highest_seq.max(header.commit_seq);
        if !self.indexed_commits.contains(&header.commit_seq) {
            self.orphan_records += 1;
            return;
        }
        if self.quarantined.contains(&header.commit_seq) {
            return;
        }
        let key = (header.commit_seq, header.stream_id_hash);
        let hash = *blake3::hash(payload).as_bytes();
        let matched = self.expected.get_mut(&key).and_then(|hashes| {
            let index = hashes.iter().position(|expected| *expected == hash)?;
            Some(hashes.swap_remove(index))
        });
        if matched.is_none() {
            *self.unmatched.entry(key).or_default() += 1;
        }
    }

    pub(crate) fn finish(mut self) -> IndexedRecordsReport {
        fn listed(mut commits: Vec<u64>) -> Vec<u64> {
            commits.sort_unstable();
            commits.dedup();
            commits.truncate(IndexedRecordsReport::LISTED_COMMITS);
            commits
        }
        let mut report = IndexedRecordsReport {
            orphan_records: self.orphan_records,
            quarantined_commits: self.quarantined.iter().copied().collect(),
            future_quarantined: self
                .listed
                .iter()
                .copied()
                .filter(|seq| *seq > self.highest_seq)
                .collect(),
            highest_commit_seq: self.highest_seq,
            ..Default::default()
        };
        let (mut missing, mut corrupt, mut unreferenced) = (Vec::new(), Vec::new(), Vec::new());
        for (key, hashes) in &self.expected {
            // A record of this stream and commit with another payload is the
            // damaged copy of an expected one; anything left over is absent.
            let altered = self.unmatched.remove(key).unwrap_or(0);
            let damaged = altered.min(hashes.len());
            if damaged > 0 {
                report.corrupt_records += damaged;
                corrupt.push(key.0);
            }
            if hashes.len() > damaged {
                report.missing_records += hashes.len() - damaged;
                missing.push(key.0);
            }
            if altered > damaged {
                report.unreferenced_records += altered - damaged;
                unreferenced.push(key.0);
            }
        }
        for (key, count) in &self.unmatched {
            report.unreferenced_records += count;
            unreferenced.push(key.0);
        }
        self.malformed_entries.sort_unstable();
        self.malformed_entries.truncate(IndexedRecordsReport::LISTED_COMMITS);
        report.missing_commits = listed(missing);
        report.corrupt_commits = listed(corrupt);
        report.unreferenced_commits = listed(unreferenced);
        report.malformed_entries = self.malformed_entries;
        report
    }
}

/// The quarantine list for `check` and `verify`. An unreadable file is an
/// error in their report (the engine will not start) and counts as empty.
pub(crate) fn quarantine_for_report(
    data_dir: &Path,
    errors: &mut Vec<String>,
) -> std::collections::BTreeSet<u64> {
    crate::engine::quarantine::load(data_dir).unwrap_or_else(|e| {
        errors.push(e.to_string());
        Default::default()
    })
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

    /// Every read-only command runs while another handle holds the advisory
    /// lock (so none needs it) and leaves the tree, `.lock` inode and bytes
    /// included, exactly as it was. (`quarantine` writes; see its tests.)
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
    fn indexed_records_separates_corrupt_missing_orphan_and_unreferenced() {
        use crate::commit_index::record::{CommitIndexEntry, StreamRef};
        use crate::format::record::{RecordHeader, RecordKind};

        let stream = |name: &str| crate::stream_identity::stream_id_hash(name);
        let hash = |payload: &[u8]| *blake3::hash(payload).as_bytes();
        let reference = |name: &str| StreamRef {
            stream_id_hash: stream(name),
            stream_kind: 1,
            segment_id: 1,
            offset: 0,
            length: 0,
        };
        let entry = |commit_seq: u64, events: &[(&str, &[u8])]| CommitIndexEntry {
            commit_seq,
            timestamp_micros: 0,
            caller_user_id: 0,
            caller_device_id_hash: [0; 16],
            command_name_hash: [0; 16],
            has_idempotency_key: false,
            idempotency_key_hash: None,
            event_refs: events.iter().map(|(name, _)| reference(name)).collect(),
            payload_hashes: events.iter().map(|(_, payload)| hash(payload)).collect(),
        };
        let header = |commit_seq: u64, name: &str, payload: &[u8]| {
            RecordHeader::new(RecordKind::Event, commit_seq, stream(name), payload.len() as u32, 0)
        };
        let entries = [
            // Two events on one stream in one commit: matched as a multiset.
            entry(1, &[("a", b"one"), ("a", b"two")]),
            entry(2, &[("a", b"three"), ("b", b"four")]),
            entry(3, &[("a", b"five")]),
        ];

        // Everything present, in any order, plus an orphan of commit 9.
        let mut all = super::IndexedRecords::new(&entries, &Default::default());
        for (seq, name, payload) in
            [(1, "a", &b"two"[..]), (1, "a", b"one"), (2, "b", b"four"), (2, "a", b"three"), (3, "a", b"five"), (9, "a", b"x")]
        {
            all.observe(&header(seq, name, payload), payload);
        }
        let report = all.finish();
        assert!(report.errors().is_empty(), "{report:?}");
        assert_eq!(report.orphan_records, 1);

        // Commit 1: one of two payloads altered. Commit 2: stream b absent.
        // Commit 3: its record plus one the commit does not reference.
        let mut damaged = super::IndexedRecords::new(&entries, &Default::default());
        for (seq, name, payload) in
            [(1, "a", &b"one"[..]), (1, "a", b"tw0"), (2, "a", b"three"), (3, "a", b"five"), (3, "c", b"six")]
        {
            damaged.observe(&header(seq, name, payload), payload);
        }
        let report = damaged.finish();
        assert_eq!((report.corrupt_records, report.corrupt_commits.clone()), (1, vec![1]));
        assert_eq!((report.missing_records, report.missing_commits.clone()), (1, vec![2]));
        assert_eq!((report.unreferenced_records, report.unreferenced_commits.clone()), (1, vec![3]));
        assert_eq!(report.errors().len(), 3);
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
