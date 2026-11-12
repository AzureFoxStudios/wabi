//! Users projection: one row per account.
//!
//! Handles `user_registered` and `user_updated`. The rows live in the SQLite
//! read model's `users` table (ADR-0001), not in `projections/snapshot.json`;
//! each row holds the account's password hash. The user deletion projection,
//! which stays in memory, removes a deleted account's row
//! ([`remove_while_applying`]). Other in-memory projections read rows while
//! they apply ([`stored_while_applying`]); the sequencer's admission check
//! ([`preflight_command`]) and every other reader see committed rows only.

use crate::engine::locks::ProjectionState;
use crate::error::Result;
use crate::format::versioned::{self, RecordFormat};
use crate::projections::codec::RecordCodec;
use crate::projections::handler::{DurableEvent, Projection};
use crate::projections::query::{apply_limit, UsersFilter, QueryableProjection};
use crate::projections::read_model::{self, Table};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UserRecord {
    pub user_id: u64,
    pub username: String,
    pub handle: Option<String>,
    pub color: String,
    pub password_hash: String,
    pub is_registered: bool,
    pub is_active: bool,
    pub created_at_micros: i64,
    pub last_seen_micros: i64,
    pub profile_picture: Option<String>,
    pub username_font: Option<String>,
    pub bio: Option<String>,
    pub status_message: Option<String>,
}

impl RecordCodec for UserRecord {
    fn codec_name() -> &'static str {
        "users"
    }

    fn encode(&self) -> Vec<u8> {
        encode_record(self)
    }

    fn decode(buf: &[u8]) -> Result<Self> {
        decode_record(buf)
    }
}

impl From<UserRecord> for crate::domain::User {
    fn from(r: UserRecord) -> Self {
        Self {
            user_id: r.user_id,
            username: r.username,
            handle: r.handle,
            color: r.color,
            password_hash: r.password_hash,
            is_registered: r.is_registered,
            is_active: r.is_active,
            is_bot: false,
            created_at_micros: r.created_at_micros,
            last_seen_micros: r.last_seen_micros,
            profile_picture: r.profile_picture,
            username_font: r.username_font,
            bio: r.bio,
            status_message: r.status_message,
        }
    }
}

/// Versioned durable layout of [`UserRecord`]; see `format::versioned`.
const FORMAT: RecordFormat = RecordFormat::new(*b"USER", "users projection");

pub fn encode_record(r: &UserRecord) -> Vec<u8> {
    versioned::encode_v1(&FORMAT, r)
}

/// Pre-profile-fields layout (before profile_picture/username_font/bio/status_message).
/// Historical `user_registered` events on Tim/prod used this shape. Postcard is not
/// forward-compatible when new trailing fields are required, so decode must fall back.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct UserRecordV1 {
    user_id: u64,
    username: String,
    handle: Option<String>,
    color: String,
    password_hash: String,
    is_registered: bool,
    is_active: bool,
    created_at_micros: i64,
    last_seen_micros: i64,
}

impl From<UserRecordV1> for UserRecord {
    fn from(r: UserRecordV1) -> Self {
        Self {
            user_id: r.user_id,
            username: r.username,
            handle: r.handle,
            color: r.color,
            password_hash: r.password_hash,
            is_registered: r.is_registered,
            is_active: r.is_active,
            created_at_micros: r.created_at_micros,
            last_seen_micros: r.last_seen_micros,
            profile_picture: None,
            username_font: None,
            bio: None,
            status_message: None,
        }
    }
}

/// Decode a `UserRecord`. Versioned bytes decode by their version byte;
/// unversioned bytes (written before Task 3.1) use the old fallback below.
pub fn decode_record(buf: &[u8]) -> Result<UserRecord> {
    versioned::decode(
        &FORMAT,
        buf,
        |version, body| match version {
            1 => Some(versioned::payload(&FORMAT, body)),
            _ => None,
        },
        decode_unversioned,
    )
}

fn decode_unversioned(buf: &[u8]) -> Result<UserRecord> {
    // Prefer current schema, then legacy v1 (no profile fields).
    if let Ok(r) = postcard::from_bytes::<UserRecord>(buf) {
        return Ok(r);
    }
    if let Ok(r) = postcard::from_bytes::<UserRecordV1>(buf) {
        return Ok(UserRecord::from(r));
    }
    Err(crate::error::WabiError::Corrupt {
        location: "users projection".into(),
        detail: "postcard decode failed for UserRecord and UserRecordV1".into(),
    })
}

pub fn encode_key(user_id: u64) -> Vec<u8> {
    user_id.to_be_bytes().to_vec()
}

pub struct UsersProjection;

/// Admission only: older duplicate names remain replayable. The sequencer
/// isolates identity writes, so every check observes preceding applied names:
/// it reads committed rows, and a command reaches this check only after every
/// earlier identity command is applied and committed.
///
/// Only the rows a check can match are read: the accounts the command names
/// by id, and those whose stored name folds to a name the command uses. A
/// check never looks at any other row (it compares ids and folded names), so
/// this decides exactly as a check against every account would, in the same
/// order (key order, then the command's own registrations).
pub fn preflight_command(
    events: &[crate::sequencer::types::EventToWrite], state: &ProjectionState,
) -> Result<()> {
    if !events.iter().any(|event| matches!(event.event_type.as_str(), "user_registered" | "user_updated" | "owner_claimed")) {
        return Ok(());
    }
    let mut users = committed_rows_named_by(events, state)?;
    for event in events {
        if event.event_type == "owner_claimed" {
            let owner: crate::projections::owner::OwnerRecord = serde_json::from_slice(&event.plaintext)
                .map_err(|_| crate::error::WabiError::Validation {
                    command: "user_identity".into(), reason: "invalid ownership target".into(),
                })?;
            if !users.iter().any(|user| user.user_id == owner.owner_user_id && user.is_active
                && user.is_registered && !user.password_hash.is_empty()) {
                return Err(crate::error::WabiError::Validation {
                    command: "user_identity".into(), reason: "ownership target no longer qualifies".into(),
                });
            }
            continue;
        }
        if !matches!(event.event_type.as_str(), "user_registered" | "user_updated") { continue; }
        let record = decode_record(&event.plaintext)?;
        let registered = event.event_type == "user_registered";
        if !registered {
            let current = users.iter().find(|user| user.user_id == record.user_id)
                .ok_or_else(|| crate::error::WabiError::Validation {
                    command: "user_identity".into(), reason: "account no longer exists".into(),
                })?;
            if record.username.is_empty() || record.username.to_lowercase() == current.username.to_lowercase() {
                continue;
            }
        }
        if record.username.trim().is_empty() {
            return Err(crate::error::WabiError::Validation {
                command: "user_identity".into(), reason: "username cannot be empty".into(),
            });
        }
        let name = record.username.to_lowercase();
        if users.iter().any(|user| user.username.to_lowercase() == name && (registered || user.user_id != record.user_id)) {
            return Err(crate::error::WabiError::Validation {
                command: "user_identity".into(), reason: "username is already taken".into(),
            });
        }
        if registered { users.push(record); }
        else if let Some(current) = users.iter_mut().find(|user| user.user_id == record.user_id) {
            current.username = record.username;
        }
    }
    Ok(())
}

/// The committed accounts [`preflight_command`] can match for `events`, in
/// key order: those named by id (an ownership target, an updated account)
/// and those whose stored name folds to a name an event uses.
fn committed_rows_named_by(
    events: &[crate::sequencer::types::EventToWrite], state: &ProjectionState,
) -> Result<Vec<UserRecord>> {
    let mut ids = std::collections::BTreeSet::new();
    let mut names = std::collections::BTreeSet::new();
    for event in events {
        match event.event_type.as_str() {
            "owner_claimed" => {
                // An undecodable target is refused by the check itself.
                if let Ok(owner) = serde_json::from_slice::<crate::projections::owner::OwnerRecord>(&event.plaintext) {
                    ids.insert(owner.owner_user_id);
                }
            }
            "user_registered" | "user_updated" => {
                // An undecodable record is refused by the check itself.
                if let Ok(record) = decode_record(&event.plaintext) {
                    if event.event_type == "user_updated" {
                        ids.insert(record.user_id);
                    }
                    names.insert(record.username.to_lowercase());
                }
            }
            _ => {}
        }
    }
    let mut rows = std::collections::BTreeMap::new();
    state.read_model().read(|conn| {
        for id in &ids {
            let key = encode_key(*id);
            if let Some(bytes) = read_model::get(conn, Table::Users, &key)? {
                rows.insert(key, bytes);
            }
        }
        for name in &names {
            for (key, bytes) in read_model::users_by_username(conn, name)? {
                rows.insert(key, bytes);
            }
        }
        Ok(())
    })?;
    rows.values().map(|bytes| decode_record(bytes)).collect()
}

/// The stored bytes of an account, as of the last committed commit; `None`
/// when there is none. For reads outside projection application: admission
/// checks, the server, tools.
pub fn stored_record(state: &ProjectionState, user_id: u64) -> Result<Option<Vec<u8>>> {
    state
        .read_model()
        .read(|conn| read_model::get(conn, Table::Users, &encode_key(user_id)))
}

/// [`stored_record`] for a handler that is applying a commit: it sees the
/// rows that commit has written so far, and during startup replay everything
/// replay has written. A read that is not part of applying a commit must not
/// use it: it would see a commit before it is finished.
///
/// During startup replay a commit at or below the read model's replay floor
/// sees the rows of a LATER commit (the read model already holds them). A
/// caller that applies such a commit must not decide anything from them.
pub(crate) fn stored_while_applying(state: &ProjectionState, user_id: u64) -> Result<Option<Vec<u8>>> {
    state
        .read_model()
        .write(|conn| read_model::get(conn, Table::Users, &encode_key(user_id)))
}

/// Whether account `user_id` exists at `commit_seq`, for an in-memory
/// projection applying that commit (the game profiles).
///
/// Above the read model's replay floor this is [`stored_while_applying`].
/// At or below it (startup replay of a commit the read model already holds)
/// the table holds a later state, so the answer is worked out from that:
/// - a row that is there now, with an id at or below `commit_seq`, existed
///   then: an id is the commit that registered it, and ids are never reused;
///   a row with a higher id was registered after this commit;
/// - an account with no row now either never existed or is deleted by a
///   later commit, which replay also applies; whatever the in-memory
///   projection stores for it now, that deletion removes again, so `false`
///   ends replay in the same state as the live answer did.
///
/// A registration in the same commit, after the event that asks, would count
/// as existing. The adapter cannot write that: it learns the id only after
/// the registering commit.
pub(crate) fn existed_while_applying(state: &ProjectionState, user_id: u64, commit_seq: u64) -> Result<bool> {
    if commit_seq > state.read_model().replay_floor() {
        return Ok(stored_while_applying(state, user_id)?.is_some());
    }
    Ok(user_id <= commit_seq && stored_while_applying(state, user_id)?.is_some())
}

/// The `user_deleted` cascade: remove the account row of `user_id`. For the
/// user deletion handler while it applies a commit.
pub(crate) fn remove_while_applying(state: &ProjectionState, user_id: u64) -> Result<()> {
    state
        .read_model()
        .write(|conn| read_model::delete_user(conn, &encode_key(user_id)))
        .map(drop)
}

/// The accounts whose username equals `username` ignoring case (as
/// `str::to_lowercase` folds both), in key order, as of the last committed
/// commit. One indexed lookup, not a scan of every account. More than one
/// result means names that were duplicated before admission refused them.
pub fn find_by_username(state: &ProjectionState, username: &str) -> Result<Vec<UserRecord>> {
    let folded = username.to_lowercase();
    let rows = state
        .read_model()
        .read(|conn| read_model::users_by_username(conn, &folded))?;
    let mut found = Vec::with_capacity(rows.len());
    for (_key, bytes) in rows {
        let record = decode_record(&bytes)?;
        // The column is derived from the record; a row whose record says
        // otherwise was not written by this build.
        if record.username.to_lowercase() == folded {
            found.push(record);
        }
    }
    Ok(found)
}

/// Test support: store an account row as it is, bypassing the log (legacy
/// and corrupt rows no current event produces). The folded name is taken
/// from the record when it decodes, and is empty otherwise. The row is
/// committed at once. The engine must not be applying a commit; nothing here
/// checks that.
#[doc(hidden)]
pub fn insert_raw_for_tests(state: &ProjectionState, user_id: u64, record: &[u8]) {
    let folded = decode_record(record).map(|r| r.username.to_lowercase()).unwrap_or_default();
    let model = state.read_model();
    model.write(|conn| read_model::put_user(conn, &encode_key(user_id), &folded, record)).unwrap();
    model.finish_commit(state.applied_commit_seq()).unwrap();
}

/// Test support: remove an account row, bypassing the log; the counterpart
/// of [`insert_raw_for_tests`].
#[doc(hidden)]
pub fn remove_raw_for_tests(state: &ProjectionState, user_id: u64) {
    let model = state.read_model();
    model.write(|conn| read_model::delete_user(conn, &encode_key(user_id))).unwrap();
    model.finish_commit(state.applied_commit_seq()).unwrap();
}

impl Projection for UsersProjection {
    fn event_type(&self) -> &str {
        "user_registered"
    }

    fn event_types(&self) -> Vec<&str> {
        vec!["user_registered", "user_updated"]
    }

    fn stores_in_read_model(&self) -> bool {
        true
    }

    fn apply(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        // Startup replay begins at the snapshot of the in-memory projections.
        // The read model may already hold later commits; its own
        // `applied_commit_seq` says which.
        if event.commit_seq <= state.read_model().replay_floor() {
            return Ok(());
        }
        let mut record: UserRecord = decode_record(&event.payload)?;
        if event.event_type == "user_registered" {
            // Override with the commit_seq so the user_id is always unique
            // and matches what the adapter returned to the caller.
            record.user_id = event.commit_seq;
        } else {
            // user_updated patches an existing record in place.
            if let Some(existing_bytes) = stored_while_applying(state, record.user_id)? {
                if let Ok(mut existing) = decode_record(&existing_bytes) {
                    // Credential-only patches do not repeat a stale login name.
                    if !record.username.is_empty() && record.username != existing.username {
                        existing.username = record.username;
                    }
                    if let Some(color) = record.color.strip_prefix("\0") {
                        existing.color = color.to_string();
                    } else if !record.color.is_empty() {
                        existing.color = record.color.clone();
                    }
                    if record.profile_picture.is_some() {
                        existing.profile_picture = record.profile_picture.clone();
                    }
                    if record.username_font.is_some() {
                        existing.username_font = record.username_font.clone();
                    }
                    if record.bio.is_some() {
                        existing.bio = record.bio.clone();
                    }
                    if record.status_message.is_some() {
                        existing.status_message = record.status_message.clone();
                    }
                    // Non-empty password_hash in the event replaces the stored hash.
                    if !record.password_hash.is_empty()
                        && record.password_hash != existing.password_hash
                    {
                        existing.password_hash = record.password_hash.clone();
                    }
                    record = existing;
                }
            }
        }
        let key = encode_key(record.user_id);
        let value = encode_record(&record);
        let folded = record.username.to_lowercase();
        state.read_model().write(|conn| read_model::put_user(conn, &key, &folded, &value))
    }
}

impl QueryableProjection for UsersProjection {
    type Record = UserRecord;
    type Filter = UsersFilter;

    /// As of the last committed commit.
    fn query(&self, state: &ProjectionState, filter: &UsersFilter) -> Result<Vec<UserRecord>> {
        let mut results = Vec::new();
        match filter.user_id {
            // user_id is the full key, so this is a direct lookup.
            Some(user_id) => {
                if let Some(bytes) = stored_record(state, user_id)? {
                    let record = decode_record(&bytes)?;
                    if let Some(active) = filter.is_active {
                        if record.is_active != active {
                            return Ok(results);
                        }
                    }
                    results.push(record);
                }
            }
            None => {
                state.read_model().read(|conn| {
                    read_model::scan(conn, Table::Users, &[], None, false, |_key, value| {
                        let record = decode_record(value)?;
                        if filter.is_active.is_none_or(|active| record.is_active == active) {
                            results.push(record);
                        }
                        Ok(true)
                    })
                })?;
            }
        }
        apply_limit(&mut results, filter.limit);
        Ok(results)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Tripwire for `READ_MODEL_GENERATION`, as for the other projections
    /// stored in the read model. The hash covers every column of every users
    /// row for a fixed set of events that reaches every branch of the
    /// handler (registration, rename, colour cleared and set, password-only
    /// patch, profile fields, an update of an unknown account) and the
    /// `user_deleted` cascade. If it changes, replay now writes something
    /// else, and a read model written by the previous build would disagree
    /// with the log.
    ///
    /// When this fails: bump `READ_MODEL_GENERATION`, then update both values
    /// here together. Never update the hash alone.
    #[test]
    fn stored_rows_are_pinned_to_the_read_model_generation() {
        use crate::projections::user_deletion::{encode_payload, UserDeletionProjection};
        let state = ProjectionState::new();
        let user = |name: &str| UserRecord {
            user_id: 0,
            username: name.into(),
            handle: Some(name.to_lowercase()),
            color: "#98D8C8".into(),
            password_hash: format!("hash-{name}"),
            is_registered: true,
            is_active: true,
            created_at_micros: 10,
            last_seen_micros: 20,
            profile_picture: None,
            username_font: None,
            bio: None,
            status_message: None,
        };
        let patch = |user_id| UserRecord {
            user_id,
            username: String::new(),
            handle: None,
            color: String::new(),
            password_hash: String::new(),
            is_registered: false,
            is_active: false,
            created_at_micros: 0,
            last_seen_micros: 0,
            profile_picture: None,
            username_font: None,
            bio: None,
            status_message: None,
        };
        let apply = |commit_seq, event_type: &str, record: UserRecord| {
            UsersProjection
                .apply(
                    &DurableEvent {
                        commit_seq,
                        stream_id: "users".into(),
                        event_type: event_type.into(),
                        payload: encode_record(&record),
                    },
                    &state,
                )
                .unwrap()
        };
        apply(1, "user_registered", user("Alice"));
        apply(2, "user_registered", user("bob"));
        apply(3, "user_registered", user("ÉMILE"));
        apply(4, "user_updated", UserRecord { username: "ALICIA".into(), color: "\0".into(), ..patch(1) });
        apply(5, "user_updated", UserRecord { password_hash: "new".into(), color: "#000000".into(), ..patch(2) });
        apply(6, "user_updated", UserRecord {
            profile_picture: Some("p".into()),
            username_font: Some("f".into()),
            bio: Some("b".into()),
            status_message: Some("s".into()),
            ..patch(3)
        });
        apply(7, "user_updated", UserRecord { username: "stray".into(), ..patch(70) });
        UserDeletionProjection
            .apply(
                &DurableEvent {
                    commit_seq: 8,
                    stream_id: "users".into(),
                    event_type: "user_deleted".into(),
                    payload: encode_payload(&crate::domain::UserDeleted { user_id: 2 }),
                },
                &state,
            )
            .unwrap();

        let mut hash = blake3::Hasher::new();
        let mut rows = 0;
        state
            .read_model()
            .for_each_full_row(Table::Users, |columns| {
                rows += 1;
                for bytes in columns {
                    hash.update(&(bytes.len() as u64).to_le_bytes());
                    hash.update(bytes);
                }
                Ok(())
            })
            .unwrap();
        assert_eq!(rows, 3, "alice, emile, the stray patch");
        let stored = hash.finalize().to_hex().to_string();
        println!("generation {} rows {stored}", read_model::READ_MODEL_GENERATION);
        assert_eq!(
            (read_model::READ_MODEL_GENERATION, stored.as_str()),
            (4, "8a1f5e09fa2d81e48ec122a8d0e3ae895d0138b01fa14ebce8a5a67ec850d4dd"),
            "replay stores different rows: bump READ_MODEL_GENERATION and update this pin with it"
        );
    }

    #[test]
    fn encode_decode_roundtrip() {
        let r = UserRecord {
            user_id: 42,
            username: "alice".into(),
            handle: Some("alice_handle".into()),
            color: "blue".into(),
            password_hash: "argon2:hash".into(),
            is_registered: true,
            is_active: true,
            created_at_micros: 1_000_000,
            last_seen_micros: 2_000_000,
            profile_picture: None,
            username_font: None,
            bio: None,
            status_message: None,
        };
        let buf = encode_record(&r);
        let decoded = decode_record(&buf).unwrap();
        assert_eq!(r, decoded);
    }

    #[test]
    fn encode_decode_no_handle() {
        let r = UserRecord {
            user_id: 7,
            username: "bob".into(),
            handle: None,
            color: "red".into(),
            password_hash: "hash".into(),
            is_registered: true,
            is_active: false,
            created_at_micros: 1_000_000,
            last_seen_micros: 1_000_000,
            profile_picture: None,
            username_font: None,
            bio: None,
            status_message: None,
        };
        let buf = encode_record(&r);
        let decoded = decode_record(&buf).unwrap();
        assert_eq!(r, decoded);
        assert_eq!(decoded.handle, None);
        assert!(!decoded.is_active);
    }

    #[test]
    fn decode_legacy_v1_user_record() {
        let legacy = UserRecordV1 {
            user_id: 0,
            username: "wabi".into(),
            handle: Some("wabi".into()),
            color: "#98D8C8".into(),
            password_hash: "$2b$12$legacyhash".into(),
            is_registered: true,
            is_active: true,
            created_at_micros: 1_000_000,
            last_seen_micros: 1_000_000,
        };
        let buf = postcard::to_allocvec(&legacy).unwrap();
        // Must not require the newer trailing Option fields.
        let decoded = decode_record(&buf).expect("v1 fallback decode");
        assert_eq!(decoded.username, "wabi");
        assert_eq!(decoded.password_hash, "$2b$12$legacyhash");
        assert_eq!(decoded.profile_picture, None);
        assert_eq!(decoded.bio, None);

        // Typed list/direct queries must retain the same legacy fallback.
        let state = ProjectionState::new();
        insert_raw_for_tests(&state, legacy.user_id, &buf);
        assert_eq!(UsersProjection.query(&state, &UsersFilter::default()).unwrap(), vec![decoded.clone()]);
        assert_eq!(UsersProjection.query(&state, &UsersFilter { user_id: Some(legacy.user_id), ..Default::default() }).unwrap(), vec![decoded]);
    }

    #[test]
    fn typed_queries_reject_corrupt_users_instead_of_hiding_accounts() {
        let state = ProjectionState::new();
        insert_raw_for_tests(&state, 42, &[0xff]);
        for filter in [UsersFilter::default(), UsersFilter { user_id: Some(42), ..Default::default() },
            UsersFilter { is_active: Some(true), limit: Some(1), ..Default::default() }] {
            assert!(UsersProjection.query(&state, &filter).is_err());
        }
    }

    #[test]
    fn insert_and_lookup() {
        let state = ProjectionState::new();
        let proj = UsersProjection;

        let r = UserRecord {
            user_id: 42,
            username: "alice".into(),
            handle: None,
            color: "blue".into(),
            password_hash: "hash".into(),
            is_registered: true,
            is_active: true,
            created_at_micros: 1_000_000,
            last_seen_micros: 1_000_000,
            profile_picture: None,
            username_font: None,
            bio: None,
            status_message: None,
        };

        let event = DurableEvent {
            commit_seq: 1,
            stream_id: "users".into(),
            event_type: "user_registered".into(),
            payload: encode_record(&r),
        };

        proj.apply(&event, &state).unwrap();

        // handler overrides user_id with commit_seq
        let stored = stored_record(&state, 1).unwrap().unwrap();
        let decoded = decode_record(&stored).unwrap();
        assert_eq!(decoded.user_id, 1);
        assert_eq!(decoded.username, "alice");
    }

    #[test]
    fn missing_returns_none() {
        let state = ProjectionState::new();
        assert!(stored_record(&state, 99).unwrap().is_none());
    }

    #[test]
    fn event_type_returns_correct() {
        let proj = UsersProjection;
        assert_eq!(proj.event_type(), "user_registered");
    }

    #[test]
    fn bad_payload_returns_error() {
        let state = ProjectionState::new();
        let event = DurableEvent {
            commit_seq: 1,
            stream_id: "users".into(),
            event_type: "user_registered".into(),
            payload: vec![0xff, 0xff],
        };
        let result = UsersProjection.apply(&event, &state);
        assert!(result.is_err());
    }

    #[test]
    fn encode_key_is_big_endian() {
        let key = encode_key(42);
        assert_eq!(key.len(), 8);
        assert_eq!(key, 42u64.to_be_bytes().to_vec());
    }

    #[test]
    fn query_by_user_id_lookup() {
        let state = ProjectionState::new();
        let proj = UsersProjection;
        // The apply path overrides user_id with commit_seq, so insert via events.
        for seq in 1..=3u64 {
            let r = UserRecord {
                user_id: seq, username: format!("u{seq}").into(), handle: None, color: "blue".into(),
                password_hash: "h".into(), is_registered: true, is_active: seq != 2,
                created_at_micros: 1, last_seen_micros: 1,
                profile_picture: None, username_font: None, bio: None, status_message: None,
            };
            proj.apply(&DurableEvent { commit_seq: seq, stream_id: "users".into(), event_type: "user_registered".into(), payload: encode_record(&r) }, &state).unwrap();
        }
        // commit_seq 1 -> user_id 1, seq 2 -> user_id 2, seq 3 -> user_id 3
        let one = proj.query(&state, &UsersFilter { user_id: Some(1), ..Default::default() }).unwrap();
        assert_eq!(one.len(), 1);
        assert_eq!(one[0].username, "u1");

        let active = proj.query(&state, &UsersFilter { is_active: Some(true), ..Default::default() }).unwrap();
        assert_eq!(active.len(), 2);
        assert!(active.iter().all(|u| u.is_active));
    }

    #[test]
    fn query_limit_truncates() {
        let state = ProjectionState::new();
        let proj = UsersProjection;
        for seq in 1..=5u64 {
            let r = UserRecord {
                user_id: seq, username: format!("u{seq}").into(), handle: None, color: "blue".into(),
                password_hash: "h".into(), is_registered: true, is_active: true,
                created_at_micros: 1, last_seen_micros: 1,
                profile_picture: None, username_font: None, bio: None, status_message: None,
            };
            proj.apply(&DurableEvent { commit_seq: seq, stream_id: "users".into(), event_type: "user_registered".into(), payload: encode_record(&r) }, &state).unwrap();
        }
        let results = proj.query(&state, &UsersFilter { limit: Some(2), ..Default::default() }).unwrap();
        assert_eq!(results.len(), 2);
    }
}
