//! Channels projection: stores channel metadata for listing and lookup.
//!
//! Handles `channel_created` events and stores `domain::Channel` as JSON
//! in the `channels` index keyed by channel_id.

use crate::domain::Channel;
use crate::engine::locks::ProjectionState;
use crate::error::Result;
use crate::projections::handler::{DurableEvent, Projection};

pub struct ChannelProjection;

impl Projection for ChannelProjection {
    fn event_type(&self) -> &str {
        "channel_created"
    }

    fn apply(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        let mut channel: Channel = serde_json::from_slice(&event.payload).map_err(|e| {
            crate::error::WabiError::Validation {
                command: "channels_projection".into(),
                reason: format!("failed to decode channel payload: {e}"),
            }
        })?;
        channel.channel_id = format!("ch_{:x}", event.commit_seq);
        let key = channel.channel_id.as_bytes().to_vec();
        let value = serde_json::to_vec(&channel).map_err(|e| {
            crate::error::WabiError::Validation {
                command: "channels_projection".into(),
                reason: format!("failed to encode channel: {e}"),
            }
        })?;
        state.insert("channels", key, value, event.commit_seq);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::projections::handler::DurableEvent;

    #[test]
    fn encode_decode_roundtrip() {
        let ch = Channel::new("ch_1", "general", 1);
        let buf = serde_json::to_vec(&ch).unwrap();
        let decoded: Channel = serde_json::from_slice(&buf).unwrap();
        assert_eq!(ch, decoded);
    }

    #[test]
    fn apply_stores_channel() {
        let state = ProjectionState::new();
        let proj = ChannelProjection;
        let mut ch = Channel::new("ch_1", "general", 42);
        ch.created_at_micros = 1_000_000;
        ch.channel_kind = crate::domain::ChannelKind::Text;
        let payload = serde_json::to_vec(&ch).unwrap();
        let event = DurableEvent {
            commit_seq: 2,
            stream_id: "channels".into(),
            event_type: "channel_created".into(),
            payload,
        };
        proj.apply(&event, &state).unwrap();
        let expected_id = format!("ch_{:x}", 2);
        let key = expected_id.as_bytes().to_vec();
        let stored = state.get("channels", &key).unwrap();
        let decoded: Channel = serde_json::from_slice(&stored).unwrap();
        assert_eq!(decoded.channel_id, expected_id);
        assert_eq!(decoded.name, "general");
        assert_eq!(decoded.owner_user_id, 42);
    }
}
