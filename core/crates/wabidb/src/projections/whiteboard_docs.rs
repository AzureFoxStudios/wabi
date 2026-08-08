use crate::domain::WhiteboardDoc;
use crate::engine::locks::ProjectionState;
use crate::error::Result;
use crate::projections::codec::RecordCodec;
use crate::projections::handler::{DurableEvent, Projection};

impl RecordCodec for WhiteboardDoc {
    fn codec_name() -> &'static str {
        "whiteboard_docs"
    }
}

pub fn encode_record(d: &WhiteboardDoc) -> Vec<u8> {
    postcard::to_allocvec(d).expect("postcard serialization failed")
}

pub fn decode_record(buf: &[u8]) -> Result<WhiteboardDoc> {
    postcard::from_bytes(buf).map_err(|e| crate::error::WabiError::Corrupt {
        location: "whiteboard_docs projection".into(),
        detail: format!("postcard decode failed: {e}"),
    })
}

pub fn encode_key(board_id: &str) -> Vec<u8> {
    board_id.as_bytes().to_vec()
}

pub struct WhiteboardDocsProjection;

impl Projection for WhiteboardDocsProjection {
    fn event_type(&self) -> &str {
        "whiteboard_doc_upserted"
    }

    fn apply(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        let record: WhiteboardDoc = decode_record(&event.payload)?;
        let key = encode_key(&record.board_id);
        let value = encode_record(&record);
        state.insert("whiteboard_docs", key, value, event.commit_seq);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_doc() -> WhiteboardDoc {
        WhiteboardDoc {
            board_id: "channel:abc".into(),
            doc_json: r#"{"boardId":"channel:abc","version":3}"#.into(),
            updated_at_micros: 1_000_000,
        }
    }

    #[test]
    fn encode_decode_roundtrip() {
        let d = sample_doc();
        let buf = encode_record(&d);
        let decoded = decode_record(&buf).unwrap();
        assert_eq!(d, decoded);
    }

    #[test]
    fn insert_and_lookup() {
        let state = ProjectionState::new();
        let proj = WhiteboardDocsProjection;

        let d = sample_doc();
        let event = DurableEvent {
            commit_seq: 1,
            stream_id: "whiteboard_docs:channel:abc".into(),
            event_type: "whiteboard_doc_upserted".into(),
            payload: encode_record(&d),
        };

        proj.apply(&event, &state).unwrap();

        let key = encode_key("channel:abc");
        let stored = state.get("whiteboard_docs", &key).unwrap();
        let decoded = decode_record(&stored).unwrap();
        assert_eq!(decoded.doc_json, r#"{"boardId":"channel:abc","version":3}"#);
    }

    #[test]
    fn missing_returns_none() {
        let state = ProjectionState::new();
        let key = encode_key("channel:nope");
        assert!(state.get("whiteboard_docs", &key).is_none());
    }

    #[test]
    fn event_type_returns_correct() {
        let proj = WhiteboardDocsProjection;
        assert_eq!(proj.event_type(), "whiteboard_doc_upserted");
    }

    #[test]
    fn bad_payload_returns_error() {
        let state = ProjectionState::new();
        let event = DurableEvent {
            commit_seq: 1,
            stream_id: "whiteboard_docs:channel:abc".into(),
            event_type: "whiteboard_doc_upserted".into(),
            payload: vec![0xba, 0xad],
        };
        let result = WhiteboardDocsProjection.apply(&event, &state);
        assert!(result.is_err());
    }

    #[test]
    fn encode_key_is_board_id_bytes() {
        let key = encode_key("channel:abc");
        assert_eq!(key, b"channel:abc".to_vec());
    }
}
