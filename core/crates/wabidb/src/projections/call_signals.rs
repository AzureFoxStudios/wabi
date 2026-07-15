//! Projection for `CallSignal` events.
//!
//! Stores one row per (session_id, signal_id). signal_id is monotonic per
//! session and assigned by the caller (the command), so it survives engine
//! restart. The frontend's `get_signals(since)` query reads all signals
//! for a session where signal_id > since.

use crate::domain::CallSignal;
use crate::engine::locks::ProjectionState;
use crate::error::{Result, WabiError};
use crate::projections::handler::{DurableEvent, Projection};

pub const INDEX_NAME: &str = "call_signals";

pub fn encode_key(session_id: &str, signal_id: u64) -> Vec<u8> {
    format!("{}:{:020}", session_id, signal_id).into_bytes()
}

pub fn encode_value(signal: &CallSignal) -> Result<Vec<u8>> {
    serde_json::to_vec(signal).map_err(|e| WabiError::Validation {
        command: "call_signals_projection_encode".into(),
        reason: format!("encode failed: {e}"),
    })
}

pub fn decode_value(bytes: &[u8]) -> Result<CallSignal> {
    serde_json::from_slice(bytes).map_err(|e| WabiError::Validation {
        command: "call_signals_projection_decode".into(),
        reason: format!("decode failed: {e}"),
    })
}

pub struct CallSignalsProjection;

impl Projection for CallSignalsProjection {
    fn event_type(&self) -> &str {
        "call_signal_emitted"
    }

    fn apply(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        let signal: CallSignal = serde_json::from_slice(&event.payload).map_err(|e| {
            WabiError::Validation {
                command: "call_signals_projection".into(),
                reason: format!("decode failed: {e}"),
            }
        })?;

        let key = encode_key(&signal.session_id, signal.signal_id);
        let value = encode_value(&signal)?;
        state.insert(INDEX_NAME, key, value, event.commit_seq);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_key_orders_by_signal_id() {
        let a = encode_key("s_1", 1);
        let b = encode_key("s_1", 2);
        let c = encode_key("s_1", 100);
        assert!(a < b);
        assert!(b < c);
    }

    #[test]
    fn encode_key_separates_sessions() {
        let s1 = encode_key("s_1", 1);
        let s2 = encode_key("s_2", 1);
        // No ordering guarantee across sessions, but must be distinct.
        assert_ne!(s1, s2);
    }
}