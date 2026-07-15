use crate::domain::UserLayout;
use crate::engine::locks::ProjectionState;
use crate::error::Result;
use crate::projections::codec::RecordCodec;
use crate::projections::handler::{DurableEvent, Projection};

impl RecordCodec for UserLayout {
    fn codec_name() -> &'static str {
        "layouts"
    }
}

pub fn encode_record(l: &UserLayout) -> Vec<u8> {
    postcard::to_allocvec(l).expect("postcard serialization failed")
}

pub fn decode_record(buf: &[u8]) -> Result<UserLayout> {
    postcard::from_bytes(buf).map_err(|e| crate::error::WabiError::Corrupt {
        location: "layouts projection".into(),
        detail: format!("postcard decode failed: {e}"),
    })
}

pub fn encode_key(user_id: u64) -> Vec<u8> {
    user_id.to_be_bytes().to_vec()
}

pub struct LayoutsProjection;

impl Projection for LayoutsProjection {
    fn event_type(&self) -> &str {
        "user_layout_upserted"
    }

    fn apply(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        let record: UserLayout = decode_record(&event.payload)?;
        let key = encode_key(record.user_id);
        let value = encode_record(&record);
        state.insert("user_layouts", key, value, event.commit_seq);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_layout() -> UserLayout {
        UserLayout {
            user_id: 42,
            layout_json: r#"{"panels":[]}"#.into(),
            updated_at_micros: 1_000_000,
        }
    }

    #[test]
    fn encode_decode_roundtrip() {
        let l = sample_layout();
        let buf = encode_record(&l);
        let decoded = decode_record(&buf).unwrap();
        assert_eq!(l, decoded);
    }

    #[test]
    fn insert_and_lookup() {
        let state = ProjectionState::new();
        let proj = LayoutsProjection;

        let l = sample_layout();
        let event = DurableEvent {
            commit_seq: 1,
            stream_id: "layouts".into(),
            event_type: "user_layout_upserted".into(),
            payload: encode_record(&l),
        };

        proj.apply(&event, &state).unwrap();

        let key = encode_key(42);
        let stored = state.get("user_layouts", &key).unwrap();
        let decoded = decode_record(&stored).unwrap();
        assert_eq!(decoded.layout_json, r#"{"panels":[]}"#);
    }

    #[test]
    fn missing_returns_none() {
        let state = ProjectionState::new();
        let key = encode_key(99);
        assert!(state.get("user_layouts", &key).is_none());
    }

    #[test]
    fn event_type_returns_correct() {
        let proj = LayoutsProjection;
        assert_eq!(proj.event_type(), "user_layout_upserted");
    }

    #[test]
    fn bad_payload_returns_error() {
        let state = ProjectionState::new();
        let event = DurableEvent {
            commit_seq: 1,
            stream_id: "layouts".into(),
            event_type: "user_layout_upserted".into(),
            payload: vec![0xba, 0xad],
        };
        let result = LayoutsProjection.apply(&event, &state);
        assert!(result.is_err());
    }

    #[test]
    fn encode_key_is_big_endian() {
        let key = encode_key(42);
        assert_eq!(key.len(), 8);
        assert_eq!(key, 42u64.to_be_bytes().to_vec());
    }
}
