use crate::engine::locks::ProjectionState;
use crate::error::Result;
use crate::projections::codec::RecordCodec;
use crate::projections::handler::{DurableEvent, Projection};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MessageRecord {
    pub message_id: String,
    pub channel_id: String,
    pub author_user_id: u64,
    pub author_device_id: String,
    pub created_at_micros: i64,
    pub encrypted_body_ref: String,
    pub idempotency_key: Option<String>,
    pub edit_history: Vec<(i64, String)>,
    pub edited_at_micros: Option<i64>,
    pub is_deleted: bool,
    /// When true the message is hidden behind a spoiler veil by default.
    /// Added after the initial schema; missing on older on-disk records,
    /// which decode via `MessageRecordV0` and default to `false`.
    pub is_spoiler: bool,
}

/// Pre-`is_spoiler` schema, used as a fallback so messages written before
/// the field existed still decode (defaulting `is_spoiler` to `false`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct MessageRecordV0 {
    pub message_id: String,
    pub channel_id: String,
    pub author_user_id: u64,
    pub author_device_id: String,
    pub created_at_micros: i64,
    pub encrypted_body_ref: String,
    pub idempotency_key: Option<String>,
    pub edit_history: Vec<(i64, String)>,
    pub edited_at_micros: Option<i64>,
    pub is_deleted: bool,
}

impl RecordCodec for MessageRecord {
    fn codec_name() -> &'static str {
        "messages"
    }
}

impl From<MessageRecord> for crate::domain::Message {
    fn from(r: MessageRecord) -> Self {
        Self {
            message_id: r.message_id,
            channel_id: r.channel_id,
            author_user_id: r.author_user_id,
            author_username: None,
            author_display_name: None,
            author_device_id: r.author_device_id,
            content: r.encrypted_body_ref,
            message_type: "text".to_string(),
            created_at_micros: r.created_at_micros,
            edited_at_micros: r.edited_at_micros,
            commit_seq: 0,
            is_deleted: r.is_deleted,
            is_spoiler: r.is_spoiler,
        }
    }
}

impl From<crate::domain::Message> for MessageRecord {
    fn from(m: crate::domain::Message) -> Self {
        Self {
            message_id: m.message_id,
            channel_id: m.channel_id,
            author_user_id: m.author_user_id,
            author_device_id: m.author_device_id,
            created_at_micros: m.created_at_micros,
            encrypted_body_ref: m.content,
            idempotency_key: None,
            edit_history: vec![],
            edited_at_micros: m.edited_at_micros,
            is_deleted: m.is_deleted,
            is_spoiler: m.is_spoiler,
        }
    }
}

pub fn encode_record(r: &MessageRecord) -> Vec<u8> {
    postcard::to_allocvec(r).expect("postcard serialization failed")
}

pub fn decode_record(buf: &[u8]) -> Result<MessageRecord> {
    decode_record_lenient(buf)
}

/// Decode a `MessageRecord`, falling back to the pre-`is_spoiler` schema so
/// on-disk records written before the field existed still load (with
/// `is_spoiler` defaulting to `false`).
pub fn decode_record_lenient(buf: &[u8]) -> Result<MessageRecord> {
    match postcard::from_bytes::<MessageRecord>(buf) {
        Ok(r) => Ok(r),
        Err(_) => {
            let v0 = postcard::from_bytes::<MessageRecordV0>(buf).map_err(|e| {
                crate::error::WabiError::Corrupt {
                    location: "messages projection".into(),
                    detail: format!("postcard decode failed: {e}"),
                }
            })?;
            Ok(MessageRecord {
                message_id: v0.message_id,
                channel_id: v0.channel_id,
                author_user_id: v0.author_user_id,
                author_device_id: v0.author_device_id,
                created_at_micros: v0.created_at_micros,
                encrypted_body_ref: v0.encrypted_body_ref,
                idempotency_key: v0.idempotency_key,
                edit_history: v0.edit_history,
                edited_at_micros: v0.edited_at_micros,
                is_deleted: v0.is_deleted,
                is_spoiler: false,
            })
        }
    }
}

pub fn encode_key(channel_id: &str, message_id: &str) -> Vec<u8> {
    let mut buf = Vec::new();
    buf.extend_from_slice(&(channel_id.len() as u64).to_le_bytes());
    buf.extend_from_slice(channel_id.as_bytes());
    buf.extend_from_slice(&(message_id.len() as u64).to_le_bytes());
    buf.extend_from_slice(message_id.as_bytes());
    buf
}

pub struct MessagesProjection;

impl Projection for MessagesProjection {
    fn event_type(&self) -> &str {
        "message_created"
    }

    fn event_types(&self) -> Vec<&str> {
        vec!["message_created", "message_edited", "message_deleted"]
    }

    fn apply(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        match event.event_type.as_str() {
            "message_created" => self.apply_created(event, state),
            "message_edited" => self.apply_edited(event, state),
            "message_deleted" => self.apply_deleted(event, state),
            _ => Ok(()),
        }
    }
}

impl MessagesProjection {
    /// Look up a single message by its channel and message ID.
    pub fn get_message(state: &ProjectionState, channel_id: &str, message_id: &str) -> Result<Option<MessageRecord>> {
        let key = encode_key(channel_id, message_id);
        match state.get("messages", &key) {
            None => Ok(None),
            Some(bytes) => decode_record(&bytes).map(Some),
        }
    }

    /// List messages in a channel. When `include_deleted` is false (the
    /// common case), soft-deleted records are filtered out.
    pub fn list_messages(state: &ProjectionState, channel_id: &str, include_deleted: bool) -> Result<Vec<MessageRecord>> {
        let mut prefix = Vec::new();
        prefix.extend_from_slice(&(channel_id.len() as u64).to_le_bytes());
        prefix.extend_from_slice(channel_id.as_bytes());
        let mut results = Vec::new();
        state.prefix_scan("messages", &prefix, |_key, value| {
            if let Ok(record) = decode_record(value) {
                if include_deleted || !record.is_deleted {
                    results.push(record);
                }
            }
        });
        Ok(results)
    }

    /// Remove all soft-deleted records from the `messages` index and return
    /// the number of entries removed.
    pub fn compact(state: &ProjectionState) -> usize {
        state.compact_index("messages", |_key, value| {
            decode_record_lenient(value)
                .ok()
                .map_or(false, |r| r.is_deleted)
        })
    }

    fn apply_created(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        let mut record: MessageRecord = decode_record(&event.payload)?;
        record.message_id = format!("msg_{:x}", event.commit_seq);
        let key = encode_key(&record.channel_id, &record.message_id);
        let value = encode_record(&record);
        state.insert("messages", key, value, event.commit_seq);
        Ok(())
    }

    fn apply_edited(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        let update: MessageRecord = decode_record(&event.payload)?;
        // Reconstruct the composite key from the update's channel + message id.
        let key = encode_key(&update.channel_id, &update.message_id);
        let value = encode_record(&update);
        state.insert("messages", key, value, event.commit_seq);
        Ok(())
    }

    fn apply_deleted(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        let update: MessageRecord = decode_record(&event.payload)?;
        let key = encode_key(&update.channel_id, &update.message_id);
        let value = encode_record(&update);
        state.insert("messages", key, value, event.commit_seq);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_msg() -> MessageRecord {
        MessageRecord {
            message_id: "msg_01".into(),
            channel_id: "ch_01".into(),
            author_user_id: 42,
            author_device_id: "dev_abc".into(),
            created_at_micros: 1_000_000,
            encrypted_body_ref: "blake3_hash_xyz".into(),
            idempotency_key: Some("ikey_1".into()),
            edit_history: vec![(500_000, "old_body".into())],
            edited_at_micros: Some(600_000),
            is_deleted: false,
            is_spoiler: false,
        }
    }

    #[test]
    fn encode_decode_roundtrip() {
        let r = sample_msg();
        let buf = encode_record(&r);
        let decoded = decode_record(&buf).unwrap();
        assert_eq!(r, decoded);
    }

    #[test]
    fn encode_decode_no_idempotency() {
        let r = MessageRecord {
            message_id: "msg_02".into(),
            channel_id: "ch_02".into(),
            author_user_id: 7,
            author_device_id: "dev_xyz".into(),
            created_at_micros: 2_000_000,
            encrypted_body_ref: "hash2".into(),
            idempotency_key: None,
            edit_history: vec![],
            edited_at_micros: None,
            is_deleted: false,
            is_spoiler: false,
        };
        let buf = encode_record(&r);
        let decoded = decode_record(&buf).unwrap();
        assert_eq!(r, decoded);
    }

    #[test]
    fn encode_decode_is_deleted() {
        let r = MessageRecord {
            is_deleted: true,
            ..sample_msg()
        };
        let buf = encode_record(&r);
        let decoded = decode_record(&buf).unwrap();
        assert_eq!(r, decoded);
        assert!(decoded.is_deleted);
    }

    /// Records written before the `is_spoiler` field existed must still
    /// decode (defaulting `is_spoiler` to `false`) so existing on-disk data
    /// survives the schema addition.
    #[test]
    fn decode_legacy_record_without_is_spoiler() {
        let legacy = MessageRecordV0 {
            message_id: "msg_legacy".into(),
            channel_id: "ch_legacy".into(),
            author_user_id: 7,
            author_device_id: "dev".into(),
            created_at_micros: 1_000_000,
            encrypted_body_ref: "body".into(),
            idempotency_key: None,
            edit_history: vec![],
            edited_at_micros: None,
            is_deleted: false,
        };
        let buf = postcard::to_allocvec(&legacy).unwrap();
        let decoded = decode_record(&buf).unwrap();
        assert_eq!(decoded.message_id, "msg_legacy");
        assert!(!decoded.is_spoiler);
    }

    fn make_event(seq: u64, event_type: &str, record: &MessageRecord) -> DurableEvent {
        DurableEvent {
            commit_seq: seq,
            stream_id: record.channel_id.clone(),
            event_type: event_type.to_string(),
            payload: encode_record(record),
        }
    }

    #[test]
    fn insert_and_lookup() {
        let state = ProjectionState::new();
        let proj = MessagesProjection;

        let r = MessageRecord {
            message_id: "msg_01".into(),
            channel_id: "ch_01".into(),
            author_user_id: 42,
            author_device_id: "dev_abc".into(),
            created_at_micros: 1_000_000,
            encrypted_body_ref: "hash".into(),
            idempotency_key: None,
            edit_history: vec![],
            edited_at_micros: None,
            is_deleted: false,
            is_spoiler: false,
        };

        let event = make_event(1, "message_created", &r);
        proj.apply(&event, &state).unwrap();

        // message_id is overridden to format!("msg_{:x}", commit_seq)
        let expected_msg_id = format!("msg_{:x}", event.commit_seq);
        let key = encode_key("ch_01", &expected_msg_id);
        let stored = state.get("messages", &key).unwrap();
        let decoded = decode_record(&stored).unwrap();
        assert_eq!(decoded.message_id, expected_msg_id);
        assert_eq!(decoded.author_user_id, 42);
    }

    #[test]
    fn edit_overwrites_record() {
        let state = ProjectionState::new();
        let proj = MessagesProjection;

        let r = MessageRecord {
            message_id: String::new(), // projection overrides from commit_seq
            channel_id: "ch_01".into(),
            author_user_id: 42,
            author_device_id: "dev_abc".into(),
            created_at_micros: 1_000_000,
            encrypted_body_ref: "original".into(),
            idempotency_key: None,
            edit_history: vec![],
            edited_at_micros: None,
            is_deleted: false,
            is_spoiler: false,
        };
        let create_event = make_event(1, "message_created", &r);
        proj.apply(&create_event, &state).unwrap();

        let stored_key = encode_key("ch_01", &format!("msg_{:x}", create_event.commit_seq));
        let stored = state.get("messages", &stored_key).unwrap();
        let mut stored_record = decode_record(&stored).unwrap();

        // Simulate editing the stored record
        stored_record.encrypted_body_ref = "edited_body".into();
        stored_record.edited_at_micros = Some(2_000_000);
        let edit_event = DurableEvent {
            commit_seq: 2,
            stream_id: "ch_01".into(),
            event_type: "message_edited".into(),
            payload: encode_record(&stored_record),
        };
        proj.apply(&edit_event, &state).unwrap();

        let decoded = decode_record(&state.get("messages", &stored_key).unwrap()).unwrap();
        assert_eq!(decoded.encrypted_body_ref, "edited_body");
        assert_eq!(decoded.edited_at_micros, Some(2_000_000));
    }

    #[test]
    fn delete_marks_record() {
        let state = ProjectionState::new();
        let proj = MessagesProjection;

        let r = MessageRecord {
            message_id: String::new(),
            channel_id: "ch_01".into(),
            author_user_id: 42,
            ..sample_msg()
        };
        let create_event = make_event(1, "message_created", &r);
        proj.apply(&create_event, &state).unwrap();

        let stored_key = encode_key("ch_01", &format!("msg_{:x}", create_event.commit_seq));
        let stored = state.get("messages", &stored_key).unwrap();
        let mut stored_record = decode_record(&stored).unwrap();
        stored_record.is_deleted = true;
        let delete_event = DurableEvent {
            commit_seq: 2,
            stream_id: "ch_01".into(),
            event_type: "message_deleted".into(),
            payload: encode_record(&stored_record),
        };
        proj.apply(&delete_event, &state).unwrap();

        let decoded = decode_record(&state.get("messages", &stored_key).unwrap()).unwrap();
        assert!(decoded.is_deleted);
    }

    #[test]
    fn missing_returns_none() {
        let state = ProjectionState::new();
        let key = encode_key("ch_99", "msg_99");
        assert!(state.get("messages", &key).is_none());
    }

    #[test]
    fn event_type_returns_correct() {
        let proj = MessagesProjection;
        assert_eq!(proj.event_type(), "message_created");
        assert!(proj.event_types().contains(&"message_edited"));
        assert!(proj.event_types().contains(&"message_deleted"));
    }

    #[test]
    fn bad_payload_returns_error() {
        let state = ProjectionState::new();
        let event = DurableEvent {
            commit_seq: 1,
            stream_id: "ch_01".into(),
            event_type: "message_created".into(),
            payload: vec![0xff, 0xff],
        };
        let result = MessagesProjection.apply(&event, &state);
        assert!(result.is_err());
    }

    #[test]
    fn typed_get_message_after_insert() {
        let state = ProjectionState::new();
        let proj = MessagesProjection;
        let r = MessageRecord {
            message_id: String::new(),
            channel_id: "ch_01".into(),
            author_user_id: 42,
            author_device_id: "dev_abc".into(),
            created_at_micros: 1_000_000,
            encrypted_body_ref: "hash".into(),
            idempotency_key: None,
            edit_history: vec![],
            edited_at_micros: None,
            is_deleted: false,
            is_spoiler: false,
        };
        let event = make_event(1, "message_created", &r);
        proj.apply(&event, &state).unwrap();
        let expected_id = format!("msg_{:x}", event.commit_seq);
        let loaded = MessagesProjection::get_message(&state, "ch_01", &expected_id).unwrap().unwrap();
        assert_eq!(loaded.message_id, expected_id);
        assert_eq!(loaded.author_user_id, 42);
    }

    #[test]
    fn typed_get_message_missing_returns_none() {
        let state = ProjectionState::new();
        let result = MessagesProjection::get_message(&state, "ch_99", "msg_99").unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn typed_list_messages_returns_all_in_channel() {
        let state = ProjectionState::new();
        let proj = MessagesProjection;
        for seq in 1..=3 {
            let r = MessageRecord {
                message_id: String::new(),
                channel_id: "ch_01".into(),
                author_user_id: seq,
                author_device_id: "dev".into(),
                created_at_micros: (seq * 1_000_000) as i64,
                encrypted_body_ref: "hash".into(),
                idempotency_key: None,
                edit_history: vec![],
                edited_at_micros: None,
                is_deleted: false,
                is_spoiler: false,
            };
            proj.apply(&make_event(seq, "message_created", &r), &state).unwrap();
        }
        let msgs = MessagesProjection::list_messages(&state, "ch_01", false).unwrap();
        assert_eq!(msgs.len(), 3);
        assert_eq!(msgs[0].author_user_id, 1);
        assert_eq!(msgs[2].author_user_id, 3);
    }

    #[test]
    fn list_messages_filters_deleted() {
        let state = ProjectionState::new();
        let proj = MessagesProjection;
        for seq in 1..=3 {
            let r = MessageRecord {
                message_id: String::new(),
                channel_id: "ch_01".into(),
                author_user_id: seq,
                ..sample_msg()
            };
            let event = make_event(seq, "message_created", &r);
            proj.apply(&event, &state).unwrap();
        }
        // Mark the middle message as deleted.
        let key = encode_key("ch_01", &format!("msg_{:x}", 2));
        let stored = state.get("messages", &key).unwrap();
        let mut deleted = decode_record(&stored).unwrap();
        deleted.is_deleted = true;
        proj.apply(&make_event(4, "message_deleted", &deleted), &state).unwrap();

        // Default: deleted hidden.
        let all = MessagesProjection::list_messages(&state, "ch_01", false).unwrap();
        assert_eq!(all.len(), 2);
        assert!(all.iter().all(|m| !m.is_deleted));

        // With include_deleted=true, all 3 + delete-event record returned.
        let with_deleted = MessagesProjection::list_messages(&state, "ch_01", true).unwrap();
        assert_eq!(with_deleted.len(), 3);
        assert!(with_deleted.iter().any(|m| m.is_deleted));
    }

    #[test]
    fn compact_removes_deleted_messages() {
        let state = ProjectionState::new();
        let proj = MessagesProjection;
        for seq in 1..=3 {
            let r = MessageRecord {
                message_id: String::new(),
                channel_id: "ch_01".into(),
                author_user_id: seq,
                ..sample_msg()
            };
            let event = make_event(seq, "message_created", &r);
            proj.apply(&event, &state).unwrap();
        }
        // Delete message 2.
        let key = encode_key("ch_01", &format!("msg_{:x}", 2));
        let stored = state.get("messages", &key).unwrap();
        let mut deleted = decode_record(&stored).unwrap();
        deleted.is_deleted = true;
        proj.apply(&make_event(4, "message_deleted", &deleted), &state).unwrap();

        // Confirm 3 entries before compaction.
        assert_eq!(MessagesProjection::list_messages(&state, "ch_01", true).unwrap().len(), 3);

        let removed = MessagesProjection::compact(&state);
        assert_eq!(removed, 1);
        // After compaction: only 2 entries remain.
        assert_eq!(MessagesProjection::list_messages(&state, "ch_01", true).unwrap().len(), 2);
        // The deleted message is gone even with include_deleted=true.
        assert!(MessagesProjection::get_message(&state, "ch_01", &format!("msg_{:x}", 2)).unwrap().is_none());
    }
}
