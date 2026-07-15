use crate::domain::Webhook;
use crate::engine::locks::ProjectionState;
use crate::error::Result;
use crate::projections::codec::RecordCodec;
use crate::projections::handler::{DurableEvent, Projection};

impl RecordCodec for Webhook {
    fn codec_name() -> &'static str {
        "webhooks"
    }
}

pub fn encode_record(w: &Webhook) -> Vec<u8> {
    postcard::to_allocvec(w).expect("postcard serialization failed")
}

pub fn decode_record(buf: &[u8]) -> Result<Webhook> {
    postcard::from_bytes(buf).map_err(|e| crate::error::WabiError::Corrupt {
        location: "webhooks projection".into(),
        detail: format!("postcard decode failed: {e}"),
    })
}

pub fn encode_key(webhook_id: &str) -> Vec<u8> {
    let mut buf = Vec::new();
    buf.extend_from_slice(&(webhook_id.len() as u64).to_le_bytes());
    buf.extend_from_slice(webhook_id.as_bytes());
    buf
}

pub struct WebhooksProjection;

impl Projection for WebhooksProjection {
    fn event_type(&self) -> &str {
        "webhook_upserted"
    }

    fn apply(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        let record: Webhook = decode_record(&event.payload)?;
        let key = encode_key(&record.webhook_id);
        let value = encode_record(&record);
        state.insert("webhooks", key, value, event.commit_seq);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_webhook() -> Webhook {
        Webhook {
            webhook_id: "wh_01".into(),
            channel_id: "ch_01".into(),
            name: "my hook".into(),
            url: "https://hooks.example.com/xyz".into(),
            created_at_micros: 1_000_000,
            created_by_user_id: 42,
        }
    }

    #[test]
    fn encode_decode_roundtrip() {
        let w = sample_webhook();
        let buf = encode_record(&w);
        let decoded = decode_record(&buf).unwrap();
        assert_eq!(w, decoded);
    }

    #[test]
    fn insert_and_lookup() {
        let state = ProjectionState::new();
        let proj = WebhooksProjection;

        let w = sample_webhook();
        let event = DurableEvent {
            commit_seq: 1,
            stream_id: "webhooks".into(),
            event_type: "webhook_upserted".into(),
            payload: encode_record(&w),
        };

        proj.apply(&event, &state).unwrap();

        let key = encode_key("wh_01");
        let stored = state.get("webhooks", &key).unwrap();
        let decoded = decode_record(&stored).unwrap();
        assert_eq!(decoded.name, "my hook");
    }

    #[test]
    fn missing_returns_none() {
        let state = ProjectionState::new();
        let key = encode_key("wh_99");
        assert!(state.get("webhooks", &key).is_none());
    }

    #[test]
    fn event_type_returns_correct() {
        let proj = WebhooksProjection;
        assert_eq!(proj.event_type(), "webhook_upserted");
    }

    #[test]
    fn bad_payload_returns_error() {
        let state = ProjectionState::new();
        let event = DurableEvent {
            commit_seq: 1,
            stream_id: "webhooks".into(),
            event_type: "webhook_upserted".into(),
            payload: vec![0xde, 0xad],
        };
        let result = WebhooksProjection.apply(&event, &state);
        assert!(result.is_err());
    }
}
