//! Task 3.5.4: the users projection lives in the SQLite read model
//! (`projections/read-model.sqlite3`, table `users`), next to the messages,
//! the channels and the channel members; it is no longer in
//! `projections/snapshot.json`.
//!
//! These tests open a real engine, like `read_model_channel_members`. They
//! cover what the read model must guarantee for accounts: it is derived
//! (delete the file and every user read is the same), it is rebuilt when
//! another generation wrote it, a commit's user rows and its
//! `applied_commit_seq` become visible together, a failed startup replay
//! leaves none of its rows, and either store (snapshot or read model) may be
//! the older one.
//!
//! Users is read by more than its own handler. The sequencer's admission
//! check (`users::preflight_command`) reads it before a command is written;
//! the in-memory game profile and recovery code projections read it while
//! they apply; the user deletion projection removes rows from it. On an
//! ordinary restart the read model is ahead of the snapshot, so replay hands
//! those projections commits older than the users rows it reads. Tests below
//! cover each.

use super::read_model_messages::{close, commit, open, read_model_file};
use crate::domain::UserDeleted;
use crate::engine::locks::ProjectionState;
use crate::engine::WabiDbEngine;
use crate::format::record::RecordKind;
use crate::projections::query::{QueryableProjection, UsersFilter};
use crate::projections::read_model::READ_MODEL_GENERATION;
use crate::projections::users::{self, encode_record, UserRecord, UsersProjection};
use crate::projections::{
    auth_revocations, game_profiles, owner, recovery_codes, test_poison, user_deletion,
};
use crate::sequencer::types::{CommandCommit, CommandOutcome, EventToWrite};
use std::path::Path;

/// Ids the reads below ask for: every id the history uses, and some it never
/// assigns.
const IDS: [u64; 14] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 404];
const NAMES: [&str; 9] = ["alice", "ALICIA", "alicia", "bob", "Bob", "carol", "dave", "nobody", ""];

fn event(kind: &str, stream: &str, plaintext: Vec<u8>) -> EventToWrite {
    EventToWrite {
        event_type: kind.into(),
        stream_id: stream.into(),
        plaintext,
        stream_kind: 6,
        record_kind: RecordKind::Event,
    }
}

/// A fixture password hash: `label` followed by a random value drawn once per
/// test process. Not a credential; random so no constant value is stored as a
/// password (CodeQL `rust/hard-coded-cryptographic-value`), and the same
/// within one process so live and restarted reads compare equal.
pub(crate) fn fixture_secret(label: &str) -> String {
    static SALT: std::sync::OnceLock<u64> = std::sync::OnceLock::new();
    format!("{label}-{:016x}", SALT.get_or_init(rand::random::<u64>))
}

/// A full account as `WdbAdapter::create_user` writes it (the handler
/// replaces `user_id` with the commit). A non-empty `password_hash` is a
/// label for [`fixture_secret`]; an empty one stays empty (a guest).
fn user(name: &str, password_hash: &str) -> UserRecord {
    UserRecord {
        user_id: 0,
        username: name.into(),
        handle: Some(name.to_lowercase()),
        color: "#98D8C8".into(),
        password_hash: if password_hash.is_empty() { String::new() } else { fixture_secret(password_hash) },
        is_registered: true,
        is_active: true,
        created_at_micros: 1_000,
        last_seen_micros: 2_000,
        profile_picture: None,
        username_font: None,
        bio: None,
        status_message: None,
    }
}

/// An empty patch of `user_id`: every field the handler would copy is empty.
fn patch(user_id: u64) -> UserRecord {
    UserRecord {
        user_id,
        username: String::new(),
        handle: None,
        color: String::new(),
        password_hash: String::new(),
        is_registered: true,
        is_active: true,
        created_at_micros: 0,
        last_seen_micros: 0,
        profile_picture: None,
        username_font: None,
        bio: None,
        status_message: None,
    }
}

fn registered(record: UserRecord) -> EventToWrite {
    event("user_registered", "users", encode_record(&record))
}

fn updated(record: UserRecord) -> EventToWrite {
    let stream = format!("user:{}", record.user_id);
    event("user_updated", &stream, encode_record(&record))
}

fn deleted(user_id: u64) -> EventToWrite {
    event("user_deleted", "users", user_deletion::encode_payload(&UserDeleted { user_id }))
}

fn unrelated() -> EventToWrite {
    let mut event = event(test_poison::EVENT_TYPE, "ch_other", b"not a user".to_vec());
    event.stream_kind = 1;
    event
}

async fn write(engine: &WabiDbEngine, events: Vec<EventToWrite>) -> u64 {
    commit(engine, events).await.unwrap().commit_seq
}

/// A history that reaches every branch of the users handler and the
/// `user_deleted` cascade: registrations, a rename, a colour cleared with the
/// `\0` prefix, a password-only patch, profile fields, a deleted user whose
/// name is then registered again, a case-only rename, an inactive account
/// and a commit no users handler sees. User ids are the registration
/// commits (alice 1, bob 2, carol 3, bob again 8, dave 10 when the history
/// starts the log). Returns the last commit.
async fn write_user_history(engine: &WabiDbEngine) -> u64 {
    let alice = write(engine, vec![registered(user("alice", "hash-a"))]).await;
    let bob = write(engine, vec![registered(user("bob", "hash-b"))]).await;
    let carol = write(engine, vec![registered(user("Carol", "hash-c"))]).await;
    let mut rename = patch(alice);
    rename.username = "Alicia".into();
    rename.color = "\0".into();
    write(engine, vec![updated(rename)]).await;
    let mut password = patch(bob);
    password.password_hash = fixture_secret("hash-b2");
    write(engine, vec![updated(password)]).await;
    let mut profile = patch(carol);
    profile.color = "#123456".into();
    profile.profile_picture = Some("pic.png".into());
    profile.username_font = Some("serif".into());
    profile.bio = Some("bio of carol".into());
    profile.status_message = Some("away".into());
    write(engine, vec![updated(profile)]).await;
    write(engine, vec![deleted(bob)]).await;
    write(engine, vec![registered(user("Bob", "hash-b3"))]).await;
    let mut case_only = patch(alice);
    case_only.username = "ALICIA".into();
    write(engine, vec![updated(case_only)]).await;
    let mut inactive = user("dave", "");
    inactive.is_active = false;
    inactive.is_registered = false;
    write(engine, vec![registered(inactive)]).await;
    write(engine, vec![unrelated()]).await
}

/// Every user read the server and the crate make, as text: the full list,
/// the active and inactive lists, each id (with and without the activity
/// filter), `user_exists`, and each login name as `get_user_by_username`
/// resolves it (case-folded). Two states that print the same text answer
/// every read the same.
fn all_user_reads(state: &ProjectionState) -> String {
    use std::fmt::Write;
    let mut out = String::new();
    let all = UsersProjection.query(state, &UsersFilter::default());
    writeln!(out, "all: {all:?}").unwrap();
    for active in [true, false] {
        let filter = UsersFilter { is_active: Some(active), ..Default::default() };
        writeln!(out, "active {active}: {:?}", UsersProjection.query(state, &filter)).unwrap();
    }
    writeln!(
        out,
        "limit 2: {:?}",
        UsersProjection.query(state, &UsersFilter { limit: Some(2), ..Default::default() })
    )
    .unwrap();
    for id in IDS {
        let filter = UsersFilter { user_id: Some(id), ..Default::default() };
        writeln!(out, "get {id}: {:?}", UsersProjection.query(state, &filter)).unwrap();
        let filter = UsersFilter { user_id: Some(id), is_active: Some(true), ..Default::default() };
        writeln!(out, "get active {id}: {:?}", UsersProjection.query(state, &filter)).unwrap();
        writeln!(out, "exists {id}: {}", user_deletion::user_exists(state, id)).unwrap();
    }
    let all = all.unwrap();
    for name in NAMES {
        let folded = name.to_lowercase();
        let found: Vec<_> = all.iter().filter(|user| user.username.to_lowercase() == folded).cloned().collect();
        // The login lookup goes through the folded-name index; it must find
        // exactly what a scan of every account finds.
        assert_eq!(users::find_by_username(state, name).unwrap(), found, "login {name}");
        writeln!(out, "login {name}: {found:?}").unwrap();
    }
    out
}

/// What the read model file of a stopped engine holds for users, read with a
/// plain SQLite connection: (key, folded name and record of every row in key
/// order, as hex; `applied_commit_seq` of the users; stored generation).
type UserFile = (Vec<(String, String, String)>, u64, i64);

fn user_file(path: &Path) -> UserFile {
    let conn = rusqlite::Connection::open(read_model_file(path)).unwrap();
    let rows = conn
        .prepare("SELECT hex(key), username_lower, hex(record) FROM users ORDER BY key")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .unwrap()
        .map(|row| row.unwrap())
        .collect();
    let applied: i64 = conn
        .query_row(
            "SELECT coalesce((SELECT seq FROM applied_commit_seq WHERE projection = 'users'), 0)",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let generation = conn.query_row("SELECT generation FROM read_model_meta", [], |row| row.get(0)).unwrap();
    (rows, applied as u64, generation)
}

fn snapshot_has_users(path: &Path) -> bool {
    let snapshot = std::fs::read_to_string(ProjectionState::snapshot_path(path)).unwrap();
    snapshot.contains("\"users\"")
}

/// The rebuild test: the read model is derived. Delete the SQLite file of a
/// stopped engine, reopen, and every user read returns what it returned
/// before. The snapshot holds no account, so only the log can bring them
/// back; the `user_deleted` cascade, which the snapshot covers, must be
/// replayed into the rebuilt table too.
#[tokio::test]
async fn deleting_the_read_model_file_changes_no_user_read() {
    let dir = tempfile::tempdir().unwrap();
    let engine = open(dir.path()).await;
    let last = write_user_history(&engine).await;
    let live = all_user_reads(engine.projection_state());
    // The history is not trivial.
    let alice_hash = fixture_secret("hash-a");
    for expected in [
        &format!("get 1: Ok([UserRecord {{ user_id: 1, username: \"ALICIA\", handle: Some(\"alice\"), color: \"\", password_hash: \"{alice_hash}\""),
        "get 2: Ok([])",
        "exists 2: false",
        "get 3: Ok([UserRecord { user_id: 3, username: \"Carol\", handle: Some(\"carol\"), color: \"#123456\"",
        "status_message: Some(\"away\")",
        "get 8: Ok([UserRecord { user_id: 8, username: \"Bob\"",
        "get active 10: Ok([])",
        "get 10: Ok([UserRecord { user_id: 10, username: \"dave\"",
        "login alicia: [UserRecord { user_id: 1,",
        "login bob: [UserRecord { user_id: 8,",
        "login alice: []",
    ] {
        assert!(live.contains(expected), "{expected} missing from\n{live}");
    }
    close(engine, dir.path()).await;

    let kept = user_file(dir.path());
    assert_eq!(kept.0.len(), 4, "alice, carol, bob again, dave: {kept:?}");
    assert_eq!(kept.1, last);
    assert!(!snapshot_has_users(dir.path()), "accounts are not in the snapshot");

    // A plain restart, from the file as it is.
    let engine = open(dir.path()).await;
    assert_eq!(all_user_reads(engine.projection_state()), live);
    close(engine, dir.path()).await;

    // With the SQLite file deleted.
    std::fs::remove_file(read_model_file(dir.path())).unwrap();
    let engine = open(dir.path()).await;
    assert_eq!(engine.projection_state().applied_commit_seq(), last);
    assert_eq!(all_user_reads(engine.projection_state()), live);
    close(engine, dir.path()).await;
    assert_eq!(user_file(dir.path()), kept, "the rebuilt file holds the same rows");

    // With every saved projection deleted.
    ProjectionState::remove_saved_projections_for_tests(dir.path());
    let engine = open(dir.path()).await;
    assert_eq!(all_user_reads(engine.projection_state()), live);
    close(engine, dir.path()).await;
    assert_eq!(user_file(dir.path()), kept);
}

/// Rebuild on generation mismatch: a file written by generation N is opened
/// by a build of generation N+1 (the stored number is changed to one this
/// build is not). The engine rebuilds it from the log: a user row planted in
/// the old file, which no event produces, is gone; reads are unchanged.
#[tokio::test]
async fn a_read_model_of_another_generation_is_rebuilt_and_user_reads_are_unchanged() {
    let dir = tempfile::tempdir().unwrap();
    let engine = open(dir.path()).await;
    let last = write_user_history(&engine).await;
    let live = all_user_reads(engine.projection_state());
    close(engine, dir.path()).await;
    let kept = user_file(dir.path());
    assert_eq!(kept.2, READ_MODEL_GENERATION);

    {
        let conn = rusqlite::Connection::open(read_model_file(dir.path())).unwrap();
        conn.execute("UPDATE read_model_meta SET generation = ?1", [READ_MODEL_GENERATION - 1])
            .unwrap();
        let mut planted = user("planted", "planted-hash");
        planted.user_id = 404;
        conn.execute(
            "INSERT INTO users (key, username_lower, record) VALUES (?1, 'planted', ?2)",
            [404u64.to_be_bytes().to_vec(), encode_record(&planted)],
        )
        .unwrap();
    }
    let stale = user_file(dir.path());
    assert_eq!((stale.0.len(), stale.2), (kept.0.len() + 1, READ_MODEL_GENERATION - 1));

    let engine = open(dir.path()).await;
    assert_eq!(engine.projection_state().applied_commit_seq(), last);
    assert_eq!(all_user_reads(engine.projection_state()), live, "the planted row survived");
    close(engine, dir.path()).await;
    assert_eq!(user_file(dir.path()), kept, "rebuilt from the log under this build's generation");
}

/// A commit's user rows and its `applied_commit_seq` become visible together:
/// until the commit is finished, another connection to the file sees neither;
/// afterwards it sees both, in one read transaction. The same holds for the
/// crate's own reads, and for the sequencer's admission check, which must
/// see committed rows and nothing else.
#[test]
fn a_commits_user_rows_and_its_applied_commit_seq_become_visible_together() {
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
        let rows: i64 = conn.query_row("SELECT count(*) FROM users", [], |row| row.get(0)).unwrap();
        let applied: i64 = conn
            .query_row(
                "SELECT coalesce((SELECT seq FROM applied_commit_seq WHERE projection = 'users'), 0)",
                [],
                |row| row.get(0),
            )
            .unwrap();
        (rows, applied)
    };
    UsersProjection
        .apply(
            &DurableEvent {
                commit_seq: 1,
                stream_id: "users".into(),
                event_type: "user_registered".into(),
                payload: encode_record(&user("alice", "hash")),
            },
            &state,
        )
        .unwrap();
    assert_eq!(seen(), (0, 0), "rows of an unfinished commit are visible");
    assert!(
        UsersProjection.query(&state, &UsersFilter::default()).unwrap().is_empty(),
        "a read sees an unfinished commit"
    );
    assert!(!user_deletion::user_exists(&state, 1));
    // Admission reads committed rows only: the unfinished registration does
    // not take the name yet.
    let again = [registered(user("ALICE", "other"))];
    crate::projections::users::preflight_command(&again, &state).unwrap();
    model.finish_commit(1).unwrap();
    assert_eq!(seen(), (1, 1));
    assert_eq!(UsersProjection.query(&state, &UsersFilter::default()).unwrap().len(), 1);
    assert!(user_deletion::user_exists(&state, 1));
    let error = crate::projections::users::preflight_command(&again, &state).unwrap_err();
    assert!(error.to_string().contains("username is already taken"), "{error}");
}

/// Startup replay applies events while it validates the log; everything it
/// writes is one transaction. When replay fails after applying some user
/// events, the file holds none of them.
#[tokio::test]
async fn a_failed_startup_replay_leaves_none_of_its_users_in_the_file() {
    let dir = tempfile::tempdir().unwrap();
    let engine = open(dir.path()).await;
    write(&engine, vec![registered(user("alice", "a"))]).await;
    let mut rename = patch(1);
    rename.username = "alicia".into();
    write(&engine, vec![updated(rename)]).await;
    let mut poison = event(test_poison::EVENT_TYPE, "ch_p", test_poison::FAIL.to_vec());
    poison.stream_kind = 1;
    assert!(commit(&engine, vec![poison]).await.is_err());
    close(engine, dir.path()).await;

    crate::projections::read_model::ReadModel::remove_files(dir.path()).unwrap();
    let error = super::reopen_after_drop(super::read_model_messages::config(dir.path()), None)
        .await
        .unwrap_err();
    assert!(error.to_string().contains("commit 3"), "{error}");
    drop(super::wait_for_stopped_engine(dir.path()).await);
    let (rows, applied, _) = user_file(dir.path());
    assert_eq!((rows.len(), applied), (0, 0), "{rows:?}");
}

/// Write a history after an old snapshot (taken after `before`), stop, put
/// the old snapshot back and reopen: the read model is ahead of the snapshot,
/// which is the normal state after a crash (the read model commits every
/// commit, the snapshot every 1,000). Returns the engine reopened that way,
/// with what `reads` returned live and the users file as it was kept.
async fn reopen_with_old_snapshot<R: PartialEq + std::fmt::Debug>(
    dir: &Path,
    before: Vec<Vec<EventToWrite>>,
    history: Vec<Vec<EventToWrite>>,
    reads: impl Fn(&ProjectionState) -> R,
) -> (WabiDbEngine, R, UserFile) {
    let engine = open(dir).await;
    write(&engine, vec![unrelated()]).await;
    for events in before {
        write(&engine, events).await;
    }
    close(engine, dir).await;
    let old_snapshot = std::fs::read(ProjectionState::snapshot_path(dir)).unwrap();

    let engine = open(dir).await;
    for events in history {
        write(&engine, events).await;
    }
    let live = reads(engine.projection_state());
    let last = engine.projection_state().applied_commit_seq();
    close(engine, dir).await;
    let kept = user_file(dir);
    assert_eq!(kept.1, last);

    std::fs::write(ProjectionState::snapshot_path(dir), &old_snapshot).unwrap();
    let engine = open(dir).await;
    assert_eq!(engine.projection_state().applied_commit_seq(), last);
    (engine, live, kept)
}

/// The users handler's replay floor. Between the snapshot and the read
/// model: user 2 registers (A) and is deleted (B). Replay hands A and B to
/// the handlers again, onto a table that already holds B's state. Without
/// the users handler's floor, A registers user 2 again, and B, whose removal
/// of the row is skipped (the read model holds it), no longer removes it:
/// the restart serves a deleted account.
#[tokio::test]
async fn replay_does_not_reapply_user_changes_the_read_model_already_holds() {
    let dir = tempfile::tempdir().unwrap();
    let reads = |state: &ProjectionState| {
        (
            UsersProjection.query(state, &UsersFilter::default()).unwrap(),
            user_deletion::user_exists(state, 2),
        )
    };
    let (engine, live, kept) = reopen_with_old_snapshot(
        dir.path(),
        vec![],
        vec![vec![registered(user("ghost", "g"))], vec![deleted(2)]],
        reads,
    )
    .await;
    assert_eq!(live, (vec![], false));
    assert_eq!(reads(engine.projection_state()), live);
    close(engine, dir.path()).await;
    assert_eq!(user_file(dir.path()), kept, "kept, not rebuilt");
}

/// The same with the whole history: the read model is ahead of a snapshot
/// that holds only the first commit.
#[tokio::test]
async fn a_read_model_ahead_of_the_snapshot_keeps_every_user_read() {
    let dir = tempfile::tempdir().unwrap();
    let engine = open(dir.path()).await;
    write(&engine, vec![unrelated()]).await;
    close(engine, dir.path()).await;
    let old_snapshot = std::fs::read(ProjectionState::snapshot_path(dir.path())).unwrap();

    let engine = open(dir.path()).await;
    let last = write_user_history(&engine).await;
    let live = all_user_reads(engine.projection_state());
    close(engine, dir.path()).await;
    let kept = user_file(dir.path());

    std::fs::write(ProjectionState::snapshot_path(dir.path()), old_snapshot).unwrap();
    let engine = open(dir.path()).await;
    assert_eq!(engine.projection_state().applied_commit_seq(), last);
    assert_eq!(all_user_reads(engine.projection_state()), live);
    close(engine, dir.path()).await;
    assert_eq!(user_file(dir.path()), kept, "kept, not rebuilt");
}

/// The other order: the read model is older than the snapshot. It is rebuilt
/// from the whole log, the `user_deleted` cascade included (the deletion is
/// at or below the snapshot, so only its read-model part runs); the
/// in-memory projections load from the snapshot.
#[tokio::test]
async fn a_read_model_behind_the_snapshot_is_rebuilt_with_the_same_user_reads() {
    let dir = tempfile::tempdir().unwrap();
    let engine = open(dir.path()).await;
    write(&engine, vec![unrelated()]).await;
    close(engine, dir.path()).await;
    let old_file = std::fs::read(read_model_file(dir.path())).unwrap();

    let engine = open(dir.path()).await;
    let last = write_user_history(&engine).await;
    let live = all_user_reads(engine.projection_state());
    close(engine, dir.path()).await;
    let kept = user_file(dir.path());

    std::fs::write(read_model_file(dir.path()), old_file).unwrap();
    assert_eq!(user_file(dir.path()).1, 1);
    let engine = open(dir.path()).await;
    assert_eq!(engine.projection_state().applied_commit_seq(), last);
    assert_eq!(all_user_reads(engine.projection_state()), live);
    close(engine, dir.path()).await;
    assert_eq!(user_file(dir.path()), kept);
}

fn game_profile(user_id: u64) -> EventToWrite {
    let mut profile = game_profiles::GameProfileRecord::empty(user_id);
    profile.revision = format!("r{user_id}");
    event(game_profiles::EVENT, &format!("game_profile:{user_id}"), serde_json::to_vec(&profile).unwrap())
}

fn game_profile_rows(state: &ProjectionState) -> Vec<(u64, Option<Vec<u8>>)> {
    (1..=12).map(|id: u64| (id, state.get(game_profiles::INDEX, &id.to_be_bytes()))).collect()
}

/// The game profile projection (in memory) stores a profile only when its
/// account exists at that commit. On a restart with the read model ahead of
/// the snapshot it is replayed onto a users table that holds a later state.
/// Between the two:
/// - a profile for id 3 before any account 3 exists (2), then the
///   registration that gets id 3 (3): live stores no profile; a check
///   against the later table would find user 3;
/// - account 4 (4) gets a profile (5) and is then deleted (6): live stores
///   the profile and the deletion removes it;
/// - account 7 (7) gets a profile (8): live keeps it.
///
/// Every profile row after the restart must match live.
#[tokio::test]
async fn replayed_game_profiles_see_the_accounts_of_their_own_commit() {
    let dir = tempfile::tempdir().unwrap();
    let (engine, live, _) = reopen_with_old_snapshot(
        dir.path(),
        vec![],
        vec![
            vec![game_profile(3)],
            vec![registered(user("three", "h"))],
            vec![registered(user("four", "h"))],
            vec![game_profile(4)],
            vec![deleted(4)],
            vec![registered(user("seven", "h"))],
            vec![game_profile(7)],
        ],
        game_profile_rows,
    )
    .await;
    let stored: Vec<u64> = live.iter().filter(|(_, row)| row.is_some()).map(|(id, _)| *id).collect();
    assert_eq!(stored, [7], "{live:?}");
    assert_eq!(game_profile_rows(engine.projection_state()), live);
    close(engine, dir.path()).await;

    // And with the read model rebuilt from the log (the users table is then
    // replayed in step with the profiles).
    std::fs::remove_file(read_model_file(dir.path())).unwrap();
    let engine = open(dir.path()).await;
    assert_eq!(game_profile_rows(engine.projection_state()), live);
    close(engine, dir.path()).await;
}

fn recovery_command(migration: bool, operations: Vec<recovery_codes::Operation>) -> EventToWrite {
    let delta = recovery_codes::Delta { schema_version: 1, migration, operations };
    event(recovery_codes::EVENT, recovery_codes::STREAM, serde_json::to_vec(&delta).unwrap())
}

fn owner_claimed(user_id: u64) -> EventToWrite {
    event(
        "owner_claimed",
        "server_meta",
        serde_json::to_vec(&owner::OwnerRecord { owner_user_id: user_id }).unwrap(),
    )
}

fn recovery_rows(state: &ProjectionState) -> (Vec<(Vec<u8>, Vec<u8>)>, Option<u64>) {
    let mut rows = Vec::new();
    state.for_each(recovery_codes::INDEX, |key, value| rows.push((key.to_vec(), value.to_vec())));
    (rows, owner::OwnerProjection::get_owner(state))
}

/// The recovery code projection (in memory) checks that the account exists
/// when a code is issued. Between the snapshot and the read model: the owner
/// (user 4) issues a code (6), hands ownership to user 7 (8) and is deleted
/// (9). On a restart with the read model ahead of the snapshot, the issue is
/// replayed while the users table no longer holds user 4. The restart must
/// succeed and every recovery read must match live.
#[tokio::test]
async fn replayed_recovery_codes_do_not_check_accounts_against_a_later_table() {
    let dir = tempfile::tempdir().unwrap();
    let initialize = vec![
        vec![event(
            auth_revocations::EVENT,
            auth_revocations::STREAM,
            serde_json::to_vec(&auth_revocations::Delta {
                schema_version: 1,
                migration: true,
                operations: vec![auth_revocations::Operation::Initialize],
            })
            .unwrap(),
        )],
        vec![recovery_command(true, vec![recovery_codes::Operation::Initialize])],
    ];
    let (engine, live, _) = reopen_with_old_snapshot(
        dir.path(),
        initialize,
        vec![
            vec![registered(user("owner", "h"))],
            vec![owner_claimed(4)],
            vec![recovery_command(
                false,
                vec![recovery_codes::Operation::Issue { digest: format!("{:064x}", 1), user_id: 4 }],
            )],
            vec![registered(user("heir", "h"))],
            vec![owner_claimed(7)],
            vec![deleted(4)],
        ],
        recovery_rows,
    )
    .await;
    assert_eq!(live.0.len(), 2, "ready and one code: {live:?}");
    assert_eq!(live.1, Some(7));
    assert_eq!(recovery_rows(engine.projection_state()), live);
    close(engine, dir.path()).await;
}

/// Two registrations of the same name (in any case) in flight at once: the
/// sequencer admits one and refuses the other before it is written, because
/// it gives every identity command its own window and admits the next only
/// after the previous one is applied and committed to the read model.
#[tokio::test]
async fn concurrent_registrations_of_one_name_admit_exactly_one() {
    let dir = tempfile::tempdir().unwrap();
    let engine = open(dir.path()).await;
    engine.get_or_create_stream_key("users").await.unwrap();
    let before = engine.barrier().current();
    let mut responses = Vec::new();
    for (round, name) in ["alice", "ALICE", "Alice", "alice"].into_iter().enumerate() {
        let (response_tx, response_rx) = tokio::sync::oneshot::channel::<crate::error::Result<CommandOutcome>>();
        engine
            .sequencer()
            .unwrap()
            .sender()
            .try_send(CommandCommit {
                caller_user_id: 0,
                caller_device_id: format!("racer-{round}"),
                command_name: "create_user".into(),
                idempotency_key: None,
                room_owner_precondition: None,
                events: vec![registered(user(name, "h"))],
                essential: true,
                response_tx,
            })
            .unwrap();
        responses.push(response_rx);
    }
    let mut admitted = 0;
    for response in responses {
        match response.await.unwrap() {
            Ok(_) => admitted += 1,
            Err(error) => assert!(error.to_string().contains("username is already taken"), "{error}"),
        }
    }
    assert_eq!(admitted, 1);
    assert_eq!(engine.barrier().current(), before + 1, "a refused registration was written");
    let users = UsersProjection.query(engine.projection_state(), &UsersFilter::default()).unwrap();
    assert_eq!(users.len(), 1, "{users:?}");
    close(engine, dir.path()).await;
    let engine = open(dir.path()).await;
    assert_eq!(UsersProjection.query(engine.projection_state(), &UsersFilter::default()).unwrap(), users);
    close(engine, dir.path()).await;
}

/// The folded-name index under names `str::to_lowercase` changes in more
/// than ASCII, and names already duplicated in the log (written by raw rows,
/// as a build before admission checked names could have): every lookup
/// agrees with a scan of every account, live, after a restart and after a
/// rebuild from the log.
#[tokio::test]
async fn username_lookups_agree_with_a_full_scan() {
    fn check(state: &ProjectionState) -> String {
        let all = UsersProjection.query(state, &UsersFilter::default()).unwrap();
        let mut seen = String::new();
        for name in ["ÉMILE", "émile", "Émile", "STRASSE", "straße", "Σίσυφος", "ΣΊΣΥΦΟΣ", "x", "X", "nobody"] {
            let folded = name.to_lowercase();
            let scanned: Vec<_> = all.iter().filter(|u| u.username.to_lowercase() == folded).cloned().collect();
            let indexed = users::find_by_username(state, name).unwrap();
            assert_eq!(indexed, scanned, "{name}");
            seen += &format!("{name}: {:?}\n", indexed.iter().map(|u| u.user_id).collect::<Vec<_>>());
        }
        seen
    }
    let dir = tempfile::tempdir().unwrap();
    let engine = open(dir.path()).await;
    for name in ["Émile", "straße", "ΣΊΣΥΦΟΣ", "X"] {
        write(&engine, vec![registered(user(name, "h"))]).await;
    }
    let live = check(engine.projection_state());
    for expected in ["ÉMILE: [1]", "émile: [1]", "STRASSE: []", "straße: [2]", "Σίσυφος: [3]", "x: [4]"] {
        assert!(live.contains(expected), "{expected} missing from\n{live}");
    }
    close(engine, dir.path()).await;
    let engine = open(dir.path()).await;
    assert_eq!(check(engine.projection_state()), live);
    close(engine, dir.path()).await;
    std::fs::remove_file(read_model_file(dir.path())).unwrap();
    let engine = open(dir.path()).await;
    assert_eq!(check(engine.projection_state()), live);
    // Names duplicated before admission refused them: both are found, in id
    // order, and a third registration of the name is still refused.
    let mut twin = user("x", "h");
    twin.user_id = 99;
    users::insert_raw_for_tests(engine.projection_state(), 99, &encode_record(&twin));
    let found = users::find_by_username(engine.projection_state(), "X").unwrap();
    assert_eq!(found.iter().map(|u| u.user_id).collect::<Vec<_>>(), [4, 99]);
    let error = commit(&engine, vec![registered(user("x", "h"))]).await.unwrap_err();
    assert!(error.to_string().contains("username is already taken"), "{error}");
    close(engine, dir.path()).await;
}

/// Measurement, not a check: the login-path reads on a file-backed engine
/// holding 10,000 accounts: the lookup by login name (`get_user_by_username`,
/// every login), the lookup by id (`get_user`, every authenticated request)
/// and one registration (its admission check reads accounts).
///
/// `cargo test --release -p wabidb --lib measure_login_lookups -- --ignored --nocapture`
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "measurement; prints timings"]
async fn measure_login_lookups() {
    const USERS: u64 = 10_000;
    let dir = tempfile::tempdir().unwrap();
    let engine = open(dir.path()).await;
    engine.get_or_create_stream_key("users").await.unwrap();
    // One registration per command, as the adapter writes them.
    for i in 0..USERS {
        write(&engine, vec![registered(user(&format!("User{i:05}"), "hash"))]).await;
    }
    let state = engine.projection_state();
    let calls = 200u64;
    let started = std::time::Instant::now();
    for call in 0..calls {
        let name = format!("user{:05}", call * 37 % USERS);
        assert_eq!(users::find_by_username(state, &name).unwrap().len(), 1);
    }
    let by_name = started.elapsed() / calls as u32;
    let started = std::time::Instant::now();
    for call in 0..calls {
        let filter = UsersFilter { user_id: Some(call * 37 % USERS + 1), ..Default::default() };
        assert_eq!(UsersProjection.query(state, &filter).unwrap().len(), 1);
    }
    let by_id = started.elapsed() / calls as u32;
    let started = std::time::Instant::now();
    for call in 0..20 {
        write(&engine, vec![registered(user(&format!("late{call}"), "hash"))]).await;
    }
    let registration = started.elapsed() / 20;
    println!(
        "{USERS} users: login name lookup {by_name:.3?}, id lookup {by_id:.3?}, one registration {registration:.3?}"
    );
    close(engine, dir.path()).await;
}

/// One command per step of the restart matrix (see the test below). User ids
/// are the registering commits: Owner 4, alice 6, bob 10, BOB 14, alicia 20,
/// late 24.
fn matrix_history() -> Vec<Vec<EventToWrite>> {
    use crate::projections::channel_members::{encode_record as encode_member, ChannelMemberRecord};
    let channel = |kind: &str, stream: &str, payload: Vec<u8>| {
        let mut event = event(kind, stream, payload);
        event.stream_kind = 1;
        event
    };
    let add_member = |user_id: u64| {
        let record = ChannelMemberRecord {
            channel_id: "group-x".into(),
            user_id,
            joined_at_micros: 10 + user_id as i64,
            role: 0,
            nick: None,
        };
        channel("channel_member_added", "channel_members:group-x", encode_member(&record))
    };
    let issue = |digest: u64, user_id: i64| {
        recovery_command(false, vec![recovery_codes::Operation::Issue { digest: format!("{digest:064x}"), user_id }])
    };
    let rename = |user_id: u64, name: &str, handle: Option<&str>| {
        let mut record = patch(user_id);
        record.username = name.into();
        record.handle = handle.map(Into::into);
        updated(record)
    };
    let mut password = patch(10);
    password.password_hash = fixture_secret("hash-bob-2");
    let group = serde_json::json!({"channel_id": "group-x", "name": "x", "channel_kind": 2,
        "owner_user_id": 4, "created_at_micros": 5});
    vec![
        vec![event(
            auth_revocations::EVENT,
            auth_revocations::STREAM,
            serde_json::to_vec(&auth_revocations::Delta {
                schema_version: 1,
                migration: true,
                operations: vec![auth_revocations::Operation::Initialize],
            })
            .unwrap(),
        )],
        vec![recovery_command(true, vec![recovery_codes::Operation::Initialize])],
        vec![channel("channel_created", "group-x", serde_json::to_vec(&group).unwrap())],
        vec![registered(user("Owner", "hash-owner"))],
        vec![owner_claimed(4)],
        vec![registered(user("alice", "hash-alice"))],
        vec![game_profile(6), add_member(6)],
        vec![issue(1, 4)],
        vec![rename(6, "Alicia", Some("ali"))],
        vec![registered(user("bob", "hash-bob"))],
        vec![game_profile(10), add_member(10)],
        vec![updated(password)],
        vec![deleted(10)],
        vec![registered(user("BOB", "hash-BOB"))],
        vec![game_profile(29), game_profile(14)],
        vec![issue(2, 4)],
        vec![owner_claimed(14)],
        vec![recovery_command(
            false,
            vec![recovery_codes::Operation::Recover { digest: format!("{:064x}", 2), user_id: 4, epoch: 5 }],
        )],
        vec![deleted(6), game_profile(6)],
        vec![registered(user("alicia", "hash-alicia2"))],
        vec![rename(20, "ALICIA", None)],
        vec![unrelated()],
        vec![game_profile(24)],
        vec![registered(user("late", "hash-late"))],
        vec![deleted(4)],
        vec![unrelated()],
    ]
}

/// Every read the matrix compares: the user reads, the game profiles, the
/// recovery codes and owner, the members of group-x, and the fingerprint of
/// every projection (in memory and read model).
fn matrix_reads(state: &ProjectionState) -> String {
    let members: Vec<u64> = crate::projections::channel_members::ChannelMembersProjection::list_members(state, "group-x")
        .unwrap()
        .into_iter()
        .map(|member| member.user_id)
        .collect();
    let profiles: Vec<u64> = (1..=30u64)
        .filter(|id| state.get(game_profiles::INDEX, &id.to_be_bytes()).is_some())
        .collect();
    // Set by every membership change, and since generation 4 (PR 349) by a
    // user deletion that removes a member.
    let revision = crate::projections::channel_members::ChannelMembersProjection::revision(state, "group-x").unwrap();
    format!(
        "{}profiles {profiles:?}\nrecovery {:?}\nmembers {members:?} revision {revision}\nfingerprint {:?}\n",
        all_user_reads(state),
        recovery_rows(state),
        state.content_fingerprint(u64::MAX, u64::MAX).unwrap(),
    )
}

/// Restart matrix. Write the history one commit per open and close, and keep
/// the snapshot and the read model file as each close left them. Then for
/// every pair (snapshot after commit i, or none) x (read model after commit
/// j, or none), put those two files back over the whole log and reopen:
/// every read, the fingerprint of every projection and the read model's
/// content digest must equal live. This covers a read model ahead of, equal
/// to and behind the snapshot, and missing either or both, for a history in
/// which in-memory projections (game profiles, recovery codes, user
/// deletion) read and write accounts while they apply.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_snapshot_and_read_model_pair_restarts_to_the_live_state() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path();
    let snapshot = ProjectionState::snapshot_path(path);
    let file = read_model_file(path);
    let mut saved = vec![(None, None)];
    let history = matrix_history();
    let steps = history.len();
    let mut live = String::new();
    for (step, events) in history.into_iter().enumerate() {
        let engine = open(path).await;
        let outcome = commit(&engine, events).await.unwrap_or_else(|e| panic!("step {}: {e}", step + 1));
        assert_eq!(outcome.commit_seq, step as u64 + 1);
        if step + 1 == steps {
            live = matrix_reads(engine.projection_state());
        }
        close(engine, path).await;
        saved.push((Some(std::fs::read(&snapshot).unwrap()), Some(std::fs::read(&file).unwrap())));
    }
    let digest = crate::engine::offline_inspect::read_model_content_digest(path).unwrap();
    for expected in ["profiles [14]", "members [] revision 19", "login alicia: [UserRecord { user_id: 20, username: \"ALICIA\""] {
        assert!(live.contains(expected), "{expected} missing from\n{live}");
    }

    let restore = |target: &Path, bytes: &Option<Vec<u8>>| match bytes {
        Some(bytes) => std::fs::write(target, bytes).unwrap(),
        None => drop(std::fs::remove_file(target)),
    };
    for (i, (snapshot_bytes, _)) in saved.iter().enumerate() {
        for (j, (_, file_bytes)) in saved.iter().enumerate() {
            restore(&snapshot, snapshot_bytes);
            restore(&file, file_bytes);
            for suffix in ["-wal", "-shm"] {
                let _ = std::fs::remove_file(format!("{}{suffix}", file.display()));
            }
            let _ = std::fs::remove_file(crate::projections::read_model::ReadModel::rebuild_marker(path));
            let engine = super::reopen_after_drop(super::read_model_messages::config(path), None)
                .await
                .unwrap_or_else(|e| panic!("snapshot after {i}, read model after {j}: {e}"));
            let reads = matrix_reads(engine.projection_state());
            close(engine, path).await;
            assert!(reads == live, "snapshot after {i}, read model after {j}:\n{reads}\nlive:\n{live}");
            assert_eq!(
                crate::engine::offline_inspect::read_model_content_digest(path).unwrap(),
                digest,
                "snapshot after {i}, read model after {j}"
            );
        }
    }
}

/// Open the stopped engine's read model file with a plain SQLite connection.
fn raw_file(path: &Path) -> rusqlite::Connection {
    rusqlite::Connection::open(read_model_file(path)).unwrap()
}

/// `username_lower` depends on the case mappings of the build that wrote it
/// (`str::to_lowercase`). The file records that build's Unicode version; a
/// file from a build with another one is rebuilt from the log, like a file of
/// another generation. Here the stored version is changed and a row no event
/// produced is planted with a fold the current build agrees with: only a
/// rebuild removes it.
#[tokio::test]
async fn a_read_model_written_with_another_unicode_version_is_rebuilt() {
    let dir = tempfile::tempdir().unwrap();
    let engine = open(dir.path()).await;
    let alice = write(&engine, vec![registered(user("alice", "a"))]).await;
    let live = all_user_reads(engine.projection_state());
    close(engine, dir.path()).await;
    let kept = user_file(dir.path());
    let stored: String = raw_file(dir.path())
        .query_row("SELECT unicode_version FROM read_model_meta", [], |row| row.get(0))
        .unwrap();
    let (major, minor, update) = char::UNICODE_VERSION;
    assert_eq!(stored, format!("{major}.{minor}.{update}"));

    {
        let conn = raw_file(dir.path());
        conn.execute("UPDATE read_model_meta SET unicode_version = '1.0.0'", []).unwrap();
        let mut planted = user("planted", "p");
        planted.user_id = 404;
        conn.execute(
            "INSERT INTO users (key, username_lower, record) VALUES (?1, 'planted', ?2)",
            [404u64.to_be_bytes().to_vec(), encode_record(&planted)],
        )
        .unwrap();
    }
    let engine = open(dir.path()).await;
    assert_eq!(all_user_reads(engine.projection_state()), live, "the planted row survived");
    assert_eq!(users::find_by_username(engine.projection_state(), "ALICE").unwrap()[0].user_id, alice);
    close(engine, dir.path()).await;
    assert_eq!(user_file(dir.path()), kept);
    let stored: String = raw_file(dir.path())
        .query_row("SELECT unicode_version FROM read_model_meta", [], |row| row.get(0))
        .unwrap();
    assert_eq!(stored, format!("{major}.{minor}.{update}"));
}

/// A stale fold (the review's case: U+A7CB lowercases to U+0264 only since
/// Unicode 16, so an older build stored the name unchanged) or a damaged one
/// makes the login lookup miss the account and would let admission take its
/// name again. Every start compares each row's `username_lower` with its
/// record and rebuilds the file when one differs.
#[tokio::test]
async fn a_stored_login_name_that_differs_from_its_record_is_rebuilt_at_open() {
    assert_eq!("\u{A7CB}x".to_lowercase(), "\u{264}x");
    let dir = tempfile::tempdir().unwrap();
    let engine = open(dir.path()).await;
    let old = write(&engine, vec![registered(user("\u{A7CB}x", "hash-old"))]).await;
    let bob = write(&engine, vec![registered(user("bob", "hash-bob"))]).await;
    close(engine, dir.path()).await;
    let kept = user_file(dir.path());
    {
        let conn = raw_file(dir.path());
        // What a build with Unicode 15 stored, and a damaged column.
        conn.execute("UPDATE users SET username_lower = ?1 WHERE key = ?2", rusqlite::params!["\u{A7CB}x", old.to_be_bytes().to_vec()])
            .unwrap();
        conn.execute("UPDATE users SET username_lower = 'b0b' WHERE key = ?1", [bob.to_be_bytes().to_vec()])
            .unwrap();
    }
    let engine = open(dir.path()).await;
    let state = engine.projection_state();
    assert_eq!(users::find_by_username(state, "\u{A7CB}x").unwrap()[0].user_id, old);
    assert_eq!(users::find_by_username(state, "BOB").unwrap()[0].user_id, bob);
    for name in ["\u{264}x", "Bob"] {
        let error = commit(&engine, vec![registered(user(name, "h"))]).await.unwrap_err();
        assert!(error.to_string().contains("username is already taken"), "{name}: {error}");
    }
    close(engine, dir.path()).await;
    assert_eq!(user_file(dir.path()), kept);
}

/// While the engine runs, admission refuses to decide from a row whose
/// stored fold differs from its record (it is only rebuilt at the next
/// start): renaming an account whose row is damaged that way is refused, and
/// nothing is written.
#[tokio::test]
async fn admission_refuses_a_row_whose_stored_login_name_differs_from_its_record() {
    let dir = tempfile::tempdir().unwrap();
    let engine = open(dir.path()).await;
    let bob = write(&engine, vec![registered(user("bob", "hash-bob"))]).await;
    let state = engine.projection_state();
    let model = state.read_model();
    model
        .write(|conn| {
            conn.execute("UPDATE users SET username_lower = 'b0b' WHERE key = ?1", [bob.to_be_bytes().to_vec()])
                .map(drop)
                .map_err(|e| crate::error::WabiError::InternalInvariantViolated { invariant: e.to_string() })
        })
        .unwrap();
    model.finish_commit(state.applied_commit_seq()).unwrap();
    let before = engine.barrier().current();
    let mut rename = patch(bob);
    rename.username = "robert".into();
    let error = commit(&engine, vec![updated(rename)]).await.unwrap_err();
    assert!(error.to_string().contains("does not match its record"), "{error}");
    assert_eq!(engine.barrier().current(), before);
    close(engine, dir.path()).await;
}

/// Old password hashes and deleted accounts must not stay readable in the
/// file's free space (`secure_delete`): `snapshot.json` was rewritten whole
/// at every checkpoint, so it dropped them. 400 accounts, so pages are
/// reused; one is deleted and another changes its password. Neither old hash
/// is anywhere in the file after a clean stop, nor after another start and
/// stop, and no write-ahead log holding them is left behind.
#[tokio::test]
async fn deleted_accounts_and_old_password_hashes_leave_no_bytes_in_the_file() {
    let hash = |i: u64| format!("$2b$12$USER{i:04}HASH{}", "x".repeat(40));
    let dir = tempfile::tempdir().unwrap();
    let engine = open(dir.path()).await;
    let mut ids = Vec::new();
    for i in 0..400 {
        ids.push(write(&engine, vec![registered(user(&format!("user{i:04}"), &hash(i)))]).await);
    }
    write(&engine, vec![deleted(ids[100])]).await;
    let mut password = patch(ids[200]);
    password.password_hash = fixture_secret("$2b$12$NEWHASH");
    write(&engine, vec![updated(password)]).await;
    close(engine, dir.path()).await;

    let check = |when: &str| {
        let file = std::fs::read(read_model_file(dir.path())).unwrap();
        let contains = |needle: &[u8]| file.windows(needle.len()).any(|window| window == needle);
        assert!(contains(b"USER0101HASH"), "{when}: the file does not hold the hashes at all");
        for gone in ["USER0100HASH", "USER0200HASH"] {
            assert!(!contains(gone.as_bytes()), "{when}: {gone} is still in the file");
        }
        for suffix in ["-wal", "-shm"] {
            let side = format!("{}{suffix}", read_model_file(dir.path()).display());
            let bytes = std::fs::read(&side).unwrap_or_default();
            assert!(
                !bytes.windows(12).any(|window| window == b"USER0100HASH" || window == b"USER0200HASH"),
                "{when}: an old hash is in {side}"
            );
        }
    };
    check("after a clean stop");
    let engine = open(dir.path()).await;
    close(engine, dir.path()).await;
    check("after another start and stop");
}

/// The read model's files are owner-only even when a copy left them 0644 with
/// a write-ahead log that still holds frames: the start tightens the database
/// file, `-wal` and `-shm` before any connection opens them (SQLite creates
/// `-shm` with the database file's mode).
#[cfg(unix)]
#[tokio::test]
async fn the_read_model_files_are_made_owner_only_before_they_are_opened() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let engine = open(dir.path()).await;
    write(&engine, vec![registered(user("alice", "a"))]).await;
    close(engine, dir.path()).await;
    let file = read_model_file(dir.path());
    let side = |suffix: &str| std::path::PathBuf::from(format!("{}{suffix}", file.display()));
    {
        // A write never checkpointed, as after a crash: copy the log while
        // it holds the frame, close, and put the copy back.
        let conn = rusqlite::Connection::open(&file).unwrap();
        conn.pragma_update(None, "journal_mode", "WAL").unwrap();
        conn.pragma_update(None, "wal_autocheckpoint", 0).unwrap();
        conn.execute("UPDATE read_model_meta SET sync_count = sync_count + 1", []).unwrap();
        let frames = std::fs::read(side("-wal")).unwrap();
        drop(conn);
        std::fs::write(side("-wal"), frames).unwrap();
    }
    assert!(std::fs::metadata(side("-wal")).unwrap().len() > 0, "no frames left in the write-ahead log");
    let _ = std::fs::remove_file(side("-shm"));
    for path in [file.clone(), side("-wal")] {
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
    }
    let mode = |path: &std::path::Path| std::fs::metadata(path).map(|m| m.permissions().mode() & 0o777).ok();
    // The start's probe opens a read-only connection to a file whose log
    // holds frames, before the engine's own open; SQLite then creates `-shm`
    // with the database file's mode.
    let lock = super::wait_for_stopped_engine(dir.path()).await;
    let state = crate::projections::read_model::ReadModel::probe(dir.path()).unwrap();
    drop(lock);
    assert!(matches!(state, crate::projections::read_model::FileState::Usable { .. }), "{state:?}");
    for path in [file.clone(), side("-wal")] {
        assert_eq!(mode(&path), Some(0o600), "after the probe: {}", path.display());
    }
    let engine = open(dir.path()).await;
    for path in [file.clone(), side("-shm")] {
        assert_eq!(mode(&path), Some(0o600), "while the engine runs: {}", path.display());
    }
    if let Some(found) = mode(&side("-wal")) {
        assert_eq!(found, 0o600, "while the engine runs: -wal");
    }
    assert_eq!(users::find_by_username(engine.projection_state(), "alice").unwrap().len(), 1);
    close(engine, dir.path()).await;
}
