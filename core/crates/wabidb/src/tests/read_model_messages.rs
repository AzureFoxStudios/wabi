//! Task 3.5.1: the messages projection lives in the SQLite read model
//! (`projections/read-model.sqlite3`); every other projection is still in
//! memory and in `projections/snapshot.json`.
//!
//! These tests open a real engine. They cover what the read model must
//! guarantee while both stores exist: it is derived (delete it and the reads
//! are the same), it is rebuilt when another build wrote it, a failed startup
//! replay leaves nothing behind, and either store may be the older one.

use crate::crypto::bootstrap::BootstrapSource;
use crate::engine::locks::ProjectionState;
use crate::engine::{WabiDbConfig, WabiDbEngine};
use crate::error::Result;
use crate::format::record::RecordKind;
use crate::projections::message_lookup;
use crate::projections::messages::{
    encode_record, ChannelMessagesCleared, MessagePageCursor, MessageRecord, MessagesProjection,
};
use crate::projections::query::{MessagesFilter, QueryableProjection};
use crate::projections::read_model::READ_MODEL_GENERATION;
use crate::projections::test_poison;
use crate::sequencer::types::{CommandCommit, CommandOutcome, EventToWrite};
use std::path::Path;

fn config(path: &Path) -> WabiDbConfig {
    let mut config = WabiDbConfig::new(path.into(), BootstrapSource::Provided([0x35; 32]));
    config.allow_init = true;
    config
}

async fn open(path: &Path) -> WabiDbEngine {
    super::reopen_after_drop(config(path), None).await.unwrap()
}

async fn close(engine: WabiDbEngine, path: &Path) {
    drop(engine);
    drop(super::wait_for_stopped_engine(path).await);
}

fn event(kind: &str, stream: &str, plaintext: Vec<u8>) -> EventToWrite {
    EventToWrite {
        event_type: kind.into(),
        stream_id: stream.into(),
        plaintext,
        stream_kind: 1,
        record_kind: RecordKind::Event,
    }
}

async fn commit(engine: &WabiDbEngine, events: Vec<EventToWrite>) -> Result<CommandOutcome> {
    for event in &events {
        engine.get_or_create_stream_key(&event.stream_id).await?;
    }
    let (response_tx, _response_rx) = tokio::sync::oneshot::channel();
    engine
        .run_command(CommandCommit {
            caller_user_id: 1,
            caller_device_id: "read-model-test".into(),
            command_name: "read_model_test".into(),
            idempotency_key: None,
            room_owner_precondition: None,
            events,
            essential: true,
            response_tx,
        })
        .await
}

fn message(channel: &str, id: &str, author: u64, created_at_micros: i64) -> MessageRecord {
    MessageRecord {
        message_id: id.into(),
        channel_id: channel.into(),
        author_user_id: author,
        author_device_id: "device".into(),
        created_at_micros,
        encrypted_body_ref: format!("body of {id}"),
        idempotency_key: None,
        edit_history: vec![],
        edited_at_micros: None,
        is_deleted: false,
        is_spoiler: false,
        files: vec![],
    }
}

fn message_event(kind: &str, record: &MessageRecord) -> EventToWrite {
    event(kind, &record.channel_id, encode_record(record))
}

async fn send(engine: &WabiDbEngine, kind: &str, record: &MessageRecord) -> u64 {
    commit(engine, vec![message_event(kind, record)]).await.unwrap().commit_seq
}

/// A history that uses every message event: creates in two channels (two of
/// them at the same timestamp, one with an id the projection assigns), an
/// edit, a delete, a channel clear, a message after the clear, and an event
/// no message handler sees. Returns the last commit.
async fn write_history(engine: &WabiDbEngine) -> u64 {
    for (id, author, time) in [("a1", 7, 100), ("a2", 8, 200), ("a3", 7, 200), ("a4", 9, 300)] {
        send(engine, "message_created", &message("ch_a", id, author, time)).await;
    }
    send(engine, "message_created", &message("ch_a", "", 7, 400)).await;
    for (id, author, time) in [("b1", 7, 150), ("b2", 8, 250)] {
        send(engine, "message_created", &message("ch_b", id, author, time)).await;
    }
    let mut edited = message("ch_a", "a2", 8, 200);
    edited.encrypted_body_ref = "a2 edited".into();
    edited.edited_at_micros = Some(500);
    send(engine, "message_edited", &edited).await;
    let mut deleted = message("ch_a", "a3", 7, 200);
    deleted.is_deleted = true;
    send(engine, "message_deleted", &deleted).await;
    let clear = ChannelMessagesCleared { channel_id: "ch_b".into(), cleared_at_micros: 600 };
    commit(
        engine,
        vec![event("channel_messages_cleared", "ch_b", serde_json::to_vec(&clear).unwrap())],
    )
    .await
    .unwrap();
    send(engine, "message_created", &message("ch_b", "b3", 9, 700)).await;
    commit(engine, vec![event(test_poison::EVENT_TYPE, "ch_other", b"not a message".to_vec())])
        .await
        .unwrap()
        .commit_seq
}

/// The result of every read the server makes of this projection, and of the
/// crate's other public reads, as text. Two states that print the same text
/// answer every read the same.
fn all_reads(state: &ProjectionState) -> String {
    use std::fmt::Write;
    let mut out = String::new();
    let ids = ["a1", "a2", "a3", "a4", "msg_5", "b1", "b2", "b3", "absent"];
    for channel in ["ch_a", "ch_b", "ch_none"] {
        for id in ids {
            let got = MessagesProjection::get_message(state, channel, id).unwrap();
            writeln!(out, "get {channel} {id}: {got:?}").unwrap();
        }
        for include_deleted in [false, true] {
            let got = MessagesProjection::list_messages(state, channel, include_deleted).unwrap();
            writeln!(out, "list {channel} {include_deleted}: {got:?}").unwrap();
            for limit in [0, 1, 3, 50] {
                let got =
                    MessagesProjection::list_messages_tail(state, channel, limit, include_deleted)
                        .unwrap();
                writeln!(out, "tail {channel} {limit} {include_deleted}: {got:?}").unwrap();
            }
        }
        for limit in [1, 2, 50] {
            let page =
                MessagesProjection::list_messages_page(state, channel, MessagePageCursor::Latest, limit)
                    .unwrap();
            writeln!(out, "page latest {channel} {limit}: {:?} {}", page.messages, page.has_more)
                .unwrap();
            for id in ids {
                for after in [false, true] {
                    let cursor = if after {
                        MessagePageCursor::After(id)
                    } else {
                        MessagePageCursor::Before(id)
                    };
                    let page = MessagesProjection::list_messages_page(state, channel, cursor, limit)
                        .map(|page| (page.messages, page.has_more))
                        .map_err(|error| error.to_string());
                    writeln!(out, "page {channel} {id} after={after} {limit}: {page:?}").unwrap();
                }
            }
        }
        for (from, through, limit) in [(0, i64::MAX, 50), (150, 250, 50), (0, 300, 2), (300, 100, 5)] {
            let got =
                MessagesProjection::list_messages_in_time_range(state, channel, from, through, limit)
                    .unwrap();
            writeln!(out, "range {channel} {from} {through} {limit}: {got:?}").unwrap();
        }
        let got = MessagesProjection::list_messages_expired(state, channel, 250, 50).unwrap();
        writeln!(out, "expired {channel}: {got:?}").unwrap();
    }
    for id in ids {
        let got = message_lookup::get(state, id).map_err(|error| error.to_string());
        writeln!(out, "by id {id}: {got:?}").unwrap();
    }
    for channel_id in [None, Some("ch_a"), Some("ch_b")] {
        for author_id in [None, Some(7), Some(8), Some(42)] {
            for include_deleted in [false, true] {
                for limit in [None, Some(2)] {
                    for since_seq in [None, Some(3)] {
                        let filter = MessagesFilter {
                            channel_id: channel_id.map(str::to_owned),
                            author_id,
                            include_deleted,
                            limit,
                            since_seq,
                            ..Default::default()
                        };
                        let got = MessagesProjection.query(state, &filter).unwrap();
                        writeln!(
                            out,
                            "query {channel_id:?} {author_id:?} {include_deleted} {limit:?} {since_seq:?}: {got:?}"
                        )
                        .unwrap();
                    }
                }
            }
        }
    }
    out
}

/// Warn-level log lines written while the returned guard is alive, on this thread.
#[derive(Clone, Default)]
struct Logs(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);

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

fn read_model_file(path: &Path) -> std::path::PathBuf {
    ProjectionState::read_model_path(path)
}

/// What the read model file of a stopped engine holds, read with a plain
/// SQLite connection: (latest rows, version rows, `applied_commit_seq`,
/// stored generation, sorted message ids).
fn file_contents(path: &Path) -> (u64, u64, u64, i64, Vec<String>) {
    let conn = rusqlite::Connection::open(read_model_file(path)).unwrap();
    let count = |sql: &str| conn.query_row(sql, [], |row| row.get::<_, i64>(0)).unwrap() as u64;
    let mut ids: Vec<String> = conn
        .prepare("SELECT message_id FROM messages")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .map(|id| id.unwrap())
        .collect();
    ids.sort();
    (
        count("SELECT count(*) FROM messages"),
        count("SELECT count(*) FROM message_versions"),
        count("SELECT coalesce((SELECT seq FROM applied_commit_seq WHERE projection = 'messages'), 0)"),
        conn.query_row("SELECT generation FROM read_model_meta", [], |row| row.get(0)).unwrap(),
        ids,
    )
}

fn poison_event(payload: &[u8]) -> EventToWrite {
    event(test_poison::EVENT_TYPE, "ch_poison", payload.to_vec())
}

/// The rebuild test: the read model is derived. Delete the SQLite file of a
/// stopped engine, reopen, and every read returns what it returned before.
#[tokio::test]
async fn deleting_the_read_model_file_changes_no_read() {
    let dir = tempfile::tempdir().unwrap();
    let engine = open(dir.path()).await;
    let last = write_history(&engine).await;
    let live = all_reads(&engine.projection_state());
    // The history is not trivial: the reads see live, edited and cleared rows.
    assert!(live.contains("a2 edited"));
    assert!(live.contains("is_deleted: true"));
    assert!(live.contains("body of b3"));
    close(engine, dir.path()).await;

    // First a plain restart, from the file as it is.
    let engine = open(dir.path()).await;
    assert_eq!(all_reads(&engine.projection_state()), live);
    close(engine, dir.path()).await;
    let kept = file_contents(dir.path());
    assert_eq!(kept.2, last);

    // Then with the SQLite file deleted. The snapshot stays, so only the log
    // can bring the messages back.
    assert!(ProjectionState::snapshot_path(dir.path()).exists());
    std::fs::remove_file(read_model_file(dir.path())).unwrap();
    let engine = open(dir.path()).await;
    let state = engine.projection_state();
    assert_eq!(state.applied_commit_seq(), last);
    assert_eq!(all_reads(&state), live);
    // The projection that stayed in memory was rebuilt with it.
    assert_eq!(
        state.get(test_poison::INDEX, &last.to_be_bytes()),
        Some(b"not a message".to_vec())
    );
    close(engine, dir.path()).await;
    assert_eq!(file_contents(dir.path()), kept, "the rebuilt file holds the same rows");

    // And with every saved projection deleted.
    ProjectionState::remove_saved_projections_for_tests(dir.path());
    assert!(!read_model_file(dir.path()).exists());
    let engine = open(dir.path()).await;
    assert_eq!(all_reads(&engine.projection_state()), live);

    // Compaction is not an event. It removes the soft-deleted rows from the
    // file, a plain restart keeps them removed, and a rebuild from the log
    // brings them back: the reads are then those from before compaction.
    let removed = MessagesProjection::compact(engine.projection_state());
    assert!(removed > 0);
    let compacted = all_reads(engine.projection_state());
    assert_ne!(compacted, live);
    assert!(!compacted.contains("is_deleted: true"));
    close(engine, dir.path()).await;
    let engine = open(dir.path()).await;
    assert_eq!(all_reads(engine.projection_state()), compacted);
    close(engine, dir.path()).await;
    std::fs::remove_file(read_model_file(dir.path())).unwrap();
    let engine = open(dir.path()).await;
    assert_eq!(all_reads(engine.projection_state()), live);
}

/// The same message ID in two rooms, which only logs from before the
/// admission check can hold (the engine refuses to write a second one, so
/// the events are applied to the store directly here). Both rows survive a
/// close and reopen of the file; a lookup by ID alone refuses to choose; and
/// after one of them is deleted and compacted the other is found.
#[test]
fn the_same_message_id_in_two_rooms_reads_the_same_after_the_file_is_reopened() {
    use crate::projections::handler::{DurableEvent, Projection};
    use crate::projections::read_model::ReadModel;
    let dir = tempfile::tempdir().unwrap();
    let apply = |state: &ProjectionState, seq: u64, kind: &str, record: &MessageRecord| {
        MessagesProjection
            .apply(
                &DurableEvent {
                    commit_seq: seq,
                    stream_id: record.channel_id.clone(),
                    event_type: kind.into(),
                    payload: encode_record(record),
                },
                state,
            )
            .unwrap();
        state.read_model().finish_commit(seq).unwrap();
    };
    let reads = |state: &ProjectionState| {
        format!(
            "{:?}\n{:?}\n{:?}\n{:?}\n{:?}",
            MessagesProjection::get_message(state, "ch_a", "shared").unwrap(),
            MessagesProjection::get_message(state, "ch_b", "shared").unwrap(),
            message_lookup::get(state, "shared").map_err(|error| error.to_string()),
            MessagesProjection::list_messages_tail(state, "ch_a", 10, true).unwrap(),
            MessagesProjection
                .query(state, &MessagesFilter { author_id: Some(7), include_deleted: true, ..Default::default() })
                .unwrap(),
        )
    };
    let open_state = || {
        let state = ProjectionState::new();
        state.attach_read_model(std::sync::Arc::new(ReadModel::open(dir.path()).unwrap()));
        state
    };

    let state = open_state();
    let mut in_a = message("ch_a", "shared", 7, 100);
    apply(&state, 1, "message_created", &in_a);
    apply(&state, 2, "message_created", &message("ch_b", "shared", 7, 200));
    let both = reads(&state);
    assert!(both.contains("belongs to multiple rooms"), "{both}");
    drop(state);
    let state = open_state();
    assert_eq!(reads(&state), both);

    in_a.is_deleted = true;
    apply(&state, 3, "message_deleted", &in_a);
    MessagesProjection::compact(&state);
    let one = reads(&state);
    assert!(!one.contains("belongs to multiple rooms"), "{one}");
    assert_eq!(
        message_lookup::get(&state, "shared").unwrap().map(|record| record.channel_id),
        Some("ch_b".to_string())
    );
    drop(state);
    assert_eq!(reads(&open_state()), one);
}

/// Rebuild on generation mismatch: a file written by generation N is opened
/// by a build of generation N+1 (here: the stored number is changed to one
/// this build is not). The engine rebuilds it from the log. A row planted in
/// the old file, which no event produces, is gone; reads are unchanged.
#[tokio::test]
async fn a_read_model_of_another_generation_is_rebuilt_from_the_log() {
    let dir = tempfile::tempdir().unwrap();
    let engine = open(dir.path()).await;
    let last = write_history(&engine).await;
    let live = all_reads(&engine.projection_state());
    close(engine, dir.path()).await;
    let kept = file_contents(dir.path());
    assert_eq!(kept.3, READ_MODEL_GENERATION);

    {
        let conn = rusqlite::Connection::open(read_model_file(dir.path())).unwrap();
        conn.execute("UPDATE read_model_meta SET generation = ?1", [READ_MODEL_GENERATION - 1])
            .unwrap();
        conn.execute(
            "INSERT INTO messages (key, channel_id, message_id, author_user_id, record) \
             VALUES (x'00', 'ch_a', 'written-by-the-other-build', 7, x'00')",
            [],
        )
        .unwrap();
    }
    let stale = file_contents(dir.path());
    assert_eq!((stale.0, stale.3), (kept.0 + 1, READ_MODEL_GENERATION - 1));

    let engine = open(dir.path()).await;
    let state = engine.projection_state();
    assert_eq!(state.applied_commit_seq(), last);
    assert_eq!(all_reads(&state), live);
    close(engine, dir.path()).await;
    let rebuilt = file_contents(dir.path());
    println!("stale file: {stale:?}\nrebuilt:    {rebuilt:?}");
    assert_eq!(rebuilt, kept, "rebuilt from the log under this build's generation");
}

/// Startup replay applies events while it validates the log. Everything it
/// writes to the read model is one transaction: when replay fails after
/// applying some message events, the file holds none of them.
#[tokio::test]
async fn a_failed_startup_replay_leaves_none_of_its_messages_in_the_file() {
    let dir = tempfile::tempdir().unwrap();
    let engine = open(dir.path()).await;
    assert_eq!(send(&engine, "message_created", &message("ch_a", "m1", 7, 100)).await, 1);
    close(engine, dir.path()).await;
    // The file as it is after commit 1, to put back later.
    let after_one = std::fs::read(read_model_file(dir.path())).unwrap();
    assert_eq!(file_contents(dir.path()), (1, 1, 1, READ_MODEL_GENERATION, vec!["m1".into()]));

    let engine = open(dir.path()).await;
    assert_eq!(send(&engine, "message_created", &message("ch_a", "m2", 7, 200)).await, 2);
    close(engine, dir.path()).await;
    let engine = open(dir.path()).await;
    assert_eq!(send(&engine, "message_created", &message("ch_a", "m3", 7, 300)).await, 3);
    // Commit 4 is durable, and its handler fails: live now, and at every replay.
    assert!(commit(&engine, vec![poison_event(test_poison::FAIL)]).await.is_err());
    assert!(!engine.is_healthy());
    close(engine, dir.path()).await;

    // 1. No read model: replay applies m1, m2 and m3, then fails at commit 4.
    crate::projections::read_model::ReadModel::remove_files(dir.path()).unwrap();
    let error = super::reopen_after_drop(config(dir.path()), None).await.unwrap_err();
    println!("startup error: {error}");
    assert!(error.to_string().contains("commit 4"), "{error}");
    drop(super::wait_for_stopped_engine(dir.path()).await);
    let contents = file_contents(dir.path());
    println!("file after the failed replay: {contents:?}");
    assert_eq!(contents, (0, 0, 0, READ_MODEL_GENERATION, vec![]));

    // 2. A read model behind the snapshot (commit 1 against the snapshot's
    // commit 2): the rebuild empties the tables inside the same transaction,
    // replays m1 to m3 and fails. The file is exactly what it was.
    std::fs::write(read_model_file(dir.path()), &after_one).unwrap();
    assert!(super::reopen_after_drop(config(dir.path()), None).await.is_err());
    drop(super::wait_for_stopped_engine(dir.path()).await);
    assert_eq!(file_contents(dir.path()), (1, 1, 1, READ_MODEL_GENERATION, vec!["m1".into()]));

    // 3. A read model that keeps its rows (no snapshot to be behind): replay
    // skips m1, applies m2 and m3 and fails. Still only m1.
    std::fs::remove_file(ProjectionState::snapshot_path(dir.path())).unwrap();
    assert!(super::reopen_after_drop(config(dir.path()), None).await.is_err());
    drop(super::wait_for_stopped_engine(dir.path()).await);
    assert_eq!(file_contents(dir.path()), (1, 1, 1, READ_MODEL_GENERATION, vec!["m1".into()]));

    // Once the operator quarantines the commit, the same directory opens and
    // holds every message.
    crate::cli::quarantine::quarantine(dir.path(), 4).unwrap();
    let engine = open(dir.path()).await;
    let state = engine.projection_state();
    for id in ["m1", "m2", "m3"] {
        assert!(MessagesProjection::get_message(&state, "ch_a", id).unwrap().is_some(), "{id}");
    }
    close(engine, dir.path()).await;
    let contents = file_contents(dir.path());
    assert_eq!((contents.0, contents.1, contents.2), (3, 3, 4));
}

/// A live commit whose handler fails keeps none of its rows either: the
/// commit's message is rolled back with it.
#[tokio::test]
async fn a_commit_that_fails_to_apply_stores_none_of_its_messages() {
    let dir = tempfile::tempdir().unwrap();
    let engine = open(dir.path()).await;
    send(&engine, "message_created", &message("ch_a", "kept", 7, 100)).await;
    let failed = commit(
        &engine,
        vec![
            message_event("message_created", &message("ch_a", "half", 7, 200)),
            poison_event(test_poison::FAIL),
        ],
    )
    .await;
    assert!(failed.is_err());
    assert!(!engine.is_healthy());
    {
        let state = engine.projection_state();
        assert!(MessagesProjection::get_message(state, "ch_a", "kept").unwrap().is_some());
        assert_eq!(MessagesProjection::get_message(state, "ch_a", "half").unwrap(), None);
    }
    close(engine, dir.path()).await;
    assert_eq!(file_contents(dir.path()), (1, 1, 1, READ_MODEL_GENERATION, vec!["kept".into()]));
}

/// Two stores, two watermarks. A checkpoint first makes the read model
/// durable at the watermark and then writes the snapshot, so a crash between
/// the two leaves the read model ahead. Simulated here by putting an older
/// snapshot back: replay starts at the snapshot, applies the later events to
/// the in-memory projections and skips the message events the read model
/// already holds.
#[tokio::test]
async fn a_read_model_ahead_of_the_snapshot_is_kept_and_replay_skips_its_events() {
    let dir = tempfile::tempdir().unwrap();
    let engine = open(dir.path()).await;
    send(&engine, "message_created", &message("ch_a", "early", 7, 100)).await;
    commit(&engine, vec![event(test_poison::EVENT_TYPE, "ch_other", b"early".to_vec())])
        .await
        .unwrap();
    close(engine, dir.path()).await;
    let old_snapshot = std::fs::read(ProjectionState::snapshot_path(dir.path())).unwrap();
    assert_eq!(ProjectionState::read_snapshot_watermark(dir.path()).unwrap(), Some(2));

    let engine = open(dir.path()).await;
    let last = write_history(&engine).await;
    let live = all_reads(&engine.projection_state());
    close(engine, dir.path()).await;
    let kept = file_contents(dir.path());
    assert_eq!(kept.2, last);

    std::fs::write(ProjectionState::snapshot_path(dir.path()), old_snapshot).unwrap();
    // Plant a marker row no event produces. A rebuild would remove it; a
    // read model that is kept still has it.
    rusqlite::Connection::open(read_model_file(dir.path()))
        .unwrap()
        .execute(
            "INSERT INTO messages (key, channel_id, message_id, author_user_id, record) \
             VALUES (x'00', 'marker', 'marker', 0, x'00')",
            [],
        )
        .unwrap();

    let engine = open(dir.path()).await;
    let state = engine.projection_state();
    assert_eq!(state.applied_commit_seq(), last);
    assert_eq!(all_reads(&state), live);
    assert_eq!(
        state.get(test_poison::INDEX, &last.to_be_bytes()),
        Some(b"not a message".to_vec()),
        "the in-memory projection replayed the commits after its snapshot"
    );
    close(engine, dir.path()).await;
    let after = file_contents(dir.path());
    assert_eq!((after.0, after.1, after.2), (kept.0 + 1, kept.1, last), "kept, not rebuilt");
    assert!(after.4.contains(&"marker".to_string()));
}

/// The other order: the read model is older than the snapshot (its newest
/// commits were lost, or an older file was put back). Replay cannot start
/// below the snapshot for one projection only, so the snapshot is not used
/// and everything is rebuilt from the log.
#[tokio::test]
async fn a_read_model_behind_the_snapshot_is_rebuilt_with_every_projection() {
    let dir = tempfile::tempdir().unwrap();
    let engine = open(dir.path()).await;
    send(&engine, "message_created", &message("ch_a", "early", 7, 100)).await;
    close(engine, dir.path()).await;
    let old_file = std::fs::read(read_model_file(dir.path())).unwrap();

    let engine = open(dir.path()).await;
    let last = write_history(&engine).await;
    let live = all_reads(&engine.projection_state());
    close(engine, dir.path()).await;
    let kept = file_contents(dir.path());
    assert_eq!(ProjectionState::read_snapshot_watermark(dir.path()).unwrap(), Some(last));

    std::fs::write(read_model_file(dir.path()), old_file).unwrap();
    assert_eq!(file_contents(dir.path()).2, 1);
    let engine = open(dir.path()).await;
    let state = engine.projection_state();
    assert_eq!(state.applied_commit_seq(), last);
    assert_eq!(all_reads(&state), live);
    assert_eq!(
        state.get(test_poison::INDEX, &last.to_be_bytes()),
        Some(b"not a message".to_vec())
    );
    close(engine, dir.path()).await;
    assert_eq!(file_contents(dir.path()), kept);
}

fn remove_the_log(path: &Path) {
    std::fs::remove_dir_all(path.join("streams")).unwrap();
    for entry in std::fs::read_dir(path.join("global/commit-index")).unwrap() {
        std::fs::remove_file(entry.unwrap().path()).unwrap();
    }
}

/// Every file under the engine directory with its bytes, except the lock.
fn tree(path: &Path) -> std::collections::BTreeMap<std::path::PathBuf, Vec<u8>> {
    let mut files = std::collections::BTreeMap::new();
    let mut pending = vec![path.to_path_buf()];
    while let Some(dir) = pending.pop() {
        for entry in std::fs::read_dir(dir).unwrap() {
            let entry = entry.unwrap().path();
            if entry.is_dir() {
                pending.push(entry);
            } else if entry.file_name().unwrap() != ".lock" {
                files.insert(entry.strip_prefix(path).unwrap().to_path_buf(), std::fs::read(&entry).unwrap());
            }
        }
    }
    files
}

/// What a refused start may not change: every file except the lock, the
/// manifest (a refusal may raise its recorded height) and SQLite's `-shm`
/// index (rebuilt from the log; a refusal may recreate it).
fn tree_for_refusal(path: &Path) -> std::collections::BTreeMap<std::path::PathBuf, Vec<u8>> {
    let mut files = tree(path);
    files.retain(|name, _| {
        let name = name.to_string_lossy();
        name != "storage-manifest.json" && !name.ends_with("-shm") && !name.ends_with(".tmp")
    });
    files
}

fn manifest_height(path: &Path) -> u64 {
    let value: serde_json::Value =
        serde_json::from_slice(&std::fs::read(path.join("storage-manifest.json")).unwrap()).unwrap();
    value["highest_commit_seq"].as_u64().unwrap()
}

fn copy_tree(from: &Path, to: &Path, skip: &dyn Fn(&str) -> bool) {
    std::fs::create_dir_all(to).unwrap();
    for entry in std::fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let name = entry.file_name().to_string_lossy().into_owned();
        if skip(&name) {
            continue;
        }
        let target = to.join(&name);
        if entry.file_type().unwrap().is_dir() {
            copy_tree(&entry.path(), &target, skip);
        } else {
            std::fs::copy(entry.path(), &target).unwrap();
        }
    }
}

async fn refused(path: &Path) -> String {
    let error = super::reopen_after_drop(config(path), None).await.unwrap_err();
    drop(super::wait_for_stopped_engine(path).await);
    assert!(matches!(error, crate::error::WabiError::Corrupt { .. }), "{error:?}");
    error.to_string()
}

/// Five message commits, cleanly stopped: snapshot and read model both at 5.
async fn five_commits(path: &Path) {
    let engine = open(path).await;
    for n in 1..=5 {
        assert_eq!(send(&engine, "message_created", &message("ch_a", &format!("m{n}"), 7, n)).await, n as u64);
    }
    close(engine, path).await;
    assert_eq!(ProjectionState::read_snapshot_watermark(path).unwrap(), Some(5));
    assert_eq!(file_contents(path).2, 5);
}

/// A checkpoint that outlived its log (the log files are gone, the snapshot
/// and the read model are both at commit 5). The engine has always opened
/// such a directory; it still does, keeps every row, and continues above 5.
#[tokio::test]
async fn a_checkpoint_that_outlived_its_log_opens_when_both_stores_agree() {
    let dir = tempfile::tempdir().unwrap();
    five_commits(dir.path()).await;
    remove_the_log(dir.path());

    let engine = open(dir.path()).await;
    let state = engine.projection_state();
    assert_eq!(state.applied_commit_seq(), 5);
    assert_eq!(crate::projections::messages::stored_message_count(state), 5);
    assert_eq!(send(&engine, "message_created", &message("ch_a", "m6", 7, 6)).await, 6);
    close(engine, dir.path()).await;
}

/// The same directory without a read model: every first start after the
/// upgrade, and every start after the file was removed. Rebuilding from the
/// log would end with no messages and none of the snapshot's rows, and the
/// next write would reuse commit 1. The engine refuses and changes nothing;
/// `wabidb-cli check` says the same.
#[tokio::test]
async fn a_log_shorter_than_the_checkpoint_is_never_rebuilt_from() {
    let dir = tempfile::tempdir().unwrap();
    five_commits(dir.path()).await;
    let read_model = std::fs::read(read_model_file(dir.path())).unwrap();
    remove_the_log(dir.path());

    // 1. No read model.
    std::fs::remove_file(read_model_file(dir.path())).unwrap();
    let before = tree_for_refusal(dir.path());
    let text = refused(dir.path()).await;
    println!("refused: {text}");
    for part in ["ends at commit 0", "covers commit 5", "no read model", "Repair required"] {
        assert!(text.contains(part), "{part}: {text}");
    }
    assert!(text.contains("may raise `highest_commit_seq`"), "{text}");
    assert!(tree_for_refusal(dir.path()) == before, "a refused start changed the directory");
    assert!(!read_model_file(dir.path()).exists());
    let report = crate::cli::check::check(dir.path()).await.unwrap();
    assert!(!report.ok);
    assert!(
        report.errors.iter().any(|e| e.contains("refuses to start") && e.contains("covers commit 5")),
        "{:?}",
        report.errors
    );

    // 2. A read model of another generation that claims commit 5.
    std::fs::write(read_model_file(dir.path()), &read_model).unwrap();
    rusqlite::Connection::open(read_model_file(dir.path()))
        .unwrap()
        .execute("UPDATE read_model_meta SET generation = generation + 1", [])
        .unwrap();
    let before = tree_for_refusal(dir.path());
    let text = refused(dir.path()).await;
    assert!(text.contains("claims commit 5") && text.contains("cannot be used"), "{text}");
    assert!(tree_for_refusal(dir.path()) == before, "the unusable file was replaced");

    // 3. A usable read model ahead of the snapshot (and so of the log).
    std::fs::write(read_model_file(dir.path()), &read_model).unwrap();
    rusqlite::Connection::open(read_model_file(dir.path()))
        .unwrap()
        .execute("UPDATE applied_commit_seq SET seq = 9", [])
        .unwrap();
    let before = tree_for_refusal(dir.path());
    let text = refused(dir.path()).await;
    assert!(text.contains("read model covers commit 9"), "{text}");
    assert!(tree_for_refusal(dir.path()) == before, "a refused start changed the directory");

    // With the read model as the engine left it, the directory opens.
    std::fs::write(read_model_file(dir.path()), &read_model).unwrap();
    assert!(crate::cli::check::check(dir.path()).await.unwrap().errors.is_empty());
    let engine = open(dir.path()).await;
    assert_eq!(engine.projection_state().applied_commit_seq(), 5);
    // Case 3 above named commit 9. Its refusal kept that in the manifest, so
    // the numbers up to 9 are not handed out again even though the file that
    // claimed them is gone.
    assert_eq!(send(&engine, "message_created", &message("ch_a", "m6", 7, 6)).await, 10);
}

/// A rebuild never lets the sequencer fall below a commit a saved projection
/// named. Here the log is whole and the read model is another build's file
/// that claims a commit above the snapshot: more than the index holds, so
/// this is refused rather than rebuilt, and `wabidb-cli check` says the same.
/// The refusal records the claimed height in the manifest, so that the
/// obvious repair, deleting the read model, cannot hand those numbers out.
#[tokio::test]
async fn an_unusable_read_model_claiming_more_than_the_log_is_refused_and_its_claim_is_kept() {
    let dir = tempfile::tempdir().unwrap();
    five_commits(dir.path()).await;
    let read_model = std::fs::read(read_model_file(dir.path())).unwrap();
    for generation_bumped in [true, false] {
        std::fs::write(read_model_file(dir.path()), &read_model).unwrap();
        {
            let conn = rusqlite::Connection::open(read_model_file(dir.path())).unwrap();
            if generation_bumped {
                conn.execute("UPDATE read_model_meta SET generation = generation + 1", []).unwrap();
            }
            conn.execute("UPDATE applied_commit_seq SET seq = 40", []).unwrap();
        }
        let before = tree_for_refusal(dir.path());
        let text = refused(dir.path()).await;
        assert!(
            text.contains("ends at commit 5") && text.contains("commit 40"),
            "{generation_bumped}: {text}"
        );
        assert!(tree_for_refusal(dir.path()) == before);
        assert_eq!(manifest_height(dir.path()), 40, "the claim was not kept");
        assert!(!dir.path().join("storage-manifest.json.tmp").exists());
        let report = crate::cli::check::check(dir.path()).await.unwrap();
        assert!(
            report.errors.iter().any(|e| e.contains("refuses to start") && e.contains("commit 40")),
            "{generation_bumped}: check disagrees with the engine: {:?}",
            report.errors
        );
        // Reset the manifest for the second round.
        let manifest = dir.path().join("storage-manifest.json");
        let mut value: serde_json::Value = serde_json::from_slice(&std::fs::read(&manifest).unwrap()).unwrap();
        value["highest_commit_seq"] = serde_json::json!(5);
        std::fs::write(&manifest, serde_json::to_vec(&value).unwrap()).unwrap();
    }

    // The operator deletes the read model. The claim of 40 left with the file;
    // the manifest kept it, so the next commit is above it.
    let manifest = dir.path().join("storage-manifest.json");
    let mut value: serde_json::Value = serde_json::from_slice(&std::fs::read(&manifest).unwrap()).unwrap();
    value["highest_commit_seq"] = serde_json::json!(1);
    std::fs::write(&manifest, serde_json::to_vec(&value).unwrap()).unwrap();
    let _ = refused(dir.path()).await;
    assert_eq!(manifest_height(dir.path()), 40);
    ProjectionState::remove_saved_projections_for_tests(dir.path());
    let engine = open(dir.path()).await;
    assert_eq!(send(&engine, "message_created", &message("ch_a", "m6", 7, 6)).await, 41);
}

/// Something that is not a file where the read model belongs: the engine
/// refuses, and `check` and `verify` say so as an error, not a warning.
#[tokio::test]
async fn a_directory_where_the_read_model_belongs_is_refused_by_the_engine_and_by_check() {
    let dir = tempfile::tempdir().unwrap();
    five_commits(dir.path()).await;
    std::fs::remove_file(read_model_file(dir.path())).unwrap();
    std::fs::create_dir(read_model_file(dir.path())).unwrap();
    let text = refused(dir.path()).await;
    assert!(text.contains("not a regular file"), "{text}");
    for errors in [
        crate::cli::check::check(dir.path()).await.unwrap().errors,
        crate::cli::verify::verify(dir.path()).await.unwrap().errors,
    ] {
        assert!(
            errors.iter().any(|e| e.contains("refuses to start") && e.contains("not a regular file")),
            "{errors:?}"
        );
    }
}

/// A rebuild request beside a file that is gone (a crash between removing
/// the two): there is nothing to rebuild, the start fills the new file from
/// the log, and the request is gone afterwards, so the next start does not
/// rebuild again.
#[tokio::test]
async fn a_stale_rebuild_request_is_cleared_when_the_file_it_was_for_is_gone() {
    let dir = tempfile::tempdir().unwrap();
    five_commits(dir.path()).await;
    crate::projections::read_model::ReadModel::request_rebuild(dir.path(), "left by a crash").unwrap();
    std::fs::remove_file(read_model_file(dir.path())).unwrap();
    let marker = dir.path().join("projections/read-model.rebuild");
    assert!(marker.is_file());
    let engine = open(dir.path()).await;
    assert!(!marker.exists(), "the stale request was kept");
    assert_eq!(crate::projections::messages::stored_message_count(engine.projection_state()), 5);
    close(engine, dir.path()).await;
    assert_eq!(
        crate::projections::read_model::ReadModel::probe(dir.path()).unwrap(),
        crate::projections::read_model::FileState::Usable { applied: 5 }
    );
}

/// A rebuild request that is a directory is not "no request": ignoring it
/// could skip a rebuild somebody asked for, so the engine refuses.
#[tokio::test]
async fn a_rebuild_request_that_is_a_directory_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    five_commits(dir.path()).await;
    std::fs::create_dir(dir.path().join("projections/read-model.rebuild")).unwrap();
    let before = tree_for_refusal(dir.path());
    let text = refused(dir.path()).await;
    assert!(text.contains("rebuild request is not a regular file"), "{text}");
    assert!(tree_for_refusal(dir.path()) == before);
    let report = crate::cli::check::check(dir.path()).await.unwrap();
    assert!(
        report.errors.iter().any(|e| e.contains("refuses to start") && e.contains("rebuild request")),
        "{:?}",
        report.errors
    );
}

/// The manifest's recorded height is trusted only up to 2^62. Above it the
/// manifest is corrupt: `u64::MAX` would stop the sequencer at its first
/// write on every restart, and 2^63 does not fit the SQLite column.
#[tokio::test]
async fn an_implausible_manifest_height_or_watermark_is_a_corrupt_directory() {
    let dir = tempfile::tempdir().unwrap();
    five_commits(dir.path()).await;
    let manifest = dir.path().join("storage-manifest.json");
    let good = std::fs::read(&manifest).unwrap();
    for height in [u64::MAX, 1u64 << 63, (1u64 << 62) + 1] {
        let mut value: serde_json::Value = serde_json::from_slice(&good).unwrap();
        value["highest_commit_seq"] = serde_json::json!(height);
        std::fs::write(&manifest, serde_json::to_vec(&value).unwrap()).unwrap();
        let before = tree(dir.path());
        let text = refused(dir.path()).await;
        assert!(text.contains("not a plausible commit number"), "{height}: {text}");
        assert!(tree(dir.path()) == before, "{height}: the directory changed");
        let report = crate::cli::check::check(dir.path()).await.unwrap();
        assert!(
            report.errors.iter().any(|e| e.contains("refuses to start") && e.contains("plausible")),
            "{height}: {:?}",
            report.errors
        );
    }
    // 2^62 itself is a plausible height and the directory opens; the next
    // commit would be above the limit, so it is refused (the boundary is
    // tested in `commit_numbers_stop_at_the_limit`).
    let mut value: serde_json::Value = serde_json::from_slice(&good).unwrap();
    value["highest_commit_seq"] = serde_json::json!(1u64 << 62);
    std::fs::write(&manifest, serde_json::to_vec(&value).unwrap()).unwrap();
    let engine = open(dir.path()).await;
    close(engine, dir.path()).await;

    std::fs::write(&manifest, &good).unwrap();
    let snapshot = ProjectionState::snapshot_path(dir.path());
    let mut value: serde_json::Value = serde_json::from_slice(&std::fs::read(&snapshot).unwrap()).unwrap();
    value["watermark"] = serde_json::json!(u64::MAX);
    std::fs::write(&snapshot, serde_json::to_vec(&value).unwrap()).unwrap();
    let text = refused(dir.path()).await;
    assert!(text.contains("not a plausible commit number"), "{text}");
}

/// The sequencer continues above the manifest's recorded height too, even
/// when nothing else on disk reaches it.
#[tokio::test]
async fn the_next_commit_is_above_the_manifests_recorded_height() {
    let dir = tempfile::tempdir().unwrap();
    five_commits(dir.path()).await;
    let manifest = dir.path().join("storage-manifest.json");
    let mut value: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&manifest).unwrap()).unwrap();
    value["highest_commit_seq"] = serde_json::json!(30);
    std::fs::write(&manifest, serde_json::to_vec(&value).unwrap()).unwrap();
    let engine = open(dir.path()).await;
    assert_eq!(send(&engine, "message_created", &message("ch_a", "m6", 7, 6)).await, 31);
}

/// A read model whose pages are damaged (the version row still reads). With
/// a whole log it is replaced and rebuilt, and every read is right. This is
/// the successor of `corrupt_message_snapshot_refuses_open_without_replacing_it_or_leaking_lock`:
/// damage in the saved messages can no longer be loaded, and when the log
/// cannot replace them the open is refused, the file is kept and the lock is
/// released.
#[tokio::test]
async fn a_damaged_read_model_is_rebuilt_from_a_whole_log_and_kept_when_the_log_is_short() {
    let dir = tempfile::tempdir().unwrap();
    let engine = open(dir.path()).await;
    let mut last = 0;
    for n in 0..200 {
        let mut record = message("ch_a", &format!("m{n:03}"), 7, n);
        record.encrypted_body_ref = "x".repeat(300);
        last = send(&engine, "message_created", &record).await;
    }
    let live = all_reads(engine.projection_state());
    close(engine, dir.path()).await;

    let path = read_model_file(dir.path());
    let mut bytes = std::fs::read(&path).unwrap();
    assert!(bytes.len() > 8 * 4096);
    for byte in &mut bytes[3 * 4096..] {
        *byte = 0x5A;
    }
    std::fs::write(&path, &bytes).unwrap();

    let engine = open(dir.path()).await;
    assert!(engine.is_healthy());
    let state = engine.projection_state();
    assert_eq!(state.applied_commit_seq(), last);
    assert_eq!(all_reads(state), live);
    // Writes work again: the admission check reads the lookup by ID.
    send(&engine, "message_created", &message("ch_a", "after", 7, 999)).await;
    close(engine, dir.path()).await;

    // The same damage with the log gone: refused, file untouched, lock free.
    let engine = open(dir.path()).await;
    close(engine, dir.path()).await;
    let mut bytes = std::fs::read(&path).unwrap();
    for byte in &mut bytes[3 * 4096..] {
        *byte = 0x5A;
    }
    std::fs::write(&path, &bytes).unwrap();
    remove_the_log(dir.path());
    let before = tree(dir.path());
    let text = refused(dir.path()).await;
    println!("refused: {text}");
    assert!(text.contains("cannot be used") && text.contains("consistency check"), "{text}");
    assert!(tree(dir.path()) == before);
    assert!(crate::engine::locks::try_acquire_process_lock(&dir.path().join(".lock"))
        .unwrap()
        .is_some());
}

/// Damage that shows up while the engine runs: reads fail, the engine stops
/// reporting healthy, and the next start rebuilds the read model.
#[tokio::test]
async fn damage_at_run_time_makes_the_engine_unhealthy_and_the_next_start_rebuilds() {
    let dir = tempfile::tempdir().unwrap();
    let engine = open(dir.path()).await;
    for n in 0..200 {
        let mut record = message("ch_a", &format!("m{n:03}"), 7, n);
        record.encrypted_body_ref = "x".repeat(300);
        send(&engine, "message_created", &record).await;
    }
    // No read yet: a read connection would keep these few pages cached and
    // never notice what happens to the file.
    assert!(engine.is_healthy());
    {
        use std::io::{Seek, SeekFrom, Write};
        let path = read_model_file(dir.path());
        let len = std::fs::metadata(&path).unwrap().len() as usize;
        let mut file = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
        file.seek(SeekFrom::Start(3 * 4096)).unwrap();
        file.write_all(&vec![0x5Au8; len - 3 * 4096]).unwrap();
    }
    // Reads that have to touch the damaged pages fail; one of them is enough.
    let mut failed = false;
    for _ in 0..40 {
        let filter = MessagesFilter { include_deleted: true, ..Default::default() };
        failed |= MessagesProjection.query(engine.projection_state(), &filter).is_err();
    }
    assert!(failed, "no read touched the damaged pages");
    assert!(!engine.is_healthy());
    // A damaged engine takes no commands, of any kind, and writes nothing:
    // refused before the log is touched, as after a commit it could not apply.
    let indexed = || {
        crate::commit_index::batcher::read_all_entries(&dir.path().join("global/commit-index"))
            .unwrap()
            .len()
    };
    let before = indexed();
    for events in [
        vec![poison_event(b"a commit that has nothing to do with messages")],
        vec![message_event("message_created", &message("ch_a", "late", 7, 999))],
    ] {
        let refused = commit(&engine, events).await.unwrap_err().to_string();
        assert!(refused.contains("engine halted"), "{refused}");
    }
    assert_eq!(indexed(), before, "a halted engine wrote to the log");
    close(engine, dir.path()).await;

    assert!(ProjectionState::read_model_path(dir.path()).with_extension("rebuild").is_file());

    let engine = open(dir.path()).await;
    assert!(engine.is_healthy());
    let state = engine.projection_state();
    let listed = MessagesProjection::list_messages(state, "ch_a", true).unwrap();
    assert_eq!(listed.len(), 200);
    assert!(listed.iter().all(|record| record.encrypted_body_ref == "x".repeat(300)));
    assert!(message_lookup::get(state, "m199").unwrap().is_some());
    assert!(!ProjectionState::read_model_path(dir.path()).with_extension("rebuild").exists());
}

/// A commit quarantined after the read model applied it. The snapshot is at
/// commit 1 and the read model at 2 when commit 2 is quarantined; the
/// command asks for a rebuild, and after the next start no read sees m2.
#[tokio::test]
async fn quarantining_a_commit_the_read_model_holds_removes_it_from_the_read_model() {
    let dir = tempfile::tempdir().unwrap();
    let engine = open(dir.path()).await;
    send(&engine, "message_created", &message("ch_a", "m1", 7, 100)).await;
    close(engine, dir.path()).await;
    let snapshot_at_one = std::fs::read(ProjectionState::snapshot_path(dir.path())).unwrap();
    let engine = open(dir.path()).await;
    assert_eq!(send(&engine, "message_created", &message("ch_a", "m2", 7, 200)).await, 2);
    close(engine, dir.path()).await;
    std::fs::write(ProjectionState::snapshot_path(dir.path()), snapshot_at_one).unwrap();
    assert_eq!(file_contents(dir.path()).4, ["m1", "m2"]);

    crate::cli::quarantine::quarantine(dir.path(), 2).unwrap();
    assert_eq!(file_contents(dir.path()).4, ["m1", "m2"], "the command deletes nothing itself");

    let engine = open(dir.path()).await;
    let state = engine.projection_state();
    assert_eq!(state.applied_commit_seq(), 2);
    assert!(MessagesProjection::get_message(state, "ch_a", "m1").unwrap().is_some());
    assert_eq!(MessagesProjection::get_message(state, "ch_a", "m2").unwrap(), None);
    assert_eq!(message_lookup::get(state, "m2").unwrap(), None);
    close(engine, dir.path()).await;
    assert_eq!(file_contents(dir.path()).4, ["m1"]);
}

/// One transaction per commit: a reader never sees part of a command. Each
/// command here writes one message to each of two channels, so any single
/// read of all messages must find an even number. (The in-memory projection
/// did not guarantee this.)
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_readers_never_see_part_of_a_commit() {
    let dir = tempfile::tempdir().unwrap();
    let engine = open(dir.path()).await;
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let readers: Vec<_> = (0..4)
        .map(|_| {
            let state = std::sync::Arc::clone(engine.projection_state());
            let stop = stop.clone();
            std::thread::spawn(move || {
                let mut reads = 0u64;
                let mut most = 0;
                while !stop.load(std::sync::atomic::Ordering::Relaxed) {
                    let all = MessagesProjection
                        .query(&state, &MessagesFilter { include_deleted: true, ..Default::default() })
                        .unwrap();
                    assert_eq!(all.len() % 2, 0, "read half of a commit: {} messages", all.len());
                    let a = MessagesProjection::list_messages_tail(&state, "ch_a", 1_000, true).unwrap();
                    assert!(a.len() * 2 >= all.len(), "a later read went backwards");
                    most = most.max(all.len());
                    reads += 1;
                }
                (reads, most)
            })
        })
        .collect();
    const COMMITS: usize = 150;
    for n in 0..COMMITS {
        commit(
            &engine,
            vec![
                message_event("message_created", &message("ch_a", &format!("a{n}"), 7, n as i64)),
                message_event("message_created", &message("ch_b", &format!("b{n}"), 8, n as i64)),
            ],
        )
        .await
        .unwrap();
        // A write is readable as soon as its command returns.
        let state = engine.projection_state();
        assert!(MessagesProjection::get_message(&state, "ch_b", &format!("b{n}")).unwrap().is_some());
    }
    stop.store(true, std::sync::atomic::Ordering::Relaxed);
    let mut total = 0;
    for reader in readers {
        let (reads, _most) = reader.join().unwrap();
        total += reads;
    }
    println!("{total} concurrent full reads during {COMMITS} two-message commits");
    assert!(total > 0);
    let state = engine.projection_state();
    assert_eq!(crate::projections::messages::stored_message_count(&state), COMMITS * 2);
}

/// The file is created with mode 0600, like the lock and fence files, and the
/// snapshot no longer holds any message.
#[tokio::test]
async fn the_read_model_file_is_owner_only_and_messages_leave_the_snapshot() {
    let dir = tempfile::tempdir().unwrap();
    let engine = open(dir.path()).await;
    write_history(&engine).await;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for name in ["read-model.sqlite3", "read-model.sqlite3-wal", "read-model.sqlite3-shm"] {
            let path = dir.path().join("projections").join(name);
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            println!("{mode:o} {name}");
            assert_eq!(mode, 0o600, "{name}");
        }
    }
    close(engine, dir.path()).await;
    let mut names: Vec<_> = std::fs::read_dir(dir.path().join("projections"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    assert_eq!(names, ["read-model.sqlite3", "snapshot.json"], "a clean stop leaves no log file");

    let snapshot = std::fs::read_to_string(ProjectionState::snapshot_path(dir.path())).unwrap();
    for legacy in crate::engine::locks::LEGACY_MESSAGE_INDEXES {
        assert!(!snapshot.contains(&format!("\"{legacy}\"")), "{legacy} is in the snapshot");
    }
    assert!(!snapshot.contains(&hex::encode("body of a1")), "a message body is in the snapshot");
    // The read model is not encrypted: the body is in the file as written.
    let file = std::fs::read(read_model_file(dir.path())).unwrap();
    assert!(file.windows(10).any(|window| window == b"body of a1"));
}

/// Measurement, not a check: how long a full rebuild of the read model takes
/// and how large SQLite's write-ahead log grows during it (the rebuild is one
/// transaction), and what the consistency check at every open costs.
///
/// `WABIDB_MEASURE_MESSAGES=1000000 cargo test --release -p wabidb --lib \
///  measure_read_model_rebuild -- --ignored --nocapture`
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "measurement; prints timings"]
async fn measure_read_model_rebuild() {
    let total: usize = std::env::var("WABIDB_MEASURE_MESSAGES")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(100_000);
    const CHANNELS: usize = 50;
    let dir = tempfile::tempdir().unwrap();
    let engine = open(dir.path()).await;
    let started = std::time::Instant::now();
    let body = "b".repeat(200);
    for round in 0..total / CHANNELS {
        let events = (0..CHANNELS)
            .map(|channel| {
                let mut record = message(
                    &format!("ch_{channel:02}"),
                    &format!("{:032x}", round * CHANNELS + channel),
                    (channel % 7) as u64,
                    round as i64 * 1_000,
                );
                record.encrypted_body_ref = body.clone();
                message_event("message_created", &record)
            })
            .collect();
        commit(&engine, events).await.unwrap();
    }
    println!("{total} messages written in {:.1?}", started.elapsed());
    close(engine, dir.path()).await;
    let file = read_model_file(dir.path());
    let size = |path: &Path| std::fs::metadata(path).map(|m| m.len()).unwrap_or(0) as f64 / 1e6;
    println!("read model file: {:.1} MB", size(&file));

    let started = std::time::Instant::now();
    let state = crate::projections::read_model::ReadModel::probe(dir.path()).unwrap();
    println!("probe with quick_check: {:.1?} ({state:?})", started.elapsed());

    let started = std::time::Instant::now();
    let engine = open(dir.path()).await;
    println!("restart with the read model kept: {:.1?}", started.elapsed());
    let started = std::time::Instant::now();
    let page = MessagesProjection::list_messages_page(
        engine.projection_state(),
        "ch_07",
        MessagePageCursor::Latest,
        50,
    )
    .unwrap();
    println!("first page of 50 after restart: {:.1?} ({} rows)", started.elapsed(), page.messages.len());
    close(engine, dir.path()).await;

    std::fs::remove_file(&file).unwrap();
    let wal = std::path::PathBuf::from(format!("{}-wal", file.display()));
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let watcher = {
        let (wal, stop) = (wal.clone(), stop.clone());
        std::thread::spawn(move || {
            let mut peak = 0u64;
            while !stop.load(std::sync::atomic::Ordering::Relaxed) {
                peak = peak.max(std::fs::metadata(&wal).map(|m| m.len()).unwrap_or(0));
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            peak
        })
    };
    let started = std::time::Instant::now();
    let engine = open(dir.path()).await;
    let rebuilt = started.elapsed();
    stop.store(true, std::sync::atomic::Ordering::Relaxed);
    let peak = watcher.join().unwrap() as f64 / 1e6;
    println!(
        "rebuild from the log (read model deleted): {rebuilt:.1?}; write-ahead log peak {peak:.1} MB; \
         file afterwards {:.1} MB",
        size(&file)
    );
    assert_eq!(crate::projections::messages::stored_message_count(engine.projection_state()), total);
}


// ---------------------------------------------------------------------------
// A directory whose log is incomplete (second review of PR 334).
// ---------------------------------------------------------------------------

/// Five messages, the log removed, one start (which keeps both saved
/// projections over the short log and records that) and one more message:
/// the index is at 6, snapshot and read model at 6, and nothing in the log
/// shows any more that commits 1 to 5 are missing.
async fn incomplete_log_directory(path: &Path) {
    five_commits(path).await;
    remove_the_log(path);
    let engine = open(path).await;
    assert_eq!(crate::engine::incomplete_log::load(path).unwrap(), Some(5), "no record at start");
    assert_eq!(send(&engine, "message_created", &message("ch_a", "m6", 7, 6)).await, 6);
    close(engine, path).await;
    assert_eq!(ProjectionState::read_snapshot_watermark(path).unwrap(), Some(5 + 1));
    assert_eq!(file_contents(path).2, 6);
}

/// The record is what keeps the guard working after a write. Without it the
/// engine opens in keep-both mode, writes one message, and then, once the
/// read model is lost in any of the three ways below, rebuilds from a log
/// that holds one message and drops the other five and every in-memory row.
#[tokio::test]
async fn a_directory_recorded_as_incomplete_never_rebuilds_from_its_log() {
    let source = tempfile::tempdir().unwrap();
    incomplete_log_directory(source.path()).await;

    let lose_the_read_model: [(&str, &dyn Fn(&Path)); 3] = [
        ("the file is deleted", &|path| {
            std::fs::remove_file(read_model_file(path)).unwrap();
        }),
        ("a rebuild is requested", &|path| {
            crate::projections::read_model::ReadModel::request_rebuild(path, "run-time damage").unwrap();
        }),
        ("the generation changes", &|path| {
            rusqlite::Connection::open(read_model_file(path))
                .unwrap()
                .execute("UPDATE read_model_meta SET generation = generation + 1", [])
                .unwrap();
        }),
    ];
    for (name, lose) in lose_the_read_model {
        let dir = tempfile::tempdir().unwrap();
        copy_tree(source.path(), dir.path(), &|_| false);
        lose(dir.path());
        let before = tree_for_refusal(dir.path());
        let text = refused(dir.path()).await;
        println!("{name}: {text}");
        for part in ["incomplete below commit 5", "cannot be rebuilt", "restore", "incomplete-log.json"] {
            assert!(text.contains(part), "{name}: {part}: {text}");
        }
        assert!(tree_for_refusal(dir.path()) == before, "{name}: a refused start changed the directory");
        assert_eq!(crate::engine::incomplete_log::load(dir.path()).unwrap(), Some(5));
        let check = crate::cli::check::check(dir.path()).await.unwrap();
        assert!(!check.ok, "{name}");
        assert!(
            check.errors.iter().any(|e| e.contains("refuses to start") && e.contains("incomplete below commit 5")),
            "{name}: {:?}",
            check.errors
        );
        let verify = crate::cli::verify::verify(dir.path()).await.unwrap();
        assert!(
            verify.errors.iter().any(|e| e.contains("refuses to start") && e.contains("incomplete below commit 5")),
            "{name}: {:?}",
            verify.errors
        );
    }

    // The same directory with its read model starts, and says what it is.
    let dir = tempfile::tempdir().unwrap();
    copy_tree(source.path(), dir.path(), &|_| false);
    let check = crate::cli::check::check(dir.path()).await.unwrap();
    assert!(check.ok, "{:?}", check.errors);
    assert!(
        check.warnings.iter().any(|w| w.contains("incomplete below commit 5") && w.contains("Back up")),
        "{:?}",
        check.warnings
    );
    let verify = crate::cli::verify::verify(dir.path()).await.unwrap();
    assert!(verify.ok, "{:?}", verify.errors);
    assert!(verify.warnings.iter().any(|w| w.contains("incomplete below commit 5")), "{:?}", verify.warnings);
    let (logs, guard) = capture_warnings();
    let engine = open(dir.path()).await;
    drop(guard);
    assert!(
        logs.text().lines().any(|line| line.contains("WARN") && line.contains("incomplete below commit 5")),
        "no warning at start:\n{}",
        logs.text()
    );
    assert_eq!(crate::projections::messages::stored_message_count(engine.projection_state()), 6);
    close(engine, dir.path()).await;
}

/// What the live checkpoint export produces: the tree without the read model
/// and its side files. The record travels with it, so the first start of the
/// copy refuses instead of dropping five messages.
#[tokio::test]
async fn a_copy_without_the_read_model_keeps_the_record_and_refuses() {
    let source = tempfile::tempdir().unwrap();
    incomplete_log_directory(source.path()).await;
    let copy = tempfile::tempdir().unwrap();
    copy_tree(source.path(), copy.path(), &|name| name.starts_with("read-model.sqlite3"));
    assert!(!read_model_file(copy.path()).exists());
    assert_eq!(crate::engine::incomplete_log::load(copy.path()).unwrap(), Some(5));
    let text = refused(copy.path()).await;
    assert!(text.contains("incomplete below commit 5") && text.contains("there is no read model"), "{text}");
}

/// `wabidb-cli quarantine` needs a rebuild, so on such a directory it refuses
/// up front, writes nothing and says why.
#[tokio::test]
async fn quarantine_refuses_a_directory_recorded_as_incomplete() {
    let dir = tempfile::tempdir().unwrap();
    incomplete_log_directory(dir.path()).await;
    let before = tree(dir.path());
    let error = crate::cli::quarantine::quarantine(dir.path(), 6).unwrap_err().to_string();
    println!("{error}");
    assert!(error.contains("incomplete below commit 5") && error.contains("would no longer start"), "{error}");
    assert!(tree(dir.path()) == before, "quarantine wrote before refusing");
    assert!(!dir.path().join("projections/read-model.rebuild").exists());
    assert!(!crate::engine::quarantine::path(dir.path()).exists());
}

/// A record that cannot be read stops startup: ignoring it would allow the
/// rebuild it exists to prevent.
#[tokio::test]
async fn an_unreadable_incomplete_log_record_refuses_startup() {
    let dir = tempfile::tempdir().unwrap();
    incomplete_log_directory(dir.path()).await;
    let record = crate::engine::incomplete_log::path(dir.path());
    for content in [&b"not json"[..], br#"{"version":9,"incomplete_below":5}"#] {
        std::fs::write(&record, content).unwrap();
        let text = refused(dir.path()).await;
        assert!(text.contains("incomplete-log.json"), "{text}");
        let check = crate::cli::check::check(dir.path()).await.unwrap();
        assert!(check.errors.iter().any(|e| e.contains("refuses to start")), "{:?}", check.errors);
    }
}

/// The rules of `plan_startup` over every combination of what is on disk.
#[test]
fn plan_startup_never_rebuilds_a_directory_recorded_as_incomplete() {
    use crate::engine::plan_startup;
    use crate::projections::read_model::FileState;
    let usable = |applied| FileState::Usable { applied };
    let unusable = |applied| FileState::Unusable { reason: "test".into(), applied };
    let states = [FileState::Missing, usable(0), usable(5), usable(9), unusable(0), unusable(5), unusable(40)];
    for index_high in [0u64, 5, 6, 9, 40] {
        for snapshot in [0u64, 5, 9] {
            for model in &states {
                for incomplete in [None, Some(5)] {
                    let plan = plan_startup(index_high, snapshot, model, incomplete);
                    let (usable_model, model_seq) = match model {
                        FileState::Missing => (false, 0),
                        FileState::Usable { applied } => (true, *applied),
                        FileState::Unusable { applied, .. } => (false, *applied),
                    };
                    let reaches = index_high >= snapshot.max(model_seq);
                    let needs_rebuild = !usable_model || model_seq < snapshot;
                    let label = format!("index {index_high} snapshot {snapshot} {model:?} incomplete {incomplete:?}");
                    if incomplete.is_some_and(|below| snapshot < below) {
                        let error = plan.err().unwrap_or_else(|| panic!("started: {label}"));
                        assert!(error.contains("from inside the hole"), "{label}: {error}");
                        continue;
                    }
                    match (reaches, needs_rebuild, incomplete) {
                        (true, true, Some(_)) => {
                            let error = plan.err().unwrap_or_else(|| panic!("rebuilt: {label}"));
                            assert!(error.contains("incomplete below commit 5"), "{label}: {error}");
                        }
                        (true, rebuild, _) => {
                            let plan = plan.unwrap_or_else(|e| panic!("{label}: {e}"));
                            assert_eq!((plan.rebuild, plan.record_incomplete_below), (rebuild, None), "{label}");
                        }
                        (false, _, _) if usable_model && model_seq == snapshot => {
                            let plan = plan.unwrap_or_else(|e| panic!("{label}: {e}"));
                            assert_eq!(
                                (plan.rebuild, plan.record_incomplete_below),
                                (false, Some(snapshot)),
                                "{label}"
                            );
                        }
                        (false, _, _) => {
                            let error = plan.err().unwrap_or_else(|| panic!("started: {label}"));
                            assert!(error.contains("Repair required"), "{label}: {error}");
                        }
                    }
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// What a refused start may touch.
// ---------------------------------------------------------------------------

/// A crash leaves the read model with frames in its write-ahead log. The
/// refusal must not fold them into the file or remove the log: reading the
/// file to decide must not change it. Only `-shm`, an index SQLite rebuilds,
/// may differ.
#[tokio::test]
async fn a_refusal_from_an_unclean_stop_leaves_the_database_and_its_log_as_they_were() {
    let dir = tempfile::tempdir().unwrap();
    five_commits(dir.path()).await;
    remove_the_log(dir.path());
    // Frames in the log: a committed update that was never checkpointed, as a
    // killed engine leaves it. The connection is leaked so nothing closes it.
    {
        let conn = rusqlite::Connection::open(read_model_file(dir.path())).unwrap();
        conn.execute("UPDATE applied_commit_seq SET seq = 4", []).unwrap();
        std::mem::forget(conn);
    }
    let model = read_model_file(dir.path());
    let wal = std::path::PathBuf::from(format!("{}-wal", model.display()));
    assert!(std::fs::metadata(&wal).unwrap().len() > 0, "the setup left no frames");
    let (db_before, wal_before) = (std::fs::read(&model).unwrap(), std::fs::read(&wal).unwrap());
    let before = tree_for_refusal(dir.path());

    let text = refused(dir.path()).await;
    println!("{text}");
    assert!(text.contains("the read model covers commit 4"), "{text}");
    assert!(std::fs::read(&model).unwrap() == db_before, "the refusal rewrote the database");
    assert!(std::fs::read(&wal).unwrap() == wal_before, "the refusal changed or removed the log");
    assert!(tree_for_refusal(dir.path()) == before);
    // The same through the lock-free commands.
    let check = crate::cli::check::check(dir.path()).await.unwrap();
    assert!(check.warnings.iter().any(|w| w.contains("was not examined")), "{:?}", check.warnings);
    assert!(std::fs::read(&model).unwrap() == db_before && std::fs::read(&wal).unwrap() == wal_before);
}

/// The probe of a clean directory creates no file either.
#[tokio::test]
async fn probing_a_cleanly_stopped_read_model_creates_and_removes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    five_commits(dir.path()).await;
    let before = tree(dir.path());
    let names = |path: &Path| {
        let mut names: Vec<_> = std::fs::read_dir(path.join("projections"))
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    };
    let listing = names(dir.path());
    for _ in 0..3 {
        assert_eq!(
            crate::projections::read_model::ReadModel::probe(dir.path()).unwrap(),
            crate::projections::read_model::FileState::Usable { applied: 5 }
        );
    }
    assert_eq!(names(dir.path()), listing);
    assert!(tree(dir.path()) == before);
}

// ---------------------------------------------------------------------------
// Round four: what a hole in the log looks like, and what it does not.
// ---------------------------------------------------------------------------

fn index_seqs(path: &Path) -> Vec<u64> {
    crate::commit_index::batcher::read_all_entries(&path.join("global/commit-index"))
        .unwrap()
        .iter()
        .map(|entry| entry.commit_seq)
        .collect()
}

fn edit_json(path: &Path, change: impl FnOnce(&mut serde_json::Value)) {
    let mut value: serde_json::Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    change(&mut value);
    std::fs::write(path, serde_json::to_vec(&value).unwrap()).unwrap();
}

/// Commit numbers can be missing from the commit index without any loss, and
/// leave no trace, which is why "the index is contiguous from commit 1" is
/// not a test for a hole: a command rejected before anything is written burns
/// its number (also before the first commit, so an index can start above 1), a
/// command that fails to prepare burns its number, and a crash between a
/// segment write and the index append leaves an orphan record with no entry
/// (`sequencer::tests::orphan_records_tolerated`). A quarantined commit stays
/// in the index. A directory with such gaps must still be rebuilt from, so a
/// contiguity check would refuse healthy installations at their first start
/// of this build.
#[tokio::test]
async fn commit_numbers_can_have_gaps_that_leave_no_trace() {
    let dir = tempfile::tempdir().unwrap();
    let engine = open(dir.path()).await;
    let ghost_edit = || vec![message_event("message_edited", &message("ch_a", "ghost", 7, 1))];
    // 1: rejected before anything is written (also: before the first commit).
    assert!(commit(&engine, ghost_edit()).await.is_err());
    assert_eq!(send(&engine, "message_created", &message("ch_a", "m1", 7, 1)).await, 2);
    // 3: fails to prepare (no key for its stream), after its number was taken.
    let (response_tx, _rx) = tokio::sync::oneshot::channel();
    let unprepared = engine
        .run_command(CommandCommit {
            caller_user_id: 1,
            caller_device_id: "gap-test".into(),
            command_name: "gap_test".into(),
            idempotency_key: None,
            room_owner_precondition: None,
            events: vec![message_event("message_created", &message("ch_unkeyed", "u1", 7, 1))],
            essential: true,
            response_tx,
        })
        .await;
    assert!(unprepared.is_err(), "{unprepared:?}");
    assert_eq!(send(&engine, "message_created", &message("ch_a", "m2", 7, 2)).await, 4);
    // 5: rejected again.
    assert!(commit(&engine, ghost_edit()).await.is_err());
    assert_eq!(send(&engine, "message_created", &message("ch_a", "m3", 7, 3)).await, 6);
    close(engine, dir.path()).await;
    assert_eq!(index_seqs(dir.path()), [2, 4, 6], "the index has the gaps 1, 3 and 5");

    // A quarantined commit stays in the index.
    crate::cli::quarantine::quarantine(dir.path(), 4).unwrap();
    assert_eq!(index_seqs(dir.path()), [2, 4, 6]);

    // The directory is healthy and every start of it replays the whole log:
    // gaps must not make that refuse.
    ProjectionState::remove_saved_projections_for_tests(dir.path());
    let engine = open(dir.path()).await;
    let state = engine.projection_state();
    assert_eq!(crate::projections::messages::stored_message_count(state), 2, "m1 and m3; m2's commit is quarantined");
    assert_eq!(state.applied_commit_seq(), 6);
    close(engine, dir.path()).await;
    let check = crate::cli::check::check(dir.path()).await.unwrap();
    assert!(check.ok, "{check:#?}");
    assert!(
        check.warnings.iter().all(|w| w.contains("quarantined") && !w.contains("incomplete")),
        "{check:#?}"
    );
}

/// A hole an older build made and then wrote past: the commit index holds only
/// commit 6, the snapshot (old format, with its messages in it) is at 6, there
/// is no read model and no record. Nothing in the index shows the hole, but the
/// snapshot still holds the messages the log cannot give back, so the first
/// start of this build, which would rebuild from the log, refuses.
#[tokio::test]
async fn a_hole_an_older_build_made_is_not_rebuilt_from() {
    // The directory as an older build left it.
    let make = |path: &Path, hole: bool| {
        let path = path.to_path_buf();
        async move {
            five_commits(&path).await;
            if hole {
                remove_the_log(&path);
                let engine = open(&path).await;
                assert_eq!(send(&engine, "message_created", &message("ch_a", "m6", 7, 6)).await, 6);
                close(engine, &path).await;
            }
            let rows: Vec<(Vec<u8>, Vec<u8>)> = rusqlite::Connection::open(read_model_file(&path))
                .unwrap()
                .prepare("SELECT key, record FROM messages ORDER BY key")
                .unwrap()
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
                .unwrap()
                .map(|row| row.unwrap())
                .collect();
            crate::projections::read_model::ReadModel::remove_files(&path).unwrap();
            let _ = std::fs::remove_file(crate::engine::incomplete_log::path(&path));
            edit_json(&path.join("storage-manifest.json"), |manifest| {
                let object = manifest.as_object_mut().unwrap();
                object.remove("incomplete_log_below");
                object.remove("log_head_commit");
            });
            edit_json(&ProjectionState::snapshot_path(&path), |snapshot| {
                snapshot.as_object_mut().unwrap().remove("incomplete_log_below");
                snapshot["indexes"].as_array_mut().unwrap().push(serde_json::json!([
                    "messages",
                    rows.iter()
                        .map(|(key, value)| serde_json::json!({"key": hex::encode(key), "value": hex::encode(value)}))
                        .collect::<Vec<_>>()
                ]));
            });
            rows.len()
        }
    };

    // With a whole log the legacy messages come back and the start succeeds.
    let whole = tempfile::tempdir().unwrap();
    assert_eq!(make(whole.path(), false).await, 5);
    let engine = open(whole.path()).await;
    assert_eq!(crate::projections::messages::stored_message_count(engine.projection_state()), 5);
    close(engine, whole.path()).await;

    // With the hole it refuses and changes nothing.
    let holed = tempfile::tempdir().unwrap();
    assert_eq!(make(holed.path(), true).await, 6);
    assert_eq!(index_seqs(holed.path()), [6]);
    let before = tree_for_refusal(holed.path());
    let text = refused(holed.path()).await;
    println!("{text}");
    for part in ["gives back 1 of the 6 messages", "first missing", "first indexed commit is 6", "restore the whole data directory"] {
        assert!(text.contains(part), "{part}: {text}");
    }
    assert!(tree_for_refusal(holder_path(&holed)) == before, "a refused start changed the directory");
    assert!(!read_model_file(holed.path()).exists(), "the refused start left a read model");
    let check = crate::cli::check::check(holed.path()).await.unwrap();
    assert!(
        check.warnings.iter().any(|w| w.contains("old in-memory format") && w.contains("6 messages")),
        "{:?}",
        check.warnings
    );
}

fn holder_path(dir: &tempfile::TempDir) -> &Path {
    dir.path()
}

/// Five messages, a backup, then the hole and one more message: the directory
/// `incomplete_log_directory` makes, with the backup taken before the hole.
async fn holed_directory_with_backup() -> (tempfile::TempDir, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    five_commits(dir.path()).await;
    let backup = tempfile::tempdir().unwrap();
    copy_tree(dir.path(), backup.path(), &|_| false);
    remove_the_log(dir.path());
    let engine = open(dir.path()).await;
    assert_eq!(send(&engine, "message_created", &message("ch_a", "m6", 7, 6)).await, 6);
    close(engine, dir.path()).await;
    assert_eq!(crate::engine::incomplete_log::load(dir.path()).unwrap(), Some(5));
    (dir, backup)
}

fn copy_without_overwriting(from: &Path, to: &Path) {
    copy_tree(from, &to.join(".staging"), &|_| false);
    let staging = to.join(".staging");
    let mut pending = vec![staging.clone()];
    while let Some(dir) = pending.pop() {
        for entry in std::fs::read_dir(dir).unwrap() {
            let entry = entry.unwrap().path();
            if entry.is_dir() {
                pending.push(entry);
                continue;
            }
            let target = to.join(entry.strip_prefix(&staging).unwrap());
            if !target.exists() {
                std::fs::create_dir_all(target.parent().unwrap()).unwrap();
                std::fs::copy(&entry, &target).unwrap();
            }
        }
    }
    std::fs::remove_dir_all(staging).unwrap();
}

/// The record is not the only evidence: the manifest and every snapshot carry
/// it. Removing the record file, or restoring log files that cannot be put
/// back, does not let a rebuild drop what only the saved projections hold.
#[tokio::test]
async fn removing_the_record_alone_does_not_allow_a_rebuild() {
    let (source, backup) = holed_directory_with_backup().await;
    let lose_the_read_model = |path: &Path| std::fs::remove_file(read_model_file(path)).unwrap();
    let expect_refusal = |label: &'static str, path: std::path::PathBuf| async move {
        let before = tree_for_refusal(&path);
        let text = refused(&path).await;
        assert!(text.contains("incomplete below commit 5"), "{label}: {text}");
        assert!(text.contains("restore the whole data directory"), "{label}: {text}");
        assert!(text.contains("does not work once commits were written"), "{label}: {text}");
        assert!(tree_for_refusal(&path) == before, "{label}: a refused start changed the directory");
        let check = crate::cli::check::check(&path).await.unwrap();
        assert!(
            check.errors.iter().any(|e| e.contains("refuses to start") && e.contains("incomplete below commit 5")),
            "{label}: {:?}",
            check.errors
        );
        let verify = crate::cli::verify::verify(&path).await.unwrap();
        assert!(!verify.ok, "{label}");
    };

    // The record file removed, nothing restored.
    let dir = tempfile::tempdir().unwrap();
    copy_tree(source.path(), dir.path(), &|_| false);
    std::fs::remove_file(crate::engine::incomplete_log::path(dir.path())).unwrap();
    lose_the_read_model(dir.path());
    expect_refusal("record file removed", dir.path().to_path_buf()).await;

    // The backup copied in without overwriting anything: the commit index and
    // the segment keep the names the new commit gave them, so nothing is
    // restored; then the record is removed too.
    let dir = tempfile::tempdir().unwrap();
    copy_tree(source.path(), dir.path(), &|_| false);
    copy_without_overwriting(backup.path(), dir.path());
    assert_eq!(index_seqs(dir.path()), [6], "a copy that does not overwrite restored commits");
    std::fs::remove_file(crate::engine::incomplete_log::path(dir.path())).unwrap();
    lose_the_read_model(dir.path());
    expect_refusal("backup copied without overwriting", dir.path().to_path_buf()).await;

    // The record file and the manifest's copy removed: the snapshot's copy remains.
    let dir = tempfile::tempdir().unwrap();
    copy_tree(source.path(), dir.path(), &|_| false);
    std::fs::remove_file(crate::engine::incomplete_log::path(dir.path())).unwrap();
    edit_json(&dir.path().join("storage-manifest.json"), |manifest| {
        manifest.as_object_mut().unwrap().remove("incomplete_log_below");
    });
    lose_the_read_model(dir.path());
    expect_refusal("record and manifest copy removed", dir.path().to_path_buf()).await;

    // The snapshot removed as well as the record file: the in-memory
    // projections would be rebuilt from inside the hole.
    let dir = tempfile::tempdir().unwrap();
    copy_tree(source.path(), dir.path(), &|_| false);
    std::fs::remove_file(crate::engine::incomplete_log::path(dir.path())).unwrap();
    std::fs::remove_file(ProjectionState::snapshot_path(dir.path())).unwrap();
    let before = tree_for_refusal(dir.path());
    let text = refused(dir.path()).await;
    assert!(text.contains("from inside the hole") || text.contains("incomplete below commit 5"), "{text}");
    assert!(tree_for_refusal(dir.path()) == before);

    // Removing all three copies is a deliberate act, and then the rebuild
    // proceeds and drops what the hole took: one message.
    let dir = tempfile::tempdir().unwrap();
    copy_tree(source.path(), dir.path(), &|_| false);
    std::fs::remove_file(crate::engine::incomplete_log::path(dir.path())).unwrap();
    edit_json(&dir.path().join("storage-manifest.json"), |manifest| {
        manifest.as_object_mut().unwrap().remove("incomplete_log_below");
    });
    edit_json(&ProjectionState::snapshot_path(dir.path()), |snapshot| {
        snapshot.as_object_mut().unwrap().remove("incomplete_log_below");
    });
    lose_the_read_model(dir.path());
    let engine = open(dir.path()).await;
    assert_eq!(crate::projections::messages::stored_message_count(engine.projection_state()), 1);
    close(engine, dir.path()).await;

    // What works: the whole directory from the backup taken before the hole.
    let restored = tempfile::tempdir().unwrap();
    copy_tree(backup.path(), restored.path(), &|_| false);
    assert_eq!(crate::engine::incomplete_log::load(restored.path()).unwrap(), None);
    let check = crate::cli::check::check(restored.path()).await.unwrap();
    assert!(check.ok && check.warnings.is_empty(), "{check:#?}");
    let engine = open(restored.path()).await;
    assert_eq!(crate::projections::messages::stored_message_count(engine.projection_state()), 5);
    close(engine, restored.path()).await;
    lose_the_read_model(restored.path());
    let engine = open(restored.path()).await;
    assert_eq!(crate::projections::messages::stored_message_count(engine.projection_state()), 5);
}

/// The log's head is recorded in the manifest once the directory has a log
/// and nothing is known to be missing; a start that finds the index beginning
/// higher than that records the loss as an incomplete log, so a rebuild is
/// refused afterwards.
#[tokio::test]
async fn a_lost_log_head_is_noticed() {
    let dir = tempfile::tempdir().unwrap();
    let engine = open(dir.path()).await;
    assert!(commit(&engine, vec![message_event("message_edited", &message("ch_a", "ghost", 7, 1))]).await.is_err());
    assert_eq!(send(&engine, "message_created", &message("ch_a", "m1", 7, 1)).await, 2);
    assert_eq!(send(&engine, "message_created", &message("ch_a", "m2", 7, 2)).await, 3);
    close(engine, dir.path()).await;
    assert_eq!(crate::engine::manifest_field(dir.path(), "log_head_commit"), None);

    // The next start records the head: the first indexed commit, 2, not 1.
    let engine = open(dir.path()).await;
    close(engine, dir.path()).await;
    assert_eq!(crate::engine::manifest_field(dir.path(), "log_head_commit"), Some(2));
    assert_eq!(crate::engine::incomplete_log::load(dir.path()).unwrap(), None, "a gap is not a hole");

    // The manifest says the head used to be commit 1.
    edit_json(&dir.path().join("storage-manifest.json"), |manifest| {
        manifest["log_head_commit"] = serde_json::json!(1);
    });
    let engine = open(dir.path()).await;
    assert_eq!(crate::engine::incomplete_log::load(dir.path()).unwrap(), Some(1));
    close(engine, dir.path()).await;
    let check = crate::cli::check::check(dir.path()).await.unwrap();
    assert!(check.warnings.iter().any(|w| w.contains("incomplete below commit 1")), "{:?}", check.warnings);
    std::fs::remove_file(read_model_file(dir.path())).unwrap();
    let text = refused(dir.path()).await;
    assert!(text.contains("incomplete below commit 1"), "{text}");
}

/// No file may name a commit above 2^62, so the sequencer refuses to allocate
/// one: the commit fails cleanly, writes nothing, and the engine halts. A
/// manifest at the limit opens, and the first commit is refused.
#[tokio::test]
async fn commit_numbers_stop_at_the_limit() {
    use crate::projections::read_model::MAX_COMMIT_SEQ;
    let set_height = |path: &Path, height: u64| {
        edit_json(&path.join("storage-manifest.json"), |manifest| {
            manifest["highest_commit_seq"] = serde_json::json!(height);
        });
    };
    let dir = tempfile::tempdir().unwrap();
    five_commits(dir.path()).await;

    // One below the limit: the next commit is the limit itself, then none.
    set_height(dir.path(), MAX_COMMIT_SEQ - 1);
    let engine = open(dir.path()).await;
    assert_eq!(send(&engine, "message_created", &message("ch_a", "last", 7, 6)).await, MAX_COMMIT_SEQ);
    let before = index_seqs(dir.path()).len();
    let refused_commit = commit(&engine, vec![message_event("message_created", &message("ch_a", "over", 7, 7))])
        .await
        .unwrap_err()
        .to_string();
    println!("{refused_commit}");
    assert!(refused_commit.contains("commit number limit reached"), "{refused_commit}");
    assert_eq!(index_seqs(dir.path()).len(), before, "the refused commit was written");
    // The engine halted: nothing else is accepted.
    assert!(commit(&engine, vec![message_event("message_created", &message("ch_a", "again", 7, 8))]).await.is_err());
    close(engine, dir.path()).await;

    // The directory still opens (every number it names is within the limit),
    // and its next commit is refused too.
    let engine = open(dir.path()).await;
    assert!(commit(&engine, vec![message_event("message_created", &message("ch_a", "never", 7, 9))])
        .await
        .unwrap_err()
        .to_string()
        .contains("commit number limit reached"));
    close(engine, dir.path()).await;

    // At the limit already: the first commit is refused.
    let dir = tempfile::tempdir().unwrap();
    five_commits(dir.path()).await;
    set_height(dir.path(), MAX_COMMIT_SEQ);
    let engine = open(dir.path()).await;
    let text = commit(&engine, vec![message_event("message_created", &message("ch_a", "over", 7, 6))])
        .await
        .unwrap_err()
        .to_string();
    assert!(text.contains("commit number limit reached") && text.contains("nothing was written"), "{text}");
}
