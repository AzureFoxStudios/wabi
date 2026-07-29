//! Channels projection: stores channel metadata for listing and lookup.
//!
//! Handles `channel_created` events and stores `domain::Channel` as JSON
//! in the `channels` index keyed by channel_id.

use crate::domain::Channel;
use crate::engine::locks::ProjectionState;
use crate::error::Result;
use crate::projections::handler::{DurableEvent, Projection};
use crate::projections::query::{apply_limit, ChannelsFilter, QueryableProjection};

pub struct ChannelProjection;

impl Projection for ChannelProjection {
    fn event_type(&self) -> &str {
        "channel_created"
    }

    fn event_types(&self) -> Vec<&str> {
        vec!["channel_created", "channel_updated"]
    }

    fn apply(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        match event.event_type.as_str() {
            "channel_created" => self.apply_created(event, state),
            "channel_updated" => self.apply_updated(event, state),
            _ => Ok(()),
        }
    }
}

impl ChannelProjection {
    fn apply_created(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
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

    /// Merge a partial channel update (sent by the settings endpoint) into
    /// the existing channel record. Unknown/missing fields are left as-is.
    fn apply_updated(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        let patch: serde_json::Value = serde_json::from_slice(&event.payload).map_err(|e| {
            crate::error::WabiError::Validation {
                command: "channels_projection".into(),
                reason: format!("failed to decode channel update: {e}"),
            }
        })?;
        let channel_id = patch
            .get("channel_id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if channel_id.is_empty() {
            return Ok(());
        }
        let key = channel_id.as_bytes().to_vec();
        let existing = match state.get("channels", &key) {
            Some(bytes) => serde_json::from_slice::<Channel>(&bytes).unwrap_or_else(|_| Channel::new(&channel_id, "", 0)),
            None => Channel::new(&channel_id, "", 0),
        };
        let mut channel = existing;
        if let Some(name) = patch.get("name").and_then(|v| v.as_str()) {
            channel.name = name.to_string();
        }
        if let Some(desc) = patch.get("description").and_then(|v| v.as_str()) {
            channel.description = Some(desc.to_string());
        }
        if let Some(force) = patch.get("force_spoiler").and_then(|v| v.as_bool()) {
            channel.force_spoiler = force;
        }
        if let Some(position) = patch.get("position").and_then(|v| v.as_i64()) {
            if let Ok(position) = i32::try_from(position) {
                channel.position = position;
            }
        }
        if let Some(parent_id) = patch.get("parent_id") {
            channel.parent_id = parent_id.as_str().map(str::to_owned);
        }
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

impl QueryableProjection for ChannelProjection {
    type Record = Channel;
    type Filter = ChannelsFilter;

    fn query(&self, state: &ProjectionState, filter: &ChannelsFilter) -> Result<Vec<Channel>> {
        let mut results = Vec::new();
        match &filter.channel_id {
            Some(channel_id) => {
                let key = channel_id.as_bytes().to_vec();
                if let Some(bytes) = state.get("channels", &key) {
                    if let Ok(channel) = serde_json::from_slice::<Channel>(&bytes) {
                        results.push(channel);
                    }
                }
            }
            None => {
                state.for_each("channels", |_key, value| {
                    if let Ok(channel) = serde_json::from_slice::<Channel>(value) {
                        results.push(channel);
                    }
                });
            }
        }
        apply_limit(&mut results, filter.limit);
        Ok(results)
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

    #[test]
    fn query_by_channel_id_lookup() {
        let state = ProjectionState::new();
        let proj = ChannelProjection;
        let mut ch = Channel::new("ch_1", "general", 42);
        ch.created_at_micros = 1_000_000;
        proj.apply(&DurableEvent { commit_seq: 2, stream_id: "channels".into(), event_type: "channel_created".into(), payload: serde_json::to_vec(&ch).unwrap() }, &state).unwrap();
        let expected_id = format!("ch_{:x}", 2);

        let found = proj.query(&state, &ChannelsFilter { channel_id: Some(expected_id.clone()), ..Default::default() }).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].channel_id, expected_id);

        let missing = proj.query(&state, &ChannelsFilter { channel_id: Some("ch_nope".into()), ..Default::default() }).unwrap();
        assert!(missing.is_empty());
    }

    #[test]
    fn query_all_channels_and_limit() {
        let state = ProjectionState::new();
        let proj = ChannelProjection;
        for seq in 1..=4u64 {
            let mut ch = Channel::new("ch", &format!("c{seq}"), 1);
            ch.channel_id = format!("ch_{:x}", seq);
            proj.apply(&DurableEvent { commit_seq: seq, stream_id: "channels".into(), event_type: "channel_created".into(), payload: serde_json::to_vec(&ch).unwrap() }, &state).unwrap();
        }
        let all = proj.query(&state, &ChannelsFilter::default()).unwrap();
        assert_eq!(all.len(), 4);
        let limited = proj.query(&state, &ChannelsFilter { limit: Some(2), ..Default::default() }).unwrap();
        assert_eq!(limited.len(), 2);
    }

    #[test]
    fn apply_updated_merges_mutable_fields() {
        let state = ProjectionState::new();
        let proj = ChannelProjection;
        let channel = Channel::new("ignored", "general", 42);
        proj.apply(
            &DurableEvent {
                commit_seq: 2,
                stream_id: "channels".into(),
                event_type: "channel_created".into(),
                payload: serde_json::to_vec(&channel).unwrap(),
            },
            &state,
        )
        .unwrap();

        let channel_id = "ch_2";
        let patch = serde_json::json!({
            "channel_id": channel_id,
            "name": "announcements",
            "description": "Important updates",
            "position": 7,
            "parent_id": "ch_parent",
            "force_spoiler": true
        });
        proj.apply(
            &DurableEvent {
                commit_seq: 3,
                stream_id: format!("channels:{channel_id}"),
                event_type: "channel_updated".into(),
                payload: serde_json::to_vec(&patch).unwrap(),
            },
            &state,
        )
        .unwrap();

        let stored = state.get("channels", channel_id.as_bytes()).unwrap();
        let updated: Channel = serde_json::from_slice(&stored).unwrap();
        assert_eq!(updated.name, "announcements");
        assert_eq!(updated.description.as_deref(), Some("Important updates"));
        assert_eq!(updated.position, 7);
        assert_eq!(updated.parent_id.as_deref(), Some("ch_parent"));
        assert!(updated.force_spoiler);
    }
}
