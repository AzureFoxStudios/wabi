use crate::engine::locks::ProjectionState;
use crate::error::Result;
use crate::projections::codec::RecordCodec;
use crate::projections::handler::{DurableEvent, Projection};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DmRecipientRecord {
    pub dm_id: String,
    pub message_id: String,
    pub recipient_user_id: u64,
    pub delivered_at_micros: Option<i64>,
    pub read_at_micros: Option<i64>,
}

impl RecordCodec for DmRecipientRecord {
    fn codec_name() -> &'static str {
        "dm_message_recipients"
    }
}

pub fn encode_record(r: &DmRecipientRecord) -> Vec<u8> {
    postcard::to_allocvec(r).expect("postcard serialization failed")
}

pub fn decode_record(buf: &[u8]) -> Result<DmRecipientRecord> {
    postcard::from_bytes(buf).map_err(|e| crate::error::WabiError::Corrupt {
        location: "dm_message_recipients projection".into(),
        detail: format!("postcard decode failed: {e}"),
    })
}

pub fn encode_key(dm_id: &str, message_id: &str, recipient_user_id: u64) -> Vec<u8> {
    let mut buf = Vec::new();
    buf.extend_from_slice(&(dm_id.len() as u64).to_le_bytes());
    buf.extend_from_slice(dm_id.as_bytes());
    buf.extend_from_slice(&(message_id.len() as u64).to_le_bytes());
    buf.extend_from_slice(message_id.as_bytes());
    buf.extend_from_slice(&recipient_user_id.to_le_bytes());
    buf
}

impl DmMessageRecipientsProjection {
    /// Look up a single DM recipient record.
    pub fn get_recipient(state: &ProjectionState, dm_id: &str, message_id: &str, user_id: u64) -> Result<Option<DmRecipientRecord>> {
        let key = encode_key(dm_id, message_id, user_id);
        match state.get("dm_message_recipients", &key) {
            None => Ok(None),
            Some(bytes) => decode_record(&bytes).map(Some),
        }
    }

    /// List all recipient records for a specific message in a DM conversation.
    pub fn list_recipients(state: &ProjectionState, dm_id: &str, message_id: &str) -> Result<Vec<DmRecipientRecord>> {
        let mut prefix = Vec::new();
        prefix.extend_from_slice(&(dm_id.len() as u64).to_le_bytes());
        prefix.extend_from_slice(dm_id.as_bytes());
        prefix.extend_from_slice(&(message_id.len() as u64).to_le_bytes());
        prefix.extend_from_slice(message_id.as_bytes());
        let mut results = Vec::new();
        state.prefix_scan("dm_message_recipients", &prefix, |_key, value| {
            if let Ok(record) = decode_record(value) {
                results.push(record);
            }
        });
        Ok(results)
    }
}

pub struct DmMessageRecipientsProjection;

impl Projection for DmMessageRecipientsProjection {
    fn event_type(&self) -> &str {
        "dm_message_recipient_added"
    }

    fn apply(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        let record: DmRecipientRecord = decode_record(&event.payload)?;
        let key = encode_key(&record.dm_id, &record.message_id, record.recipient_user_id);
        let value = encode_record(&record);
        state.insert("dm_message_recipients", key, value, event.commit_seq);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_decode_roundtrip() {
        let r = DmRecipientRecord {
            dm_id: "dm_01".into(),
            message_id: "msg_01".into(),
            recipient_user_id: 200,
            delivered_at_micros: Some(3_000_000),
            read_at_micros: None,
        };
        let buf = encode_record(&r);
        let decoded = decode_record(&buf).unwrap();
        assert_eq!(r, decoded);
    }

    #[test]
    fn insert_and_lookup() {
        let state = ProjectionState::new();
        let proj = DmMessageRecipientsProjection;

        let r = DmRecipientRecord {
            dm_id: "dm_01".into(),
            message_id: "msg_01".into(),
            recipient_user_id: 200,
            delivered_at_micros: None,
            read_at_micros: None,
        };

        let event = DurableEvent {
            commit_seq: 1,
            stream_id: "dm_01".into(),
            event_type: "dm_message_recipient_added".into(),
            payload: encode_record(&r),
        };

        proj.apply(&event, &state).unwrap();

        let key = encode_key("dm_01", "msg_01", 200);
        let stored = state.get("dm_message_recipients", &key).unwrap();
        let decoded = decode_record(&stored).unwrap();
        assert_eq!(decoded.recipient_user_id, 200);
    }

    #[test]
    fn mark_delivered() {
        let state = ProjectionState::new();
        let proj = DmMessageRecipientsProjection;

        let r = DmRecipientRecord {
            dm_id: "dm_01".into(),
            message_id: "msg_01".into(),
            recipient_user_id: 200,
            delivered_at_micros: Some(5_000_000),
            read_at_micros: None,
        };

        let event = DurableEvent {
            commit_seq: 2,
            stream_id: "dm_01".into(),
            event_type: "dm_message_recipient_added".into(),
            payload: encode_record(&r),
        };

        proj.apply(&event, &state).unwrap();

        let key = encode_key("dm_01", "msg_01", 200);
        let stored = state.get("dm_message_recipients", &key).unwrap();
        let decoded = decode_record(&stored).unwrap();
        assert_eq!(decoded.delivered_at_micros, Some(5_000_000));
        assert_eq!(decoded.read_at_micros, None);
    }

    #[test]
    fn event_type_returns_correct() {
        let proj = DmMessageRecipientsProjection;
        assert_eq!(proj.event_type(), "dm_message_recipient_added");
    }

    #[test]
    fn typed_get_recipient_after_insert() {
        let state = ProjectionState::new();
        let proj = DmMessageRecipientsProjection;
        let r = DmRecipientRecord {
            dm_id: "dm_01".into(),
            message_id: "msg_01".into(),
            recipient_user_id: 200,
            delivered_at_micros: None,
            read_at_micros: None,
        };
        let event = DurableEvent {
            commit_seq: 1,
            stream_id: "dm_01".into(),
            event_type: "dm_message_recipient_added".into(),
            payload: encode_record(&r),
        };
        proj.apply(&event, &state).unwrap();
        let loaded = DmMessageRecipientsProjection::get_recipient(&state, "dm_01", "msg_01", 200).unwrap().unwrap();
        assert_eq!(loaded.recipient_user_id, 200);
    }

    #[test]
    fn typed_list_recipients_for_message() {
        let state = ProjectionState::new();
        let proj = DmMessageRecipientsProjection;
        for uid in [100u64, 200, 300] {
            let r = DmRecipientRecord {
                dm_id: "dm_01".into(),
                message_id: "msg_01".into(),
                recipient_user_id: uid,
                delivered_at_micros: None,
                read_at_micros: None,
            };
            proj.apply(
                &DurableEvent {
                    commit_seq: uid,
                    stream_id: "dm_01".into(),
                    event_type: "dm_message_recipient_added".into(),
                    payload: encode_record(&r),
                },
                &state,
            )
            .unwrap();
        }
        let recipients = DmMessageRecipientsProjection::list_recipients(&state, "dm_01", "msg_01").unwrap();
        assert_eq!(recipients.len(), 3);
    }
}
