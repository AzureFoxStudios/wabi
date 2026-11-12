//! Task 3.5.2: the channels projection lives in the SQLite read model
//! (`projections/read-model.sqlite3`, table `channels`), next to the
//! messages; it is no longer in `projections/snapshot.json`.
//!
//! These tests open a real engine, like `read_model_messages`. They cover
//! what the read model must guarantee for channels: it is derived (delete the
//! file and every channel read is the same), it is rebuilt when another
//! generation wrote it, a commit's channel rows and its `applied_commit_seq`
//! become visible together, a failed startup replay leaves none of its rows,
//! and either store (snapshot or read model) may be the older one.
//!
//! The room placement projection, which stays in memory, reads the channels
//! table while it applies a commit. Several tests below exercise that read
//! through replay, because the two stores can be at different commits.

use super::read_model_messages::{close, commit, config, open, read_model_file};
use crate::domain::Channel;
use crate::engine::locks::ProjectionState;
use crate::engine::WabiDbEngine;
use crate::format::record::RecordKind;
use crate::projections::channels::ChannelProjection;
use crate::projections::query::{ChannelsFilter, QueryableProjection};
use crate::projections::read_model::READ_MODEL_GENERATION;
use crate::projections::{room_placement, test_poison};
use crate::sequencer::types::EventToWrite;
use std::path::Path;

fn event(kind: &str, stream: &str, stream_kind: u8, plaintext: Vec<u8>) -> EventToWrite {
    EventToWrite {
        event_type: kind.into(),
        stream_id: stream.into(),
        plaintext,
        stream_kind,
        record_kind: RecordKind::Event,
    }
}

/// A `channel_created` on the shared stream: the engine assigns `ch_{seq:x}`.
fn created(name: &str) -> EventToWrite {
    let mut channel = Channel::new("", name, 1);
    channel.created_at_micros = 10;
    event("channel_created", "channels", 6, serde_json::to_vec(&channel).unwrap())
}

/// The first placement of the channel created in the same commit.
fn placement() -> EventToWrite {
    let init = room_placement::RoomPlacementInitialization {
        schema_version: 1,
        owner_node_id: "node-1".into(),
        replica_node_ids: vec![],
    };
    event(
        room_placement::INIT_EVENT,
        room_placement::INIT_STREAM,
        6,
        serde_json::to_vec(&init).unwrap(),
    )
}

fn json_event(kind: &str, stream: &str, value: serde_json::Value) -> EventToWrite {
    event(kind, stream, 1, serde_json::to_vec(&value).unwrap())
}

async fn write(engine: &WabiDbEngine, events: Vec<EventToWrite>) -> u64 {
    commit(engine, events).await.unwrap().commit_seq
}

/// A history that uses every channel event and every branch of the handler:
/// creates with an assigned id (two of them with a placement in the same
/// commit), a DM with a caller-assigned id and a numeric kind, partial
/// updates, `update_settings` with a `row` wrapper, an update that must not
/// create a nameless row, one that creates a named row, a delete, a cleared
/// parent, and a commit no channel handler sees. Returns the ids to read and
/// the last commit.
async fn write_channel_history(engine: &WabiDbEngine) -> (Vec<String>, u64) {
    let general = format!("ch_{:x}", write(engine, vec![created("general"), placement()]).await);
    let random = format!("ch_{:x}", write(engine, vec![created("random")]).await);
    let dm = "dm-user-1-user-2";
    write(
        engine,
        vec![json_event(
            "channel_created",
            dm,
            serde_json::json!({"channel_id": dm, "name": "DM", "channel_kind": 2,
                "owner_user_id": 1, "created_at_micros": 20}),
        )],
    )
    .await;
    write(
        engine,
        vec![json_event(
            "channel_updated",
            &format!("channels:{random}"),
            serde_json::json!({"channel_id": random, "name": "random-renamed",
                "description": "about", "position": 7, "parent_id": general,
                "force_spoiler": true}),
        )],
    )
    .await;
    write(
        engine,
        vec![json_event(
            "update_settings",
            &format!("channels:{general}"),
            serde_json::json!({"row": {"channel_id": general, "position": 3}}),
        )],
    )
    .await;
    write(
        engine,
        vec![json_event(
            "channel_updated",
            "channels:ch_ghost",
            serde_json::json!({"channel_id": "ch_ghost", "description": "no name"}),
        )],
    )
    .await;
    write(
        engine,
        vec![json_event(
            "channel_updated",
            "channels:ch_by_update",
            serde_json::json!({"channel_id": "ch_by_update", "name": "made by an update"}),
        )],
    )
    .await;
    let doomed = format!("ch_{:x}", write(engine, vec![created("doomed"), placement()]).await);
    write(
        engine,
        vec![json_event(
            "channel_deleted",
            &format!("channels:{doomed}"),
            serde_json::json!({"channel_id": doomed}),
        )],
    )
    .await;
    write(
        engine,
        vec![json_event(
            "channel_updated",
            &format!("channels:{random}"),
            serde_json::json!({"channel_id": random, "parent_id": null}),
        )],
    )
    .await;
    let last = write(
        engine,
        vec![event(test_poison::EVENT_TYPE, "ch_other", 1, b"not a channel".to_vec())],
    )
    .await;
    let ids = [general.as_str(), random.as_str(), dm, doomed.as_str(), "ch_ghost", "ch_by_update", "absent"]
        .map(str::to_owned)
        .to_vec();
    (ids, last)
}

/// Every channel read the server and the crate make, as text: the list, a
/// limited list, a lookup of each id, and the room placement of each id
/// (written by a projection that checks the channels table while it
/// applies). Two states that print the same text answer every read the same.
fn all_channel_reads(state: &ProjectionState, ids: &[String]) -> String {
    use std::fmt::Write;
    let mut out = String::new();
    for limit in [None, Some(0), Some(2)] {
        let got = ChannelProjection.query(state, &ChannelsFilter { limit, ..Default::default() });
        writeln!(out, "list {limit:?}: {got:?}").unwrap();
    }
    for id in ids {
        let filter = ChannelsFilter { channel_id: Some(id.clone()), ..Default::default() };
        let got = ChannelProjection.query(state, &filter);
        writeln!(out, "get {id}: {got:?}").unwrap();
        let placed = state.get(room_placement::INDEX, id.as_bytes()).map(|bytes| room_placement::decode(&bytes));
        writeln!(out, "placement {id}: {placed:?}").unwrap();
    }
    out
}

/// What the read model file of a stopped engine holds for channels, read
/// with a plain SQLite connection: (channel id and record of every row in
/// key order, `applied_commit_seq` of the channels, stored generation).
fn channel_file(path: &Path) -> (Vec<(String, String)>, u64, i64) {
    let conn = rusqlite::Connection::open(read_model_file(path)).unwrap();
    let rows = conn
        .prepare("SELECT CAST(key AS TEXT), CAST(record AS TEXT) FROM channels ORDER BY key")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .map(|row| row.unwrap())
        .collect();
    let applied: i64 = conn
        .query_row(
            "SELECT coalesce((SELECT seq FROM applied_commit_seq WHERE projection = 'channels'), 0)",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let generation = conn.query_row("SELECT generation FROM read_model_meta", [], |row| row.get(0)).unwrap();
    (rows, applied as u64, generation)
}

fn snapshot_has_channels_index(path: &Path) -> bool {
    std::fs::read_to_string(ProjectionState::snapshot_path(path))
        .unwrap()
        .contains("\"channels\"")
}

/// The rebuild test: the read model is derived. Delete the SQLite file of a
/// stopped engine, reopen, and every channel read returns what it returned
/// before. The snapshot holds no channel, so only the log can bring them back.
#[tokio::test]
async fn deleting_the_read_model_file_changes_no_channel_read() {
    let dir = tempfile::tempdir().unwrap();
    let engine = open(dir.path()).await;
    let (ids, last) = write_channel_history(&engine).await;
    let live = all_channel_reads(engine.projection_state(), &ids);
    // The history is not trivial.
    for expected in ["random-renamed", "made by an update", "channel_kind: Dm", "epoch: 1", "position: 3"] {
        assert!(live.contains(expected), "{expected} missing from\n{live}");
    }
    assert!(!live.contains("name: \"doomed\""), "{live}");
    close(engine, dir.path()).await;

    let kept = channel_file(dir.path());
    assert_eq!(kept.0.len(), 4, "general, random, the DM and the row an update made: {kept:?}");
    assert_eq!(kept.1, last);
    assert!(!snapshot_has_channels_index(dir.path()), "channels are not in the snapshot");

    // A plain restart, from the file as it is.
    let engine = open(dir.path()).await;
    assert_eq!(all_channel_reads(engine.projection_state(), &ids), live);
    close(engine, dir.path()).await;

    // With the SQLite file deleted.
    std::fs::remove_file(read_model_file(dir.path())).unwrap();
    let engine = open(dir.path()).await;
    assert_eq!(engine.projection_state().applied_commit_seq(), last);
    assert_eq!(all_channel_reads(engine.projection_state(), &ids), live);
    close(engine, dir.path()).await;
    assert_eq!(channel_file(dir.path()), kept, "the rebuilt file holds the same rows");

    // With every saved projection deleted.
    ProjectionState::remove_saved_projections_for_tests(dir.path());
    let engine = open(dir.path()).await;
    assert_eq!(all_channel_reads(engine.projection_state(), &ids), live);
    close(engine, dir.path()).await;
    assert_eq!(channel_file(dir.path()), kept);
}

/// Rebuild on generation mismatch: a file written by generation N is opened
/// by a build of generation N+1 (the stored number is changed to one this
/// build is not). The engine rebuilds it from the log: a channel row planted
/// in the old file, which no event produces, is gone; reads are unchanged.
#[tokio::test]
async fn a_read_model_of_another_generation_is_rebuilt_and_channel_reads_are_unchanged() {
    let dir = tempfile::tempdir().unwrap();
    let engine = open(dir.path()).await;
    let (ids, last) = write_channel_history(&engine).await;
    let live = all_channel_reads(engine.projection_state(), &ids);
    close(engine, dir.path()).await;
    let kept = channel_file(dir.path());
    assert_eq!(kept.2, READ_MODEL_GENERATION);

    {
        let conn = rusqlite::Connection::open(read_model_file(dir.path())).unwrap();
        conn.execute("UPDATE read_model_meta SET generation = ?1", [READ_MODEL_GENERATION - 1])
            .unwrap();
        let planted = serde_json::to_vec(&Channel::new("ch_planted", "planted", 1)).unwrap();
        conn.execute(
            "INSERT INTO channels (key, record) VALUES (CAST('ch_planted' AS BLOB), ?1)",
            [planted],
        )
        .unwrap();
    }
    let mut with_planted = ids.clone();
    with_planted.push("ch_planted".into());
    let stale = channel_file(dir.path());
    assert_eq!((stale.0.len(), stale.2), (kept.0.len() + 1, READ_MODEL_GENERATION - 1));

    let engine = open(dir.path()).await;
    assert_eq!(engine.projection_state().applied_commit_seq(), last);
    let reads = all_channel_reads(engine.projection_state(), &with_planted);
    assert!(!reads.contains("planted\""), "the planted row survived: a rebuild did not happen");
    assert_eq!(all_channel_reads(engine.projection_state(), &ids), live);
    close(engine, dir.path()).await;
    assert_eq!(channel_file(dir.path()), kept, "rebuilt from the log under this build's generation");
}

/// A commit's channel rows and its `applied_commit_seq` become visible
/// together: until the commit is finished, another connection to the file
/// sees neither; afterwards it sees both, in one read transaction.
#[test]
fn a_commits_channel_rows_and_its_applied_commit_seq_become_visible_together() {
    use crate::projections::handler::{DurableEvent, Projection};
    use crate::projections::read_model::ReadModel;
    let dir = tempfile::tempdir().unwrap();
    let model = std::sync::Arc::new(ReadModel::open(dir.path()).unwrap());
    let state = ProjectionState::new();
    state.attach_read_model(model.clone());
    let seen = || {
        let conn = rusqlite::Connection::open_with_flags(
            read_model_file(dir.path()),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        conn.execute_batch("BEGIN").unwrap();
        let rows: i64 = conn.query_row("SELECT count(*) FROM channels", [], |row| row.get(0)).unwrap();
        let applied: i64 = conn
            .query_row(
                "SELECT coalesce((SELECT seq FROM applied_commit_seq WHERE projection = 'channels'), 0)",
                [],
                |row| row.get(0),
            )
            .unwrap();
        (rows, applied)
    };
    let channel = Channel::new("", "general", 1);
    ChannelProjection
        .apply(
            &DurableEvent {
                commit_seq: 1,
                stream_id: "channels".into(),
                event_type: "channel_created".into(),
                payload: serde_json::to_vec(&channel).unwrap(),
            },
            &state,
        )
        .unwrap();
    assert_eq!(seen(), (0, 0), "rows of an unfinished commit are visible");
    assert!(
        ChannelProjection.query(&state, &ChannelsFilter::default()).unwrap().is_empty(),
        "a read sees an unfinished commit"
    );
    model.finish_commit(1).unwrap();
    assert_eq!(seen(), (1, 1));
    assert_eq!(ChannelProjection.query(&state, &ChannelsFilter::default()).unwrap().len(), 1);
}

/// Startup replay applies events while it validates the log; everything it
/// writes is one transaction. When replay fails after applying some channel
/// events, the file holds none of them.
#[tokio::test]
async fn a_failed_startup_replay_leaves_none_of_its_channels_in_the_file() {
    let dir = tempfile::tempdir().unwrap();
    let engine = open(dir.path()).await;
    write(&engine, vec![created("one"), placement()]).await;
    write(&engine, vec![created("two")]).await;
    assert!(commit(&engine, vec![event(test_poison::EVENT_TYPE, "ch_p", 1, test_poison::FAIL.to_vec())])
        .await
        .is_err());
    close(engine, dir.path()).await;

    crate::projections::read_model::ReadModel::remove_files(dir.path()).unwrap();
    let error = super::reopen_after_drop(config(dir.path()), None).await.unwrap_err();
    assert!(error.to_string().contains("commit 3"), "{error}");
    drop(super::wait_for_stopped_engine(dir.path()).await);
    let (rows, applied, _) = channel_file(dir.path());
    assert_eq!((rows.len(), applied), (0, 0), "{rows:?}");
}

/// The snapshot is older than the read model (the normal state after a
/// crash: the read model commits every commit, the snapshot every 1,000). A
/// channel created with its placement and deleted later lies between the two.
/// Replay gives that commit to the in-memory room placement again, while the
/// channels table already holds the later state, in which the channel is
/// gone. The engine must still open, with the same reads.
#[tokio::test]
async fn a_read_model_ahead_of_the_snapshot_replays_placements_of_deleted_channels() {
    let dir = tempfile::tempdir().unwrap();
    let engine = open(dir.path()).await;
    write(&engine, vec![event(test_poison::EVENT_TYPE, "ch_other", 1, b"early".to_vec())]).await;
    close(engine, dir.path()).await;
    let old_snapshot = std::fs::read(ProjectionState::snapshot_path(dir.path())).unwrap();

    let engine = open(dir.path()).await;
    let (ids, last) = write_channel_history(&engine).await;
    let live = all_channel_reads(engine.projection_state(), &ids);
    close(engine, dir.path()).await;
    let kept = channel_file(dir.path());

    std::fs::write(ProjectionState::snapshot_path(dir.path()), old_snapshot).unwrap();
    let engine = open(dir.path()).await;
    assert_eq!(engine.projection_state().applied_commit_seq(), last);
    assert_eq!(all_channel_reads(engine.projection_state(), &ids), live);
    close(engine, dir.path()).await;
    assert_eq!(channel_file(dir.path()), kept, "kept, not rebuilt");
}

/// The other order: the read model is older than the snapshot. It is rebuilt
/// from the whole log; the room placements load from the snapshot.
#[tokio::test]
async fn a_read_model_behind_the_snapshot_is_rebuilt_with_the_same_channel_reads() {
    let dir = tempfile::tempdir().unwrap();
    let engine = open(dir.path()).await;
    write(&engine, vec![created("early")]).await;
    close(engine, dir.path()).await;
    let old_file = std::fs::read(read_model_file(dir.path())).unwrap();

    let engine = open(dir.path()).await;
    let (mut ids, last) = write_channel_history(&engine).await;
    ids.push("ch_1".into());
    let live = all_channel_reads(engine.projection_state(), &ids);
    close(engine, dir.path()).await;
    let kept = channel_file(dir.path());

    std::fs::write(read_model_file(dir.path()), old_file).unwrap();
    assert_eq!(channel_file(dir.path()).1, 1);
    let engine = open(dir.path()).await;
    assert_eq!(engine.projection_state().applied_commit_seq(), last);
    assert_eq!(all_channel_reads(engine.projection_state(), &ids), live);
    close(engine, dir.path()).await;
    assert_eq!(channel_file(dir.path()), kept);
}

/// The channels handler's own replay floor. With the read model ahead of the
/// snapshot, replay hands the commits between the two to every handler; the
/// channels handler must skip those the table already holds. Here commit A
/// updates a channel that has no row (the ghost-row guard drops it) and
/// commit B creates the row by naming it. Re-applying A onto B's row at the
/// next start would give the channel A's description, which it never had.
#[tokio::test]
async fn replay_does_not_reapply_channel_events_the_read_model_already_holds() {
    let dir = tempfile::tempdir().unwrap();
    let engine = open(dir.path()).await;
    write(&engine, vec![event(test_poison::EVENT_TYPE, "ch_other", 1, b"early".to_vec())]).await;
    close(engine, dir.path()).await;
    let old_snapshot = std::fs::read(ProjectionState::snapshot_path(dir.path())).unwrap();

    let engine = open(dir.path()).await;
    for value in [
        serde_json::json!({"channel_id": "ch_q", "description": "dropped by the guard"}),
        serde_json::json!({"channel_id": "ch_q", "name": "named later"}),
    ] {
        write(&engine, vec![json_event("channel_updated", "channels:ch_q", value)]).await;
    }
    let get = |state: &ProjectionState| {
        ChannelProjection
            .query(state, &ChannelsFilter { channel_id: Some("ch_q".into()), ..Default::default() })
            .unwrap()
    };
    let live = get(engine.projection_state());
    assert_eq!(live.len(), 1);
    assert_eq!(live[0].description, None);
    close(engine, dir.path()).await;

    std::fs::write(ProjectionState::snapshot_path(dir.path()), &old_snapshot).unwrap();
    let engine = open(dir.path()).await;
    assert_eq!(get(engine.projection_state()), live);
    close(engine, dir.path()).await;
}
