//! Message lookup by ID alone. Multiple legacy rooms may retain the same ID;
//! an ID-only request must reject that ambiguity rather than choose a room.
//!
//! The lookup is an index on the read model's `messages` table, so it cannot
//! be missing an entry or point at a row that is gone.

use crate::{
    engine::locks::ProjectionState,
    error::{Result, WabiError},
    projections::messages::{decode_record, MessageRecord},
    projections::read_model,
};

/// Error location of a failed lookup. The name of the in-memory index this
/// replaced, kept so the error reads the same.
pub const INDEX: &str = "message_by_id_v1";

fn corrupt(detail: impl Into<String>) -> WabiError {
    WabiError::Corrupt {
        location: INDEX.into(),
        detail: detail.into(),
    }
}

pub fn get(state: &ProjectionState, message_id: &str) -> Result<Option<MessageRecord>> {
    // Two rows are enough to see the ambiguity.
    let mut rows = state
        .read_model()
        .read(|conn| read_model::messages_by_id(conn, message_id))?;
    if rows.len() > 1 {
        return Err(corrupt(format!(
            "message ID {message_id} belongs to multiple rooms"
        )));
    }
    let Some((channel_id, bytes)) = rows.pop() else {
        return Ok(None);
    };
    let record = decode_record(&bytes)?;
    if record.message_id != message_id || record.channel_id != channel_id {
        return Err(corrupt(format!(
            "message {message_id} lookup does not match its row"
        )));
    }
    Ok(Some(record))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::projections::{
        handler::{DurableEvent, Projection},
        messages::{encode_key, encode_record, MessagesProjection},
        read_model::Table,
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
        let rows = |table| state.read_model().read(|conn| read_model::count(conn, table)).unwrap();
        assert_eq!(rows(Table::Messages), 0);
        assert_eq!(rows(Table::MessageVersions), 0);
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

    /// A snapshot saved while messages lived in the in-memory indexes still
    /// lists them. They are not loaded: the read model is rebuilt from the
    /// log, so nothing can be read from a stale copy.
    #[test]
    fn legacy_snapshot_message_indexes_are_not_loaded() {
        let dir = tempfile::tempdir().unwrap();
        let state = ProjectionState::new();
        let row = record("ch_a", "msg_a");
        for index in crate::engine::locks::LEGACY_MESSAGE_INDEXES {
            state.insert(index, encode_key("ch_a", "msg_a"), encode_record(&row), 9);
        }
        state.insert("users", b"kept".to_vec(), b"row".to_vec(), 9);
        state.set_applied_commit_seq(9);
        state.save_snapshot(dir.path()).unwrap();
        let (restored, watermark) = ProjectionState::load_snapshot(dir.path()).unwrap().unwrap();
        assert_eq!(watermark, 9);
        for index in crate::engine::locks::LEGACY_MESSAGE_INDEXES {
            assert_eq!(restored.index_len(index), 0, "{index}");
        }
        assert_eq!(restored.get("users", b"kept"), Some(b"row".to_vec()));
        assert_eq!(get(&restored, "msg_a").unwrap(), None);
    }

    #[test]
    fn exact_lookup_does_not_decode_unrelated_history() {
        let state = ProjectionState::new();
        let row = record("ch_a", "msg_a");
        apply(&state, "message_created", &row, 1);
        state
            .read_model()
            .write(|conn| {
                read_model::put_message(
                    conn,
                    &encode_key("ch_b", "unrelated"),
                    "ch_b",
                    "unrelated",
                    1,
                    &[0xff],
                )
            })
            .unwrap();
        assert_eq!(get(&state, "msg_a").unwrap(), Some(row));
        assert!(get(&state, "unrelated").is_err());
        assert_eq!(get(&state, "absent").unwrap(), None);
    }
}
