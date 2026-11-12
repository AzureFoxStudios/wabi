//! Task 3.5.3: the channel_members projection lives in the SQLite read model
//! (`projections/read-model.sqlite3`, tables `channel_members` and
//! `channel_membership_versions`), next to the messages and the channels; it
//! is no longer in `projections/snapshot.json`.
//!
//! These tests open a real engine, like `read_model_channels`. They cover what
//! the read model must guarantee for memberships: it is derived (delete the
//! file and every membership read is the same), it is rebuilt when another
//! generation wrote it, a commit's member rows and its `applied_commit_seq`
//! become visible together, a failed startup replay leaves none of its rows,
//! and either store (snapshot or read model) may be the older one.
//!
//! The user deletion projection, which stays in memory, removes a deleted
//! user's memberships from these tables while it applies `user_deleted`.
//! Several tests below exercise that write through replay, because the two
//! stores can be at different commits.

use super::read_model_messages::{close, commit, config, open, read_model_file};
use crate::domain::UserDeleted;
use crate::engine::locks::ProjectionState;
use crate::engine::WabiDbEngine;
use crate::format::record::RecordKind;
use crate::projections::channel_members::{
    encode_key, encode_record, ChannelMemberRecord, ChannelMembersChanged, ChannelMembersProjection,
};
use crate::projections::channels::ChannelProjection;
use crate::projections::query::{ChannelsFilter, QueryableProjection};
use crate::projections::read_model::READ_MODEL_GENERATION;
use crate::projections::{test_poison, user_deletion};
use crate::sequencer::types::EventToWrite;
use std::path::Path;

const CHANNELS: [&str; 5] = ["group-a", "group-b", "group-g", "group-c", "group-absent"];
const USERS: [u64; 5] = [1, 2, 3, 9, 404];

fn event(kind: &str, stream: &str, plaintext: Vec<u8>) -> EventToWrite {
    EventToWrite {
        event_type: kind.into(),
        stream_id: stream.into(),
        plaintext,
        stream_kind: 1,
        record_kind: RecordKind::Event,
    }
}

fn member(channel: &str, user_id: u64, role: u8, joined_at_micros: i64) -> ChannelMemberRecord {
    ChannelMemberRecord {
        channel_id: channel.into(),
        user_id,
        joined_at_micros,
        role,
        nick: (role == 3).then(|| format!("owner of {channel}")),
    }
}

fn added(record: ChannelMemberRecord) -> EventToWrite {
    let stream = format!("channel_members:{}", record.channel_id);
    event("channel_member_added", &stream, encode_record(&record))
}

fn removed(channel: &str, user_id: u64) -> EventToWrite {
    // What `WdbAdapter::remove_channel_member` writes.
    event(
        "channel_member_removed",
        &format!("channel_members:{channel}"),
        encode_record(&member(channel, user_id, 0, 0)),
    )
}

fn changed(channel: &str, upserts: Vec<ChannelMemberRecord>, removals: Vec<u64>) -> EventToWrite {
    let change = ChannelMembersChanged { channel_id: channel.into(), upserts, removals };
    event(
        "channel_members_changed",
        &format!("channel_members:{channel}"),
        serde_json::to_vec(&change).unwrap(),
    )
}

fn user_deleted(user_id: u64) -> EventToWrite {
    let mut deleted = event("user_deleted", "users", user_deletion::encode_payload(&UserDeleted { user_id }));
    deleted.stream_kind = 6;
    deleted
}

/// A group channel with a caller-assigned id (created on its own stream).
fn group(id: &str) -> EventToWrite {
    let value = serde_json::json!({"channel_id": id, "name": format!("name of {id}"),
        "channel_kind": 2, "owner_user_id": 1, "created_at_micros": 5});
    event("channel_created", id, serde_json::to_vec(&value).unwrap())
}

fn unrelated() -> EventToWrite {
    event(test_poison::EVENT_TYPE, "ch_other", b"not a membership".to_vec())
}

async fn write(engine: &WabiDbEngine, events: Vec<EventToWrite>) -> u64 {
    commit(engine, events).await.unwrap().commit_seq
}

/// A history that uses every membership event and every branch of the
/// handler, and the `user_deleted` cascade: adds, a role change by a second
/// add, a removal of a member who is not there, a removal and a rejoin,
/// batch upserts and removals, a deleted user (in two channels) who is added
/// again afterwards, and a commit no membership handler sees. Returns the
/// last commit.
async fn write_member_history(engine: &WabiDbEngine) -> u64 {
    for id in ["group-a", "group-b", "group-g", "group-c"] {
        write(engine, vec![group(id)]).await;
    }
    write(engine, vec![added(member("group-a", 1, 3, 10))]).await;
    write(engine, vec![added(member("group-a", 2, 0, 11))]).await;
    write(engine, vec![added(member("group-b", 1, 0, 12))]).await;
    write(engine, vec![removed("group-a", 9)]).await;
    write(engine, vec![added(member("group-a", 2, 2, 13))]).await;
    write(
        engine,
        vec![changed("group-g", vec![member("group-g", 1, 3, 14), member("group-g", 2, 0, 14), member("group-g", 3, 0, 14)], vec![])],
    )
    .await;
    write(engine, vec![changed("group-g", vec![member("group-g", 3, 1, 15)], vec![2])]).await;
    write(engine, vec![removed("group-b", 1)]).await;
    write(engine, vec![added(member("group-b", 1, 0, 999))]).await;
    write(engine, vec![added(member("group-c", 3, 0, 16))]).await;
    write(engine, vec![user_deleted(3)]).await;
    write(engine, vec![added(member("group-c", 3, 0, 777))]).await;
    write(engine, vec![unrelated()]).await
}

/// Every membership read the server and the crate make, as text: the member
/// list and revision of each channel, a lookup of each pair, and the
/// channels each user belongs to joined with the channel rows (what
/// `list_channels` for a member returns). Two states that print the same
/// text answer every read the same.
fn all_member_reads(state: &ProjectionState) -> String {
    use std::fmt::Write;
    let mut out = String::new();
    for channel in CHANNELS {
        let members = ChannelMembersProjection::list_members(state, channel);
        writeln!(out, "list {channel}: {members:?}").unwrap();
        let revision = ChannelMembersProjection::revision(state, channel);
        writeln!(out, "revision {channel}: {revision:?}").unwrap();
        for user in USERS {
            let got = ChannelMembersProjection::get_member(state, channel, user);
            writeln!(out, "get {channel} {user}: {got:?}").unwrap();
        }
    }
    let channels = ChannelProjection.query(state, &ChannelsFilter::default()).unwrap();
    for user in USERS {
        let joined: Vec<_> = channels
            .iter()
            .filter(|channel| {
                ChannelMembersProjection::get_member(state, &channel.channel_id, user)
                    .unwrap()
                    .is_some()
            })
            .map(|channel| (&channel.channel_id, &channel.name))
            .collect();
        writeln!(out, "channels of {user}: {joined:?}").unwrap();
    }
    out
}

/// What the read model file of a stopped engine holds for memberships, read
/// with a plain SQLite connection: (key and record of every member row in key
/// order, as hex; every revision row; `applied_commit_seq` of the
/// memberships; stored generation).
type MemberFile = (Vec<(String, String)>, Vec<(String, String)>, u64, i64);

fn member_file(path: &Path) -> MemberFile {
    let conn = rusqlite::Connection::open(read_model_file(path)).unwrap();
    let rows = |sql: &str| -> Vec<(String, String)> {
        conn.prepare(sql)
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .map(|row| row.unwrap())
            .collect()
    };
    let members = rows("SELECT hex(key), hex(record) FROM channel_members ORDER BY key");
    let versions = rows("SELECT CAST(key AS TEXT), hex(record) FROM channel_membership_versions ORDER BY key");
    let applied: i64 = conn
        .query_row(
            "SELECT coalesce((SELECT seq FROM applied_commit_seq WHERE projection = 'channel_members'), 0)",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let generation = conn.query_row("SELECT generation FROM read_model_meta", [], |row| row.get(0)).unwrap();
    (members, versions, applied as u64, generation)
}

fn snapshot_has_member_indexes(path: &Path) -> bool {
    let snapshot = std::fs::read_to_string(ProjectionState::snapshot_path(path)).unwrap();
    snapshot.contains("\"channel_members\"") || snapshot.contains("\"channel_membership_versions\"")
}

/// The rebuild test: the read model is derived. Delete the SQLite file of a
/// stopped engine, reopen, and every membership read returns what it returned
/// before. The snapshot holds no membership, so only the log can bring them
/// back; the `user_deleted` cascade, which the snapshot covers, must be
/// replayed into the rebuilt tables too.
#[tokio::test]
async fn deleting_the_read_model_file_changes_no_member_read() {
    let dir = tempfile::tempdir().unwrap();
    let engine = open(dir.path()).await;
    let last = write_member_history(&engine).await;
    let live = all_member_reads(engine.projection_state());
    // The history is not trivial.
    for expected in [
        "get group-a 2: Ok(Some(ChannelMemberRecord { channel_id: \"group-a\", user_id: 2, joined_at_micros: 13, role: 2",
        "get group-b 1: Ok(Some(ChannelMemberRecord { channel_id: \"group-b\", user_id: 1, joined_at_micros: 999",
        "get group-g 3: Ok(None)",
        "get group-g 2: Ok(None)",
        "get group-c 3: Ok(Some(ChannelMemberRecord { channel_id: \"group-c\", user_id: 3, joined_at_micros: 777",
        "revision group-a: Ok(9)",
        // The user_deleted cascade (commit 15) removed user 3 from group-g:
        // its revision is the deletion's commit, live and after each rebuild
        // below. group-c's is the rejoin after it.
        "revision group-g: Ok(15)",
        "revision group-c: Ok(16)",
        "revision group-absent: Ok(0)",
        "channels of 1: [(\"group-a\", \"name of group-a\"), (\"group-b\", \"name of group-b\"), (\"group-g\", \"name of group-g\")]",
    ] {
        assert!(live.contains(expected), "{expected} missing from\n{live}");
    }
    close(engine, dir.path()).await;

    let kept = member_file(dir.path());
    assert_eq!(kept.0.len(), 5, "group-a 1 and 2, group-b 1, group-g 1, group-c 3: {kept:?}");
    assert_eq!(kept.1.len(), 4, "a revision for each group: {kept:?}");
    assert_eq!(kept.2, last);
    assert!(!snapshot_has_member_indexes(dir.path()), "memberships are not in the snapshot");

    // A plain restart, from the file as it is.
    let engine = open(dir.path()).await;
    assert_eq!(all_member_reads(engine.projection_state()), live);
    close(engine, dir.path()).await;

    // With the SQLite file deleted.
    std::fs::remove_file(read_model_file(dir.path())).unwrap();
    let engine = open(dir.path()).await;
    assert_eq!(engine.projection_state().applied_commit_seq(), last);
    assert_eq!(all_member_reads(engine.projection_state()), live);
    close(engine, dir.path()).await;
    assert_eq!(member_file(dir.path()), kept, "the rebuilt file holds the same rows");

    // With every saved projection deleted.
    ProjectionState::remove_saved_projections_for_tests(dir.path());
    let engine = open(dir.path()).await;
    assert_eq!(all_member_reads(engine.projection_state()), live);
    close(engine, dir.path()).await;
    assert_eq!(member_file(dir.path()), kept);
}

/// Rebuild on generation mismatch: a file written by generation N is opened
/// by a build of generation N+1 (the stored number is changed to one this
/// build is not). The engine rebuilds it from the log: a member row planted
/// in the old file, which no event produces, is gone; reads are unchanged.
#[tokio::test]
async fn a_read_model_of_another_generation_is_rebuilt_and_member_reads_are_unchanged() {
    let dir = tempfile::tempdir().unwrap();
    let engine = open(dir.path()).await;
    let last = write_member_history(&engine).await;
    let live = all_member_reads(engine.projection_state());
    close(engine, dir.path()).await;
    let kept = member_file(dir.path());
    assert_eq!(kept.3, READ_MODEL_GENERATION);

    {
        let conn = rusqlite::Connection::open(read_model_file(dir.path())).unwrap();
        conn.execute("UPDATE read_model_meta SET generation = ?1", [READ_MODEL_GENERATION - 1])
            .unwrap();
        conn.execute(
            "INSERT INTO channel_members (key, user_id, record) VALUES (?1, 404, ?2)",
            [encode_key("group-absent", 404), encode_record(&member("group-absent", 404, 3, 1))],
        )
        .unwrap();
    }
    let stale = member_file(dir.path());
    assert_eq!((stale.0.len(), stale.3), (kept.0.len() + 1, READ_MODEL_GENERATION - 1));

    let engine = open(dir.path()).await;
    assert_eq!(engine.projection_state().applied_commit_seq(), last);
    assert_eq!(all_member_reads(engine.projection_state()), live, "the planted row survived");
    close(engine, dir.path()).await;
    assert_eq!(member_file(dir.path()), kept, "rebuilt from the log under this build's generation");
}

/// A commit's member rows and its `applied_commit_seq` become visible
/// together: until the commit is finished, another connection to the file
/// sees neither; afterwards it sees both, in one read transaction.
#[test]
fn a_commits_member_rows_and_its_applied_commit_seq_become_visible_together() {
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
        let count = |table: &str| -> i64 {
            conn.query_row(&format!("SELECT count(*) FROM {table}"), [], |row| row.get(0)).unwrap()
        };
        let applied: i64 = conn
            .query_row(
                "SELECT coalesce((SELECT seq FROM applied_commit_seq WHERE projection = 'channel_members'), 0)",
                [],
                |row| row.get(0),
            )
            .unwrap();
        (count("channel_members"), count("channel_membership_versions"), applied)
    };
    let change = ChannelMembersChanged {
        channel_id: "group-a".into(),
        upserts: vec![member("group-a", 1, 3, 1), member("group-a", 2, 0, 1)],
        removals: vec![],
    };
    ChannelMembersProjection
        .apply(
            &DurableEvent {
                commit_seq: 1,
                stream_id: "channel_members:group-a".into(),
                event_type: "channel_members_changed".into(),
                payload: serde_json::to_vec(&change).unwrap(),
            },
            &state,
        )
        .unwrap();
    assert_eq!(seen(), (0, 0, 0), "rows of an unfinished commit are visible");
    assert!(
        ChannelMembersProjection::list_members(&state, "group-a").unwrap().is_empty(),
        "a read sees an unfinished commit"
    );
    assert_eq!(ChannelMembersProjection::revision(&state, "group-a").unwrap(), 0);
    model.finish_commit(1).unwrap();
    assert_eq!(seen(), (2, 1, 1));
    assert_eq!(ChannelMembersProjection::list_members(&state, "group-a").unwrap().len(), 2);
    assert_eq!(ChannelMembersProjection::revision(&state, "group-a").unwrap(), 1);
}

/// Startup replay applies events while it validates the log; everything it
/// writes is one transaction. When replay fails after applying some
/// membership events, the file holds none of them.
#[tokio::test]
async fn a_failed_startup_replay_leaves_none_of_its_members_in_the_file() {
    let dir = tempfile::tempdir().unwrap();
    let engine = open(dir.path()).await;
    write(&engine, vec![added(member("group-a", 1, 3, 1))]).await;
    write(&engine, vec![changed("group-g", vec![member("group-g", 2, 0, 2)], vec![])]).await;
    assert!(commit(&engine, vec![event(test_poison::EVENT_TYPE, "ch_p", test_poison::FAIL.to_vec())])
        .await
        .is_err());
    close(engine, dir.path()).await;

    crate::projections::read_model::ReadModel::remove_files(dir.path()).unwrap();
    let error = super::reopen_after_drop(config(dir.path()), None).await.unwrap_err();
    assert!(error.to_string().contains("commit 3"), "{error}");
    drop(super::wait_for_stopped_engine(dir.path()).await);
    let (members, versions, applied, _) = member_file(dir.path());
    assert_eq!((members.len(), versions.len(), applied), (0, 0, 0), "{members:?} {versions:?}");
}

/// The snapshot is older than the read model (the normal state after a
/// crash: the read model commits every commit, the snapshot every 1,000).
/// Between the two: user 5 joins group-x (A), is deleted (B), and joins
/// group-y (C). Replay hands A, B and C to the handlers again, onto tables
/// that already hold C's state.
///
/// Both replay floors are needed, each because of the other:
/// - without the membership handler's, A is applied again and puts group-x/5
///   back, and B, whose cascade is skipped, no longer removes it;
/// - without the user deletion's, B's cascade runs again and removes
///   group-y/5, which C, skipped, no longer adds.
///
/// Either way the restart serves a membership that differs from live.
#[tokio::test]
async fn replay_does_not_reapply_membership_changes_the_read_model_already_holds() {
    let dir = tempfile::tempdir().unwrap();
    let engine = open(dir.path()).await;
    write(&engine, vec![unrelated()]).await;
    close(engine, dir.path()).await;
    let old_snapshot = std::fs::read(ProjectionState::snapshot_path(dir.path())).unwrap();

    let engine = open(dir.path()).await;
    write(&engine, vec![added(member("group-x", 5, 0, 1))]).await;
    write(&engine, vec![user_deleted(5)]).await;
    write(&engine, vec![added(member("group-y", 5, 0, 2))]).await;
    let reads = |state: &ProjectionState| {
        (
            ChannelMembersProjection::list_members(state, "group-x").unwrap(),
            ChannelMembersProjection::list_members(state, "group-y").unwrap(),
            ChannelMembersProjection::revision(state, "group-x").unwrap(),
            ChannelMembersProjection::revision(state, "group-y").unwrap(),
        )
    };
    let live = reads(engine.projection_state());
    // group-x's revision is B's commit: the cascade removed user 5 from it.
    assert_eq!((live.0.len(), live.1.len(), live.2, live.3), (0, 1, 3, 4), "{live:?}");
    close(engine, dir.path()).await;
    let kept = member_file(dir.path());

    std::fs::write(ProjectionState::snapshot_path(dir.path()), &old_snapshot).unwrap();
    let engine = open(dir.path()).await;
    assert_eq!(engine.projection_state().applied_commit_seq(), 4);
    assert_eq!(reads(engine.projection_state()), live);
    close(engine, dir.path()).await;
    assert_eq!(member_file(dir.path()), kept, "kept, not rebuilt");
}

/// The same with the whole history: the read model is ahead of a snapshot
/// that holds only the channels' first commits.
#[tokio::test]
async fn a_read_model_ahead_of_the_snapshot_keeps_every_member_read() {
    let dir = tempfile::tempdir().unwrap();
    let engine = open(dir.path()).await;
    write(&engine, vec![unrelated()]).await;
    close(engine, dir.path()).await;
    let old_snapshot = std::fs::read(ProjectionState::snapshot_path(dir.path())).unwrap();

    let engine = open(dir.path()).await;
    let last = write_member_history(&engine).await;
    let live = all_member_reads(engine.projection_state());
    close(engine, dir.path()).await;
    let kept = member_file(dir.path());

    std::fs::write(ProjectionState::snapshot_path(dir.path()), old_snapshot).unwrap();
    let engine = open(dir.path()).await;
    assert_eq!(engine.projection_state().applied_commit_seq(), last);
    assert_eq!(all_member_reads(engine.projection_state()), live);
    close(engine, dir.path()).await;
    assert_eq!(member_file(dir.path()), kept, "kept, not rebuilt");
}

/// The other order: the read model is older than the snapshot. It is rebuilt
/// from the whole log, the `user_deleted` cascade included; the in-memory
/// projections load from the snapshot.
#[tokio::test]
async fn a_read_model_behind_the_snapshot_is_rebuilt_with_the_same_member_reads() {
    let dir = tempfile::tempdir().unwrap();
    let engine = open(dir.path()).await;
    write(&engine, vec![added(member("group-c", 3, 0, 1))]).await;
    close(engine, dir.path()).await;
    let old_file = std::fs::read(read_model_file(dir.path())).unwrap();

    let engine = open(dir.path()).await;
    let last = write_member_history(&engine).await;
    let live = all_member_reads(engine.projection_state());
    close(engine, dir.path()).await;
    let kept = member_file(dir.path());

    std::fs::write(read_model_file(dir.path()), old_file).unwrap();
    assert_eq!(member_file(dir.path()).2, 1);
    let engine = open(dir.path()).await;
    assert_eq!(engine.projection_state().applied_commit_seq(), last);
    assert_eq!(all_member_reads(engine.projection_state()), live);
    close(engine, dir.path()).await;
    assert_eq!(member_file(dir.path()), kept);
}

/// `channel_ids_of_user` and the `user_deleted` cascade find a user's rows
/// through the indexed `user_id` column. They must find exactly what a scan of
/// every member row (decoding each record) finds: after a history with joins,
/// leaves, a role change, batch changes, a user deletion and a rejoin, live,
/// after a restart and after a rebuild from the log.
#[tokio::test]
async fn channel_ids_of_user_agrees_with_a_full_scan() {
    fn full_scan(state: &ProjectionState, user_id: u64) -> Vec<String> {
        let mut channels = Vec::new();
        state
            .read_model()
            .for_each_row(crate::projections::read_model::Table::ChannelMembers, |_key, record| {
                let record = crate::projections::channel_members::decode_record(record)?;
                if record.user_id == user_id {
                    channels.push(record.channel_id);
                }
                Ok(())
            })
            .unwrap();
        channels
    }
    fn check(state: &ProjectionState) -> String {
        let mut seen = String::new();
        for user in USERS.into_iter().chain([5, 0, u64::MAX]) {
            let indexed = ChannelMembersProjection::channel_ids_of_user(state, user).unwrap();
            assert_eq!(indexed, full_scan(state, user), "user {user}");
            seen += &format!("{user}: {indexed:?}\n");
        }
        seen
    }
    let dir = tempfile::tempdir().unwrap();
    let engine = open(dir.path()).await;
    write_member_history(&engine).await;
    // A user id above i64::MAX, stored in the signed column.
    write(&engine, vec![added(member("group-a", u64::MAX, 0, 1))]).await;
    write(&engine, vec![added(member("group-b", u64::MAX, 0, 1))]).await;
    write(&engine, vec![removed("group-a", u64::MAX)]).await;
    let live = check(engine.projection_state());
    for expected in [
        "1: [\"group-a\", \"group-b\", \"group-g\"]",
        "2: [\"group-a\"]",
        "3: [\"group-c\"]",
        &format!("{}: [\"group-b\"]", u64::MAX),
    ] {
        assert!(live.contains(expected), "{expected} missing from\n{live}");
    }
    close(engine, dir.path()).await;

    let engine = open(dir.path()).await;
    assert_eq!(check(engine.projection_state()), live);
    close(engine, dir.path()).await;
    std::fs::remove_file(read_model_file(dir.path())).unwrap();
    let engine = open(dir.path()).await;
    assert_eq!(check(engine.projection_state()), live);
    close(engine, dir.path()).await;
}

/// Measurement, not a check: what `channel_ids_of_user` (every socket join and
/// every channel list of a member) costs on a file-backed engine holding
/// 50,000 memberships (5,000 channels of 10 members; 5,000 users in 10
/// channels each).
///
/// `cargo test --release -p wabidb --lib measure_channel_ids_of_user -- --ignored --nocapture`
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "measurement; prints timings"]
async fn measure_channel_ids_of_user() {
    const CHANNELS: u64 = 5_000;
    const PER_CHANNEL: u64 = 10;
    const USERS: u64 = 5_000;
    let dir = tempfile::tempdir().unwrap();
    let engine = open(dir.path()).await;
    for batch in 0..CHANNELS / 50 {
        let events = (batch * 50..(batch + 1) * 50)
            .map(|channel| {
                let id = format!("group-{channel:05}");
                let upserts = (0..PER_CHANNEL)
                    .map(|i| member(&id, (channel * PER_CHANNEL + i) % USERS + 1, 0, 1))
                    .collect();
                changed(&id, upserts, vec![])
            })
            .collect();
        write(&engine, events).await;
    }
    let state = engine.projection_state();
    let calls = 500u64;
    let started = std::time::Instant::now();
    for call in 0..calls {
        let channels = ChannelMembersProjection::channel_ids_of_user(state, call * 7 % USERS + 1).unwrap();
        assert_eq!(channels.len() as u64, CHANNELS * PER_CHANNEL / USERS);
    }
    let elapsed = started.elapsed();
    println!(
        "channel_ids_of_user over {} memberships: {:.3?} per call ({calls} calls)",
        CHANNELS * PER_CHANNEL,
        elapsed / calls as u32
    );
    close(engine, dir.path()).await;
}
