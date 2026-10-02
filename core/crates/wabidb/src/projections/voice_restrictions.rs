//! Durable per-channel voice moderation. Legacy event payloads are JSON;
//! optional actor/time metadata does not change any postcard-encoded record.

use crate::{
    domain::{DeafenRecord, MuteRecord},
    engine::locks::ProjectionState,
    error::{Result, WabiError},
    projections::handler::{DurableEvent, Projection},
};
use serde::Deserialize;
use std::collections::{HashMap, HashSet};

pub const MUTES: &str = "mutes";
pub const DEAFENS: &str = "deafens";
pub const EVENTS: &[&str] = &[
    "user_muted",
    "user_unmuted",
    "user_deafened",
    "user_undeafened",
];

fn corrupt(detail: &str) -> WabiError {
    WabiError::Corrupt {
        location: "voice restrictions".into(),
        detail: detail.into(),
    }
}

fn valid_channel(channel: &str) -> bool {
    !channel.is_empty()
        && channel.len() <= 128
        && channel
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b':'))
}

pub fn encode_key(channel_id: &str, user_id: u64) -> Vec<u8> {
    let mut key = Vec::with_capacity(16 + channel_id.len());
    key.extend_from_slice(&(channel_id.len() as u64).to_be_bytes());
    key.extend_from_slice(channel_id.as_bytes());
    key.extend_from_slice(&user_id.to_be_bytes());
    key
}

#[derive(Deserialize)]
struct RestrictionEvent {
    channel_id: String,
    target_user_id: u64,
    #[serde(default)]
    until_micros: Option<i64>,
    #[serde(default)]
    actor_user_id: u64,
    #[serde(default)]
    set_at_micros: i64,
}

fn decode_event(event_type: &str, bytes: &[u8]) -> Result<RestrictionEvent> {
    if !EVENTS.contains(&event_type) || bytes.len() > 4096 {
        return Err(corrupt("invalid moderation event"));
    }
    let row: RestrictionEvent =
        serde_json::from_slice(bytes).map_err(|_| corrupt("invalid moderation event JSON"))?;
    if !valid_channel(&row.channel_id)
        || row.target_user_id == 0
        || row.set_at_micros < 0
        || (event_type == "user_muted" && row.until_micros.is_none())
    {
        return Err(corrupt("invalid moderation event fields"));
    }
    Ok(row)
}

pub fn decode_mute(bytes: &[u8]) -> Result<MuteRecord> {
    if bytes.len() > 4096 {
        return Err(corrupt("oversized mute record"));
    }
    let row: MuteRecord =
        serde_json::from_slice(bytes).map_err(|_| corrupt("invalid mute record JSON"))?;
    if !valid_channel(&row.channel_id) || row.user_id == 0 || row.set_at_micros < 0 {
        return Err(corrupt("invalid mute record fields"));
    }
    Ok(row)
}

pub fn decode_deafen(bytes: &[u8]) -> Result<DeafenRecord> {
    if bytes.len() > 4096 {
        return Err(corrupt("oversized deafen record"));
    }
    let row: DeafenRecord =
        serde_json::from_slice(bytes).map_err(|_| corrupt("invalid deafen record JSON"))?;
    if !valid_channel(&row.channel_id) || row.user_id == 0 || row.set_at_micros < 0 {
        return Err(corrupt("invalid deafen record fields"));
    }
    Ok(row)
}

pub fn is_muted(
    state: &ProjectionState,
    channel_id: &str,
    user_id: u64,
    now_micros: i64,
) -> Result<bool> {
    let Some(bytes) = state.get(MUTES, &encode_key(channel_id, user_id)) else {
        return Ok(false);
    };
    let row = decode_mute(&bytes)?;
    if row.channel_id != channel_id || row.user_id != user_id {
        return Err(corrupt("mute key does not match record"));
    }
    Ok(row.until_micros == i64::MAX || row.until_micros > now_micros)
}

pub fn is_deafened(state: &ProjectionState, channel_id: &str, user_id: u64) -> Result<bool> {
    let Some(bytes) = state.get(DEAFENS, &encode_key(channel_id, user_id)) else {
        return Ok(false);
    };
    let row = decode_deafen(&bytes)?;
    if row.channel_id != channel_id || row.user_id != user_id {
        return Err(corrupt("deafen key does not match record"));
    }
    Ok(true)
}

pub struct VoiceRestrictionsProjection;

impl Projection for VoiceRestrictionsProjection {
    fn event_type(&self) -> &str {
        EVENTS[0]
    }

    fn event_types(&self) -> Vec<&str> {
        EVENTS.to_vec()
    }

    fn apply(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        let row = decode_event(&event.event_type, &event.payload)?;
        let mute = matches!(event.event_type.as_str(), "user_muted" | "user_unmuted");
        let index = if mute { MUTES } else { DEAFENS };
        if event.stream_id != format!("{index}:{}:{}", row.channel_id, row.target_user_id) {
            return Err(corrupt("moderation payload does not match its stream"));
        }
        let key = encode_key(&row.channel_id, row.target_user_id);
        let value = match event.event_type.as_str() {
            "user_muted" => serde_json::to_vec(&MuteRecord {
                channel_id: row.channel_id,
                user_id: row.target_user_id,
                muted_by_user_id: row.actor_user_id,
                until_micros: row
                    .until_micros
                    .ok_or_else(|| corrupt("mute expiry missing"))?,
                set_at_micros: row.set_at_micros,
            }),
            "user_deafened" => serde_json::to_vec(&DeafenRecord {
                channel_id: row.channel_id,
                user_id: row.target_user_id,
                deafened_by_user_id: row.actor_user_id,
                set_at_micros: row.set_at_micros,
            }),
            _ => {
                state.remove(index, &key);
                return Ok(());
            }
        }
        .map_err(|_| corrupt("moderation record serialization failed"))?;
        state.insert(index, key, value, event.commit_seq);
        Ok(())
    }
}

/// Older dispatchers stored only the last ignored payload per event type.
/// Those markers cannot enumerate affected pairs: recover all committed
/// kind-1 streams before the checkpoint, then filter moderation events.
/// Rebuild in scratch state so failed recovery cannot partly change a snapshot.
pub(crate) struct LegacyVoiceRepair {
    stream_hashes: HashSet<[u8; 16]>,
    markers: HashMap<String, Vec<u8>>,
    observed_markers: HashSet<String>,
    rebuilt: ProjectionState,
}

impl LegacyVoiceRepair {
    pub(crate) fn from_snapshot(state: &ProjectionState) -> Result<Option<Self>> {
        let mut markers = HashMap::new();
        for event_type in EVENTS {
            if let Some(bytes) = state.get("events", event_type.as_bytes()) {
                decode_event(event_type, &bytes)?;
                markers.insert((*event_type).to_owned(), bytes);
            }
        }
        Ok((!markers.is_empty()).then(|| Self {
            stream_hashes: HashSet::new(),
            markers,
            observed_markers: HashSet::new(),
            rebuilt: ProjectionState::new(),
        }))
    }

    pub(crate) fn include_stream(&mut self, hash: [u8; 16]) {
        self.stream_hashes.insert(hash);
    }

    pub(crate) fn includes(&self, hash: &[u8; 16]) -> bool {
        self.stream_hashes.contains(hash)
    }

    pub(crate) fn observe(&mut self, event: &DurableEvent) -> Result<()> {
        if EVENTS.contains(&event.event_type.as_str()) {
            VoiceRestrictionsProjection.apply(event, &self.rebuilt)?;
            if self.markers.get(&event.event_type) == Some(&event.payload) {
                self.observed_markers.insert(event.event_type.clone());
            }
        }
        Ok(())
    }

    pub(crate) fn finish(self, state: &ProjectionState) -> Result<()> {
        if self.observed_markers.len() != self.markers.len() {
            return Err(corrupt(
                "legacy moderation history missing; repair required before startup",
            ));
        }
        for index in [MUTES, DEAFENS] {
            state.compact_index(index, |_, _| true);
            self.rebuilt.for_each(index, |key, value| {
                state.insert(
                    index,
                    key.to_vec(),
                    value.to_vec(),
                    state.applied_commit_seq(),
                );
            });
        }
        for event_type in EVENTS {
            state.remove("events", event_type.as_bytes());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_payloads_expiry_and_stream_validation() {
        let state = ProjectionState::new();
        let mut event = DurableEvent {
            commit_seq: 1,
            stream_id: "mutes:voice:9".into(),
            event_type: "user_muted".into(),
            payload: br#"{"channel_id":"voice","target_user_id":9,"until_micros":42}"#.to_vec(),
        };
        VoiceRestrictionsProjection.apply(&event, &state).unwrap();
        assert!(is_muted(&state, "voice", 9, 41).unwrap());
        assert!(!is_muted(&state, "voice", 9, 42).unwrap());
        assert!(!is_muted(&state, "other", 9, 1).unwrap());
        event.stream_id = "mutes:other:9".into();
        assert!(VoiceRestrictionsProjection.apply(&event, &state).is_err());
        event.stream_id = "mutes:voice:9".into();
        event.payload = br#"{"channel_id":"voice","target_user_id":9}"#.to_vec();
        assert!(VoiceRestrictionsProjection.apply(&event, &state).is_err());
        event.event_type = "user_unmuted".into();
        VoiceRestrictionsProjection.apply(&event, &state).unwrap();
        assert!(!is_muted(&state, "voice", 9, 1).unwrap());
    }
}
