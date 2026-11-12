//! Task 3.2: an operator can get past one poison event without restoring a
//! backup. A projection handler that fails, or panics, on a durable event
//! halts the engine; startup then refuses with an error naming the commit;
//! `wabidb-cli quarantine --seq N` records the commit; the next startup
//! skips it with a warn log naming it.

use std::sync::{Arc, Mutex};

use crate::crypto::bootstrap::BootstrapSource;
use crate::engine::{WabiDbConfig, WabiDbEngine};
use crate::error::{Result, WabiError};
use crate::format::record::RecordKind;
use crate::projections::test_poison;
use crate::sequencer::types::{CommandCommit, CommandOutcome, EventToWrite};

const BOOTSTRAP: [u8; 32] = [0x3Cu8; 32];

fn config(path: &std::path::Path) -> WabiDbConfig {
    let mut config = WabiDbConfig::new(path.to_path_buf(), BootstrapSource::Provided(BOOTSTRAP));
    config.allow_init = true;
    config
}

async fn commit(engine: &WabiDbEngine, payload: &[u8]) -> Result<CommandOutcome> {
    let stream = "ch_poison";
    engine.get_or_create_stream_key(stream).await?;
    let (response_tx, _response_rx) = tokio::sync::oneshot::channel();
    engine
        .run_command(CommandCommit {
            room_owner_precondition: None,
            caller_user_id: 1,
            caller_device_id: "quarantine-test".into(),
            command_name: "poison_test".into(),
            idempotency_key: None,
            events: vec![EventToWrite {
                stream_id: stream.into(),
                event_type: test_poison::EVENT_TYPE.into(),
                stream_kind: 1,
                record_kind: RecordKind::Event,
                plaintext: payload.to_vec(),
            }],
            essential: true,
            response_tx,
        })
        .await
}

/// Log lines written while the returned guard is alive, on this thread.
#[derive(Clone, Default)]
struct Logs(Arc<Mutex<Vec<u8>>>);

impl Logs {
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.0.lock().unwrap()).into_owned()
    }
}

impl std::io::Write for Logs {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for Logs {
    type Writer = Logs;

    fn make_writer(&'a self) -> Logs {
        self.clone()
    }
}

fn capture_warnings() -> (Logs, tracing::subscriber::DefaultGuard) {
    let logs = Logs::default();
    let subscriber = tracing_subscriber::fmt()
        .with_writer(logs.clone())
        .with_max_level(tracing::Level::WARN)
        .with_ansi(false)
        .finish();
    (logs, tracing::subscriber::set_default(subscriber))
}

/// Commit 1 is good; commit 2 carries `poison`, which the live handler
/// rejects or panics on and so halts the engine. Returns once the engine
/// has released its advisory lock.
async fn tree_with_poison_at_commit_2(path: &std::path::Path, poison: &[u8]) {
    let engine = crate::tests::reopen_after_drop(config(path), None).await.unwrap();
    assert_eq!(commit(&engine, b"good").await.unwrap().commit_seq, 1);
    let live = commit(&engine, poison).await;
    assert!(live.is_err(), "the live dispatcher must not acknowledge a poison event");
    assert!(!engine.is_healthy());
    drop(engine);
    drop(crate::tests::wait_for_stopped_engine(path).await);
}

/// Startup refuses, naming commit 2; quarantine it; startup succeeds with a
/// warn naming commit 2, keeps commit 1, and new writes continue above 2.
async fn refuse_then_quarantine_then_start(path: &std::path::Path, expected_detail: &str) {
    let error = match crate::tests::reopen_after_drop(config(path), None).await {
        Ok(_) => panic!("startup must refuse a poison event"),
        Err(error) => error,
    };
    println!("startup error: {error}");
    assert!(matches!(error, WabiError::Corrupt { .. }), "{error:?}");
    let message = error.to_string();
    assert!(message.contains("commit 2"), "error must name the commit: {message}");
    assert!(message.contains(test_poison::EVENT_TYPE), "error must name the event type: {message}");
    assert!(message.contains(expected_detail), "{message}");
    assert!(message.contains("quarantine --seq 2"), "error must name the repair: {message}");

    let report = crate::cli::quarantine::quarantine(path, 2).unwrap();
    assert_eq!(report.quarantined, vec![2]);
    assert!(!report.already_quarantined);

    let (logs, guard) = capture_warnings();
    let engine = crate::tests::reopen_after_drop(config(path), None).await.unwrap();
    drop(guard);
    let logs = logs.text();
    println!("captured warnings:\n{logs}");
    assert!(
        logs.lines().any(|l| l.contains("WARN") && l.contains("quarantined commit 2")),
        "startup must warn that it skipped commit 2:\n{logs}"
    );

    let state = engine.projection_state();
    assert!(state.get(test_poison::INDEX, &1u64.to_be_bytes()).is_some(), "commit 1 must apply");
    assert!(state.get(test_poison::INDEX, &2u64.to_be_bytes()).is_none());
    assert_eq!(state.applied_commit_seq(), 2);
    assert_eq!(commit(&engine, b"after").await.unwrap().commit_seq, 3);
    drop(engine);
    drop(crate::tests::wait_for_stopped_engine(path).await);

    // Without the snapshot, a later startup replays the whole log again.
    crate::engine::locks::ProjectionState::remove_saved_projections_for_tests(path);
    let engine = crate::tests::reopen_after_drop(config(path), None).await.unwrap();
    let state = engine.projection_state();
    assert!(state.get(test_poison::INDEX, &2u64.to_be_bytes()).is_none());
    assert!(state.get(test_poison::INDEX, &3u64.to_be_bytes()).is_some());
    assert_eq!(state.applied_commit_seq(), 3);
}

#[tokio::test]
async fn failing_handler_is_named_at_startup_and_quarantine_skips_it() {
    let dir = tempfile::tempdir().unwrap();
    tree_with_poison_at_commit_2(dir.path(), test_poison::FAIL).await;
    refuse_then_quarantine_then_start(dir.path(), "test handler rejects this payload").await;
}

/// On main a panicking handler panics inside `open()` on every restart.
#[tokio::test]
async fn panicking_handler_is_named_at_startup_and_quarantine_skips_it() {
    let dir = tempfile::tempdir().unwrap();
    tree_with_poison_at_commit_2(dir.path(), test_poison::PANIC).await;
    refuse_then_quarantine_then_start(dir.path(), "test handler panics on this payload").await;
}

/// A quarantine file the engine cannot read must stop startup, not be
/// treated as empty: that would re-apply the poison event, or worse, skip
/// nothing the operator asked to skip.
#[tokio::test]
async fn unparseable_quarantine_file_refuses_startup() {
    let dir = tempfile::tempdir().unwrap();
    tree_with_poison_at_commit_2(dir.path(), test_poison::FAIL).await;
    crate::cli::quarantine::quarantine(dir.path(), 2).unwrap();
    let file = crate::engine::quarantine::path(dir.path());

    for bad in [&b"{\"version\":1,\"commit_seqs\":[2"[..], b"[2]", b"{\"version\":2,\"commit_seqs\":[2]}"] {
        std::fs::write(&file, bad).unwrap();
        let error = match crate::tests::reopen_after_drop(config(dir.path()), None).await {
            Ok(_) => panic!("started with quarantine file {:?}", String::from_utf8_lossy(bad)),
            Err(error) => error,
        };
        assert!(matches!(error, WabiError::Corrupt { .. }), "{error:?}");
        assert!(error.to_string().contains("quarantine.json"), "{error}");
        // The file is left as it was for the operator.
        assert_eq!(std::fs::read(&file).unwrap(), bad);
    }
}

/// A listed seq above every commit on disk would be the seq of the next
/// real write, which the live dispatcher would then skip.
#[tokio::test]
async fn quarantine_file_listing_a_future_seq_refuses_startup() {
    let dir = tempfile::tempdir().unwrap();
    {
        let engine = crate::tests::reopen_after_drop(config(dir.path()), None).await.unwrap();
        commit(&engine, b"good").await.unwrap();
    }
    drop(crate::tests::wait_for_stopped_engine(dir.path()).await);
    std::fs::write(
        crate::engine::quarantine::path(dir.path()),
        br#"{"version":1,"commit_seqs":[2]}"#,
    )
    .unwrap();
    let error = match crate::tests::reopen_after_drop(config(dir.path()), None).await {
        Ok(_) => panic!("started with a quarantined future seq"),
        Err(error) => error,
    };
    assert!(error.to_string().contains("lists commit 2, above every commit on disk (1)"), "{error}");
}
