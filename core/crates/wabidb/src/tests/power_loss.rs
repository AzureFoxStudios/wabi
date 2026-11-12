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
    let header = RecordHeader::new(
        RecordKind::Event,
        commit_seq,
        stream_hash,
        payload.len() as u32,
        crc,
    );
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
        write_record(&mut writer, i, b"data before fsync")
            .await
            .unwrap();
    }

    // Complete Tokio's background writes into the kernel cache, without fsync.
    // This tests same-system readability before fsync, not power-loss durability.
    writer.drain_pending_writes_for_test().await.unwrap();
    let seg_path = writer.path().to_path_buf();
    drop(writer);

    // Reopen the completed, unsynced segment with a separate reader.
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
        write_record(&mut writer, i, b"orphan record")
            .await
            .unwrap();
    }

    // Simulate crash: commit-index append never happened.
    // Close (flush) the segment writer to simulate the segment being
    // fully written but no commit-index entry created.
    writer.close().await.unwrap();

    // On recovery, the segment reader finds the records as orphans.
    let seg_path = events_dir.join("00000001.wseg");
    let mut reader = SegmentReader::open(&seg_path).await.unwrap();
    let all_records = reader.read_records().await.unwrap();

    assert_eq!(
        all_records.len(),
        3,
        "all 3 orphan records are present on disk"
    );

    // Apply an orphan filter that rejects everything (simulating a commit
    // index that has no entries). The reader should skip all 3.
    let mut reader2 = SegmentReader::open(&seg_path).await.unwrap();
    let filtered = reader2.read_records_filtered(|_| false).await.unwrap();
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
        write_record(&mut writer, i, b"durable record")
            .await
            .unwrap();
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

    assert_eq!(
        records.len(),
        3,
        "all 3 records must be durable after flush"
    );
    for (i, record) in records.iter().enumerate() {
        assert_eq!(record.header.commit_seq, i as u64 + 1);
        assert_eq!(record.payload, b"durable record");
    }

    // Verify the file is on disk and has the expected size.
    let metadata = tokio::fs::metadata(&saved_path).await.unwrap();
    let header = records[0].header.clone();
    let expected_size = header.total_size() as u64 * 3;
    assert_eq!(
        metadata.len(),
        expected_size,
        "file size must match 3 records"
    );
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
        room_owner_precondition: None,
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

/// Read the crash signal file written by `crash_point()`. This proves the
/// hook fired at the expected boundary, distinguishing an intentional crash
/// from a fallback panic ("child did not crash") or unrelated failure that
/// also exits non-zero.
fn validate_crash_signal(data_dir: &std::path::Path) -> Option<String> {
    let signal_path = data_dir.join("crash_signal.txt");
    std::fs::read_to_string(&signal_path)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Open the engine, register a stream, and commit `n` commands.
/// After this, the engine will have committed seq 1..=n.
///
/// Uses the deterministic (bootstrap-derived) stream key so every
/// generation of this test reopens with the SAME key and prior records
/// stay decryptable across restarts.
async fn populate_engine(data_dir: &std::path::Path, n: u64) {
    let config = WabiDbConfig {
        data_dir: data_dir.to_path_buf(),
        bootstrap_source: BootstrapSource::Provided([0xABu8; 32]),
        bootstrap_salt: None,
        allow_init: true,
        replication_config: None,
        sync_transport: None,
            test_boot_wallclock_override: None,
    };
    let engine = WabiDbEngine::open(config).await.unwrap();
    engine.get_or_create_stream_key("ch_crash").await.unwrap();
    for i in 1..=n {
        let outcome = engine
            .run_command(make_crash_cmd(i, "ch_crash", 1, b"prior data"))
            .await
            .unwrap();
        assert_eq!(outcome.commit_seq, i);
    }
    // Await the writer/index/checkpoint tasks before synchronously launching
    // a child from the parent runtime. Never unlink the lock to bypass them.
    engine.close_for_tests().await.unwrap();
}

/// Verify recovery after a crash: engine reopens on the EXISTING commit
/// index and segments. The sequencer resumes above the recovered
/// high-water mark, so a fresh write must get `commit_seq > prior highest`,
/// and the commit index must contain strictly increasing, duplicate-free
/// seqs across all `.widx` files.
async fn verify_recovery(data_dir: &std::path::Path, expected_prior_count: u64) {
    // The crash releases its OS advisory lock; reopen the existing inode.

    let config = WabiDbConfig {
        data_dir: data_dir.to_path_buf(),
        bootstrap_source: BootstrapSource::Provided([0xABu8; 32]),
        bootstrap_salt: None,
        allow_init: true,
        replication_config: None,
        sync_transport: None,
            test_boot_wallclock_override: None,
    };
    let engine = WabiDbEngine::open(config).await.unwrap();
    engine.get_or_create_stream_key("ch_crash").await.unwrap();

    // Verify the projection state has the expected number of prior commits.
    let applied = engine.projection_state().applied_commit_seq();
    assert!(
        applied >= expected_prior_count,
        "expected at least {expected_prior_count} prior commits, got {applied}"
    );

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
    let data_dir =
        std::env::var("WABIDB_DATA_DIR").expect("WABIDB_DATA_DIR must be set for crash child");
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
            test_boot_wallclock_override: None,
        };
        let engine = WabiDbEngine::open(config).await.unwrap();
        engine.get_or_create_stream_key("ch_crash").await.unwrap();

        // Commit 100 prior commands so the state is non-trivial.
        for i in 1..=100u64 {
            let outcome = engine
                .run_command(make_crash_cmd(i, "ch_crash", 1, b"prior data"))
                .await
                .unwrap();
            assert_eq!(outcome.commit_seq, i);
        }

        // The crash boundary command — this will hit the crash_point hook.
        let _ = engine
            .run_command(make_crash_cmd(101, "ch_crash", 1, b"crash boundary"))
            .await;
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

    // Validate the crash signal: proves the crash hook fired at the
    // expected boundary, not a fallback panic or unrelated failure.
    let signal = validate_crash_signal(dir.path());
    assert_eq!(
        signal,
        Some("crash_before_any_write".to_string()),
        "crash signal file must confirm the expected boundary was reached"
    );

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

    // Validate the crash signal.
    let signal = validate_crash_signal(dir.path());
    assert_eq!(
        signal,
        Some("crash_mid_stream_write".to_string()),
        "crash signal file must confirm boundary 1 was reached"
    );

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

    // Validate the crash signal.
    let signal = validate_crash_signal(dir.path());
    assert_eq!(
        signal,
        Some("crash_before_index_fsync".to_string()),
        "crash signal file must confirm boundary 2 was reached"
    );

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

    // Validate the crash signal.
    let signal = validate_crash_signal(dir.path());
    assert_eq!(
        signal,
        Some("crash_after_index_fsync".to_string()),
        "crash signal file must confirm boundary 3 was reached"
    );

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

    // Validate the crash signal.
    let signal = validate_crash_signal(dir.path());
    assert_eq!(
        signal,
        Some("crash_after_projection_update".to_string()),
        "crash signal file must confirm boundary 4 was reached"
    );

    // Verify recovery: engine reopens with prior commits intact.
    parent_rt.block_on(verify_recovery(dir.path(), 100));
}

// ---------------------------------------------------------------------------
// Task 3.5: messages live in the SQLite read model, the other projections in
// the snapshot file. A crash can leave the two at different commits.
// ---------------------------------------------------------------------------

#[cfg(feature = "test-harness")]
fn crash_message(id: &str, body: &str) -> crate::projections::messages::MessageRecord {
    crate::projections::messages::MessageRecord {
        message_id: id.into(),
        channel_id: "ch_crash".into(),
        author_user_id: 7,
        author_device_id: "crash".into(),
        created_at_micros: 1,
        encrypted_body_ref: body.into(),
        idempotency_key: None,
        edit_history: vec![],
        edited_at_micros: None,
        is_deleted: false,
        is_spoiler: false,
        files: vec![],
    }
}

#[cfg(feature = "test-harness")]
fn crash_message_cmd(kind: &str, id: &str, body: &str) -> CommandCommit {
    let (tx, _rx) = tokio::sync::oneshot::channel();
    CommandCommit {
        room_owner_precondition: None,
        caller_user_id: 7,
        caller_device_id: "crash".into(),
        command_name: "crash_message".into(),
        idempotency_key: None,
        events: vec![EventToWrite {
            stream_id: "ch_crash".into(),
            event_type: kind.into(),
            stream_kind: 1,
            record_kind: RecordKind::Event,
            plaintext: crate::projections::messages::encode_record(&crash_message(id, body)),
        }],
        essential: true,
        response_tx: tx,
    }
}

#[cfg(feature = "test-harness")]
fn crash_config(data_dir: &std::path::Path) -> WabiDbConfig {
    WabiDbConfig {
        data_dir: data_dir.to_path_buf(),
        bootstrap_source: BootstrapSource::Provided([0xABu8; 32]),
        bootstrap_salt: None,
        allow_init: true,
        replication_config: None,
        sync_transport: None,
        test_boot_wallclock_override: None,
    }
}

/// Child of the two read-model crash tests. Opens the directory the parent
/// prepared (messages m1..m5, cleanly stopped), writes m6..m9 and an edit of
/// m2, then either takes a projection checkpoint or writes one more message.
/// The configured crash point ends the process inside that last step.
#[cfg(feature = "test-harness")]
#[test]
fn run_read_model_crash_child() {
    let Ok(step) = std::env::var("WABIDB_READ_MODEL_CRASH") else {
        return; // not in child mode
    };
    let data_dir = std::path::PathBuf::from(std::env::var("WABIDB_DATA_DIR").unwrap());
    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
        let engine = WabiDbEngine::open(crash_config(&data_dir)).await.unwrap();
        engine.get_or_create_stream_key("ch_crash").await.unwrap();
        for n in 6..=9 {
            engine
                .run_command(crash_message_cmd("message_created", &format!("m{n}"), "body"))
                .await
                .unwrap();
        }
        engine
            .run_command(crash_message_cmd("message_edited", "m2", "edited before the crash"))
            .await
            .unwrap();
        if step == "checkpoint" {
            let _ = engine.projection_state().save_snapshot(&data_dir);
        } else {
            let _ = engine
                .run_command(crash_message_cmd("message_created", "m10", "boundary"))
                .await;
        }
        panic!("child did not crash at its boundary; crash_point may not be wired");
    });
}

#[cfg(feature = "test-harness")]
fn crash_with_messages(boundary: &str, step: &str) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
        let engine = WabiDbEngine::open(crash_config(dir.path())).await.unwrap();
        engine.get_or_create_stream_key("ch_crash").await.unwrap();
        for n in 1..=5 {
            engine
                .run_command(crash_message_cmd("message_created", &format!("m{n}"), "body"))
                .await
                .unwrap();
        }
        engine.close_for_tests().await.unwrap();
    });
    assert_eq!(
        crate::engine::locks::ProjectionState::read_snapshot_watermark(dir.path()).unwrap(),
        Some(5)
    );
    let status = std::process::Command::new(std::env::current_exe().unwrap())
        .arg("tests::power_loss::run_read_model_crash_child")
        .arg("--nocapture")
        .env("WABIDB_READ_MODEL_CRASH", step)
        .env("WABIDB_CRASH_AT", boundary)
        .env("WABIDB_DATA_DIR", dir.path())
        .status()
        .unwrap();
    assert!(!status.success(), "child should have crashed");
    assert_eq!(validate_crash_signal(dir.path()), Some(boundary.to_string()));
    dir
}

#[cfg(feature = "test-harness")]
async fn messages_after_crash(data_dir: &std::path::Path) -> (u64, Vec<(String, String)>) {
    use crate::projections::messages::MessagesProjection;
    let engine = WabiDbEngine::open(crash_config(data_dir)).await.unwrap();
    let state = engine.projection_state();
    let mut found = Vec::new();
    for n in 1..=10 {
        let id = format!("m{n}");
        if let Some(record) = MessagesProjection::get_message(state, "ch_crash", &id).unwrap() {
            found.push((id, record.encrypted_body_ref));
        }
    }
    // The listing agrees with the point reads.
    assert_eq!(
        MessagesProjection::list_messages(state, "ch_crash", true).unwrap().len(),
        found.len()
    );
    let applied = state.applied_commit_seq();
    engine.close_for_tests().await.unwrap();
    (applied, found)
}

#[cfg(feature = "test-harness")]
fn expected_messages(through: u64) -> Vec<(String, String)> {
    (1..=through)
        .map(|n| {
            let body = if n == 2 { "edited before the crash" } else { "body" };
            (format!("m{n}"), body.to_string())
        })
        .collect()
}

/// The process dies inside a checkpoint: the read model has been made
/// durable at commit 10 and the snapshot file still says 5. Nothing was shut
/// down, so SQLite's write-ahead log is as the crash left it. The next open
/// replays commits 6 to 10 into the in-memory projections and keeps the
/// messages the read model already holds.
#[cfg(feature = "test-harness")]
#[test]
#[ignore]
fn crash_between_read_model_sync_and_snapshot() {
    use crate::engine::locks::ProjectionState;
    let dir = crash_with_messages("crash_between_read_model_sync_and_snapshot", "checkpoint");
    assert_eq!(ProjectionState::read_snapshot_watermark(dir.path()).unwrap(), Some(5));
    let model = ProjectionState::read_model_path(dir.path());
    let wal = std::path::PathBuf::from(format!("{}-wal", model.display()));
    println!(
        "after the crash: snapshot at 5, read model {} bytes, write-ahead log {:?} bytes",
        std::fs::metadata(&model).unwrap().len(),
        std::fs::metadata(&wal).map(|m| m.len()).ok()
    );
    let rt = tokio::runtime::Runtime::new().unwrap();
    let (applied, found) = rt.block_on(messages_after_crash(dir.path()));
    assert_eq!(applied, 10);
    assert_eq!(found, expected_messages(9));
    // Stable across another restart.
    assert_eq!(rt.block_on(messages_after_crash(dir.path())), (10, expected_messages(9)));
}

/// The process dies right after a message commit was applied (the child's
/// first write, m6, at commit 6), with no checkpoint and no shutdown: the
/// snapshot is at 5 and SQLite never synced that commit. Whether or not the
/// file kept it, the log has it, and the next open ends with the message.
#[cfg(feature = "test-harness")]
#[test]
#[ignore]
fn crash_after_a_message_commit_keeps_the_message() {
    let dir = crash_with_messages("crash_after_projection_update", "write");
    let rt = tokio::runtime::Runtime::new().unwrap();
    let (applied, found) = rt.block_on(messages_after_crash(dir.path()));
    assert_eq!(applied, 6);
    let expected: Vec<_> = (1..=6).map(|n| (format!("m{n}"), "body".to_string())).collect();
    assert_eq!(found, expected);
    assert_eq!(rt.block_on(messages_after_crash(dir.path())), (6, expected));
}

/// The process dies after a message's records and index entry are durable
/// and before the commit is applied anywhere: the read model has never seen
/// commit 6. The next open replays it from the log.
#[cfg(feature = "test-harness")]
#[test]
#[ignore]
fn crash_before_a_message_commit_is_applied_replays_it() {
    let dir = crash_with_messages("crash_after_index_fsync", "write");
    let rt = tokio::runtime::Runtime::new().unwrap();
    let (applied, found) = rt.block_on(messages_after_crash(dir.path()));
    assert_eq!(applied, 6);
    let expected: Vec<_> = (1..=6).map(|n| (format!("m{n}"), "body".to_string())).collect();
    assert_eq!(found, expected);
}

// ---------------------------------------------------------------------------
// Task 3.5.2: channels live in the read model too. The room placement
// projection, which stays in the snapshot, reads them while it applies.
// ---------------------------------------------------------------------------

#[cfg(feature = "test-harness")]
fn channel_event(kind: &str, stream: &str, value: serde_json::Value) -> EventToWrite {
    EventToWrite {
        stream_id: stream.into(),
        event_type: kind.into(),
        stream_kind: 6,
        record_kind: RecordKind::Event,
        plaintext: serde_json::to_vec(&value).unwrap(),
    }
}

/// A command creating a channel on the shared stream (the engine names it
/// `ch_{seq:x}`), with its first room placement in the same commit when
/// `placed`.
#[cfg(feature = "test-harness")]
fn create_channel_cmd(name: &str, placed: bool) -> CommandCommit {
    let (tx, _rx) = tokio::sync::oneshot::channel();
    let mut events = vec![channel_event(
        "channel_created",
        "channels",
        serde_json::to_value(crate::domain::Channel::new("", name, 7)).unwrap(),
    )];
    if placed {
        events.push(channel_event(
            crate::projections::room_placement::INIT_EVENT,
            crate::projections::room_placement::INIT_STREAM,
            serde_json::json!({"schemaVersion": 1, "ownerNodeId": "node-1", "replicaNodeIds": []}),
        ));
    }
    CommandCommit {
        room_owner_precondition: None,
        caller_user_id: 7,
        caller_device_id: "crash".into(),
        command_name: "crash_channel".into(),
        idempotency_key: None,
        events,
        essential: true,
        response_tx: tx,
    }
}

#[cfg(feature = "test-harness")]
fn channel_change_cmd(kind: &str, value: serde_json::Value) -> CommandCommit {
    let (tx, _rx) = tokio::sync::oneshot::channel();
    let id = value["channel_id"].as_str().unwrap().to_string();
    CommandCommit {
        room_owner_precondition: None,
        caller_user_id: 7,
        caller_device_id: "crash".into(),
        command_name: "crash_channel".into(),
        idempotency_key: None,
        events: vec![channel_event(kind, &format!("channels:{id}"), value)],
        essential: true,
        response_tx: tx,
    }
}

#[cfg(feature = "test-harness")]
async fn ensure_channel_streams(engine: &WabiDbEngine) {
    for stream in ["channels", crate::projections::room_placement::INIT_STREAM, "channels:ch_1", "channels:ch_4"] {
        engine.get_or_create_stream_key(stream).await.unwrap();
    }
}

/// Child of the two channel crash tests. Opens the directory the parent
/// prepared (channels ch_1..ch_3, cleanly stopped, snapshot at 3).
/// - `write`: creates a placed channel (commit 4); the configured crash point
///   ends the process inside that commit.
/// - `checkpoint`: creates a placed channel (4), deletes it (5), creates
///   another (6), renames ch_1 (7), then takes a checkpoint, inside which the
///   crash point ends the process.
#[cfg(feature = "test-harness")]
#[test]
fn run_channel_crash_child() {
    let Ok(step) = std::env::var("WABIDB_CHANNEL_CRASH") else {
        return; // not in child mode
    };
    let data_dir = std::path::PathBuf::from(std::env::var("WABIDB_DATA_DIR").unwrap());
    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
        let engine = WabiDbEngine::open(crash_config(&data_dir)).await.unwrap();
        ensure_channel_streams(&engine).await;
        let _ = engine.run_command(create_channel_cmd("placed", true)).await;
        if step == "checkpoint" {
            engine
                .run_command(channel_change_cmd("channel_deleted", serde_json::json!({"channel_id": "ch_4"})))
                .await
                .unwrap();
            engine.run_command(create_channel_cmd("six", false)).await.unwrap();
            engine
                .run_command(channel_change_cmd(
                    "channel_updated",
                    serde_json::json!({"channel_id": "ch_1", "name": "renamed before the crash"}),
                ))
                .await
                .unwrap();
            let _ = engine.projection_state().save_snapshot(&data_dir);
        }
        panic!("child did not crash at its boundary; crash_point may not be wired");
    });
}

#[cfg(feature = "test-harness")]
fn crash_with_channels(boundary: &str, step: &str) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
        let engine = WabiDbEngine::open(crash_config(dir.path())).await.unwrap();
        ensure_channel_streams(&engine).await;
        for name in ["one", "two", "three"] {
            engine.run_command(create_channel_cmd(name, false)).await.unwrap();
        }
        engine.close_for_tests().await.unwrap();
    });
    assert_eq!(
        crate::engine::locks::ProjectionState::read_snapshot_watermark(dir.path()).unwrap(),
        Some(3)
    );
    let status = std::process::Command::new(std::env::current_exe().unwrap())
        .arg("tests::power_loss::run_channel_crash_child")
        .arg("--nocapture")
        .env("WABIDB_CHANNEL_CRASH", step)
        .env("WABIDB_CRASH_AT", boundary)
        .env("WABIDB_DATA_DIR", dir.path())
        .status()
        .unwrap();
    assert!(!status.success(), "child should have crashed");
    assert_eq!(validate_crash_signal(dir.path()), Some(boundary.to_string()));
    dir
}

/// The channel ids in the read model file as the crash left it, and its
/// `applied_commit_seq` for channels, read in one SQLite read transaction.
/// (Opening the file recovers its write-ahead log, as the engine would.)
#[cfg(feature = "test-harness")]
fn channel_file_after_crash(data_dir: &std::path::Path) -> (Vec<String>, u64) {
    let path = crate::engine::locks::ProjectionState::read_model_path(data_dir);
    let conn = rusqlite::Connection::open(path).unwrap();
    conn.execute_batch("BEGIN").unwrap();
    let ids = conn
        .prepare("SELECT CAST(key AS TEXT) FROM channels ORDER BY key")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .map(|id| id.unwrap())
        .collect();
    let applied: i64 = conn
        .query_row(
            "SELECT coalesce((SELECT seq FROM applied_commit_seq WHERE projection = 'channels'), 0)",
            [],
            |row| row.get(0),
        )
        .unwrap();
    (ids, applied as u64)
}

/// Every channel the engine serves after a restart (id and name), the room
/// placements, and its watermark.
#[cfg(feature = "test-harness")]
async fn channels_after_crash(data_dir: &std::path::Path) -> (u64, Vec<(String, String)>, Vec<String>) {
    use crate::projections::channels::ChannelProjection;
    use crate::projections::query::{ChannelsFilter, QueryableProjection};
    let engine = WabiDbEngine::open(crash_config(data_dir)).await.unwrap();
    let state = engine.projection_state();
    let channels = ChannelProjection
        .query(state, &ChannelsFilter::default())
        .unwrap()
        .into_iter()
        .map(|channel| (channel.channel_id, channel.name))
        .collect();
    let mut placed = Vec::new();
    for id in ["ch_1", "ch_2", "ch_3", "ch_4", "ch_5", "ch_6", "ch_7"] {
        if state.get(crate::projections::room_placement::INDEX, id.as_bytes()).is_some() {
            placed.push(id.to_string());
        }
    }
    let applied = state.applied_commit_seq();
    engine.close_for_tests().await.unwrap();
    (applied, channels, placed)
}

#[cfg(feature = "test-harness")]
fn named(rows: &[(&str, &str)]) -> Vec<(String, String)> {
    rows.iter().map(|(id, name)| (id.to_string(), name.to_string())).collect()
}

/// The process dies right after a commit that created a channel and its room
/// placement was applied, before the caller heard back, with no checkpoint
/// and no shutdown (snapshot at 3). The file as the crash left it has the
/// channel's row exactly when its `applied_commit_seq` covers the commit; the
/// next open ends with the channel and its placement either way.
#[cfg(feature = "test-harness")]
#[test]
#[ignore]
fn crash_after_a_channel_commit_keeps_its_rows_and_watermark_together() {
    let dir = crash_with_channels("crash_after_projection_update", "write");
    let (ids, applied) = channel_file_after_crash(dir.path());
    println!("after the crash: channels {ids:?}, applied_commit_seq {applied}");
    assert_eq!(ids.contains(&"ch_4".to_string()), applied >= 4, "{ids:?} at {applied}");
    assert!(applied <= 4);
    let rt = tokio::runtime::Runtime::new().unwrap();
    let after = rt.block_on(channels_after_crash(dir.path()));
    let expected = (
        4,
        named(&[("ch_1", "one"), ("ch_2", "two"), ("ch_3", "three"), ("ch_4", "placed")]),
        vec!["ch_4".to_string()],
    );
    assert_eq!(after, expected);
    assert_eq!(channel_file_after_crash(dir.path()), (vec!["ch_1".into(), "ch_2".into(), "ch_3".into(), "ch_4".into()], 4));
    assert_eq!(rt.block_on(channels_after_crash(dir.path())), expected);
}

/// The process dies inside a checkpoint: the read model is durable at commit
/// 7 and the snapshot still says 3. Commit 4 created a placed channel that
/// commit 5 deleted, so the next open replays a placement whose channel the
/// read model no longer holds; it must open, with every channel change kept.
#[cfg(feature = "test-harness")]
#[test]
#[ignore]
fn crash_between_read_model_sync_and_snapshot_keeps_channels() {
    let dir = crash_with_channels("crash_between_read_model_sync_and_snapshot", "checkpoint");
    assert_eq!(
        crate::engine::locks::ProjectionState::read_snapshot_watermark(dir.path()).unwrap(),
        Some(3)
    );
    let (ids, applied) = channel_file_after_crash(dir.path());
    assert_eq!(applied, 7);
    assert_eq!(ids, ["ch_1", "ch_2", "ch_3", "ch_6"]);
    let rt = tokio::runtime::Runtime::new().unwrap();
    let expected = (
        7,
        named(&[
            ("ch_1", "renamed before the crash"),
            ("ch_2", "two"),
            ("ch_3", "three"),
            ("ch_6", "six"),
        ]),
        vec!["ch_4".to_string()],
    );
    assert_eq!(rt.block_on(channels_after_crash(dir.path())), expected);
    assert_eq!(rt.block_on(channels_after_crash(dir.path())), expected);
}

// ---------------------------------------------------------------------------
// Task 3.5.3: channel members live in the read model too. The user deletion
// projection, which stays in the snapshot, removes memberships from it while
// it applies.
// ---------------------------------------------------------------------------

/// A command with one membership event: `channel_member_added` or
/// `channel_member_removed` of `user_id` in `channel`, or `user_deleted` of
/// `user_id` when `channel` is `None`.
#[cfg(feature = "test-harness")]
fn member_cmd(kind: &str, channel: Option<&str>, user_id: u64) -> CommandCommit {
    use crate::projections::channel_members::{encode_record, ChannelMemberRecord};
    let (tx, _rx) = tokio::sync::oneshot::channel();
    let event = match channel {
        Some(channel) => EventToWrite {
            stream_id: format!("channel_members:{channel}"),
            event_type: kind.into(),
            stream_kind: 1,
            record_kind: RecordKind::Event,
            plaintext: encode_record(&ChannelMemberRecord {
                channel_id: channel.into(),
                user_id,
                joined_at_micros: 100 + user_id as i64,
                role: 0,
                nick: None,
            }),
        },
        None => EventToWrite {
            stream_id: "users".into(),
            event_type: kind.into(),
            stream_kind: 6,
            record_kind: RecordKind::Event,
            plaintext: crate::projections::user_deletion::encode_payload(&crate::domain::UserDeleted { user_id }),
        },
    };
    CommandCommit {
        room_owner_precondition: None,
        caller_user_id: 7,
        caller_device_id: "crash".into(),
        command_name: "crash_member".into(),
        idempotency_key: None,
        events: vec![event],
        essential: true,
        response_tx: tx,
    }
}

#[cfg(feature = "test-harness")]
async fn ensure_member_streams(engine: &WabiDbEngine) {
    for stream in ["users", "channel_members:group-a", "channel_members:group-b", "channel_members:group-c", "channel_members:group-d"] {
        engine.get_or_create_stream_key(stream).await.unwrap();
    }
}

/// Child of the two membership crash tests. Opens the directory the parent
/// prepared (group-a holds 1 and 2, group-b holds 1; cleanly stopped,
/// snapshot at 3).
/// - `write`: adds 3 to group-a (commit 4); the configured crash point ends
///   the process inside that commit.
/// - `checkpoint`: adds 5 to group-c (4), deletes user 5 (5), adds 5 to
///   group-d (6), removes 2 from group-a (7), then takes a checkpoint, inside
///   which the crash point ends the process.
#[cfg(feature = "test-harness")]
#[test]
fn run_member_crash_child() {
    let Ok(step) = std::env::var("WABIDB_MEMBER_CRASH") else {
        return; // not in child mode
    };
    let data_dir = std::path::PathBuf::from(std::env::var("WABIDB_DATA_DIR").unwrap());
    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
        let engine = WabiDbEngine::open(crash_config(&data_dir)).await.unwrap();
        ensure_member_streams(&engine).await;
        if step == "write" {
            let _ = engine.run_command(member_cmd("channel_member_added", Some("group-a"), 3)).await;
        } else {
            for (kind, channel, user) in [
                ("channel_member_added", Some("group-c"), 5),
                ("user_deleted", None, 5),
                ("channel_member_added", Some("group-d"), 5),
                ("channel_member_removed", Some("group-a"), 2),
            ] {
                engine.run_command(member_cmd(kind, channel, user)).await.unwrap();
            }
            let _ = engine.projection_state().save_snapshot(&data_dir);
        }
        panic!("child did not crash at its boundary; crash_point may not be wired");
    });
}

#[cfg(feature = "test-harness")]
fn crash_with_members(boundary: &str, step: &str) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
        let engine = WabiDbEngine::open(crash_config(dir.path())).await.unwrap();
        ensure_member_streams(&engine).await;
        for (channel, user) in [("group-a", 1), ("group-a", 2), ("group-b", 1)] {
            engine.run_command(member_cmd("channel_member_added", Some(channel), user)).await.unwrap();
        }
        engine.close_for_tests().await.unwrap();
    });
    assert_eq!(
        crate::engine::locks::ProjectionState::read_snapshot_watermark(dir.path()).unwrap(),
        Some(3)
    );
    let status = std::process::Command::new(std::env::current_exe().unwrap())
        .arg("tests::power_loss::run_member_crash_child")
        .arg("--nocapture")
        .env("WABIDB_MEMBER_CRASH", step)
        .env("WABIDB_CRASH_AT", boundary)
        .env("WABIDB_DATA_DIR", dir.path())
        .status()
        .unwrap();
    assert!(!status.success(), "child should have crashed");
    assert_eq!(validate_crash_signal(dir.path()), Some(boundary.to_string()));
    dir
}

/// The member rows in the read model file as the crash left it (channel and
/// user of each, in key order), and its `applied_commit_seq` for channel
/// members, read in one SQLite read transaction. (Opening the file recovers
/// its write-ahead log, as the engine would.)
#[cfg(feature = "test-harness")]
fn member_file_after_crash(data_dir: &std::path::Path) -> (Vec<(String, u64)>, u64) {
    let path = crate::engine::locks::ProjectionState::read_model_path(data_dir);
    let conn = rusqlite::Connection::open(path).unwrap();
    conn.execute_batch("BEGIN").unwrap();
    let rows = conn
        .prepare("SELECT record FROM channel_members ORDER BY key")
        .unwrap()
        .query_map([], |row| row.get::<_, Vec<u8>>(0))
        .unwrap()
        .map(|record| {
            let record = crate::projections::channel_members::decode_record(&record.unwrap()).unwrap();
            (record.channel_id, record.user_id)
        })
        .collect();
    let applied: i64 = conn
        .query_row(
            "SELECT coalesce((SELECT seq FROM applied_commit_seq WHERE projection = 'channel_members'), 0)",
            [],
            |row| row.get(0),
        )
        .unwrap();
    (rows, applied as u64)
}

/// The members of every group the engine serves after a restart, each
/// group's revision, and the watermark.
#[cfg(feature = "test-harness")]
async fn members_after_crash(data_dir: &std::path::Path) -> (u64, Vec<(String, Vec<u64>, u64)>) {
    use crate::projections::channel_members::ChannelMembersProjection;
    let engine = WabiDbEngine::open(crash_config(data_dir)).await.unwrap();
    let state = engine.projection_state();
    let mut groups = Vec::new();
    for group in ["group-a", "group-b", "group-c", "group-d"] {
        let members = ChannelMembersProjection::list_members(state, group)
            .unwrap()
            .into_iter()
            .map(|member| member.user_id)
            .collect();
        groups.push((group.to_string(), members, ChannelMembersProjection::revision(state, group).unwrap()));
    }
    let applied = state.applied_commit_seq();
    engine.close_for_tests().await.unwrap();
    (applied, groups)
}

#[cfg(feature = "test-harness")]
fn groups(rows: &[(&str, &[u64], u64)]) -> Vec<(String, Vec<u64>, u64)> {
    rows.iter().map(|(group, members, revision)| (group.to_string(), members.to_vec(), *revision)).collect()
}

/// The process dies right after a commit that added a member was applied,
/// before the caller heard back, with no checkpoint and no shutdown (snapshot
/// at 3). The file as the crash left it has the member's row exactly when its
/// `applied_commit_seq` covers the commit; the next open ends with the member
/// either way.
#[cfg(feature = "test-harness")]
#[test]
#[ignore]
fn crash_after_a_member_commit_keeps_its_rows_and_watermark_together() {
    let dir = crash_with_members("crash_after_projection_update", "write");
    let (rows, applied) = member_file_after_crash(dir.path());
    println!("after the crash: members {rows:?}, applied_commit_seq {applied}");
    assert_eq!(rows.contains(&("group-a".to_string(), 3)), applied >= 4, "{rows:?} at {applied}");
    assert!(applied <= 4);
    let rt = tokio::runtime::Runtime::new().unwrap();
    let expected = (
        4,
        groups(&[("group-a", &[1, 2, 3], 4), ("group-b", &[1], 3), ("group-c", &[], 0), ("group-d", &[], 0)]),
    );
    assert_eq!(rt.block_on(members_after_crash(dir.path())), expected);
    let (rows, applied) = member_file_after_crash(dir.path());
    assert_eq!((rows.len(), applied), (4, 4), "{rows:?}");
    assert_eq!(rt.block_on(members_after_crash(dir.path())), expected);
}

/// The process dies inside a checkpoint: the read model is durable at commit
/// 7 and the snapshot still says 3. Between the two, user 5 joined group-c,
/// was deleted, and joined group-d. The next open replays the deletion to the
/// in-memory user deletion projection while the members table already holds
/// the later state; it must open with every membership change kept.
#[cfg(feature = "test-harness")]
#[test]
#[ignore]
fn crash_between_read_model_sync_and_snapshot_keeps_members() {
    let dir = crash_with_members("crash_between_read_model_sync_and_snapshot", "checkpoint");
    assert_eq!(
        crate::engine::locks::ProjectionState::read_snapshot_watermark(dir.path()).unwrap(),
        Some(3)
    );
    let (rows, applied) = member_file_after_crash(dir.path());
    assert_eq!(applied, 7);
    assert_eq!(rows, [("group-a".to_string(), 1), ("group-b".to_string(), 1), ("group-d".to_string(), 5)]);
    let rt = tokio::runtime::Runtime::new().unwrap();
    let expected = (
        7,
        groups(&[("group-a", &[1], 7), ("group-b", &[1], 3), ("group-c", &[], 4), ("group-d", &[5], 6)]),
    );
    assert_eq!(rt.block_on(members_after_crash(dir.path())), expected);
    assert_eq!(rt.block_on(members_after_crash(dir.path())), expected);
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
            test_boot_wallclock_override: None,
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
        let config = WabiDbConfig {
            data_dir: dir.path().to_path_buf(),
            bootstrap_source: BootstrapSource::Provided([0xABu8; 32]),
            bootstrap_salt: None,
            allow_init: true,
            replication_config: None,
            sync_transport: None,
            test_boot_wallclock_override: None,
        };
        let engine = super::reopen_after_drop(config, None).await.unwrap();
        engine.get_or_create_stream_key("ch_crash").await.unwrap();

        let ci_dir = dir.path().join("global").join("commit-index");
        let entries = crate::commit_index::batcher::read_all_entries(&ci_dir).unwrap();
        let seqs: Vec<u64> = entries.iter().map(|e| e.commit_seq).collect();
        assert_eq!(
            seqs.len(),
            7,
            "expected 5 + 2 commits in the index, got {seqs:?}"
        );
        let mut sorted = seqs.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(
            seqs, sorted,
            "commit index must have no duplicate seqs: {seqs:?}"
        );

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
