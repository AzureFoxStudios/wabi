//! Domain modules (`wabidb::domain_modules`), exercised only through the
//! engine's public API, as a crate outside the engine would use it.
//!
//! The module here keeps running totals. Adding is not idempotent, so an
//! event applied twice or not at all shows up as a wrong total.

use std::path::Path;
use std::sync::Arc;
use wabidb::crypto::bootstrap::BootstrapSource;
use wabidb::domain_modules::{DomainEvent, DomainIndexes, DomainModule, DomainProjection};
use wabidb::engine::locks::ProjectionState;
use wabidb::engine::{WabiDbConfig, WabiDbEngine};
use wabidb::error::{Result, WabiError};
use wabidb::format::record::RecordKind;
use wabidb::projections::handler::DurableEvent;
use wabidb::sequencer::types::{CommandCommit, EventToWrite};

const ADDED: &str = "tally.added";
const CLEARED: &str = "tally.cleared";

/// `tally.added` carries "<name>=<amount>"; `tally.cleared` carries "<name>".
/// `factor` stands for a change of projection logic between versions.
struct Tally {
    factor: u64,
}

impl DomainProjection for Tally {
    fn apply(&self, event: &DurableEvent, indexes: &DomainIndexes<'_>) -> Result<()> {
        let text = String::from_utf8_lossy(&event.payload).to_string();
        if event.event_type == CLEARED {
            indexes.delete("totals", text.as_bytes());
            return Ok(());
        }
        let (name, amount) = text.split_once('=').expect("name=amount");
        let amount: u64 = amount.parse().expect("amount");
        let before = indexes
            .get("totals", name.as_bytes())
            .map_or(0, |bytes| u64::from_be_bytes(bytes.try_into().unwrap()));
        let total = before + amount * self.factor;
        indexes.put("totals", name.as_bytes().to_vec(), total.to_be_bytes().to_vec());
        indexes.put("last_commit", name.as_bytes().to_vec(), event.commit_seq.to_be_bytes().to_vec());
        Ok(())
    }
}

fn tally(version: u32, factor: u64) -> DomainModule {
    DomainModule {
        id: "tally",
        version,
        event_types: &[ADDED, CLEARED],
        projection: Arc::new(Tally { factor }),
    }
}

fn config(path: &Path) -> WabiDbConfig {
    let mut config = WabiDbConfig::new(path.into(), BootstrapSource::Provided([0x41; 32]));
    config.allow_init = true;
    config
}

/// Open, waiting for a just-dropped engine to release the directory.
async fn open(path: &Path, modules: Vec<DomainModule>) -> WabiDbEngine {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        match WabiDbEngine::open_with_modules(config(path), "node-1".into(), modules.clone()).await {
            Ok(engine) => return engine,
            Err(WabiError::AlreadyRunning { .. }) if tokio::time::Instant::now() < deadline => {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
            Err(error) => panic!("open failed: {error}"),
        }
    }
}

/// Wait until a dropped engine's background writers have let go of the
/// directory, so its files can be changed.
async fn stopped(path: &Path) {
    use fs4::fs_std::FileExt;
    let lock = std::fs::OpenOptions::new().read(true).write(true).open(path.join(".lock")).unwrap();
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
    while !FileExt::try_lock_exclusive(&lock).unwrap() {
        assert!(tokio::time::Instant::now() < deadline, "the engine did not stop");
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
}

fn event(kind: &str, stream: &str, payload: &str) -> DomainEvent {
    DomainEvent { stream_id: stream.into(), event_type: kind.into(), payload: payload.as_bytes().to_vec() }
}

async fn add(engine: &WabiDbEngine, name: &str, amount: u64) -> u64 {
    engine
        .write_domain_events("tally", 1, "add", None, vec![event(ADDED, &format!("tally.{name}"), &format!("{name}={amount}"))])
        .await
        .unwrap()
        .commit_seq
}

/// Write an event without going through the module, as a build without the
/// module (or a replicating peer) would have left it in the log.
async fn raw(engine: &WabiDbEngine, kind: &str, stream: &str, payload: &str) {
    engine.get_or_create_stream_key(stream).await.unwrap();
    engine
        .run_command(CommandCommit {
            caller_user_id: 1,
            caller_device_id: "test".into(),
            command_name: "raw".into(),
            idempotency_key: None,
            room_owner_precondition: None,
            events: vec![EventToWrite {
                stream_id: stream.into(),
                event_type: kind.into(),
                stream_kind: 0,
                record_kind: RecordKind::Event,
                plaintext: payload.as_bytes().to_vec(),
            }],
            essential: true,
            response_tx: tokio::sync::oneshot::channel().0,
        })
        .await
        .unwrap();
}

/// Every total of the module, as (name, total).
fn totals(engine: &WabiDbEngine) -> Vec<(String, u64)> {
    engine
        .domain_reader("tally")
        .unwrap()
        .scan_prefix("totals", b"")
        .into_iter()
        .map(|(k, v)| (String::from_utf8(k).unwrap(), u64::from_be_bytes(v.try_into().unwrap())))
        .collect()
}

fn named(pairs: &[(&str, u64)]) -> Vec<(String, u64)> {
    pairs.iter().map(|(name, total)| (name.to_string(), *total)).collect()
}

fn snapshot(path: &Path) -> serde_json::Value {
    serde_json::from_str(&std::fs::read_to_string(ProjectionState::snapshot_path(path)).unwrap()).unwrap()
}

async fn write_history(engine: &WabiDbEngine) {
    add(engine, "a", 5).await;
    add(engine, "b", 7).await;
    add(engine, "a", 1).await;
    add(engine, "gone", 9).await;
    engine
        .write_domain_events("tally", 1, "clear", None, vec![event(CLEARED, "tally.gone", "gone")])
        .await
        .unwrap();
    // Two streams in one command.
    engine
        .write_domain_events(
            "tally",
            1,
            "add_two",
            None,
            vec![event(ADDED, "tally.a", "a=10"), event(ADDED, "tally.c", "c=3")],
        )
        .await
        .unwrap();
}

const HISTORY: [(&str, u64); 3] = [("a", 16), ("b", 7), ("c", 3)];

#[tokio::test]
async fn a_write_is_applied_before_it_returns_and_reads_see_only_the_module() {
    let dir = tempfile::tempdir().unwrap();
    let engine = open(dir.path(), vec![tally(1, 1)]).await;
    let seq = add(&engine, "a", 5).await;
    let reader = engine.domain_reader("tally").unwrap();
    assert_eq!(reader.get("totals", b"a"), Some(5u64.to_be_bytes().to_vec()));
    assert_eq!(reader.get("last_commit", b"a"), Some(seq.to_be_bytes().to_vec()));
    // Stored under the module's own name, out of the way of core indexes.
    assert_eq!(engine.projection_state().get("domain.tally.totals", b"a"), Some(5u64.to_be_bytes().to_vec()));
    assert_eq!(engine.projection_state().get("totals", b"a"), None);
    assert!(engine.domain_reader("other").is_err());
}

#[tokio::test]
async fn a_module_cannot_write_outside_its_names() {
    let dir = tempfile::tempdir().unwrap();
    let engine = open(dir.path(), vec![tally(1, 1)]).await;
    let refused = |events: Vec<DomainEvent>| {
        let engine = &engine;
        async move {
            let result = engine.write_domain_events("tally", 1, "x", None, events).await;
            assert!(matches!(result, Err(WabiError::Validation { .. })), "{result:?}");
        }
    };
    refused(vec![]).await;
    refused(vec![event("message_created", "tally.a", "a=1")]).await;
    refused(vec![event("tally.unregistered", "tally.a", "a=1")]).await;
    refused(vec![event(ADDED, "channels", "a=1")]).await;
    refused(vec![event(ADDED, "tallyx.a", "a=1")]).await;
    refused(vec![event(ADDED, "tally.", "a=1")]).await;
    refused(vec![event(ADDED, "tally.A/b", "a=1")]).await;
    refused(vec![event(ADDED, "tally.a", "a=1"), event(ADDED, "tally.a", "a=2")]).await;
    assert!(engine.write_domain_events("other", 1, "x", None, vec![event(ADDED, "tally.a", "a=1")]).await.is_err());
    assert_eq!(totals(&engine), vec![]);
}

#[tokio::test]
async fn malformed_modules_are_refused_before_the_directory_is_touched() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("never-created");
    let module = |id: &'static str, event_types: &'static [&'static str]| DomainModule {
        id,
        version: 1,
        event_types,
        projection: Arc::new(Tally { factor: 1 }),
    };
    for modules in [
        vec![module("Tally", &["Tally.added"])],
        vec![module("", &[".added"])],
        vec![module("1tally", &["1tally.added"])],
        vec![module("tally", &[])],
        vec![module("tally", &["added"])],
        vec![module("tally", &["other.added"])],
        vec![module("tally", &["tally."])],
        vec![module("tally", &[ADDED]), module("tally", &[CLEARED])],
        vec![module("tally", &[ADDED, ADDED])],
        // "domain" would be a legal id; a core event type is not a legal name for it.
        vec![module("message_created", &["message_created"])],
    ] {
        let result = WabiDbEngine::open_with_modules(config(&path), "node-1".into(), modules).await;
        assert!(matches!(result, Err(WabiError::Validation { .. })), "{:?}", result.err());
        assert!(!path.exists());
    }
}

#[tokio::test]
async fn indexes_are_the_same_after_a_restart_and_after_losing_the_snapshot() {
    let dir = tempfile::tempdir().unwrap();
    let engine = open(dir.path(), vec![tally(1, 1)]).await;
    write_history(&engine).await;
    assert_eq!(totals(&engine), named(&HISTORY));
    drop(engine);

    // From the snapshot: nothing is replayed, nothing is applied twice.
    let engine = open(dir.path(), vec![tally(1, 1)]).await;
    assert_eq!(totals(&engine), named(&HISTORY));
    assert_eq!(snapshot(dir.path())["domains"], serde_json::json!({"tally": 1}));
    add(&engine, "b", 1).await;
    drop(engine);

    // From the log alone.
    stopped(dir.path()).await;
    ProjectionState::remove_saved_projections_for_tests(dir.path());
    let engine = open(dir.path(), vec![tally(1, 1)]).await;
    assert_eq!(totals(&engine), named(&[("a", 16), ("b", 8), ("c", 3)]));
}

#[tokio::test]
async fn a_module_absent_for_a_while_comes_back_complete() {
    let dir = tempfile::tempdir().unwrap();
    let engine = open(dir.path(), vec![tally(1, 1)]).await;
    write_history(&engine).await;
    drop(engine);

    // A build without the module opens the directory, keeps the module's
    // events that reach it, and saves a snapshot that no longer vouches for
    // the module's indexes.
    let engine = open(dir.path(), vec![]).await;
    assert!(engine.domain_reader("tally").is_err());
    raw(&engine, ADDED, "tally.b", "b=100").await;
    raw(&engine, "some_core_event", "elsewhere", "x").await;
    assert!(engine.is_healthy());
    drop(engine);
    let engine = open(dir.path(), vec![]).await;
    drop(engine);
    let saved = snapshot(dir.path());
    assert!(saved.get("domains").is_none(), "a build without modules writes the old snapshot format");
    assert!(saved["watermark"].as_u64().unwrap() > 0);

    // Back with the module: rebuilt from the whole log, the stale indexes
    // in the snapshot are not added to.
    let engine = open(dir.path(), vec![tally(1, 1)]).await;
    assert_eq!(totals(&engine), named(&[("a", 16), ("b", 107), ("c", 3)]));
    add(&engine, "c", 1).await;
    drop(engine);
    // The rebuild was saved; this start loads it.
    assert_eq!(snapshot(dir.path())["domains"], serde_json::json!({"tally": 1}));
    let engine = open(dir.path(), vec![tally(1, 1)]).await;
    assert_eq!(totals(&engine), named(&[("a", 16), ("b", 107), ("c", 4)]));
}

#[tokio::test]
async fn a_module_new_to_an_existing_directory_starts_from_the_whole_log() {
    let dir = tempfile::tempdir().unwrap();
    let engine = open(dir.path(), vec![]).await;
    raw(&engine, "some_core_event", "elsewhere", "x").await;
    raw(&engine, ADDED, "tally.early", "early=4").await;
    drop(engine);
    let engine = open(dir.path(), vec![tally(1, 1)]).await;
    assert_eq!(totals(&engine), named(&[("early", 4)]));
    add(&engine, "early", 1).await;
    assert_eq!(totals(&engine), named(&[("early", 5)]));
}

#[tokio::test]
async fn a_new_version_rebuilds_with_the_new_logic() {
    let dir = tempfile::tempdir().unwrap();
    let engine = open(dir.path(), vec![tally(1, 1)]).await;
    write_history(&engine).await;
    drop(engine);
    let engine = open(dir.path(), vec![tally(2, 10)]).await;
    assert_eq!(totals(&engine), named(&[("a", 160), ("b", 70), ("c", 30)]));
    // The cleared name does not come back from the old indexes.
    assert_eq!(engine.domain_reader("tally").unwrap().get("totals", b"gone"), None);
    drop(engine);
    assert_eq!(snapshot(dir.path())["domains"], serde_json::json!({"tally": 2}));
    // And back: a version is an identity, not an ordering.
    let engine = open(dir.path(), vec![tally(1, 1)]).await;
    assert_eq!(totals(&engine), named(&HISTORY));
}

#[tokio::test]
async fn an_engine_without_modules_is_unchanged() {
    let dir = tempfile::tempdir().unwrap();
    let engine = WabiDbEngine::open(config(dir.path())).await.unwrap();
    raw(&engine, "some_core_event", "elsewhere", "x").await;
    drop(engine);
    let engine = open(dir.path(), vec![]).await;
    assert_eq!(engine.projection_state().get("events", b"some_core_event"), Some(b"x".to_vec()));
    drop(engine);
    let saved = snapshot(dir.path());
    assert!(saved.get("domains").is_none());
}
