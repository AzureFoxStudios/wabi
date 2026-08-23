//! User-badge projection: stores `badge_assigned` / `badge_removed` events
//! in a live `"user_badges"` index so name surfaces can render assignable
//! badges without touching postcard-encoded user records.
//!
//! ## Event types handled
//!
//! | Event type | Source |
//! |---|---|
//! | `badge_assigned` | `ingest_event("badges", "assign_badge", ...)` |
//! | `badge_removed` | `ingest_event("badges", "remove_badge", ...)` |
//!
//! Payloads are JSON (written through the adapter's generic ingest funnel):
//!
//! ```json
//! { "user_id": 7, "badge_id": "founder", "assigned_by": 1 }
//! ```
//!
//! The index is keyed `(user_id, badge_id)`; removal deletes the key, so
//! replay is idempotent and the live view always reflects current state.

use crate::engine::locks::ProjectionState;
use crate::error::Result;
use crate::projections::handler::{DurableEvent, Projection};
use serde::{Deserialize, Serialize};

/// A badge currently assigned to a user.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UserBadgeRecord {
    pub user_id: u64,
    pub badge_id: String,
    pub assigned_by: u64,
    #[serde(default)]
    pub assigned_at_micros: i64,
}

pub fn encode_record(r: &UserBadgeRecord) -> Vec<u8> {
    serde_json::to_vec(r).expect("serde_json serialization failed")
}

pub fn decode_record(buf: &[u8]) -> Result<UserBadgeRecord> {
    serde_json::from_slice(buf).map_err(|e| crate::error::WabiError::Corrupt {
        location: "user_badges projection".into(),
        detail: format!("json decode failed: {e}"),
    })
}

/// Index key: `user_id` (8 LE bytes) followed by a length-prefixed badge id,
/// so per-user listing is a prefix scan.
pub fn encode_key(user_id: u64, badge_id: &str) -> Vec<u8> {
    let mut buf = Vec::new();
    buf.extend_from_slice(&user_id.to_le_bytes());
    buf.extend_from_slice(&(badge_id.len() as u32).to_le_bytes());
    buf.extend_from_slice(badge_id.as_bytes());
    buf
}

pub fn encode_user_prefix(user_id: u64) -> Vec<u8> {
    user_id.to_le_bytes().to_vec()
}

fn decode_payload(event: &DurableEvent) -> Result<(u64, String, u64, i64)> {
    let p: serde_json::Value =
        serde_json::from_slice(&event.payload).map_err(|_| crate::error::WabiError::Validation {
            command: "user_badges_projection".into(),
            reason: "payload is not valid JSON".into(),
        })?;
    let user_id = p.get("user_id").and_then(|v| v.as_u64()).unwrap_or(0);
    let badge_id = p
        .get("badge_id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let assigned_by = p.get("assigned_by").and_then(|v| v.as_u64()).unwrap_or(0);
    let assigned_at_micros = p
        .get("assigned_at_micros")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    Ok((user_id, badge_id, assigned_by, assigned_at_micros))
}

pub struct BadgesProjection;

impl Projection for BadgesProjection {
    fn event_type(&self) -> &str {
        "badge_assigned"
    }

    fn event_types(&self) -> Vec<&str> {
        vec!["badge_assigned", "badge_removed"]
    }

    fn apply(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        let (user_id, badge_id, _assigned_by, _at) = decode_payload(event)?;
        if user_id == 0 || badge_id.is_empty() {
            return Ok(());
        }
        let key = encode_key(user_id, &badge_id);
        if event.event_type == "badge_removed" {
            state.remove("user_badges", &key);
            return Ok(());
        }
        let record = UserBadgeRecord {
            user_id,
            badge_id,
            assigned_by: _assigned_by,
            assigned_at_micros: if _at > 0 {
                _at
            } else {
                event.commit_seq as i64
            },
        };
        state.insert("user_badges", key, encode_record(&record), event.commit_seq);
        Ok(())
    }
}

impl BadgesProjection {
    /// All badges currently held by a user.
    pub fn list_user_badges(
        state: &ProjectionState,
        user_id: u64,
    ) -> Result<Vec<UserBadgeRecord>> {
        let mut out = Vec::new();
        state.prefix_scan("user_badges", &encode_user_prefix(user_id), |_key, value| {
            if let Ok(record) = decode_record(value) {
                out.push(record);
            }
        });
        out.sort_by(|a, b| a.badge_id.cmp(&b.badge_id));
        Ok(out)
    }

    /// Look up one specific badge assignment.
    pub fn get_user_badge(
        state: &ProjectionState,
        user_id: u64,
        badge_id: &str,
    ) -> Result<Option<UserBadgeRecord>> {
        match state.get("user_badges", &encode_key(user_id, badge_id)) {
            None => Ok(None),
            Some(bytes) => decode_record(&bytes).map(Some),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_event(event_type: &str, user_id: u64, badge_id: &str) -> DurableEvent {
        DurableEvent {
            commit_seq: 1,
            stream_id: "badges:test".into(),
            event_type: event_type.into(),
            payload: serde_json::json!({
                "user_id": user_id,
                "badge_id": badge_id,
                "assigned_by": 42,
            })
            .to_string()
            .into_bytes(),
        }
    }

    #[test]
    fn assign_then_list() {
        let state = ProjectionState::new();
        let proj = BadgesProjection;
        proj.apply(&make_event("badge_assigned", 7, "alpha"), &state)
            .unwrap();
        proj.apply(&make_event("badge_assigned", 7, "beta"), &state)
            .unwrap();
        let badges = BadgesProjection::list_user_badges(&state, 7).unwrap();
        assert_eq!(badges.len(), 2);
        assert_eq!(badges[0].badge_id, "alpha");
        assert_eq!(badges[1].badge_id, "beta");
        assert_eq!(badges[0].assigned_by, 42);
    }

    #[test]
    fn remove_deletes_key_and_replay_is_idempotent() {
        let state = ProjectionState::new();
        let proj = BadgesProjection;
        proj.apply(&make_event("badge_assigned", 7, "alpha"), &state)
            .unwrap();
        proj.apply(&make_event("badge_removed", 7, "alpha"), &state)
            .unwrap();
        assert!(BadgesProjection::list_user_badges(&state, 7)
            .unwrap()
            .is_empty());
        // Removing again must not error or resurrect anything.
        proj.apply(&make_event("badge_removed", 7, "alpha"), &state)
            .unwrap();
        assert!(BadgesProjection::get_user_badge(&state, 7, "alpha")
            .unwrap()
            .is_none());
    }

    #[test]
    fn reassign_overwrites() {
        let state = ProjectionState::new();
        let proj = BadgesProjection;
        proj.apply(&make_event("badge_assigned", 3, "founder"), &state)
            .unwrap();
        proj.apply(&make_event("badge_assigned", 3, "founder"), &state)
            .unwrap();
        let badges = BadgesProjection::list_user_badges(&state, 3).unwrap();
        assert_eq!(badges.len(), 1);
    }

    #[test]
    fn empty_payload_rows_are_skipped() {
        let state = ProjectionState::new();
        let proj = BadgesProjection;
        let bad = DurableEvent {
            commit_seq: 2,
            stream_id: "badges:test".into(),
            event_type: "badge_assigned".into(),
            payload: serde_json::json!({ "user_id": 0, "badge_id": "" })
                .to_string()
                .into_bytes(),
        };
        proj.apply(&bad, &state).unwrap();
        assert!(BadgesProjection::list_user_badges(&state, 0)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn record_roundtrip() {
        let r = UserBadgeRecord {
            user_id: 9,
            badge_id: "bug-hunter".into(),
            assigned_by: 1,
            assigned_at_micros: 1_000,
        };
        let decoded = decode_record(&encode_record(&r)).unwrap();
        assert_eq!(r, decoded);
    }
}
