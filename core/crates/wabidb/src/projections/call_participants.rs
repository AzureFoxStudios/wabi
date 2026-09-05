//! Projection for `CallParticipant` events.
//!
//! Stores one row per `participant_key` (`<session_id>:<user_id>`).
//! Updated on `call_participant_joined` and `call_participant_left` events.
//!
//! Secondary index `call_participants_by_session:<session_id>` -> list of
//! participant_keys is maintained for the `WHERE session_id = '...'`
//! subscription query.

use crate::domain::CallParticipant;
use crate::engine::locks::ProjectionState;
use crate::error::{Result, WabiError};
use crate::projections::handler::{DurableEvent, Projection};

pub const INDEX_NAME: &str = "call_participants";
pub const SECONDARY_INDEX_PREFIX: &str = "call_participants_by_session:";

pub fn encode_key(participant_key: &str) -> Vec<u8> {
    participant_key.as_bytes().to_vec()
}

pub fn encode_value(participant: &CallParticipant) -> Result<Vec<u8>> {
    serde_json::to_vec(participant).map_err(|e| WabiError::Validation {
        command: "call_participants_projection_encode".into(),
        reason: format!("encode failed: {e}"),
    })
}

pub fn decode_value(bytes: &[u8]) -> Result<CallParticipant> {
    serde_json::from_slice(bytes).map_err(|e| WabiError::Validation {
        command: "call_participants_projection_decode".into(),
        reason: format!("decode failed: {e}"),
    })
}

pub fn secondary_key(session_id: &str) -> Vec<u8> {
    format!("{}{}", SECONDARY_INDEX_PREFIX, session_id).into_bytes()
}

/// Update the secondary index when a participant is added or updated.
/// Stores a JSON array of participant_keys for the session.
fn secondary_add(
    state: &ProjectionState,
    session_id: &str,
    participant_key: &str,
    commit_seq: u64,
) {
    let key = secondary_key(session_id);
    let mut keys: Vec<String> = state
        .get(INDEX_NAME, &key)
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    if !keys.contains(&participant_key.to_string()) {
        keys.push(participant_key.to_string());
    }
    if let Ok(bytes) = serde_json::to_vec(&keys) {
        state.insert(INDEX_NAME, key, bytes, commit_seq);
    }
}

pub struct CallParticipantsProjection;

impl Projection for CallParticipantsProjection {
    fn event_type(&self) -> &str {
        "call_participant_joined"
    }

    fn event_types(&self) -> Vec<&str> {
        vec!["call_participant_joined", "call_participant_left"]
    }

    fn apply(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        let participant: CallParticipant = match serde_json::from_slice(&event.payload) {
            Ok(p) => p,
            Err(_) => {
                // Partial update (leave): load existing, patch timestamps.
                let participant_key = event
                    .stream_id
                    .strip_prefix("call_participant:")
                    .unwrap_or(&event.stream_id);
                let key = encode_key(participant_key);
                // A leave after a failed join is already satisfied. Invalid
                // payloads must still fail instead of being silently ignored.
                let patch: serde_json::Value =
                    serde_json::from_slice(&event.payload).map_err(|e| WabiError::Validation {
                        command: "call_participants_projection".into(),
                        reason: format!("invalid partial update: {e}"),
                    })?;
                if event.event_type == "call_participant_left"
                    && patch
                        .get("left_at_micros")
                        .and_then(|v| v.as_i64())
                        .is_some()
                    && state.get(INDEX_NAME, &key).is_none()
                {
                    return Ok(());
                }
                let existing_bytes =
                    state
                        .get(INDEX_NAME, &key)
                        .ok_or_else(|| WabiError::NotFound {
                            what: format!("call_participant:{}", participant_key),
                        })?;
                let mut existing = decode_value(&existing_bytes)?;
                if let Some(v) = patch.get("left_at_micros").and_then(|v| v.as_i64()) {
                    existing.left_at_micros = Some(v);
                }
                if let Some(v) = patch.get("last_updated_at_micros").and_then(|v| v.as_i64()) {
                    existing.last_updated_at_micros = v;
                }
                existing
            }
        };

        let key = encode_key(&participant.participant_key);
        let value = encode_value(&participant)?;
        state.insert(INDEX_NAME, key.clone(), value, event.commit_seq);

        // Maintain secondary index.
        secondary_add(
            state,
            &participant.session_id,
            &participant.participant_key,
            event.commit_seq,
        );

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_decode_roundtrip() {
        let p = CallParticipant::new("s_1", 1, "stable-1", false);
        let bytes = encode_value(&p).unwrap();
        let back = decode_value(&bytes).unwrap();
        assert_eq!(p, back);
    }

    #[test]
    fn encode_key_matches_participant_key() {
        assert_eq!(encode_key("s_1:1"), b"s_1:1".to_vec());
    }

    #[test]
    fn absent_teardown_is_idempotent_without_creating_secondary_membership() {
        let state = ProjectionState::new();
        let mut event = DurableEvent {
            commit_seq: 1,
            stream_id: "call_participant:absent:1".into(),
            event_type: "call_participant_left".into(),
            payload: serde_json::to_vec(&serde_json::json!({"left_at_micros": 42})).unwrap(),
        };
        for _ in 0..2 {
            CallParticipantsProjection.apply(&event, &state).unwrap();
        }
        assert!(state.get(INDEX_NAME, b"absent:1").is_none());
        assert!(state.get(INDEX_NAME, &secondary_key("absent")).is_none());
        for invalid in [b"not json".to_vec(), b"{}".to_vec()] {
            event.payload = invalid;
            assert!(CallParticipantsProjection.apply(&event, &state).is_err());
        }
    }
}
