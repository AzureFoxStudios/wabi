use crate::engine::locks::ProjectionState;
use crate::error::Result;
use crate::projections::codec::RecordCodec;
use crate::projections::handler::{DurableEvent, Projection};
use crate::projections::query::{apply_limit, UsersFilter, QueryableProjection};
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

pub fn encode_record(r: &UserRecord) -> Vec<u8> {
    postcard::to_allocvec(r).expect("postcard serialization failed")
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

pub fn decode_record(buf: &[u8]) -> Result<UserRecord> {
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

impl Projection for UsersProjection {
    fn event_type(&self) -> &str {
        "user_registered"
    }

    fn event_types(&self) -> Vec<&str> {
        vec!["user_registered", "user_updated"]
    }

    fn apply(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        let mut record: UserRecord = decode_record(&event.payload)?;
        if event.event_type == "user_registered" {
            // Override with the commit_seq so the user_id is always unique
            // and matches what the adapter returned to the caller.
            record.user_id = event.commit_seq;
        } else {
            // user_updated patches an existing record in place.
            let key = encode_key(record.user_id);
            if let Some(existing_bytes) = state.get("users", &key) {
                if let Ok(mut existing) = decode_record(&existing_bytes) {
                    if record.username != existing.username {
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
        state.insert("users", key, value, event.commit_seq);
        Ok(())
    }
}

impl QueryableProjection for UsersProjection {
    type Record = UserRecord;
    type Filter = UsersFilter;

    fn query(&self, state: &ProjectionState, filter: &UsersFilter) -> Result<Vec<UserRecord>> {
        let mut results = Vec::new();
        match filter.user_id {
            // user_id is the full key, so this is a direct lookup.
            Some(user_id) => {
                let key = encode_key(user_id);
                if let Some(bytes) = state.get("users", &key) {
                    if let Ok(record) = decode_record(&bytes) {
                        if let Some(active) = filter.is_active {
                            if record.is_active != active {
                                return Ok(results);
                            }
                        }
                        results.push(record);
                    }
                }
            }
            None => {
                state.for_each("users", |_key, value| {
                    if let Ok(record) = decode_record(value) {
                        if let Some(active) = filter.is_active {
                            if record.is_active != active {
                                return;
                            }
                        }
                        results.push(record);
                    }
                });
            }
        }
        apply_limit(&mut results, filter.limit);
        Ok(results)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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

        let key = encode_key(1); // handler overrides user_id with commit_seq
        let stored = state.get("users", &key).unwrap();
        let decoded = decode_record(&stored).unwrap();
        assert_eq!(decoded.user_id, 1);
        assert_eq!(decoded.username, "alice");
    }

    #[test]
    fn missing_returns_none() {
        let state = ProjectionState::new();
        let key = encode_key(99);
        assert!(state.get("users", &key).is_none());
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
