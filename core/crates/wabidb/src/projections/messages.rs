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
            files: r
                .files
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
            files: m
                .files
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

/// Extract the commit sequence from a message id, if it encodes one.
///
/// Two id generations exist on disk:
/// - `msg_{:x}` (legacy seq-hex, mixed width) — parseable
/// - `msg_<uuid-simple>` (current) — NOT parseable; returns None
///
/// Used only by the bounded tail query to decide whether index order can be
/// trusted for early exit (see `list_messages_tail`).
fn parse_seq_from_message_id(message_id: &str) -> Option<u64> {
    message_id
        .strip_prefix("msg_")
        .and_then(|h| u64::from_str_radix(h, 16).ok())
}

/// True when a message id belongs to the current UUID generation
/// (`uuid::Uuid::simple()` = exactly 32 hex chars). Legacy seq-hex ids are at
/// most 16 chars (`msg_{:x}` of a u64), so length is an unambiguous
/// discriminator. UUID ids carry no ordering among themselves — the caller
/// re-sorts by timestamp, so bounded walks must not early-exit while any
/// remain.
fn is_uuid_generation_id(message_id: &str) -> bool {
    match message_id.strip_prefix("msg_") {
        Some(rest) => rest.len() >= 32,
        None => false,
    }
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
    pub fn get_message(
        state: &ProjectionState,
        channel_id: &str,
        message_id: &str,
    ) -> Result<Option<MessageRecord>> {
        let key = encode_key(channel_id, message_id);
        match state.get("messages", &key) {
            None => Ok(None),
            Some(bytes) => decode_record(&bytes).map(Some),
        }
    }

    /// List messages in a channel. When `include_deleted` is false (the
    /// common case), soft-deleted records are filtered out.
    pub fn list_messages(
        state: &ProjectionState,
        channel_id: &str,
        include_deleted: bool,
    ) -> Result<Vec<MessageRecord>> {
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

    /// Bounded tail query (t_ee2420fe): fetch the most recent `limit`
    /// messages of a channel by reverse-iterating the index, visiting
    /// O(limit) records instead of decode-all + sort + truncate.
    ///
    /// Ordering caveat: the current UUID id generation carries no ordering,
    /// so lexicographic index order is NOT chronological within a channel
    /// that contains UUID ids. This method therefore walks back until it has
    /// `limit` live messages AND has passed all UUID-generation rows; the
    /// caller (adapter) re-sorts the returned batch by created_at_micros.
    /// For a channel whose newest messages are all UUID ids this visits only
    /// those rows — the common case. A channel with interleaved generations
    /// may visit extra rows but still returns correct data.
    pub fn list_messages_tail(
        state: &ProjectionState,
        channel_id: &str,
        limit: usize,
        include_deleted: bool,
    ) -> Result<Vec<MessageRecord>> {
        if limit == 0 {
            return Ok(Vec::new());
        }
        let mut prefix = Vec::new();
        prefix.extend_from_slice(&(channel_id.len() as u64).to_le_bytes());
        prefix.extend_from_slice(channel_id.as_bytes());

        let mut results_rev: Vec<MessageRecord> = Vec::with_capacity(limit);
        // Walk the TIME-ordered secondary index (messages_by_channel_time:
        // key = channel, created_at BE, commit_seq BE, id) newest-first. The
        // primary index is id-string-ordered and carries no chronology for
        // UUID ids — the wrong index here was the source of a test bug.
        //
        // Edit/delete events append NEW entries (later commit_seq in the key)
        // rather than overwriting, so walking backwards the first entry seen
        // per message id is its latest state; older versions are skipped.
        let mut seen_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
        state.prefix_scan_reverse("messages_by_channel_time", &prefix, |_key, value| {
            if results_rev.len() >= limit {
                return false; // window full — early exit
            }
            let record = match decode_record(value) {
                Ok(r) => r,
                Err(_) => return true,
            };
            if !seen_ids.insert(record.message_id.clone()) {
                return true; // older version of an already-resolved message
            }
            if !include_deleted && record.is_deleted {
                return true;
            }
            results_rev.push(record);
            true
        });
        results_rev.reverse();
        results_rev.truncate(limit);
        Ok(results_rev)
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
        // Prefer the id stamped by the writer (UUID). Only fall back to
        // commit_seq when older producers left message_id empty.
        // commit_seq-only ids collapse in client keyed lists when anything
        // reuses a seq ("new message eats old").
        if record.message_id.trim().is_empty() {
            record.message_id = format!("msg_{:x}", event.commit_seq);
        }
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

    fn query(
        &self,
        state: &ProjectionState,
        filter: &MessagesFilter,
    ) -> Result<Vec<MessageRecord>> {
        match (&filter.channel_id, &filter.author_id) {
            // Channel-scoped queries use the time-ordered secondary index:
            // walk BACKWARDS from the newest entry and stop at `limit`.
            // O(limit) instead of decode-all + sort + truncate (finding #4).
            (Some(channel_id), _) => {
                let mut prefix = Vec::new();
                prefix.extend_from_slice(&(channel_id.len() as u64).to_le_bytes());
                prefix.extend_from_slice(channel_id.as_bytes());
                let limit = filter.limit.unwrap_or(usize::MAX);
                let since_seq = filter.since_seq;
                let mut results: Vec<MessageRecord> = Vec::with_capacity(limit.min(1024));
                // Walking backwards, the FIRST entry seen for a message id is
                // its newest state (later events land on later keys). Track
                // seen ids so edit/delete duplicates of the same message are
                // collapsed to their latest version.
                let mut seen_ids: std::collections::HashSet<String> =
                    std::collections::HashSet::new();
                state.prefix_scan_reverse("messages_by_channel_time", &prefix, |_key, value| {
                    if results.len() >= limit {
                        return false; // early exit — window is full
                    }
                    match decode_record(value) {
                        Ok(record) => {
                            if !seen_ids.insert(record.message_id.clone()) {
                                return true; // older version of an already-resolved message
                            }
                            if !filter.include_deleted && record.is_deleted {
                                return true; // skip, keep walking
                            }
                            if let Some(author) = filter.author_id {
                                if record.author_user_id != author {
                                    return true;
                                }
                            }
                            // seq-monotonic output is preserved by the index's
                            // commit order; `since_seq` filters legacy
                            // hex-seq ids (UUID ids never match and are
                            // always newer than any stored watermark).
                            if let Some(since) = since_seq {
                                let seq = record
                                    .message_id
                                    .strip_prefix("msg_")
                                    .and_then(|h| u64::from_str_radix(h, 16).ok());
                                match seq {
                                    Some(s) if s < since => return true,
                                    _ => {} // UUID id or newer seq: keep
                                }
                            }
                            results.push(record);
                            true
                        }
                        Err(_) => true,
                    }
                });
                // Index walk is newest-first; callers expect oldest-first.
                results.reverse();
                Ok(results)
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
/// exact same `MessageRecord` the primary `messages` index stores. The
/// primary path (apply_created) prefers the writer-stamped id (UUID) and
/// only falls back to `msg_{commit_seq:x}` when the writer left it empty —
/// mirror that exactly so secondary and primary values are byte-consistent.
fn reencoded_payload(event: &DurableEvent) -> Vec<u8> {
    let mut record: MessageRecord = match decode_record(&event.payload) {
        Ok(r) => r,
        Err(_) => return event.payload.clone(),
    };
    if event.event_type == "message_created" && record.message_id.trim().is_empty() {
        record.message_id = format!("msg_{:x}", event.commit_seq);
    }
    encode_record(&record)
}

/// Secondary index: one entry per (channel_id, created_at_micros,
/// message_id). Time-ordered within a channel so history queries can walk it
/// BACKWARDS and early-exit at `limit` — O(limit) instead of decode-everything
/// + sort (perf audit finding #4). Ids are UUIDs by design (commit_seq ids
/// collapsed client keyed lists), so key order on the id itself is meaningless;
/// created_at_micros is what carries ordering. Replay rebuilds this index
/// automatically like the others.
pub struct MessagesByChannelTimeIndex;

impl SecondaryIndex for MessagesByChannelTimeIndex {
    fn name(&self) -> &str {
        "messages_by_channel_time"
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
        // Mirror reencoded_payload's id handling: prefer the writer-stamped
        // id; fall back to commit_seq only when the writer left it empty, so
        // the trailing id disambiguator matches the primary record's id.
        let message_id =
            if event.event_type == "message_created" && record.message_id.trim().is_empty() {
                format!("msg_{:x}", event.commit_seq)
            } else {
                record.message_id.clone()
            };
        let mut buf =
            Vec::with_capacity(8 + 2 + record.channel_id.len() + 8 + 8 + 2 + message_id.len());
        buf.extend_from_slice(&(record.channel_id.len() as u64).to_le_bytes());
        buf.extend_from_slice(record.channel_id.as_bytes());
        buf.extend_from_slice(&record.created_at_micros.to_be_bytes()); // BE: sortable
                                                                        // commit_seq tiebreaker: messages sharing a timestamp stay in
                                                                        // commit order (seq-monotonic), preserving the old query's ordering
                                                                        // contract for equal-timestamp rows.
        buf.extend_from_slice(&event.commit_seq.to_be_bytes());
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

/// The registered secondary indexes for `MessagesProjection`. Kept as a
/// single source of truth so both the live dispatcher and replay can iterate
/// them. Order is stable; it is only used for iteration.
pub const MESSAGES_SECONDARY_INDEXES: &[&dyn SecondaryIndex] = &[
    &MessagesByChannelIndex,
    &MessagesByAuthorIndex,
    &MessagesByChannelTimeIndex,
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

    fn base_record(message_id: &str, channel_id: &str, created_at_micros: i64) -> MessageRecord {
        MessageRecord {
            message_id: message_id.into(),
            channel_id: channel_id.into(),
            author_user_id: 1,
            author_device_id: "dev".into(),
            created_at_micros,
            encrypted_body_ref: format!("body-{message_id}"),
            idempotency_key: None,
            edit_history: vec![],
            edited_at_micros: None,
            is_deleted: false,
            is_spoiler: false,
            files: vec![],
        }
    }

    // t_ee2420fe acceptance: tail query returns the newest N live messages
    // across the mixed id generations (legacy seq-hex + current UUID), and
    // stops early instead of scanning the whole channel.
    #[test]
    fn list_messages_tail_mixed_generations_returns_newest() {
        let state = ProjectionState::new();
        let proj = MessagesProjection;

        // 5 legacy seq-hex ids (mixed widths — the historical ordering bug),
        // then 4 UUID-generation ids (chronologically newest).
        for seq in [2u64, 0xf, 0x10, 0x100, 0x100000] {
            let r = base_record(&format!("msg_{seq:x}"), "ch_mix", 1_000 + (seq % 7) as i64);
            proj.apply(&make_event(seq, "message_created", &r), &state)
                .unwrap();
        }
        for i in 0..4u64 {
            let r = base_record(
                &format!("msg_{:032x}", 0xA000 + i),
                "ch_mix",
                9_000_000 + i as i64,
            );
            proj.apply(&make_event(10_000 + i, "message_created", &r), &state)
                .unwrap();
        }

        // limit=3 → the three newest UUID rows.
        let tail = MessagesProjection::list_messages_tail(&state, "ch_mix", 3, false).unwrap();
        assert_eq!(tail.len(), 3);
        let ids: Vec<String> = tail.iter().map(|m| m.message_id.clone()).collect();
        assert!(
            tail.iter().all(|m| is_uuid_generation_id(&m.message_id)),
            "tail should be UUID-generation rows, got {ids:?}"
        );

        // limit=8 → all 4 UUID rows + the 4 newest legacy rows.
        let tail = MessagesProjection::list_messages_tail(&state, "ch_mix", 8, false).unwrap();
        assert_eq!(tail.len(), 8);
        let legacy_count = tail
            .iter()
            .filter(|m| !is_uuid_generation_id(&m.message_id))
            .count();
        assert_eq!(legacy_count, 4);

        // Chronological order preserved after reverse.
        assert!(
            tail.windows(2)
                .all(|w| w[0].created_at_micros <= w[1].created_at_micros),
            "tail must be chronological"
        );
    }

    #[test]
    fn prefix_scan_reverse_walks_highest_first_and_stops_early() {
        let state = ProjectionState::new();
        let proj = MessagesProjection;
        for seq in [1u64, 2, 3, 4, 5] {
            let r = base_record(&format!("msg_{seq:x}"), "ch_r", seq as i64);
            proj.apply(&make_event(seq, "message_created", &r), &state)
                .unwrap();
        }
        let mut prefix = Vec::new();
        prefix.extend_from_slice(3usize.to_be_bytes().as_slice()); // unused; build real prefix below
        prefix.clear();
        prefix.extend_from_slice(&("ch_r".len() as u64).to_le_bytes());
        prefix.extend_from_slice(b"ch_r");

        let mut visited = 0usize;
        let mut keys: Vec<String> = Vec::new();
        state.prefix_scan_reverse("messages", &prefix, |k, _v| {
            visited += 1;
            keys.push(String::from_utf8_lossy(k).to_string());
            visited < 2 // early exit after 2
        });
        assert_eq!(visited, 2, "early exit must stop iteration");
        // Highest key first.
        let first_id_start = keys[0].rfind("msg_").expect("key embeds msg id");
        assert!(keys[0][first_id_start..].starts_with("msg_5"));
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

        // The writer-stamped UUID id is kept (golden rule 3: ids are UUIDs
        // end-to-end; a seq-only id collapses in client keyed lists).
        let key = encode_key("ch_01", "msg_01");
        let stored = state.get("messages", &key).unwrap();
        let decoded = decode_record(&stored).unwrap();
        assert_eq!(decoded.message_id, "msg_01");
        assert_eq!(decoded.author_user_id, 42);

        // Legacy producers with an empty id fall back to msg_{commit_seq:x}.
        let mut legacy = r;
        legacy.message_id = String::new();
        let legacy_event = DurableEvent {
            commit_seq: 7,
            stream_id: "ch_01".into(),
            event_type: "message_created".into(),
            payload: encode_record(&legacy),
        };
        proj.apply(&legacy_event, &state).unwrap();
        let legacy_key = encode_key("ch_01", "msg_7");
        assert!(state.get("messages", &legacy_key).is_some());
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
        let loaded = MessagesProjection::get_message(&state, "ch_01", &expected_id)
            .unwrap()
            .unwrap();
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
            proj.apply(&make_event(seq, "message_created", &r), &state)
                .unwrap();
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
        proj.apply(&make_event(4, "message_deleted", &deleted), &state)
            .unwrap();

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
        proj.apply(&make_event(4, "message_deleted", &deleted), &state)
            .unwrap();

        // Confirm 3 entries before compaction.
        assert_eq!(
            MessagesProjection::list_messages(&state, "ch_01", true)
                .unwrap()
                .len(),
            3
        );

        let removed = MessagesProjection::compact(&state);
        // Removed: 1 primary + 1 messages_by_channel + 1 messages_by_author for
        // the deleted message (compaction now also purges secondary indexes).
        assert_eq!(removed, 3);
        // After compaction: only 2 entries remain.
        assert_eq!(
            MessagesProjection::list_messages(&state, "ch_01", true)
                .unwrap()
                .len(),
            2
        );
        // The deleted message is gone even with include_deleted=true.
        assert!(
            MessagesProjection::get_message(&state, "ch_01", &format!("msg_{:x}", 2))
                .unwrap()
                .is_none()
        );
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
        assert!(
            value.is_some(),
            "messages_by_channel should contain the key"
        );
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
            proj.apply(&make_event(seq, "message_created", &r), &state)
                .unwrap();
        }
        // A second channel with one message.
        let r2 = MessageRecord {
            message_id: String::new(),
            channel_id: "ch_02".into(),
            author_user_id: 99,
            ..sample_msg()
        };
        proj.apply(&make_event(4, "message_created", &r2), &state)
            .unwrap();

        let mut prefix = Vec::new();
        prefix.extend_from_slice(&("ch_01".len() as u64).to_le_bytes());
        prefix.extend_from_slice(b"ch_01");
        let mut count = 0;
        state.prefix_scan("messages_by_channel", &prefix, |_k, _v| count += 1);
        assert_eq!(
            count, 3,
            "ch_01 should have 3 entries in messages_by_channel"
        );

        let mut prefix2 = Vec::new();
        prefix2.extend_from_slice(&("ch_02".len() as u64).to_le_bytes());
        prefix2.extend_from_slice(b"ch_02");
        let mut count2 = 0;
        state.prefix_scan("messages_by_channel", &prefix2, |_k, _v| count2 += 1);
        assert_eq!(
            count2, 1,
            "ch_02 should have 1 entry in messages_by_channel"
        );
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
        assert!(state
            .get("messages_by_author", &author_key(7, &msg_id))
            .is_some());
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
                channel_id: if seq % 2 == 0 {
                    "ch_02".to_string()
                } else {
                    "ch_01".to_string()
                },
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
        assert_eq!(MESSAGES_SECONDARY_INDEXES.len(), 3);
        assert_eq!(MESSAGES_SECONDARY_INDEXES[0].name(), "messages_by_channel");
        assert_eq!(MESSAGES_SECONDARY_INDEXES[1].name(), "messages_by_author");
        assert_eq!(
            MESSAGES_SECONDARY_INDEXES[2].name(),
            "messages_by_channel_time"
        );
        // Only message_* events should yield keys.
        let non_msg = DurableEvent {
            commit_seq: 1,
            stream_id: "x".into(),
            event_type: "channel_created".into(),
            payload: vec![],
        };
        assert!(MESSAGES_SECONDARY_INDEXES[0]
            .extract_keys(&non_msg)
            .is_empty());
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
        proj.apply(
            &make_event(1, "message_created", &query_sample(1, "ch_01", 10, false)),
            &state,
        )
        .unwrap();
        proj.apply(
            &make_event(2, "message_created", &query_sample(2, "ch_01", 20, false)),
            &state,
        )
        .unwrap();
        // ch_02: one message by a third author.
        proj.apply(
            &make_event(3, "message_created", &query_sample(3, "ch_02", 30, false)),
            &state,
        )
        .unwrap();

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
        proj.apply(
            &make_event(1, "message_created", &query_sample(1, "ch_01", 10, false)),
            &state,
        )
        .unwrap();
        proj.apply(
            &make_event(2, "message_created", &query_sample(2, "ch_01", 20, false)),
            &state,
        )
        .unwrap();

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
        proj.apply(
            &make_event(1, "message_created", &query_sample(1, "ch_01", 42, false)),
            &state,
        )
        .unwrap();
        proj.apply(
            &make_event(2, "message_created", &query_sample(2, "ch_02", 99, false)),
            &state,
        )
        .unwrap();

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
            proj.apply(
                &make_event(
                    seq,
                    "message_created",
                    &query_sample(seq, "ch_01", seq, false),
                ),
                &state,
            )
            .unwrap();
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
        proj.apply(
            &make_event(1, "message_created", &query_sample(1, "ch_01", 1, false)),
            &state,
        )
        .unwrap();
        proj.apply(
            &make_event(2, "message_created", &query_sample(2, "ch_01", 2, false)),
            &state,
        )
        .unwrap();
        // Soft-delete message 2 (created under commit_seq 2 → msg_2).
        let key = encode_key("ch_01", &format!("msg_{:x}", 2));
        let stored = state.get("messages", &key).expect("message 2 should exist");
        let mut deleted = decode_record_lenient(&stored).unwrap();
        deleted.is_deleted = true;
        proj.apply(&make_event(3, "message_deleted", &deleted), &state)
            .unwrap();

        let default_q = proj
            .query(
                &state,
                &MessagesFilter {
                    channel_id: Some("ch_01".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(default_q.len(), 1);

        let with_deleted = proj
            .query(
                &state,
                &MessagesFilter {
                    channel_id: Some("ch_01".into()),
                    include_deleted: true,
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(with_deleted.len(), 2);
    }

    #[test]
    fn query_since_seq_excludes_older() {
        let state = ProjectionState::new();
        let proj = MessagesProjection;
        for seq in 1..=3 {
            proj.apply(
                &make_event(
                    seq,
                    "message_created",
                    &query_sample(seq, "ch_01", seq, false),
                ),
                &state,
            )
            .unwrap();
        }
        let filter = MessagesFilter {
            channel_id: Some("ch_01".into()),
            since_seq: Some(2),
            ..Default::default()
        };
        let results = proj.query(&state, &filter).unwrap();
        assert_eq!(results.len(), 2);
        assert!(results
            .iter()
            .all(|m| m.message_id != format!("msg_{:x}", 1)));
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
            proj.apply(&make_event(*seq, "message_created", &r), &state)
                .unwrap();
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
        // limit=2 returns the NEWEST window (reverse walk + early exit),
        // oldest-first within the window. Chat history wants the latest
        // messages; this is the documented contract since the time index
        // (t_ee2420fe).
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
        assert_eq!(limited[0].message_id, "msg_f");
        assert_eq!(limited[1].message_id, "msg_10");
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
                proj.apply(&make_event(seq, "message_created", &r), &state)
                    .unwrap();
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
