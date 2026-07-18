use crate::engine::locks::ProjectionState;
use crate::error::Result;
use crate::projections::codec::RecordCodec;
use crate::projections::handler::{DurableEvent, Projection};
use crate::projections::query::{apply_limit, DmMessagesFilter, QueryableProjection};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DmMessageRecord {
    pub dm_id: String,
    pub message_id: String,
    pub author_user_id: u64,
    pub author_device_id: String,
    pub created_at_micros: i64,
    pub encrypted_body_ref: String,
    pub idempotency_key: Option<String>,
    pub edit_history: Vec<(i64, String)>,
}

impl RecordCodec for DmMessageRecord {
    fn codec_name() -> &'static str {
        "dm_messages"
    }
}

pub fn encode_record(r: &DmMessageRecord) -> Vec<u8> {
    postcard::to_allocvec(r).expect("postcard serialization failed")
}

pub fn decode_record(buf: &[u8]) -> Result<DmMessageRecord> {
    postcard::from_bytes(buf).map_err(|e| crate::error::WabiError::Corrupt {
        location: "dm_messages projection".into(),
        detail: format!("postcard decode failed: {e}"),
    })
}

pub fn encode_key(dm_id: &str, message_id: &str) -> Vec<u8> {
    let mut buf = Vec::new();
    buf.extend_from_slice(&(dm_id.len() as u64).to_le_bytes());
    buf.extend_from_slice(dm_id.as_bytes());
    buf.extend_from_slice(&(message_id.len() as u64).to_le_bytes());
    buf.extend_from_slice(message_id.as_bytes());
    buf
}

impl DmMessagesProjection {
    /// Look up a single DM message.
    pub fn get_message(state: &ProjectionState, dm_id: &str, message_id: &str) -> Result<Option<DmMessageRecord>> {
        let key = encode_key(dm_id, message_id);
        match state.get("dm_messages", &key) {
            None => Ok(None),
            Some(bytes) => decode_record(&bytes).map(Some),
        }
    }

    /// List all messages in a DM conversation.
    pub fn list_messages(state: &ProjectionState, dm_id: &str) -> Result<Vec<DmMessageRecord>> {
        let mut prefix = Vec::new();
        prefix.extend_from_slice(&(dm_id.len() as u64).to_le_bytes());
        prefix.extend_from_slice(dm_id.as_bytes());
        let mut results = Vec::new();
        state.prefix_scan("dm_messages", &prefix, |_key, value| {
            if let Ok(record) = decode_record(value) {
                results.push(record);
            }
        });
        Ok(results)
    }
}

pub struct DmMessagesProjection;

impl Projection for DmMessagesProjection {
    fn event_type(&self) -> &str {
        "dm_message_created"
    }

    fn apply(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        let record: DmMessageRecord = decode_record(&event.payload)?;
        let key = encode_key(&record.dm_id, &record.message_id);
        let value = encode_record(&record);
        state.insert("dm_messages", key, value, event.commit_seq);
        Ok(())
    }
}

impl QueryableProjection for DmMessagesProjection {
    type Record = DmMessageRecord;
    type Filter = DmMessagesFilter;

    fn query(&self, state: &ProjectionState, filter: &DmMessagesFilter) -> Result<Vec<DmMessageRecord>> {
        let mut results = Vec::new();
        match &filter.dm_id {
            // dm_id is the leading key component, so this is a prefix scan.
            Some(dm_id) => {
                let mut prefix = Vec::new();
                prefix.extend_from_slice(&(dm_id.len() as u64).to_le_bytes());
                prefix.extend_from_slice(dm_id.as_bytes());
                state.prefix_scan("dm_messages", &prefix, |_key, value| {
                    if let Ok(record) = decode_record(value) {
                        if let Some(author) = filter.author_id {
                            if record.author_user_id != author {
                                return;
                            }
                        }
                        results.push(record);
                    }
                });
            }
            None => {
                state.for_each("dm_messages", |_key, value| {
                    if let Ok(record) = decode_record(value) {
                        if let Some(author) = filter.author_id {
                            if record.author_user_id != author {
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
        let r = DmMessageRecord {
            dm_id: "dm_01".into(),
            message_id: "msg_01".into(),
            author_user_id: 100,
            author_device_id: "dev_a".into(),
            created_at_micros: 2_000_000,
            encrypted_body_ref: "hash123".into(),
            idempotency_key: None,
            edit_history: vec![],
        };
        let buf = encode_record(&r);
        let decoded = decode_record(&buf).unwrap();
        assert_eq!(r, decoded);
    }

    #[test]
    fn insert_and_lookup() {
        let state = ProjectionState::new();
        let proj = DmMessagesProjection;

        let r = DmMessageRecord {
            dm_id: "dm_01".into(),
            message_id: "msg_01".into(),
            author_user_id: 100,
            author_device_id: "dev_a".into(),
            created_at_micros: 2_000_000,
            encrypted_body_ref: "hash123".into(),
            idempotency_key: None,
            edit_history: vec![],
        };

        let event = DurableEvent {
            commit_seq: 1,
            stream_id: "dm_01".into(),
            event_type: "dm_message_created".into(),
            payload: encode_record(&r),
        };

        proj.apply(&event, &state).unwrap();

        let key = encode_key("dm_01", "msg_01");
        let stored = state.get("dm_messages", &key).unwrap();
        let decoded = decode_record(&stored).unwrap();
        assert_eq!(decoded.message_id, "msg_01");
        assert_eq!(decoded.author_user_id, 100);
    }

    #[test]
    fn missing_returns_none() {
        let state = ProjectionState::new();
        let key = encode_key("dm_99", "msg_99");
        assert!(state.get("dm_messages", &key).is_none());
    }

    #[test]
    fn event_type_returns_correct() {
        let proj = DmMessagesProjection;
        assert_eq!(proj.event_type(), "dm_message_created");
    }

    #[test]
    fn typed_get_dm_message_after_insert() {
        let state = ProjectionState::new();
        let proj = DmMessagesProjection;
        let r = DmMessageRecord {
            dm_id: "dm_01".into(),
            message_id: "msg_01".into(),
            author_user_id: 100,
            author_device_id: "dev_a".into(),
            created_at_micros: 2_000_000,
            encrypted_body_ref: "hash123".into(),
            idempotency_key: None,
            edit_history: vec![],
        };
        let event = DurableEvent {
            commit_seq: 1,
            stream_id: "dm_01".into(),
            event_type: "dm_message_created".into(),
            payload: encode_record(&r),
        };
        proj.apply(&event, &state).unwrap();
        let loaded = DmMessagesProjection::get_message(&state, "dm_01", "msg_01").unwrap().unwrap();
        assert_eq!(loaded.message_id, "msg_01");
        assert_eq!(loaded.author_user_id, 100);
    }

    #[test]
    fn typed_list_dm_messages_returns_all() {
        let state = ProjectionState::new();
        let proj = DmMessagesProjection;
        for i in 1..=3 {
            let r = DmMessageRecord {
                dm_id: "dm_01".into(),
                message_id: format!("msg_{i:02}"),
                author_user_id: 100 + i,
                author_device_id: "dev".into(),
                created_at_micros: (i * 1_000_000) as i64,
                encrypted_body_ref: "hash".into(),
                idempotency_key: None,
                edit_history: vec![],
            };
            proj.apply(
                &DurableEvent {
                    commit_seq: i,
                    stream_id: "dm_01".into(),
                    event_type: "dm_message_created".into(),
                    payload: encode_record(&r),
                },
                &state,
            )
            .unwrap();
        }
        let msgs = DmMessagesProjection::list_messages(&state, "dm_01").unwrap();
        assert_eq!(msgs.len(), 3);
    }

    #[test]
    fn query_by_dm_id_prefix() {
        let state = ProjectionState::new();
        let proj = DmMessagesProjection;
        for i in 1..=3 {
            let r = DmMessageRecord { dm_id: "dm_01".into(), message_id: format!("msg_{i:02}"), author_user_id: 100 + i, author_device_id: "dev".into(), created_at_micros: (i * 1_000_000) as i64, encrypted_body_ref: "hash".into(), idempotency_key: None, edit_history: vec![] };
            proj.apply(&DurableEvent { commit_seq: i, stream_id: "dm_01".into(), event_type: "dm_message_created".into(), payload: encode_record(&r) }, &state).unwrap();
        }
        // A message in another DM must not appear.
        let other = DmMessageRecord { dm_id: "dm_99".into(), message_id: "msg_99".into(), author_user_id: 200, author_device_id: "dev".into(), created_at_micros: 1, encrypted_body_ref: "h".into(), idempotency_key: None, edit_history: vec![] };
        proj.apply(&DurableEvent { commit_seq: 9, stream_id: "dm_99".into(), event_type: "dm_message_created".into(), payload: encode_record(&other) }, &state).unwrap();

        let results = proj.query(&state, &DmMessagesFilter { dm_id: Some("dm_01".into()), ..Default::default() }).unwrap();
        assert_eq!(results.len(), 3);
        assert!(results.iter().all(|m| m.dm_id == "dm_01"));
    }

    #[test]
    fn query_by_author_filters() {
        let state = ProjectionState::new();
        let proj = DmMessagesProjection;
        for i in 1..=3 {
            let r = DmMessageRecord { dm_id: "dm_01".into(), message_id: format!("msg_{i:02}"), author_user_id: 7, author_device_id: "dev".into(), created_at_micros: (i * 1_000_000) as i64, encrypted_body_ref: "hash".into(), idempotency_key: None, edit_history: vec![] };
            proj.apply(&DurableEvent { commit_seq: i, stream_id: "dm_01".into(), event_type: "dm_message_created".into(), payload: encode_record(&r) }, &state).unwrap();
        }
        let results = proj.query(&state, &DmMessagesFilter { dm_id: Some("dm_01".into()), author_id: Some(7), ..Default::default() }).unwrap();
        assert_eq!(results.len(), 3);
        assert!(results.iter().all(|m| m.author_user_id == 7));
        // A different author in the same dm returns nothing.
        let none = proj.query(&state, &DmMessagesFilter { dm_id: Some("dm_01".into()), author_id: Some(999), ..Default::default() }).unwrap();
        assert!(none.is_empty());
    }

    #[test]
    fn query_limit_truncates() {
        let state = ProjectionState::new();
        let proj = DmMessagesProjection;
        for i in 1..=4 {
            let r = DmMessageRecord { dm_id: "dm_01".into(), message_id: format!("msg_{i:02}"), author_user_id: 7, author_device_id: "dev".into(), created_at_micros: (i * 1_000_000) as i64, encrypted_body_ref: "hash".into(), idempotency_key: None, edit_history: vec![] };
            proj.apply(&DurableEvent { commit_seq: i, stream_id: "dm_01".into(), event_type: "dm_message_created".into(), payload: encode_record(&r) }, &state).unwrap();
        }
        let results = proj.query(&state, &DmMessagesFilter { dm_id: Some("dm_01".into()), author_id: None, limit: Some(2) }).unwrap();
        assert_eq!(results.len(), 2);
    }
}
