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
    ProjectionState::remove_snapshot(dir.path());
    assert!(!read_model_file(dir.path()).exists());
    let engine = open(dir.path()).await;
    assert_eq!(all_reads(&engine.projection_state()), live);
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

/// A derived store cannot be ahead of its source: a read model that claims a
/// commit the log does not have is rebuilt.
#[tokio::test]
async fn a_read_model_ahead_of_the_log_is_rebuilt() {
    let dir = tempfile::tempdir().unwrap();
    let engine = open(dir.path()).await;
    let last = write_history(&engine).await;
    let live = all_reads(&engine.projection_state());
    close(engine, dir.path()).await;
    let kept = file_contents(dir.path());

    {
        let conn = rusqlite::Connection::open(read_model_file(dir.path())).unwrap();
        conn.execute("UPDATE applied_commit_seq SET seq = ?1", [last as i64 + 100]).unwrap();
        conn.execute(
            "INSERT INTO messages (key, channel_id, message_id, author_user_id, record) \
             VALUES (x'00', 'ch_a', 'from-a-commit-the-log-lacks', 7, x'00')",
            [],
        )
        .unwrap();
    }
    let engine = open(dir.path()).await;
    assert_eq!(engine.projection_state().applied_commit_seq(), last);
    assert_eq!(all_reads(&engine.projection_state()), live);
    close(engine, dir.path()).await;
    assert_eq!(file_contents(dir.path()), kept);
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
