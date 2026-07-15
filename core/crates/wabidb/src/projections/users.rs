use crate::engine::locks::ProjectionState;
use crate::error::Result;
use crate::projections::codec::RecordCodec;
use crate::projections::handler::{DurableEvent, Projection};
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
            created_at_micros: r.created_at_micros,
            last_seen_micros: r.last_seen_micros,
        }
    }
}

pub fn encode_record(r: &UserRecord) -> Vec<u8> {
    postcard::to_allocvec(r).expect("postcard serialization failed")
}

pub fn decode_record(buf: &[u8]) -> Result<UserRecord> {
    postcard::from_bytes(buf).map_err(|e| crate::error::WabiError::Corrupt {
        location: "users projection".into(),
        detail: format!("postcard decode failed: {e}"),
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

    fn apply(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        let mut record: UserRecord = decode_record(&event.payload)?;
        // Override with the commit_seq so the user_id is always unique
        // and matches what the adapter returned to the caller.
        record.user_id = event.commit_seq;
        let key = encode_key(record.user_id);
        let value = encode_record(&record);
        state.insert("users", key, value, event.commit_seq);
        Ok(())
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
        };
        let buf = encode_record(&r);
        let decoded = decode_record(&buf).unwrap();
        assert_eq!(r, decoded);
        assert_eq!(decoded.handle, None);
        assert!(!decoded.is_active);
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
}
