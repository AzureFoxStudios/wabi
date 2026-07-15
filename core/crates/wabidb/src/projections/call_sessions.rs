//! Projection for `CallSession` events.
//!
//! Stores one row per `session_id`. Updated on `call_session_created` and
//! `call_session_ended` events.

use crate::domain::CallSession;
use crate::engine::locks::ProjectionState;
use crate::error::{Result, WabiError};
use crate::projections::handler::{DurableEvent, Projection};

pub const INDEX_NAME: &str = "call_sessions";

pub fn encode_key(session_id: &str) -> Vec<u8> {
    session_id.as_bytes().to_vec()
}

pub fn encode_value(session: &CallSession) -> Result<Vec<u8>> {
    serde_json::to_vec(session).map_err(|e| WabiError::Validation {
        command: "call_sessions_projection_encode".into(),
        reason: format!("encode failed: {e}"),
    })
}

pub fn decode_value(bytes: &[u8]) -> Result<CallSession> {
    serde_json::from_slice(bytes).map_err(|e| WabiError::Validation {
        command: "call_sessions_projection_decode".into(),
        reason: format!("decode failed: {e}"),
    })
}

pub struct CallSessionsProjection;

impl Projection for CallSessionsProjection {
    fn event_type(&self) -> &str {
        "call_session_created"
    }

    /// Handle both create and end events for the same session row.
    fn event_types(&self) -> Vec<&str> {
        vec!["call_session_created", "call_session_ended"]
    }

    fn apply(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        // The event payload may be a full CallSession (create) or a
        // partial update (end). We decode leniently: try CallSession
        // first; if that fails, decode as JSON Value and look for an
        // existing record to update.
        let session: CallSession = match serde_json::from_slice(&event.payload) {
            Ok(s) => s,
            Err(_) => {
                // Partial update: load existing, patch, re-encode.
                let key = encode_key(
                    event.stream_id
                        .strip_prefix("call_session:")
                        .unwrap_or(&event.stream_id),
                );
                let existing_bytes = state.get(INDEX_NAME, &key).ok_or_else(|| {
                    WabiError::NotFound {
                        what: format!("call_session:{}", event.stream_id),
                    }
                })?;
                let mut existing = decode_value(&existing_bytes)?;
                let patch: serde_json::Value = serde_json::from_slice(&event.payload)
                    .map_err(|e| WabiError::Validation {
                        command: "call_sessions_projection".into(),
                        reason: format!("invalid partial update: {e}"),
                    })?;
                if let Some(v) = patch.get("ended_at_micros").and_then(|v| v.as_i64()) {
                    existing.ended_at_micros = Some(v);
                }
                if let Some(v) = patch.get("active").and_then(|v| v.as_bool()) {
                    existing.active = v;
                }
                if let Some(v) = patch.get("last_updated_at_micros").and_then(|v| v.as_i64()) {
                    existing.last_updated_at_micros = v;
                }
                existing
            }
        };

        let key = encode_key(&session.session_id);
        let value = encode_value(&session)?;
        state.insert(INDEX_NAME, key, value, event.commit_seq);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_decode_roundtrip() {
        let s = CallSession::new("s_1", "ch_1", "audio-call", 1, 10, "webrtc");
        let bytes = encode_value(&s).unwrap();
        let back = decode_value(&bytes).unwrap();
        assert_eq!(s, back);
    }

    #[test]
    fn encode_key_matches_session_id() {
        assert_eq!(encode_key("abc"), b"abc".to_vec());
    }
}