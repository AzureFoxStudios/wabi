//! Compact derived message-ID lookup. Primary records and replay encodings are
//! unchanged. Multiple legacy rooms may retain the same ID; an ID-only request
//! must reject that ambiguity rather than choose a room by iteration order.

use crate::{
    engine::locks::ProjectionState,
    error::{Result, WabiError},
    projections::messages::{decode_record, encode_key, MessageRecord},
};
use std::collections::HashMap;

pub const INDEX: &str = "message_by_id_v1";

fn prefix(message_id: &str) -> Vec<u8> {
    let mut key = (message_id.len() as u64).to_le_bytes().to_vec();
    key.extend_from_slice(message_id.as_bytes());
    key
}

pub fn key(channel_id: &str, message_id: &str) -> Vec<u8> {
    let mut key = prefix(message_id);
    key.extend_from_slice(&encode_key(channel_id, message_id));
    key
}

fn corrupt(detail: impl Into<String>) -> WabiError {
    WabiError::Corrupt {
        location: INDEX.into(),
        detail: detail.into(),
    }
}

pub fn write(state: &ProjectionState, record: &MessageRecord, commit_seq: u64) {
    state.insert(
        INDEX,
        key(&record.channel_id, &record.message_id),
        encode_key(&record.channel_id, &record.message_id),
        commit_seq,
    );
}

pub fn get(state: &ProjectionState, message_id: &str) -> Result<Option<MessageRecord>> {
    // Bound the ambiguity check to two pointers; resolve primary rows after
    // releasing the index lock, never from inside the scan callback.
    let mut matches = Vec::with_capacity(2);
    state.prefix_scan_reverse(INDEX, &prefix(message_id), |key, value| {
        matches.push((key.to_vec(), value.to_vec()));
        matches.len() < 2
    });
    if matches.len() > 1 {
        return Err(corrupt(format!(
            "message ID {message_id} belongs to multiple rooms"
        )));
    }
    let Some((lookup_key, primary_key)) = matches.pop() else {
        if state.index_len(INDEX) != state.index_len("messages") {
            return Err(corrupt(
                "message ID lookup is incomplete; startup rebuild is required",
            ));
        }
        return Ok(None);
    };
    let bytes = state
        .get("messages", &primary_key)
        .ok_or_else(|| corrupt(format!("message {message_id} points to a missing row")))?;
    let record = decode_record(&bytes)?;
    if record.message_id != message_id
        || encode_key(&record.channel_id, message_id) != primary_key
        || key(&record.channel_id, message_id) != lookup_key
    {
        return Err(corrupt(format!(
            "message {message_id} lookup does not match its row"
        )));
    }
    Ok(Some(record))
}

/// Run at engine open before the dispatcher starts. Validate existing pointers
/// before inserting missing ones; leave records and the applied watermark alone.
pub fn rebuild(state: &ProjectionState) -> Result<usize> {
    let count = state.index_len("messages");
    let mut expected = HashMap::with_capacity(count);
    let mut error = None;
    state.for_each("messages", |primary_key, bytes| {
        match decode_record(bytes) {
            Ok(record) => {
                if encode_key(&record.channel_id, &record.message_id) != primary_key {
                    error = Some(corrupt("primary message key does not match its record"));
                }
                expected.insert(
                    key(&record.channel_id, &record.message_id),
                    primary_key.to_vec(),
                );
            }
            Err(failure) => error = Some(failure),
        }
    });
    if let Some(error) = error {
        return Err(error);
    }
    state.for_each(INDEX, |key, value| {
        if expected.get(key).map(Vec::as_slice) != Some(value) {
            error = Some(corrupt(
                "existing message ID pointer conflicts with primary state",
            ));
        }
    });
    if let Some(error) = error {
        return Err(error);
    }
    let mut inserted = 0;
    for (lookup_key, primary_key) in expected {
        if state.get(INDEX, &lookup_key).is_none() {
            state.insert(INDEX, lookup_key, primary_key, state.applied_commit_seq());
            inserted += 1;
        }
    }
    Ok(inserted)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::projections::{
        handler::{DurableEvent, Projection},
        messages::{encode_record, MessagesProjection},
    };

    pub(crate) fn record(room: &str, id: &str) -> MessageRecord {
        MessageRecord {
            message_id: id.into(),
            channel_id: room.into(),
            author_user_id: 1,
            author_device_id: "test-device".into(),
            created_at_micros: 1,
            encrypted_body_ref: "body".into(),
            idempotency_key: None,
            edit_history: vec![],
            edited_at_micros: None,
            is_deleted: false,
            is_spoiler: false,
            files: vec![],
        }
    }

    pub(crate) fn apply(state: &ProjectionState, kind: &str, row: &MessageRecord, seq: u64) {
        MessagesProjection
            .apply(
                &DurableEvent {
                    commit_seq: seq,
                    stream_id: row.channel_id.clone(),
                    event_type: kind.into(),
                    payload: encode_record(row),
                },
                state,
            )
            .unwrap();
    }

    #[test]
    fn lookup_tracks_edits_and_deletion_and_compacts_all_time_versions() {
        let state = ProjectionState::new();
        let mut row = record("ch_a", "msg_a");
        apply(&state, "message_created", &row, 1);
        assert_eq!(get(&state, "msg_a").unwrap(), Some(row.clone()));
        row.encrypted_body_ref = "edited".into();
        row.edited_at_micros = Some(2);
        apply(&state, "message_edited", &row, 2);
        assert_eq!(get(&state, "msg_a").unwrap(), Some(row.clone()));
        row.is_deleted = true;
        apply(&state, "message_deleted", &row, 3);
        assert_eq!(get(&state, "msg_a").unwrap(), Some(row));
        assert!(MessagesProjection::compact(&state) >= 4);
        assert_eq!(state.index_len(INDEX), 0);
        assert_eq!(state.index_len("messages_by_channel_time"), 0);
        assert_eq!(get(&state, "msg_a").unwrap(), None);
    }

    #[test]
    fn legacy_duplicate_ids_preserve_both_rooms_but_fail_id_only_resolution() {
        let state = ProjectionState::new();
        let mut a = record("ch_a", "shared");
        let b = record("ch_b", "shared");
        apply(&state, "message_created", &a, 1);
        apply(&state, "message_created", &b, 2);
        assert!(get(&state, "shared").is_err());
        assert_eq!(
            MessagesProjection::get_message(&state, "ch_a", "shared").unwrap(),
            Some(a.clone())
        );
        assert_eq!(
            MessagesProjection::get_message(&state, "ch_b", "shared").unwrap(),
            Some(b.clone())
        );
        a.is_deleted = true;
        apply(&state, "message_deleted", &a, 3);
        MessagesProjection::compact(&state);
        assert_eq!(get(&state, "shared").unwrap(), Some(b));
    }

    #[test]
    fn legacy_snapshot_rebuild_preserves_records_and_watermark() {
        let dir = tempfile::tempdir().unwrap();
        let state = ProjectionState::new();
        let row = record("ch_a", "msg_a");
        state.insert(
            "messages",
            encode_key("ch_a", "msg_a"),
            encode_record(&row),
            9,
        );
        state.set_applied_commit_seq(9);
        state.save_snapshot(dir.path()).unwrap();
        let (restored, watermark) = ProjectionState::load_snapshot(dir.path()).unwrap().unwrap();
        assert_eq!(watermark, 9);
        assert!(get(&restored, "msg_a").is_err());
        assert_eq!(rebuild(&restored).unwrap(), 1);
        assert_eq!(get(&restored, "msg_a").unwrap(), Some(row.clone()));
        restored.save_snapshot(dir.path()).unwrap();
        let (reopened, watermark) = ProjectionState::load_snapshot(dir.path()).unwrap().unwrap();
        assert_eq!(watermark, 9);
        assert_eq!(rebuild(&reopened).unwrap(), 0);
        assert_eq!(get(&reopened, "msg_a").unwrap(), Some(row));
    }

    #[test]
    fn corrupt_primary_or_lookup_fails_before_rebuild_mutation() {
        for wrong_pointer in [false, true] {
            let state = ProjectionState::new();
            let row = record("ch_a", "msg_a");
            let primary = encode_key("ch_a", "msg_a");
            state.insert(
                "messages",
                if wrong_pointer {
                    primary.clone()
                } else {
                    b"bad-key".to_vec()
                },
                encode_record(&row),
                1,
            );
            if wrong_pointer {
                state.insert(INDEX, key("ch_a", "msg_a"), b"wrong-target".to_vec(), 1);
                assert!(get(&state, "msg_a").is_err());
            }
            let before = state.index_len(INDEX);
            assert!(rebuild(&state).is_err());
            assert_eq!(state.index_len(INDEX), before);
        }
    }

    #[test]
    fn exact_lookup_does_not_decode_unrelated_history() {
        let state = ProjectionState::new();
        let row = record("ch_a", "msg_a");
        apply(&state, "message_created", &row, 1);
        state.insert("messages", encode_key("ch_b", "unrelated"), vec![0xff], 2);
        state.insert(
            INDEX,
            key("ch_b", "unrelated"),
            encode_key("ch_b", "unrelated"),
            2,
        );
        assert_eq!(get(&state, "msg_a").unwrap(), Some(row));
        assert!(get(&state, "unrelated").is_err());
        assert_eq!(get(&state, "absent").unwrap(), None);
    }
}
