use crate::engine::locks::ProjectionState;
use crate::error::Result;
use crate::projections::codec::RecordCodec;
use crate::projections::handler::{DurableEvent, Projection};
use crate::projections::query::{apply_limit, MessagesFilter, QueryableProjection};
use crate::projections::secondary_index::SecondaryIndex;
use crossbeam_skiplist::SkipMap;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FileAttachmentRecord {
    pub file_url: String,
    pub file_name: String,
    pub file_size: u64,
}

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
    /// File attachments uploaded with the message. Empty on older records
    /// (defaults to `vec![]` during decode).
    #[serde(default)]
    pub files: Vec<FileAttachmentRecord>,
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
            files: r.files
                .into_iter()
                .map(|f| crate::domain::FileAttachmentRecord {
                    file_url: f.file_url,
                    file_name: f.file_name,
                    file_size: f.file_size,
                })
                .collect(),
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
            files: m.files
                .into_iter()
                .map(|f| FileAttachmentRecord {
                    file_url: f.file_url,
                    file_name: f.file_name,
                    file_size: f.file_size,
                })
                .collect(),
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
                files: vec![],
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
        let result = match event.event_type.as_str() {
            "message_created" => self.apply_created(event, state),
            "message_edited" => self.apply_edited(event, state),
            "message_deleted" => self.apply_deleted(event, state),
            _ => Ok(()),
        };
        if result.is_ok() {
            apply_secondary_indexes(event, state);
        }
        result
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

    /// Remove all soft-deleted records from the `messages` primary index and
    /// from the `messages_by_channel` / `messages_by_author` secondary
    /// indexes (otherwise deleted rows linger in the secondary indexes until a
    /// full rebuild). Returns the total number of entries removed.
    pub fn compact(state: &ProjectionState) -> usize {
        let primary = state.compact_index("messages", |_key, value| {
            decode_record_lenient(value)
                .ok()
                .map_or(false, |r| r.is_deleted)
        });
        let by_channel = state.compact_index("messages_by_channel", |_key, value| {
            decode_record_lenient(value)
                .ok()
                .map_or(false, |r| r.is_deleted)
        });
        let by_author = state.compact_index("messages_by_author", |_key, value| {
            decode_record_lenient(value)
                .ok()
                .map_or(false, |r| r.is_deleted)
        });
        primary + by_channel + by_author
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

impl QueryableProjection for MessagesProjection {
    type Record = MessageRecord;
    type Filter = MessagesFilter;

    fn query(&self, state: &ProjectionState, filter: &MessagesFilter) -> Result<Vec<MessageRecord>> {
        match (&filter.channel_id, &filter.author_id) {
            // Channel-scoped queries use the messages_by_channel secondary index.
            (Some(channel_id), _) => {
                let mut prefix = Vec::new();
                prefix.extend_from_slice(&(channel_id.len() as u64).to_le_bytes());
                prefix.extend_from_slice(channel_id.as_bytes());
                let mut results = Vec::new();
                state.prefix_scan("messages_by_channel", &prefix, |_key, value| {
                    if let Ok(record) = decode_record(value) {
                        if !filter.include_deleted && record.is_deleted {
                            return;
                        }
                        if let Some(author) = filter.author_id {
                            if record.author_user_id != author {
                                return;
                            }
                        }
                        results.push(record);
                    }
                });
                filter_since_and_limit(results, filter)
            }
            // Author-scoped queries (no channel) use messages_by_author.
            (None, Some(author_id)) => {
                let mut prefix = Vec::new();
                prefix.extend_from_slice(&(author_id.to_le_bytes()));
                let mut results = Vec::new();
                state.prefix_scan("messages_by_author", &prefix, |_key, value| {
                    if let Ok(record) = decode_record(value) {
                        if !filter.include_deleted && record.is_deleted {
                            return;
                        }
                        results.push(record);
                    }
                });
                filter_since_and_limit(results, filter)
            }
            // No indexed dimension: scan the primary index.
            (None, None) => {
                let mut results = Vec::new();
                state.for_each("messages", |_key, value| {
                    if let Ok(record) = decode_record(value) {
                        if !filter.include_deleted && record.is_deleted {
                            return;
                        }
                        results.push(record);
                    }
                });
                filter_since_and_limit(results, filter)
            }
        }
    }
}

/// Apply the `since_seq` / `limit` portions of a `MessagesFilter` to a result
/// set collected from a secondary or primary index. `since_seq` is derived
/// from the message id (`msg_{:x}` of its commit_seq).
///
/// **Ordering**: secondary index `prefix_scan` returns results in
/// lexicographic key order (`msg_{:x}` hex). After decode + filter that is
/// NOT strictly commit_seq order when message ids have mixed widths
/// (msg_9 vs msg_10). We sort by parsed numeric commit_seq so the caller
/// gets seq-monotonic output regardless of key encoding.
fn filter_since_and_limit(
    mut results: Vec<MessageRecord>,
    filter: &MessagesFilter,
) -> Result<Vec<MessageRecord>> {
    if let Some(since) = filter.since_seq {
        results.retain(|r| {
            r.message_id
                .strip_prefix("msg_")
                .and_then(|h| u64::from_str_radix(h, 16).ok())
                .map_or(false, |seq| seq >= since)
        });
    }
    // Sort by parsed numeric commit_seq (msg_{:x}) so mixed-width hex ids
    // (e.g. msg_9, msg_f, msg_10) come in seq-monotonic order.
    // Unknown formats sort last (stable) rather than before seq 1.
    results.sort_by_key(|r| {
        r.message_id
            .strip_prefix("msg_")
            .and_then(|h| u64::from_str_radix(h, 16).ok())
            .unwrap_or(u64::MAX)
    });
    apply_limit(&mut results, filter.limit);
    Ok(results)
}

/// Secondary index: one entry per (channel_id, message_id) so a channel's
/// messages can be enumerated without scanning the primary index. The key
/// mirrors the primary `messages` key encoding; the value is the encoded
/// `MessageRecord` (with message_id rewritten on create, matching primary).
pub struct MessagesByChannelIndex;

impl SecondaryIndex for MessagesByChannelIndex {
    fn name(&self) -> &str {
        "messages_by_channel"
    }

    fn extract_keys(&self, event: &DurableEvent) -> Vec<Vec<u8>> {
        if !matches!(
            event.event_type.as_str(),
            "message_created" | "message_edited" | "message_deleted"
        ) {
            return vec![];
        }
        let record: MessageRecord = match decode_record(&event.payload) {
            Ok(r) => r,
            Err(_) => return vec![],
        };
        let message_id = if event.event_type == "message_created" {
            format!("msg_{:x}", event.commit_seq)
        } else {
            record.message_id.clone()
        };
        vec![encode_key(&record.channel_id, &message_id)]
    }

    fn apply(&self, index: &SkipMap<Vec<u8>, Vec<u8>>, event: &DurableEvent) {
        for key in self.extract_keys(event) {
            index.insert(key, reencoded_payload(event));
        }
    }
}

/// Secondary index: one entry per (author_user_id, message_id) so a user's
/// messages can be enumerated across channels. The value is the encoded
/// `MessageRecord`.
pub struct MessagesByAuthorIndex;

impl SecondaryIndex for MessagesByAuthorIndex {
    fn name(&self) -> &str {
        "messages_by_author"
    }

    fn extract_keys(&self, event: &DurableEvent) -> Vec<Vec<u8>> {
        if !matches!(
            event.event_type.as_str(),
            "message_created" | "message_edited" | "message_deleted"
        ) {
            return vec![];
        }
        let record: MessageRecord = match decode_record(&event.payload) {
            Ok(r) => r,
            Err(_) => return vec![],
        };
        let message_id = if event.event_type == "message_created" {
            format!("msg_{:x}", event.commit_seq)
        } else {
            record.message_id.clone()
        };
        let mut buf = Vec::new();
        buf.extend_from_slice(&(record.author_user_id as u64).to_le_bytes());
        buf.extend_from_slice(&(message_id.len() as u64).to_le_bytes());
        buf.extend_from_slice(message_id.as_bytes());
        vec![buf]
    }

    fn apply(&self, index: &SkipMap<Vec<u8>, Vec<u8>>, event: &DurableEvent) {
        for key in self.extract_keys(event) {
            index.insert(key, reencoded_payload(event));
        }
    }
}

/// Re-encode a message event's payload so the secondary index stores the
/// exact same `MessageRecord` the primary `messages` index stores. For
/// `message_created`, the primary path overrides `message_id` to
/// `format!("msg_{:x}", commit_seq)`; mirror that here so secondary and
/// primary values are byte-consistent.
fn reencoded_payload(event: &DurableEvent) -> Vec<u8> {
    let mut record: MessageRecord = match decode_record(&event.payload) {
        Ok(r) => r,
        Err(_) => return event.payload.clone(),
    };
    if event.event_type == "message_created" {
        record.message_id = format!("msg_{:x}", event.commit_seq);
    }
    encode_record(&record)
}

/// The registered secondary indexes for `MessagesProjection`. Kept as a
/// single source of truth so both the live dispatcher and replay can iterate
/// them. Order is stable; it is only used for iteration.
pub const MESSAGES_SECONDARY_INDEXES: &[&dyn SecondaryIndex] = &[
    &MessagesByChannelIndex,
    &MessagesByAuthorIndex,
];

/// Apply all registered secondary indexes for the messages projection to the
/// given event. Called from the same path as the primary `apply` so replays
/// rebuild them automatically.
pub fn apply_secondary_indexes(event: &DurableEvent, state: &ProjectionState) {
    for index in MESSAGES_SECONDARY_INDEXES {
        let name = index.name().to_string();
        state.with_index(&name, |map| index.apply(map, event));
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
            files: vec![],
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
            files: vec![],
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
                files: vec![],
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
            files: vec![],
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
            files: vec![],
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
                files: vec![],
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
        // Removed: 1 primary + 1 messages_by_channel + 1 messages_by_author for
        // the deleted message (compaction now also purges secondary indexes).
        assert_eq!(removed, 3);
        // After compaction: only 2 entries remain.
        assert_eq!(MessagesProjection::list_messages(&state, "ch_01", true).unwrap().len(), 2);
        // The deleted message is gone even with include_deleted=true.
        assert!(MessagesProjection::get_message(&state, "ch_01", &format!("msg_{:x}", 2)).unwrap().is_none());
    }

    // --- Secondary index tests --------------------------------------------

    fn decode_msg_id(record: &MessageRecord, created: bool, commit_seq: u64) -> String {
        if created {
            format!("msg_{:x}", commit_seq)
        } else {
            record.message_id.clone()
        }
    }

    #[test]
    fn secondary_index_by_channel_populated_on_create() {
        let state = ProjectionState::new();
        let proj = MessagesProjection;
        let r = MessageRecord {
            message_id: String::new(),
            channel_id: "ch_01".into(),
            author_user_id: 42,
            ..sample_msg()
        };
        let event = make_event(1, "message_created", &r);
        proj.apply(&event, &state).unwrap();

        let expected_id = format!("msg_{:x}", event.commit_seq);
        let key = encode_key("ch_01", &expected_id);
        let value = state.get("messages_by_channel", &key);
        assert!(value.is_some(), "messages_by_channel should contain the key");
        // The value should decode back to the same message record.
        let decoded = decode_record(&value.unwrap()).unwrap();
        assert_eq!(decoded.message_id, expected_id);
        assert_eq!(decoded.channel_id, "ch_01");
    }

    #[test]
    fn secondary_index_by_channel_groups_multiple_messages() {
        let state = ProjectionState::new();
        let proj = MessagesProjection;
        for seq in 1..=3 {
            let r = MessageRecord {
                message_id: String::new(),
                channel_id: "ch_01".into(),
                author_user_id: seq,
                ..sample_msg()
            };
            proj.apply(&make_event(seq, "message_created", &r), &state).unwrap();
        }
        // A second channel with one message.
        let r2 = MessageRecord {
            message_id: String::new(),
            channel_id: "ch_02".into(),
            author_user_id: 99,
            ..sample_msg()
        };
        proj.apply(&make_event(4, "message_created", &r2), &state).unwrap();

        let mut prefix = Vec::new();
        prefix.extend_from_slice(&("ch_01".len() as u64).to_le_bytes());
        prefix.extend_from_slice(b"ch_01");
        let mut count = 0;
        state.prefix_scan("messages_by_channel", &prefix, |_k, _v| count += 1);
        assert_eq!(count, 3, "ch_01 should have 3 entries in messages_by_channel");

        let mut prefix2 = Vec::new();
        prefix2.extend_from_slice(&("ch_02".len() as u64).to_le_bytes());
        prefix2.extend_from_slice(b"ch_02");
        let mut count2 = 0;
        state.prefix_scan("messages_by_channel", &prefix2, |_k, _v| count2 += 1);
        assert_eq!(count2, 1, "ch_02 should have 1 entry in messages_by_channel");
    }

    #[test]
    fn secondary_index_by_author_populated_on_create() {
        let state = ProjectionState::new();
        let proj = MessagesProjection;
        let r = MessageRecord {
            message_id: String::new(),
            channel_id: "ch_01".into(),
            author_user_id: 42,
            ..sample_msg()
        };
        let event = make_event(1, "message_created", &r);
        proj.apply(&event, &state).unwrap();

        let expected_id = format!("msg_{:x}", event.commit_seq);
        let mut key = Vec::new();
        key.extend_from_slice(&(42u64).to_le_bytes());
        key.extend_from_slice(&(expected_id.len() as u64).to_le_bytes());
        key.extend_from_slice(expected_id.as_bytes());
        let value = state.get("messages_by_author", &key);
        assert!(value.is_some(), "messages_by_author should contain the key");
        let decoded = decode_record(&value.unwrap()).unwrap();
        assert_eq!(decoded.author_user_id, 42);
    }

    #[test]
    fn secondary_indexes_updated_on_edit_and_delete() {
        let state = ProjectionState::new();
        let proj = MessagesProjection;
        let r = MessageRecord {
            message_id: String::new(),
            channel_id: "ch_01".into(),
            author_user_id: 7,
            ..sample_msg()
        };
        let create_event = make_event(1, "message_created", &r);
        proj.apply(&create_event, &state).unwrap();
        let msg_id = format!("msg_{:x}", create_event.commit_seq);

        // Edit: re-inserts under the same secondary keys.
        let stored_key = encode_key("ch_01", &msg_id);
        let stored = state.get("messages", &stored_key).unwrap();
        let mut edited = decode_record(&stored).unwrap();
        edited.encrypted_body_ref = "edited".into();
        proj.apply(
            &DurableEvent {
                commit_seq: 2,
                stream_id: "ch_01".into(),
                event_type: "message_edited".into(),
                payload: encode_record(&edited),
            },
            &state,
        )
        .unwrap();

        // By-channel key still present with edited body.
        let ch_key = encode_key("ch_01", &msg_id);
        let value = state.get("messages_by_channel", &ch_key).unwrap();
        let decoded = decode_record(&value).unwrap();
        assert_eq!(decoded.encrypted_body_ref, "edited");

        // Delete: secondary indexes continue to hold the deleted record
        // (deletion is a soft flag in this schema; compaction removes it).
        let mut deleted = decoded;
        deleted.is_deleted = true;
        proj.apply(
            &DurableEvent {
                commit_seq: 3,
                stream_id: "ch_01".into(),
                event_type: "message_deleted".into(),
                payload: encode_record(&deleted),
            },
            &state,
        )
        .unwrap();
        assert!(state.get("messages_by_channel", &ch_key).is_some());
        assert!(state.get("messages_by_author", &author_key(7, &msg_id)).is_some());
    }

    fn author_key(author: u64, message_id: &str) -> Vec<u8> {
        let mut key = Vec::new();
        key.extend_from_slice(&(author as u64).to_le_bytes());
        key.extend_from_slice(&(message_id.len() as u64).to_le_bytes());
        key.extend_from_slice(message_id.as_bytes());
        key
    }

    #[test]
    fn secondary_indexes_built_during_replay() {
        // Simulate a full replay: a fresh state applies the same events that
        // were previously dispatched. The secondary indexes must match.
        let live = ProjectionState::new();
        let proj = MessagesProjection;
        let mut recorded = Vec::new();
        for seq in 1..=3 {
            let r = MessageRecord {
                message_id: String::new(),
                channel_id: if seq % 2 == 0 { "ch_02".to_string() } else { "ch_01".to_string() },
                author_user_id: seq * 10,
                ..sample_msg()
            };
            let event = make_event(seq, "message_created", &r);
            proj.apply(&event, &live).unwrap();
            recorded.push(event);
        }

        // Replay into a fresh state through the same apply path.
        let replayed = ProjectionState::new();
        for event in &recorded {
            proj.apply(event, &replayed).unwrap();
        }

        // The secondary indexes should be byte-identical.
        let live_ch: Vec<(Vec<u8>, Vec<u8>)> = collect_index(&live, "messages_by_channel");
        let replayed_ch: Vec<(Vec<u8>, Vec<u8>)> = collect_index(&replayed, "messages_by_channel");
        assert_eq!(live_ch, replayed_ch);

        let live_au: Vec<(Vec<u8>, Vec<u8>)> = collect_index(&live, "messages_by_author");
        let replayed_au: Vec<(Vec<u8>, Vec<u8>)> = collect_index(&replayed, "messages_by_author");
        assert_eq!(live_au, replayed_au);

        assert_eq!(replayed_ch.len(), 3);
        assert_eq!(replayed_au.len(), 3);
    }

    fn collect_index(state: &ProjectionState, index: &str) -> Vec<(Vec<u8>, Vec<u8>)> {
        let mut entries = Vec::new();
        state.for_each(index, |k, v| entries.push((k.to_vec(), v.to_vec())));
        entries.sort();
        entries
    }

    #[test]
    fn secondary_index_trait_const_registered() {
        assert_eq!(MESSAGES_SECONDARY_INDEXES.len(), 2);
        assert_eq!(MESSAGES_SECONDARY_INDEXES[0].name(), "messages_by_channel");
        assert_eq!(MESSAGES_SECONDARY_INDEXES[1].name(), "messages_by_author");
        // Only message_* events should yield keys.
        let non_msg = DurableEvent {
            commit_seq: 1,
            stream_id: "x".into(),
            event_type: "channel_created".into(),
            payload: vec![],
        };
        assert!(MESSAGES_SECONDARY_INDEXES[0].extract_keys(&non_msg).is_empty());
    }

    // --- QueryableProjection tests -----------------------------------------

    fn query_sample(seq: u64, channel_id: &str, author: u64, deleted: bool) -> MessageRecord {
        MessageRecord {
            message_id: String::new(),
            channel_id: channel_id.into(),
            author_user_id: author,
            author_device_id: "dev".into(),
            created_at_micros: (seq * 1_000_000) as i64,
            encrypted_body_ref: format!("hash_{seq}"),
            idempotency_key: None,
            edit_history: vec![],
            edited_at_micros: None,
            is_deleted: deleted,
            is_spoiler: false,
            files: vec![],
        }
    }

    #[test]
    fn query_by_channel_uses_secondary_index() {
        let state = ProjectionState::new();
        let proj = MessagesProjection;
        // ch_01: two messages by two authors.
        proj.apply(&make_event(1, "message_created", &query_sample(1, "ch_01", 10, false)), &state).unwrap();
        proj.apply(&make_event(2, "message_created", &query_sample(2, "ch_01", 20, false)), &state).unwrap();
        // ch_02: one message by a third author.
        proj.apply(&make_event(3, "message_created", &query_sample(3, "ch_02", 30, false)), &state).unwrap();

        let filter = MessagesFilter {
            channel_id: Some("ch_01".into()),
            ..Default::default()
        };
        let results = proj.query(&state, &filter).unwrap();
        assert_eq!(results.len(), 2);
        assert!(results.iter().all(|m| m.channel_id == "ch_01"));
        // Non-matching channel must not appear.
        assert!(results.iter().all(|m| m.author_user_id != 30));
    }

    #[test]
    fn query_by_channel_and_author_narrows() {
        let state = ProjectionState::new();
        let proj = MessagesProjection;
        proj.apply(&make_event(1, "message_created", &query_sample(1, "ch_01", 10, false)), &state).unwrap();
        proj.apply(&make_event(2, "message_created", &query_sample(2, "ch_01", 20, false)), &state).unwrap();

        let filter = MessagesFilter {
            channel_id: Some("ch_01".into()),
            author_id: Some(10),
            ..Default::default()
        };
        let results = proj.query(&state, &filter).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].author_user_id, 10);
    }

    #[test]
    fn query_by_author_uses_secondary_index() {
        let state = ProjectionState::new();
        let proj = MessagesProjection;
        proj.apply(&make_event(1, "message_created", &query_sample(1, "ch_01", 42, false)), &state).unwrap();
        proj.apply(&make_event(2, "message_created", &query_sample(2, "ch_02", 99, false)), &state).unwrap();

        let filter = MessagesFilter {
            author_id: Some(42),
            ..Default::default()
        };
        let results = proj.query(&state, &filter).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].author_user_id, 42);
        assert_eq!(results[0].channel_id, "ch_01");
    }

    #[test]
    fn query_limit_truncates() {
        let state = ProjectionState::new();
        let proj = MessagesProjection;
        for seq in 1..=5 {
            proj.apply(&make_event(seq, "message_created", &query_sample(seq, "ch_01", seq, false)), &state).unwrap();
        }
        let filter = MessagesFilter {
            channel_id: Some("ch_01".into()),
            limit: Some(2),
            ..Default::default()
        };
        let results = proj.query(&state, &filter).unwrap();
        assert_eq!(results.len(), 2);
    }

    #[test]
    fn query_filters_deleted_by_default() {
        let state = ProjectionState::new();
        let proj = MessagesProjection;
        proj.apply(&make_event(1, "message_created", &query_sample(1, "ch_01", 1, false)), &state).unwrap();
        proj.apply(&make_event(2, "message_created", &query_sample(2, "ch_01", 2, false)), &state).unwrap();
        // Soft-delete message 2 (created under commit_seq 2 → msg_2).
        let key = encode_key("ch_01", &format!("msg_{:x}", 2));
        let stored = state.get("messages", &key).expect("message 2 should exist");
        let mut deleted = decode_record_lenient(&stored).unwrap();
        deleted.is_deleted = true;
        proj.apply(&make_event(3, "message_deleted", &deleted), &state).unwrap();

        let default_q = proj.query(&state, &MessagesFilter { channel_id: Some("ch_01".into()), ..Default::default() }).unwrap();
        assert_eq!(default_q.len(), 1);

        let with_deleted = proj.query(&state, &MessagesFilter { channel_id: Some("ch_01".into()), include_deleted: true, ..Default::default() }).unwrap();
        assert_eq!(with_deleted.len(), 2);
    }

    #[test]
    fn query_since_seq_excludes_older() {
        let state = ProjectionState::new();
        let proj = MessagesProjection;
        for seq in 1..=3 {
            proj.apply(&make_event(seq, "message_created", &query_sample(seq, "ch_01", seq, false)), &state).unwrap();
        }
        let filter = MessagesFilter {
            channel_id: Some("ch_01".into()),
            since_seq: Some(2),
            ..Default::default()
        };
        let results = proj.query(&state, &filter).unwrap();
        assert_eq!(results.len(), 2);
        assert!(results.iter().all(|m| m.message_id != format!("msg_{:x}", 1)));
    }


    #[test]
    fn query_returns_messages_in_seq_monotonic_order_with_mixed_width_ids() {
        let state = ProjectionState::new();
        let proj = MessagesProjection;
        // seq 7  → msg_7   (1 hex digit)
        // seq 15 → msg_f   (1 hex digit)
        // seq 16 → msg_10  (2 hex digits)
        // Lexicographic key order: msg_10, msg_7, msg_f
        // Seq-monotonic order:      msg_7, msg_f, msg_10
        for seq in &[7u64, 15, 16] {
            let r = MessageRecord {
                message_id: String::new(),
                channel_id: "ch_01".into(),
                author_user_id: *seq,
                ..sample_msg()
            };
            proj.apply(&make_event(*seq, "message_created", &r), &state).unwrap();
        }
        let filter = MessagesFilter {
            channel_id: Some("ch_01".into()),
            ..Default::default()
        };
        let results = proj.query(&state, &filter).unwrap();
        assert_eq!(results.len(), 3);
        // Must be in commit_seq order: 7, 15, 16
        assert_eq!(results[0].message_id, "msg_7");
        assert_eq!(results[1].message_id, "msg_f");
        assert_eq!(results[2].message_id, "msg_10");
        // Also verify limit works after sort
        let limited = proj
            .query(
                &state,
                &MessagesFilter {
                    channel_id: Some("ch_01".into()),
                    limit: Some(2),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(limited.len(), 2);
        assert_eq!(limited[0].message_id, "msg_7");
        assert_eq!(limited[1].message_id, "msg_f");
    }

    /// A7 quality gate: channel-scoped query at 10k messages stays well under
    /// the GOAL p99 target of 5ms on typical dev hardware (best-effort; we
    /// assert < 50ms to avoid CI flake on slow boxes while still catching
    /// accidental full-table scans that take hundreds of ms).
    #[test]
    fn query_index_backed_10k_channel_is_fast() {
        use std::time::Instant;
        let state = ProjectionState::new();
        let proj = MessagesProjection;
        // 50 channels × 200 msgs = 10k
        for ch in 0..50u64 {
            let channel = format!("ch_{ch:02}");
            for i in 0..200u64 {
                let seq = ch * 200 + i + 1;
                let r = MessageRecord {
                    message_id: String::new(),
                    channel_id: channel.clone(),
                    author_user_id: i,
                    ..sample_msg()
                };
                proj.apply(&make_event(seq, "message_created", &r), &state).unwrap();
            }
        }
        let filter = MessagesFilter {
            channel_id: Some("ch_07".into()),
            ..Default::default()
        };
        // Warm
        let _ = proj.query(&state, &filter).unwrap();
        let start = Instant::now();
        let results = proj.query(&state, &filter).unwrap();
        let elapsed = start.elapsed();
        assert_eq!(results.len(), 200);
        assert!(
            elapsed.as_millis() < 50,
            "list_messages via index took {:?} (want <50ms; GOAL p99 <5ms on fast HW)",
            elapsed
        );
        // Regression: wrong channel empty
        let empty = proj
            .query(
                &state,
                &MessagesFilter {
                    channel_id: Some("ch_missing".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        assert!(empty.is_empty());
    }

}
