//! SPIKE (throwaway, Task 0.1): the messages read model on SQLite must give
//! the same answers as the in-memory skip-map read model, live and after every
//! restart path, while the rows actually live in SQLite and not in RAM.

use super::*;
use crate::{
    format::record::RecordKind,
    projections::{
        message_lookup,
        messages::{encode_record, ChannelMessagesCleared, MessagePageCursor, MessageRecord, MessagesProjection},
    },
    sequencer::types::{CommandCommit, EventToWrite},
};

/// Data-directory opt-in for the spike backend, and where its file lives.
const OPT_IN_MARKER: &str = "spike-messages-sqlite";
const SQLITE_FILE: &str = "projections/messages.sqlite3";

fn config(path: &std::path::Path) -> WabiDbConfig {
    let mut config = WabiDbConfig::new(path.into(), BootstrapSource::Provided([0x5A; 32]));
    config.allow_init = true;
    config
}

/// Ids are deliberately not ordered like time (multiplying by an odd constant
/// is a bijection on u64), and pairs of messages share a timestamp.
fn message(channel: &str, n: u64) -> MessageRecord {
    MessageRecord {
        message_id: format!("msg_{:032x}", n.wrapping_mul(0x9E37_79B9_7F4A_7C15)),
        channel_id: channel.into(),
        author_user_id: 1 + n % 4,
        author_device_id: String::new(),
        created_at_micros: 1_000_000 + (n / 2) as i64,
        encrypted_body_ref: format!("body {n}"),
        idempotency_key: Some(format!("idem {n}")),
        edit_history: vec![],
        edited_at_micros: None,
        is_deleted: false,
        is_spoiler: n % 11 == 0,
        files: vec![],
    }
}

async fn commit(engine: &WabiDbEngine, events: Vec<(&str, &str, Vec<u8>)>) -> u64 {
    let (response_tx, _response_rx) = tokio::sync::oneshot::channel();
    let events = events
        .into_iter()
        .map(|(kind, stream, plaintext)| EventToWrite {
            event_type: kind.into(),
            stream_id: stream.into(),
            plaintext,
            stream_kind: 1,
            record_kind: RecordKind::Event,
        })
        .collect();
    engine
        .run_command(CommandCommit {
            caller_user_id: 1,
            caller_device_id: "spike".into(),
            command_name: "spike_messages".into(),
            idempotency_key: None,
            room_owner_precondition: None,
            events,
            essential: true,
            response_tx,
        })
        .await
        .unwrap()
        .commit_seq
}

/// Write the same history into an engine: plain sends, a two-room command
/// (two message events in one commit), an edit, a delete and a room clear.
async fn write_history(engine: &WabiDbEngine) -> u64 {
    for room in ["ch_a", "ch_b", "ch_c"] {
        engine.get_or_create_stream_key(room).await.unwrap();
    }
    for n in 0..130 {
        let room = if n % 3 == 0 { "ch_b" } else { "ch_a" };
        commit(engine, vec![("message_created", room, encode_record(&message(room, n)))]).await;
    }
    commit(
        engine,
        vec![
            ("message_created", "ch_a", encode_record(&message("ch_a", 500))),
            ("message_created", "ch_b", encode_record(&message("ch_b", 501))),
        ],
    )
    .await;
    let mut edited = message("ch_a", 10);
    edited.encrypted_body_ref = "edited body".into();
    edited.edit_history = vec![(1, "body 10".into())];
    edited.edited_at_micros = Some(9_000_000);
    commit(engine, vec![("message_edited", "ch_a", encode_record(&edited))]).await;
    let mut deleted = message("ch_a", 20);
    deleted.is_deleted = true;
    commit(engine, vec![("message_deleted", "ch_a", encode_record(&deleted))]).await;
    for n in 600..605 {
        commit(engine, vec![("message_created", "ch_c", encode_record(&message("ch_c", n)))]).await;
    }
    let clear = ChannelMessagesCleared { channel_id: "ch_c".into(), cleared_at_micros: 7 };
    commit(
        engine,
        vec![("channel_messages_cleared", "ch_c", serde_json::to_vec(&clear).unwrap())],
    )
    .await
}

/// Every read the server makes against the messages read model.
fn observe(state: &ProjectionState) -> Vec<String> {
    let ids = |records: &[MessageRecord]| -> String {
        records
            .iter()
            .map(|r| format!("{}:{}:{}:{}", r.message_id, r.created_at_micros, r.is_deleted, r.encrypted_body_ref))
            .collect::<Vec<_>>()
            .join(",")
    };
    let mut seen = Vec::new();
    for room in ["ch_a", "ch_b", "ch_c", "ch_missing"] {
        let latest = MessagesProjection::list_messages_page(state, room, MessagePageCursor::Latest, 50).unwrap();
        seen.push(format!("{room} latest {} {}", latest.has_more, ids(&latest.messages)));
        if let Some(first) = latest.messages.first() {
            let before = MessagesProjection::list_messages_page(state, room, MessagePageCursor::Before(&first.message_id), 50).unwrap();
            seen.push(format!("{room} before {} {}", before.has_more, ids(&before.messages)));
            if let Some(oldest) = before.messages.first() {
                let after = MessagesProjection::list_messages_page(state, room, MessagePageCursor::After(&oldest.message_id), 50).unwrap();
                seen.push(format!("{room} after {} {}", after.has_more, ids(&after.messages)));
            }
        }
        seen.push(format!("{room} tail {}", ids(&MessagesProjection::list_messages_tail(state, room, 20, false).unwrap())));
        seen.push(format!("{room} tail+deleted {}", ids(&MessagesProjection::list_messages_tail(state, room, 20, true).unwrap())));
        seen.push(format!("{room} range {}", ids(&MessagesProjection::list_messages_in_time_range(state, room, 1_000_010, 1_000_030, 7).unwrap())));
        let mut all = MessagesProjection::list_messages(state, room, true).unwrap();
        all.sort_by(|l, r| l.message_id.cmp(&r.message_id));
        seen.push(format!("{room} all {}", ids(&all)));
    }
    for n in [0, 10, 20, 129, 500, 501, 602, 9_999] {
        let id = message("ch_a", n).message_id;
        let found = message_lookup::get(state, &id).unwrap();
        seen.push(format!("lookup {n} {:?}", found.map(|r| (r.channel_id, r.encrypted_body_ref, r.is_deleted))));
        let direct = MessagesProjection::get_message(state, "ch_a", &id).unwrap();
        seen.push(format!("get ch_a {n} {:?}", direct.map(|r| r.encrypted_body_ref)));
    }
    seen
}

/// Live, after a normal restart (projection snapshot present), and after a
/// restart with no projection snapshot (replay of the whole log).
async fn run(dir: &std::path::Path, sqlite: bool) -> (u64, Vec<Vec<String>>) {
    if sqlite {
        std::fs::write(dir.join(OPT_IN_MARKER), b"sqlite\n").unwrap();
    }
    let engine = WabiDbEngine::open(config(dir)).await.unwrap();
    let last = write_history(&engine).await;
    let mut views = vec![observe(engine.projection_state())];
    drop(engine);
    drop(crate::tests::wait_for_stopped_engine(dir).await);
    let engine = crate::tests::reopen_after_drop(config(dir), None).await.unwrap();
    views.push(observe(engine.projection_state()));
    drop(engine);
    let stopped = crate::tests::wait_for_stopped_engine(dir).await;
    ProjectionState::remove_snapshot(dir);
    drop(stopped);
    let engine = crate::tests::reopen_after_drop(config(dir), None).await.unwrap();
    assert_eq!(engine.projection_state().applied_commit_seq(), last);
    views.push(observe(engine.projection_state()));
    (last, views)
}

#[tokio::test]
async fn sqlite_messages_read_model_matches_memory_and_survives_restart_and_rebuild() {
    let memory_dir = tempfile::tempdir().unwrap();
    let (memory_last, memory_views) = run(memory_dir.path(), false).await;
    assert!(!memory_dir.path().join(SQLITE_FILE).exists());

    let sqlite_dir = tempfile::tempdir().unwrap();
    let (sqlite_last, sqlite_views) = run(sqlite_dir.path(), true).await;
    assert_eq!(sqlite_last, memory_last);

    // The read model lives in SQLite, not in the in-memory skip maps.
    let path = sqlite_dir.path().join(SQLITE_FILE);
    assert!(path.exists(), "spike must keep the messages read model in {SQLITE_FILE}");
    let engine = crate::tests::reopen_after_drop(config(sqlite_dir.path()), None).await.unwrap();
    for index in ["messages", "messages_by_channel", "messages_by_author", "messages_by_channel_time", message_lookup::INDEX] {
        assert_eq!(engine.projection_state().index_len(index), 0, "{index} must not be held in RAM");
    }
    drop(engine);
    drop(crate::tests::wait_for_stopped_engine(sqlite_dir.path()).await);
    {
        let db = rusqlite::Connection::open(&path).unwrap();
        let applied: i64 = db
            .query_row("SELECT seq FROM applied_commit_seq", [], |row| row.get(0))
            .unwrap();
        assert_eq!(applied as u64, sqlite_last);
        let rows: i64 = db.query_row("SELECT count(*) FROM messages", [], |row| row.get(0)).unwrap();
        assert_eq!(rows, 130 + 2 + 5);
    }

    // The SQLite file is derived: deleting it rebuilds the same answers.
    std::fs::remove_file(&path).unwrap();
    let _ = std::fs::remove_file(path.with_extension("sqlite3-wal"));
    let _ = std::fs::remove_file(path.with_extension("sqlite3-shm"));
    let engine = crate::tests::reopen_after_drop(config(sqlite_dir.path()), None).await.unwrap();
    let rebuilt = observe(engine.projection_state());

    for (step, (memory, sqlite)) in memory_views.iter().zip(&sqlite_views).enumerate() {
        assert_eq!(memory, sqlite, "view {step} differs between memory and SQLite");
    }
    assert_eq!(memory_views[0], rebuilt, "rebuilt SQLite read model differs");
}
