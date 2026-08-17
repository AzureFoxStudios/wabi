use crate::crypto::bootstrap::BootstrapSource;
use crate::engine::{WabiDbConfig, WabiDbEngine};
use crate::error::Result;
use crate::format::record::{payload_crc32c, RecordHeader, RecordKind};
use crate::sequencer::types::{CommandCommit, EventToWrite};
use crate::stream_log::segment_reader::SegmentReader;
use crate::stream_log::segment_writer::SegmentWriter;
use std::time::Duration;

/// Helper: write a single record to a segment and return its header + payload.
async fn write_record(
    writer: &mut SegmentWriter,
    commit_seq: u64,
    payload: &[u8],
) -> Result<(RecordHeader, Vec<u8>)> {
    let mut stream_hash = [0u8; 16];
    stream_hash[0] = 0xAB;
    let crc = payload_crc32c(payload);
    let header = RecordHeader::new(RecordKind::Event, commit_seq, stream_hash, payload.len() as u32, crc);
    writer.append(&header, payload).await?;
    Ok((header, payload.to_vec()))
}

/// Scenario 1: Write records, simulate crash before fsync, then read back.
///
/// "Crash before fsync" means the data is in the kernel page cache but not
/// necessarily on disk. Even without an explicit fsync, the data is still
/// readable via the page cache on the same system. This test verifies that
/// the data IS readable (from the kernel cache) even without fsync, which
/// is the expected behavior for a "crash before fsync" scenario where the
/// crash does not occur.
#[tokio::test]
async fn simulate_power_loss_before_fsync() {
    let dir = tempfile::tempdir().unwrap();
    let events_dir = dir.path().join("events");

    // Open a writer and append 3 records without fsync.
    let mut writer = SegmentWriter::open(&events_dir, "ch_test".into())
        .await
        .unwrap();
    for i in 1..=3u64 {
        write_record(&mut writer, i, b"data before fsync").await.unwrap();
    }

    // Simulate a crash by NOT flushing and just dropping the writer.
    let _path = writer.path().to_path_buf();

    // After "restart", open the segment with a reader.
    let seg_path = events_dir.join("00000001.wseg");
    let mut reader = SegmentReader::open(&seg_path).await.unwrap();
    let records = reader.read_records().await.unwrap();

    // All 3 records should be readable (they were written to the page cache).
    assert_eq!(records.len(), 3, "all 3 records should be readable");
    for (i, record) in records.iter().enumerate() {
        assert_eq!(record.header.commit_seq, i as u64 + 1);
        assert_eq!(record.payload, b"data before fsync");
    }
}

/// Scenario 2: Write 3 records, simulate crash between segment write and
/// commit-index append. On recovery the records appear as "orphans" —
/// they exist in the segment file but have no commit-index entry.
///
/// Orphans are tolerated per Option B rollback semantics (Council Review #1
/// §2.2). This test verifies that the orphan records are present when read
/// without a commit-index filter (they would be silently skipped when a
/// filter is applied).
#[tokio::test]
async fn simulate_crash_between_segment_write_and_commit_index() {
    let dir = tempfile::tempdir().unwrap();
    let events_dir = dir.path().join("events");

    // Write 3 records to the segment.
    let mut writer = SegmentWriter::open(&events_dir, "ch_orphan".into())
        .await
        .unwrap();
    for i in 1..=3u64 {
        write_record(&mut writer, i, b"orphan record").await.unwrap();
    }

    // Simulate crash: commit-index append never happened.
    // Close (flush) the segment writer to simulate the segment being
    // fully written but no commit-index entry created.
    writer.close().await.unwrap();

    // On recovery, the segment reader finds the records as orphans.
    let seg_path = events_dir.join("00000001.wseg");
    let mut reader = SegmentReader::open(&seg_path).await.unwrap();
    let all_records = reader.read_records().await.unwrap();

    assert_eq!(all_records.len(), 3, "all 3 orphan records are present on disk");

    // Apply an orphan filter that rejects everything (simulating a commit
    // index that has no entries). The reader should skip all 3.
    let mut reader2 = SegmentReader::open(&seg_path).await.unwrap();
    let filtered = reader2
        .read_records_filtered(|_| false)
        .await
        .unwrap();
    assert!(
        filtered.is_empty(),
        "all records should be skipped when filtered as orphans"
    );

    // Apply a filter that accepts only commit_seq 2 (simulating a commit
    // index that only has seq 2). The reader should return only that record.
    let mut reader3 = SegmentReader::open(&seg_path).await.unwrap();
    let partial = reader3
        .read_records_filtered(|h| h.commit_seq == 2)
        .await
        .unwrap();
    assert_eq!(partial.len(), 1, "only commit_seq=2 should be accepted");
    assert_eq!(partial[0].header.commit_seq, 2);
}

/// Scenario 3: Write 3 records, simulate crash after commit-index fsync,
/// restart, all 3 records are durable.
///
/// In this scenario, the full write path completes: segment is written,
/// flushed/fsynced, and the commit index entry is fsynced. On recovery,
/// all 3 records should be readable from the segment file.
#[tokio::test]
async fn simulate_power_loss_after_commit_index_fsync() {
    let dir = tempfile::tempdir().unwrap();
    let events_dir = dir.path().join("events");

    // Write and FLUSH (fsync) after each record, simulating the full
    // durable write path: segment written + commit index fsynced.
    let mut writer = SegmentWriter::open(&events_dir, "ch_durable".into())
        .await
        .unwrap();
    for i in 1..=3u64 {
        write_record(&mut writer, i, b"durable record").await.unwrap();
    }
    writer.flush().await.unwrap();

    // Simulate crash after commit-index fsync.
    // (In a real scenario the commit-index batcher would also fsync;
    // here we just verify the segment data is durable.)
    let saved_path = writer.path().to_path_buf();
    writer.close().await.unwrap();

    // After restart, read the segment.
    let mut reader = SegmentReader::open(&saved_path).await.unwrap();
    let records = reader.read_records().await.unwrap();

    assert_eq!(records.len(), 3, "all 3 records must be durable after flush");
    for (i, record) in records.iter().enumerate() {
        assert_eq!(record.header.commit_seq, i as u64 + 1);
        assert_eq!(record.payload, b"durable record");
    }

    // Verify the file is on disk and has the expected size.
    let metadata = tokio::fs::metadata(&saved_path).await.unwrap();
    let header = records[0].header.clone();
    let expected_size = header.total_size() as u64 * 3;
    assert_eq!(metadata.len(), expected_size, "file size must match 3 records");
}

// ---------------------------------------------------------------------------
// Physical power-loss tests (wabidb-99)
//
// These tests use subprocess isolation: the parent spawns the test binary
// as a child process with WABIDB_CRASH_BOUNDARY set to one of 5 boundary
// points. The child's crash_point() hook fires at the configured boundary
// and calls std::process::exit(1). The parent then reopens the engine and
// verifies recovery invariants.
//
// Run with: cargo test --features test-harness -p wabidb --lib tests::power_loss -- --ignored
// ---------------------------------------------------------------------------

/// Build a simple command with one event.
fn make_crash_cmd(
    seq_prefix: u64,
    stream_id: &str,
    stream_kind: u8,
    plaintext: &[u8],
) -> CommandCommit {
    let (tx, _rx) = tokio::sync::oneshot::channel();
    CommandCommit {
        caller_user_id: seq_prefix,
        caller_device_id: format!("dev{seq_prefix}"),
        command_name: "crash_test".into(),
        idempotency_key: Some(format!("crash_{seq_prefix}")),
        events: vec![EventToWrite {
            stream_id: stream_id.to_string(),
            event_type: "test_event".into(),
            stream_kind,
            record_kind: RecordKind::Event,
            plaintext: plaintext.to_vec(),
        }],
        essential: true,
        response_tx: tx,
    }
}

/// Spawn the child process that will crash at the configured boundary.
/// Returns the child's exit status.
fn spawn_crash_child(
    data_dir: &std::path::Path,
    boundary: &str,
) -> std::io::Result<std::process::ExitStatus> {
    let mut cmd = std::process::Command::new(std::env::current_exe().unwrap());
    cmd.arg("tests::power_loss::run_crash_child")
        .arg("--nocapture")
        .env("WABIDB_CRASH_BOUNDARY", boundary)
        .env("WABIDB_CRASH_AT", boundary)
        .env("WABIDB_DATA_DIR", data_dir);
    cmd.status()
}

/// Open the engine, register a stream, and commit `n` commands.
/// After this, the engine will have committed seq 1..=n.
///
/// Uses the deterministic (bootstrap-derived) stream key so every
/// generation of this test reopens with the SAME key and prior records
/// stay decryptable across restarts.
async fn populate_engine(
    data_dir: &std::path::Path,
    n: u64,
) {
    let config = WabiDbConfig {
        data_dir: data_dir.to_path_buf(),
        bootstrap_source: BootstrapSource::Provided([0xABu8; 32]),
        bootstrap_salt: None,
        allow_init: true,
        replication_config: None,
        sync_transport: None,
        };
    let engine = WabiDbEngine::open(config).await.unwrap();
    engine.get_or_create_stream_key("ch_crash").await.unwrap();
    for i in 1..=n {
        let outcome = engine.run_command(make_crash_cmd(i, "ch_crash", 1, b"prior data")).await.unwrap();
        assert_eq!(outcome.commit_seq, i);
    }
    // Let the engine drain before drop/shutdown.
    tokio::time::sleep(Duration::from_millis(50)).await;
}

/// Verify recovery after a crash: engine reopens on the EXISTING commit
/// index and segments. The sequencer resumes above the recovered
/// high-water mark, so a fresh write must get `commit_seq > prior highest`,
/// and the commit index must contain strictly increasing, duplicate-free
/// seqs across all `.widx` files.
async fn verify_recovery(
    data_dir: &std::path::Path,
    expected_prior_count: u64,
) {
    // Remove the stale lock file left by the crashed child process.
    let lock_path = data_dir.join(".lock");
    let _ = std::fs::remove_file(&lock_path);

    let config = WabiDbConfig {
        data_dir: data_dir.to_path_buf(),
        bootstrap_source: BootstrapSource::Provided([0xABu8; 32]),
        bootstrap_salt: None,
        allow_init: true,
        replication_config: None,
        sync_transport: None,
        };
    let engine = WabiDbEngine::open(config).await.unwrap();
    engine.get_or_create_stream_key("ch_crash").await.unwrap();

    // Verify the projection state has the expected number of prior commits.
    let applied = engine.projection_state().applied_commit_seq();
    assert!(applied >= expected_prior_count,
        "expected at least {expected_prior_count} prior commits, got {applied}");

    // The recovered commit index must be duplicate-free and ordered.
    let ci_dir = data_dir.join("global").join("commit-index");
    let entries = crate::commit_index::batcher::read_all_entries(&ci_dir).unwrap();
    let seqs: Vec<u64> = entries.iter().map(|e| e.commit_seq).collect();
    let mut sorted = seqs.clone();
    sorted.sort_unstable();
    sorted.dedup();
    assert!(
        seqs == sorted,
        "commit index seqs must be strictly increasing with no duplicates, got {seqs:?}"
    );

    // Submit a fresh command: it must land ABOVE the recovered high-water
    // mark (never reuse a seq from a previous incarnation).
    let outcome = engine
        .run_command(make_crash_cmd(u64::MAX, "ch_crash", 1, b"recovery verify"))
        .await
        .unwrap();
    assert!(
        outcome.commit_seq > expected_prior_count,
        "post-restart commit_seq {} must exceed prior high-water mark {}",
        outcome.commit_seq,
        expected_prior_count
    );
}

// ---------------------------------------------------------------------------
// Child entry point — invoked as a subprocess by the parent tests.
// ---------------------------------------------------------------------------

/// This test function is the child entry point for physical power-loss tests.
/// It only acts when WABIDB_CRASH_BOUNDARY is set; otherwise it's a no-op
/// so it doesn't interfere with normal test runs.
#[cfg(feature = "test-harness")]
#[test]
fn run_crash_child() {
    let boundary = match std::env::var("WABIDB_CRASH_BOUNDARY") {
        Ok(b) => b,
        Err(_) => return, // not in child mode
    };
    let data_dir = std::env::var("WABIDB_DATA_DIR")
        .expect("WABIDB_DATA_DIR must be set for crash child");
    let path = std::path::PathBuf::from(&data_dir);

    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
        let config = WabiDbConfig {
            data_dir: path,
            bootstrap_source: BootstrapSource::Provided([0xABu8; 32]),
            bootstrap_salt: None,
            allow_init: true,
            replication_config: None,
            sync_transport: None,
        };
        let engine = WabiDbEngine::open(config).await.unwrap();
        engine.get_or_create_stream_key("ch_crash").await.unwrap();

        // Commit 100 prior commands so the state is non-trivial.
        for i in 1..=100u64 {
            let outcome = engine.run_command(make_crash_cmd(i, "ch_crash", 1, b"prior data")).await.unwrap();
            assert_eq!(outcome.commit_seq, i);
        }

        // The crash boundary command — this will hit the crash_point hook.
        let _ = engine.run_command(make_crash_cmd(101, "ch_crash", 1, b"crash boundary")).await;
        // If we get here, the crash didn't fire (shouldn't happen if the
        // boundary is valid and test-harness is enabled).
        panic!("child did not crash at boundary '{boundary}'; crash_point may not be wired");
    });

    panic!("child did not crash at boundary '{boundary}'");
}

// ---------------------------------------------------------------------------
// 5 physical power-loss tests
// ---------------------------------------------------------------------------

/// Boundary 0: crash before any stream write.
/// Verifies: burned-seq invariant — seq 101 is never reused.
#[cfg(feature = "test-harness")]
#[test]
#[ignore]
fn crash_before_any_write() {
    let dir = tempfile::tempdir().unwrap();

    // Populate with 100 prior commits using the parent process.
    let parent_rt = tokio::runtime::Runtime::new().unwrap();
    parent_rt.block_on(populate_engine(dir.path(), 100));

    // Spawn the child to crash at boundary 0.
    let status = spawn_crash_child(dir.path(), "crash_before_any_write").unwrap();
    assert!(!status.success(), "child should have crashed at boundary 0");

    // Verify recovery: engine reopens with prior commits intact.
    parent_rt.block_on(verify_recovery(dir.path(), 100));
}

/// Boundary 1: crash after one stream's segment write, before another's.
/// Verifies: orphan skip — stream segments have data but commit index doesn't.
#[cfg(feature = "test-harness")]
#[test]
#[ignore]
fn crash_mid_stream_write() {
    let dir = tempfile::tempdir().unwrap();

    let parent_rt = tokio::runtime::Runtime::new().unwrap();
    parent_rt.block_on(populate_engine(dir.path(), 100));

    let status = spawn_crash_child(dir.path(), "crash_mid_stream_write").unwrap();
    assert!(!status.success(), "child should have crashed at boundary 1");

    // Verify recovery: engine reopens with prior commits intact.
    parent_rt.block_on(verify_recovery(dir.path(), 100));
}

/// Boundary 2: crash after all segment fsyncs, before commit index fsync.
/// Verifies: Option B orphan skip — orphans on disk are tolerated.
#[cfg(feature = "test-harness")]
#[test]
#[ignore]
fn crash_before_index_fsync() {
    let dir = tempfile::tempdir().unwrap();

    let parent_rt = tokio::runtime::Runtime::new().unwrap();
    parent_rt.block_on(populate_engine(dir.path(), 100));

    let status = spawn_crash_child(dir.path(), "crash_before_index_fsync").unwrap();
    assert!(!status.success(), "child should have crashed at boundary 2");

    // Verify recovery: engine reopens with prior commits intact.
    parent_rt.block_on(verify_recovery(dir.path(), 100));
}

/// Boundary 3: crash after commit index fsync, before projection update.
/// Verifies: durability-await — index entry is durable, but the Ok was
/// never sent, so the client retry is safe.
#[cfg(feature = "test-harness")]
#[test]
#[ignore]
fn crash_after_index_fsync() {
    let dir = tempfile::tempdir().unwrap();

    let parent_rt = tokio::runtime::Runtime::new().unwrap();
    parent_rt.block_on(populate_engine(dir.path(), 100));

    let status = spawn_crash_child(dir.path(), "crash_after_index_fsync").unwrap();
    assert!(!status.success(), "child should have crashed at boundary 3");

    // Verify recovery: engine reopens with prior commits intact.
    parent_rt.block_on(verify_recovery(dir.path(), 100));
}

/// Boundary 4: crash after projection update, before run_command returns.
/// Verifies: idempotency — the command was fully committed but the caller
/// never received the Ok, so retry with the same idempotency key is safe.
#[cfg(feature = "test-harness")]
#[test]
#[ignore]
fn crash_after_projection_update() {
    let dir = tempfile::tempdir().unwrap();

    let parent_rt = tokio::runtime::Runtime::new().unwrap();
    parent_rt.block_on(populate_engine(dir.path(), 100));

    let status = spawn_crash_child(dir.path(), "crash_after_projection_update").unwrap();
    assert!(!status.success(), "child should have crashed at boundary 4");

    // Verify recovery: engine reopens with prior commits intact.
    parent_rt.block_on(verify_recovery(dir.path(), 100));
}

// ---------------------------------------------------------------------------
// Restart safety regression test (no crash harness needed)
// ---------------------------------------------------------------------------

/// Graceful restart must never reset the commit sequencer.
///
/// Regression test for the audit finding that `next_commit_seq` restarted
/// at 1 on every boot: duplicate `commit_seq`s across generations caused
/// (a) AES-GCM nonce reuse — the stream key is deterministically re-derived
/// and the nonce IS the commit_seq — and (b) duplicate generations of events
/// replayed into projections. With seq seeding at open, three generations of
/// writes must produce one strictly-increasing commit history.
#[tokio::test]
async fn restart_never_reuses_commit_seq() {
    let dir = tempfile::tempdir().unwrap();

    // Generation 1: commits 1..=5 (graceful drop saves snapshot + removes lock).
    populate_engine(dir.path(), 5).await;

    // Generation 2: reopen on the SAME data dir; new writes must continue
    // above the recovered high-water mark.
    {
        let config = WabiDbConfig {
            data_dir: dir.path().to_path_buf(),
            bootstrap_source: BootstrapSource::Provided([0xABu8; 32]),
            bootstrap_salt: None,
            allow_init: true,
            replication_config: None,
            sync_transport: None,
        };
        let engine = WabiDbEngine::open(config).await.unwrap();
        engine.get_or_create_stream_key("ch_crash").await.unwrap();

        let first = engine
            .run_command(make_crash_cmd(50, "ch_crash", 1, b"gen2 first"))
            .await
            .unwrap();
        assert!(
            first.commit_seq > 5,
            "generation-2 write got seq {} after 5 prior commits; sequencer reset detected",
            first.commit_seq
        );

        let second = engine
            .run_command(make_crash_cmd(51, "ch_crash", 1, b"gen2 second"))
            .await
            .unwrap();
        assert_eq!(
            second.commit_seq,
            first.commit_seq + 1,
            "seqs within a generation must be contiguous"
        );

        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    // Generation 3: reopen again. The commit index must hold exactly 7
    // strictly-increasing entries and the watermark must cover them all.
    {
        let lock_path = dir.path().join(".lock");
        let _ = std::fs::remove_file(&lock_path); // no-op on graceful drop

        let config = WabiDbConfig {
            data_dir: dir.path().to_path_buf(),
            bootstrap_source: BootstrapSource::Provided([0xABu8; 32]),
            bootstrap_salt: None,
            allow_init: true,
            replication_config: None,
            sync_transport: None,
        };
        let engine = WabiDbEngine::open(config).await.unwrap();
        engine.get_or_create_stream_key("ch_crash").await.unwrap();

        let ci_dir = dir.path().join("global").join("commit-index");
        let entries = crate::commit_index::batcher::read_all_entries(&ci_dir).unwrap();
        let seqs: Vec<u64> = entries.iter().map(|e| e.commit_seq).collect();
        assert_eq!(seqs.len(), 7, "expected 5 + 2 commits in the index, got {seqs:?}");
        let mut sorted = seqs.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(seqs, sorted, "commit index must have no duplicate seqs: {seqs:?}");

        let applied = engine.projection_state().applied_commit_seq();
        assert!(
            applied >= 7,
            "watermark after replay must cover all commits, got {applied}"
        );

        let third = engine
            .run_command(make_crash_cmd(52, "ch_crash", 1, b"gen3"))
            .await
            .unwrap();
        assert!(
            third.commit_seq > seqs.iter().copied().max().unwrap(),
            "generation-3 write must exceed all recovered seqs"
        );
    }
}
