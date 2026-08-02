use crate::domain::Emote;
use crate::engine::locks::ProjectionState;
use crate::error::Result;
use crate::projections::codec::RecordCodec;
use crate::projections::handler::{DurableEvent, Projection};

impl RecordCodec for Emote {
    fn codec_name() -> &'static str {
        "emotes"
    }
}

pub fn encode_record(e: &Emote) -> Vec<u8> {
    postcard::to_allocvec(e).expect("postcard serialization failed")
}

pub fn decode_record(buf: &[u8]) -> Result<Emote> {
    postcard::from_bytes(buf).map_err(|e| crate::error::WabiError::Corrupt {
        location: "emotes projection".into(),
        detail: format!("postcard decode failed: {e}"),
    })
}

pub fn encode_key(emote_id: &str) -> Vec<u8> {
    let mut buf = Vec::new();
    buf.extend_from_slice(&(emote_id.len() as u64).to_le_bytes());
    buf.extend_from_slice(emote_id.as_bytes());
    buf
}

pub struct EmotesProjection;

impl Projection for EmotesProjection {
    fn event_type(&self) -> &str {
        "emote_upserted"
    }

    fn event_types(&self) -> Vec<&str> {
        vec!["emote_upserted", "emote_deleted"]
    }

    fn apply(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        match event.event_type.as_str() {
            "emote_upserted" => {
                let record: Emote = decode_record(&event.payload)?;
                let key = encode_key(&record.emote_id);
                let value = encode_record(&record);
                state.insert("emotes", key, value, event.commit_seq);
            }
            "emote_deleted" => {
                let emote_id = std::str::from_utf8(&event.payload)
                    .map_err(|e| crate::error::WabiError::Corrupt {
                        location: "emotes projection".into(),
                        detail: format!("invalid emote_id utf8 in delete payload: {e}"),
                    })?;
                let key = encode_key(emote_id);
                state.remove("emotes", &key);
            }
            _ => {}
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_emote() -> Emote {
        Emote {
            emote_id: "emo_01".into(),
            name: "blobwave".into(),
            image_url: "https://cdn.example.com/blobwave.png".into(),
            created_at_micros: 1_000_000,
            created_by_user_id: 42,
            display_name: "Blob Wave".into(),
            artist: "Blob Artist".into(),
            category: "custom".into(),
            kind: "sticker".into(),
        }
    }

    #[test]
    fn encode_decode_roundtrip() {
        let e = sample_emote();
        let buf = encode_record(&e);
        let decoded = decode_record(&buf).unwrap();
        assert_eq!(e, decoded);
    }

    #[test]
    fn insert_and_lookup() {
        let state = ProjectionState::new();
        let proj = EmotesProjection;

        let e = sample_emote();
        let event = DurableEvent {
            commit_seq: 1,
            stream_id: "emotes".into(),
            event_type: "emote_upserted".into(),
            payload: encode_record(&e),
        };

        proj.apply(&event, &state).unwrap();

        let key = encode_key("emo_01");
        let stored = state.get("emotes", &key).unwrap();
        let decoded = decode_record(&stored).unwrap();
        assert_eq!(decoded.name, "blobwave");
    }

    #[test]
    fn missing_returns_none() {
        let state = ProjectionState::new();
        let key = encode_key("emo_99");
        assert!(state.get("emotes", &key).is_none());
    }

    #[test]
    fn event_type_returns_correct() {
        let proj = EmotesProjection;
        assert_eq!(proj.event_type(), "emote_upserted");
    }

    #[test]
    fn bad_payload_returns_error() {
        let state = ProjectionState::new();
        let event = DurableEvent {
            commit_seq: 1,
            stream_id: "emotes".into(),
            event_type: "emote_upserted".into(),
            payload: vec![0xff],
        };
        let result = EmotesProjection.apply(&event, &state);
        assert!(result.is_err());
    }
}
