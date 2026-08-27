//! Channels projection: stores channel metadata for listing and lookup.
//!
//! Handles `channel_created`, `channel_updated` and `channel_deleted`
//! events and stores `domain::Channel` as JSON in the `channels` index
//! keyed by channel_id.

use crate::domain::{Channel, ChannelKind};
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
        vec![
            "channel_created",
            "channel_updated",
            "channel_deleted",
            "update_settings",
            "update",
        ]
    }

    fn apply(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        match event.event_type.as_str() {
            "channel_created" => self.apply_created(event, state),
            "channel_updated" | "update_settings" | "update" => self.apply_updated(event, state),
            "channel_deleted" => self.apply_deleted(event, state),
            _ => Ok(()),
        }
    }
}

/// Map a wire `channel_kind` value to the domain enum. Accepts both the
/// serde string form ("Voice") and the raw `repr(u8)` number some legacy
/// writers used (`ChannelKind::Voice as u8`).
fn parse_channel_kind(value: &serde_json::Value) -> ChannelKind {
    match value {
        serde_json::Value::Number(n) => match n.as_u64() {
            Some(0) => ChannelKind::Text,
            Some(1) => ChannelKind::Voice,
            Some(2) => ChannelKind::Dm,
            Some(3) => ChannelKind::GroupDm,
            Some(4) => ChannelKind::Announcement,
            Some(5) => ChannelKind::Whiteboard,
            Some(6) => ChannelKind::Wiki,
            Some(7) => ChannelKind::Forum,
            Some(8) => ChannelKind::Incident,
            Some(9) => ChannelKind::Gallery,
            Some(10) => ChannelKind::Category,
            Some(11) => ChannelKind::Lore,
            Some(12) => ChannelKind::Planning,
            Some(13) => ChannelKind::Reception,
            _ => ChannelKind::Text,
        },
        serde_json::Value::String(s) => match s.as_str() {
            "Text" => ChannelKind::Text,
            "Voice" => ChannelKind::Voice,
            "Dm" => ChannelKind::Dm,
            "GroupDm" => ChannelKind::GroupDm,
            "Announcement" => ChannelKind::Announcement,
            "Whiteboard" => ChannelKind::Whiteboard,
            "Wiki" => ChannelKind::Wiki,
            "Forum" => ChannelKind::Forum,
            "Incident" => ChannelKind::Incident,
            "Gallery" => ChannelKind::Gallery,
            "Category" => ChannelKind::Category,
            "Lore" => ChannelKind::Lore,
            "Planning" => ChannelKind::Planning,
            "Reception" => ChannelKind::Reception,
            _ => ChannelKind::Text,
        },
        _ => ChannelKind::Text,
    }
}

/// Decode a `channel_created` payload into a [`Channel`].
///
/// Strict serde first; on failure fall back to a lenient field-by-field
/// decode. The lenient path matters for two legacy payload shapes still
/// present in on-disk event logs:
///   * DM/group creation wrote `"channel_kind": <number>` (repr-u8) which
///     strict serde rejects (it expects the variant name string). Those
///     events used to be dropped silently, so DM/group channels never got
///     a projection row and their deletes could never find them.
///   * Partial payloads missing optional fields.
fn decode_created_payload(payload: &[u8]) -> Result<Channel> {
    if let Ok(channel) = serde_json::from_slice::<Channel>(payload) {
        return Ok(channel);
    }
    let value: serde_json::Value = serde_json::from_slice(payload).map_err(|e| {
        crate::error::WabiError::Validation {
            command: "channels_projection".into(),
            reason: format!("failed to decode channel payload: {e}"),
        }
    })?;
    let get_str = |key: &str| {
        value
            .get(key)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    };
    Ok(Channel {
        channel_id: get_str("channel_id"),
        name: get_str("name"),
        channel_kind: value
            .get("channel_kind")
            .map(parse_channel_kind)
            .unwrap_or(ChannelKind::Text),
        owner_user_id: value
            .get("owner_user_id")
            .and_then(|v| v.as_u64())
            .unwrap_or(0),
        created_at_micros: value
            .get("created_at_micros")
            .and_then(|v| v.as_i64())
            .unwrap_or(0),
        is_active: value.get("is_active").and_then(|v| v.as_bool()).unwrap_or(true),
        description: value
            .get("description")
            .and_then(|v| v.as_str())
            .map(str::to_owned),
        position: value
            .get("position")
            .and_then(|v| v.as_i64())
            .and_then(|v| i32::try_from(v).ok())
            .unwrap_or(0),
        parent_id: value
            .get("parent_id")
            .and_then(|v| v.as_str())
            .map(str::to_owned),
        asset_storage: value
            .get("asset_storage")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        force_spoiler: value
            .get("force_spoiler")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
    })
}

impl ChannelProjection {
    fn apply_created(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        let mut channel = decode_created_payload(&event.payload)?;
        // Regular channels are created on the shared "channels" stream and
        // the engine assigns the id (ch_{commit_seq}). DM/group channels are
        // created on their own stream with a caller-assigned id
        // (dm-user-{a}-user-{b} / group-{uuid}) — keep that id, otherwise
        // the projection row becomes unreachable by the id every other
        // subsystem uses (duplicate-checks, deletes, message auth) and the
        // channel turns into an unkillable zombie. The discriminator: a
        // caller-assigned id is written to the channel's OWN stream, so it
        // matches the event's stream_id.
        if channel.channel_id.is_empty() || channel.channel_id != event.stream_id {
            channel.channel_id = format!("ch_{:x}", event.commit_seq);
        }
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

    /// Remove the channel row from the `channels` index. Payload is
    /// `{"channel_id": "..."}` (what `WdbAdapter::delete_channel` emits).
    /// Deleting through a durable event (instead of a projection-only
    /// overwrite) is what makes deletions survive event-log replay,
    /// snapshot restores, and replication — the old overwrite-only path
    /// resurrected deleted channels on every restart ("zombie channels").
    fn apply_deleted(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        let value: serde_json::Value = serde_json::from_slice(&event.payload).map_err(|e| {
            crate::error::WabiError::Validation {
                command: "channels_projection".into(),
                reason: format!("failed to decode channel_deleted payload: {e}"),
            }
        })?;
        let channel_id = value
            .get("channel_id")
            .or_else(|| value.get("row").and_then(|r| r.get("channel_id")))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if channel_id.is_empty() {
            return Ok(());
        }
        state.remove("channels", channel_id.as_bytes());
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
        let patch = patch.get("row").cloned().unwrap_or(patch);
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
            Some(bytes) => Some(serde_json::from_slice::<Channel>(&bytes).unwrap_or_else(|_| Channel::new(&channel_id, "", 0))),
            None => None,
        };
        // Ghost-row guard: an update for a channel the projection has never
        // seen must not materialize a NAMELESS row (that is what rendered
        // bare "#" / raw-id channels in the sidebar). Only create the row
        // when the patch itself carries a usable name.
        if existing.is_none()
            && !patch
                .get("name")
                .and_then(|v| v.as_str())
                .is_some_and(|name| !name.trim().is_empty())
        {
            return Ok(());
        }
        let mut channel = existing.unwrap_or_else(|| Channel::new(&channel_id, "", 0));
        if let Some(name) = patch.get("name").and_then(|v| v.as_str()) {
            // Never blank a channel name to empty — an empty string here
            // would turn the channel into a nameless "#" row.
            if !name.trim().is_empty() {
                channel.name = name.to_string();
            }
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

    #[test]
    fn channel_deleted_removes_row() {
        let state = ProjectionState::new();
        let proj = ChannelProjection;
        let channel = Channel::new("", "doomed", 42);
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
        let channel_id = format!("ch_{:x}", 2);
        assert!(state.get("channels", channel_id.as_bytes()).is_some());

        // Deleting via the durable event removes the projection row — this
        // is what keeps a deletion true across restart/replay (no zombies).
        proj.apply(
            &DurableEvent {
                commit_seq: 3,
                stream_id: format!("channels:{channel_id}"),
                event_type: "channel_deleted".into(),
                payload: serde_json::to_vec(&serde_json::json!({ "channel_id": channel_id })).unwrap(),
            },
            &state,
        )
        .unwrap();

        assert!(state.get("channels", channel_id.as_bytes()).is_none());
        let all = proj.query(&state, &ChannelsFilter::default()).unwrap();
        assert!(all.is_empty());

        // Deleting an unknown channel is a harmless no-op.
        proj.apply(
            &DurableEvent {
                commit_seq: 4,
                stream_id: "channels:ch_nope".into(),
                event_type: "channel_deleted".into(),
                payload: serde_json::to_vec(&serde_json::json!({ "channel_id": "ch_nope" })).unwrap(),
            },
            &state,
        )
        .unwrap();
    }

    #[test]
    fn apply_created_preserves_caller_assigned_dm_id_and_numeric_kind() {
        // Legacy DM creation wrote a caller-assigned id on the channel's own
        // stream and channel_kind as the repr-u8 number (2 = Dm). The row
        // must land under the caller's id (dm-user-1-user-2), not the
        // commit-seq id — otherwise deletes/lookups by the real id never
        // match and the DM becomes an undeletable zombie.
        let state = ProjectionState::new();
        let proj = ChannelProjection;
        let payload = serde_json::json!({
            "channel_id": "dm-user-1-user-2",
            "name": "DM with bob",
            "channel_kind": 2u8,
            "owner_user_id": 1,
            "created_at_micros": 1_000_000
        });
        proj.apply(
            &DurableEvent {
                commit_seq: 9,
                stream_id: "dm-user-1-user-2".into(),
                event_type: "channel_created".into(),
                payload: serde_json::to_vec(&payload).unwrap(),
            },
            &state,
        )
        .unwrap();

        let stored = state
            .get("channels", b"dm-user-1-user-2")
            .expect("row must be keyed by the caller-assigned id");
        let decoded: Channel = serde_json::from_slice(&stored).unwrap();
        assert_eq!(decoded.channel_id, "dm-user-1-user-2");
        assert_eq!(decoded.name, "DM with bob");
        assert_eq!(decoded.channel_kind, crate::domain::ChannelKind::Dm);
        // The seq-derived phantom key must NOT exist.
        assert!(state
            .get("channels", format!("ch_{:x}", 9).as_bytes())
            .is_none());
    }

    #[test]
    fn apply_created_group_numeric_kind_maps_to_group_dm() {
        let state = ProjectionState::new();
        let proj = ChannelProjection;
        let payload = serde_json::json!({
            "channel_id": "group-1234",
            "name": "the crew",
            "channel_kind": 3u8,
            "owner_user_id": 0,
            "created_at_micros": 1
        });
        proj.apply(
            &DurableEvent {
                commit_seq: 10,
                stream_id: "group-1234".into(),
                event_type: "channel_created".into(),
                payload: serde_json::to_vec(&payload).unwrap(),
            },
            &state,
        )
        .unwrap();
        let stored = state.get("channels", b"group-1234").unwrap();
        let decoded: Channel = serde_json::from_slice(&stored).unwrap();
        assert_eq!(decoded.channel_kind, crate::domain::ChannelKind::GroupDm);
        assert_eq!(decoded.name, "the crew");
    }

    #[test]
    fn apply_update_settings_unwraps_row_and_clears_parent() {
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
        let wrapped = serde_json::json!({
            "row": {
                "channel_id": channel_id,
                "position": 3,
                "parent_id": serde_json::Value::Null
            }
        });
        proj.apply(
            &DurableEvent {
                commit_seq: 4,
                stream_id: format!("channels:{channel_id}"),
                event_type: "update_settings".into(),
                payload: serde_json::to_vec(&wrapped).unwrap(),
            },
            &state,
        )
        .unwrap();

        let stored = state.get("channels", channel_id.as_bytes()).unwrap();
        let updated: Channel = serde_json::from_slice(&stored).unwrap();
        assert_eq!(updated.position, 3);
        assert!(updated.parent_id.is_none());
    }
}
